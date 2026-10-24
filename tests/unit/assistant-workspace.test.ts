import { describe, expect, it } from "vitest";
import {
  deliveryProgress,
  confirmationStatus,
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

describe("StatusFix confirmation facts", () => {
  it.each([
    ["pending", 3, 999, "pending"],
    ["pending", 2, 999, "invalid"],
    ["pending", 3, 99, "expired"],
    ["succeeded", 1, 99, "succeeded"],
    ["executing", 3, 99, "executing"],
  ])(
    "projects %s revision %s expiry %s as %s",
    (status, revision, expiry, expected) => {
      expect(
        confirmationStatus(
          {
            status,
            receipt: status === "succeeded" ? { saved: true } : undefined,
            task_revision: revision,
            expires_at: new Date(Number(expiry)),
          },
          { task_revision: 3, task: { stage: "awaiting_confirmation" } },
          100,
        ),
      ).toBe(expected);
    },
  );
  it("invalidates a stopped pending card without losing a committed receipt", () => {
    const session = { task_revision: 3, task: { stage: "stopped" } };
    expect(
      confirmationStatus(
        { status: "pending", task_revision: 3, expires_at: new Date(999) },
        session,
        100,
      ),
    ).toBe("invalid");
    expect(
      confirmationStatus(
        { status: "succeeded", receipt: { saved: true }, task_revision: 2 },
        session,
        100,
      ),
    ).toBe("succeeded");
  });
  it("a missing success receipt remains unverified", () => {
    expect(
      confirmationStatus({ status: "succeeded" }, { task_revision: 3 }),
    ).toBe("unverified");
  });
  it("retains a saved first delivery while the next has not generated", () => {
    const t = task();
    t.stage = "stopped";
    const f = structuredClone(facts);
    f.runs = f.runs.slice(0, 1);
    f.confirmations = f.confirmations.slice(0, 1);
    delete (t.executionPlan.steps[3] as any).receipt;
    expect(deliveryProgress(t, f)).toMatchObject([
      { status: "saved", savedCount: 5 },
      { generatedCount: null, confirmed: false },
    ]);
  });
  it("relinks an invalid card by its run after the waiting preparation was reset", () => {
    const t = task();
    delete (t.executionPlan.steps[5] as any).receipt;
    const f = structuredClone(facts);
    f.confirmations[1] = { id: "apply-b", status: "expired", runId: "run-b" };
    expect(deliveryProgress(t, f)![1]).toMatchObject({
      status: "awaiting_review",
      confirmationStatus: "expired",
      generatedCount: 5,
    });
  });
  it("cumulative partial adoptions satisfy the goal without duplicate receipts", () => {
    const f = structuredClone(facts);
    f.confirmations = [
      {
        id: "one",
        runId: "run-a",
        status: "succeeded",
        summary: { range: "partial" },
        receipt: {
          receipt: { draftId: "draft-a", adopted: 2, adoptionId: "one" },
        },
      },
      {
        id: "two",
        runId: "run-a",
        status: "succeeded",
        summary: { range: "task" },
        receipt: {
          receipt: { draftId: "draft-a", adopted: 3, adoptionId: "two" },
        },
      },
    ];
    f.confirmations.push({ ...f.confirmations[1], id: "replay" });
    expect(deliveryProgress(task(), f)![0]).toMatchObject({
      status: "saved",
      savedCount: 5,
    });
  });
});
