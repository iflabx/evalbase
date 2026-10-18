import { describe, expect, it } from "vitest";
import {
  deliveryProgress,
  type WorkspaceFacts,
} from "../../src/assistant/workspace.js";

function task() {
  return {
    stage: "awaiting_confirmation",
    executionPlan: {
      contractVersion: 1,
      mode: "execute",
      current: 5,
      steps: ["a", "b"].flatMap((id) => [
        {
          action: "generate_candidates",
          deliveryId: id,
          input: {
            name: "集合 " + id,
            outputCount: 5,
            instructions: "内部要求",
          },
          status: "executed",
          receipt: { runId: "run-" + id, draftId: "draft-" + id },
        },
        { action: "read_processing", deliveryId: id, status: "executed" },
        {
          action: "request_processing_apply",
          deliveryId: id,
          status: id === "a" ? "executed" : "waiting",
          receipt: { proposalId: "apply-" + id },
        },
      ]),
    },
  };
}
const facts: WorkspaceFacts = {
  projectId: "project-a",
  runs: ["a", "b"].map((id) => ({
    id: "run-" + id,
    status: "succeeded",
    count: 5,
  })),
  drafts: ["a", "b"].map((id) => ({
    id: "draft-" + id,
    count: id === "a" ? 5 : 0,
  })),
  confirmations: [
    {
      id: "apply-a",
      status: "succeeded",
      summary: { range: "task" },
      receipt: { receipt: { draftId: "draft-a", adopted: 5 } },
    },
    { id: "apply-b", status: "pending", summary: { count: 5 } },
  ],
};

describe("OPT37 workspace delivery facts", () => {
  it("keeps the first saved delivery visible while the second waits for confirmation", () => {
    const input = task();
    const before = structuredClone(input);
    const result = deliveryProgress(input, facts)!;
    expect(result).toMatchObject([
      {
        id: "a",
        name: "集合 a",
        count: 5,
        status: "saved",
        generatedCount: 5,
        savedCount: 5,
        confirmed: true,
      },
      {
        id: "b",
        name: "集合 b",
        count: 5,
        status: "awaiting_confirmation",
        generatedCount: 5,
        savedCount: 0,
        confirmed: false,
      },
    ]);
    expect(result[0].draft?.url).toBe(
      "/projects/project-a/test-sets/drafts/draft-a",
    );
    expect(JSON.stringify(result)).not.toContain("内部要求");
    expect(input).toEqual(before);
  });

  it("does not turn a pending card or an executed step into a saved result", () => {
    const input = task();
    input.executionPlan.steps[5].status = "executed";
    const result = deliveryProgress(input, facts)!;
    expect(result[1]).toMatchObject({
      savedCount: 0,
      confirmed: false,
      status: "awaiting_confirmation",
    });
    const noReceipt = structuredClone(facts);
    noReceipt.confirmations[1].status = "succeeded";
    expect(deliveryProgress(input, noReceipt)![1]).toMatchObject({
      savedCount: 0,
      confirmed: false,
    });
  });

  it("reports partial saves and uses the real draft total for a final-count goal", () => {
    const input = task();
    const partial = structuredClone(facts);
    partial.confirmations[0].receipt!.receipt.adopted = 3;
    partial.confirmations[0].summary!.range = "partial";
    expect(deliveryProgress(input, partial)![0]).toMatchObject({
      savedCount: 3,
      status: "partially_saved",
      confirmed: true,
    });
    (input.executionPlan.steps[0] as any).countKind = "final";
    partial.confirmations[0].summary!.range = "task";
    expect(deliveryProgress(input, partial)![0]).toMatchObject({
      savedCount: 3,
      status: "saved",
      countKind: "final",
      draft: { count: 5 },
    });
  });

  it("shows actual retained results for a failed run without inheriting another delivery's failure", () => {
    const input = {
      ...task(),
      stage: "failed",
      error: "assistant_model_failed",
    };
    const failed = structuredClone(facts);
    failed.confirmations = [failed.confirmations[0]];
    failed.runs[1] = { id: "run-b", status: "failed", count: 2 };
    expect(deliveryProgress(input, failed)).toMatchObject([
      { status: "saved" },
      {
        status: "failed",
        generatedCount: 2,
        savedCount: 0,
        run: { id: "run-b" },
      },
    ]);
    input.stage = "awaiting_review";
    failed.runs[1].status = "succeeded";
    expect(deliveryProgress(input, failed)![1].status).toBe("awaiting_review");
  });

  it("shows a saved unexecuted plan as planned rather than a user pause", () => {
    const input = { ...task(), executionPaused: true };
    input.executionPlan.mode = "plan";
    expect(
      deliveryProgress(input, {
        ...facts,
        runs: [],
        drafts: [],
        confirmations: [],
      })![1].status,
    ).toBe("planned");
  });

  it("does not reinterpret a legacy plan or substitute a latest run from another delivery", () => {
    const input = task();
    delete (input.executionPlan as any).contractVersion;
    expect(deliveryProgress(input, facts)).toBeUndefined();
    const current = task();
    delete (current.executionPlan.steps[3] as any).receipt;
    (current as any).runId = "run-a";
    expect(deliveryProgress(current, facts)![1]).toMatchObject({
      generatedCount: null,
      confirmed: false,
    });
    expect(deliveryProgress(current, facts)![1].run).toBeUndefined();
  });
});
