import { describe, expect, it } from "vitest";
import {
  bindTaskInput,
  completeDocumentDeliveries,
  resolvedStepInput,
  settleExecutionPlan,
  type ExecutionPlan,
} from "../../src/assistant/plan.js";

function plan(current = 3): ExecutionPlan {
  return {
    contractVersion: 1,
    mode: "execute",
    current,
    steps: [
      {
        id: "generate-a",
        title: "生成 A",
        deliveryId: "a",
        action: "generate_candidates",
        status: "executed",
        receipt: { key: "a", runId: "run-a", draftId: "draft-a" },
      },
      {
        id: "generate-b",
        title: "生成 B",
        deliveryId: "b",
        action: "generate_candidates",
        status: "executed",
        receipt: { key: "b", runId: "run-b", draftId: "draft-b" },
      },
      {
        id: "read-a",
        title: "核对 A",
        deliveryId: "a",
        action: "read_processing",
        status: "executed",
        receipt: { key: "read-a", runId: "run-a" },
      },
      {
        id: "apply-a",
        title: "采用 A",
        deliveryId: "a",
        action: "request_processing_apply",
        input: { allTask: true, allValid: true, target: { kind: "draft" } },
        status: "pending",
      },
    ],
  };
}

describe("OPT36 fixed execution facts", () => {
  it("compiles an actionable confirmation card without another model decision", () => {
    const steps = completeDocumentDeliveries([
      { title: "A", deliveryId: "a", action: "generate_candidates" },
      { title: "B", deliveryId: "b", action: "generate_candidates" },
    ]);
    expect(
      steps.filter((step) => step.action === "request_processing_apply"),
    ).toEqual([
      expect.objectContaining({
        deliveryId: "a",
        input: { allTask: true, allValid: true, target: { kind: "draft" } },
      }),
      expect.objectContaining({
        deliveryId: "b",
        input: { allTask: true, allValid: true, target: { kind: "draft" } },
      }),
    ]);
  });

  it("binds run and destination to this delivery even when a different delivery ran last", () => {
    const executionPlan = plan();
    const input = bindTaskInput(
      "request_processing_apply",
      {},
      {
        executionPlan,
        runId: "run-b",
        targetDraftId: "draft-b",
        createdDraftId: "draft-b",
      },
    );
    expect(input).toEqual({
      runId: "run-a",
      allTask: true,
      allValid: true,
      target: { kind: "draft", id: "draft-a" },
    });
  });

  it("never invents missing delivery dependencies from task or another delivery", () => {
    const executionPlan = plan();
    executionPlan.steps = executionPlan.steps.filter(
      (step) =>
        step.deliveryId !== "a" || step.action === "request_processing_apply",
    );
    executionPlan.current = 1;
    const input = bindTaskInput(
      "request_processing_apply",
      {},
      {
        executionPlan,
        runId: "run-b",
        targetDraftId: "draft-b",
        target: { kind: "draft", id: "draft-b" },
      },
    );
    expect(input.runId).toBeUndefined();
    expect(input.target).toEqual({ kind: "draft" });
  });

  it("restores the frozen operation input but leaves explicit conflicts visible to guards", () => {
    const executionPlan = plan();
    executionPlan.steps[3].operation = {
      key: "original-operation",
      input: {
        runId: "run-a",
        target: { kind: "draft", id: "draft-a" },
        resultIds: ["1:1"],
      },
    };
    expect(resolvedStepInput(executionPlan)).toEqual(
      executionPlan.steps[3].operation!.input,
    );
    expect(resolvedStepInput(executionPlan, { runId: "run-b" }).runId).toBe(
      "run-b",
    );
  });

  it("keeps a waiting real run until that exact run completes", () => {
    const executionPlan = plan(0);
    executionPlan.steps[0] = {
      ...executionPlan.steps[0],
      revision: 7,
      status: "waiting",
    };
    const task = { executionPlan };
    const wrong = settleExecutionPlan(
      task,
      "read_processing",
      { runId: "run-b", status: "succeeded", partial: false, missingCount: 0 },
      "event",
      7,
    );
    expect(wrong.executionPlan).toBe(executionPlan);
    expect(wrong.nextAction).toBeNull();
    const completed = settleExecutionPlan(
      task,
      "read_processing",
      { runId: "run-a", status: "succeeded", partial: false, missingCount: 0 },
      "event",
      7,
    );
    expect(completed.executionPlan!.current).toBe(1);
    expect(completed.executionPlan!.steps[0].receipt).toEqual(
      executionPlan.steps[0].receipt,
    );
  });

  it("projects only unpaused current work and preserves manual confirmation", () => {
    const executionPlan = plan();
    const input = bindTaskInput(
      "request_processing_apply",
      {},
      { executionPlan },
    );
    const prepared = settleExecutionPlan(
      { executionPlan },
      "request_processing_apply",
      { id: "proposal-a", requiresUserConfirmation: true },
      "apply-operation",
      undefined,
      input,
    );
    expect(prepared.executionPlan!.current).toBe(3);
    expect(prepared.executionPlan!.steps[3].status).toBe("waiting");
    expect(prepared.nextAction).toBeNull();
    const confirmed = settleExecutionPlan(
      prepared,
      "confirmed",
      {
        id: "proposal-a",
        status: "succeeded",
        receipt: { draftId: "draft-a" },
      },
      "apply-operation",
    );
    expect(confirmed.executionPlan!.current).toBe(4);
    for (const blocked of [
      { executionPaused: true },
      { question: "补充范围" },
      { executionPlan: { ...executionPlan, needsReview: true } },
    ]) {
      const result = settleExecutionPlan(
        { executionPlan, ...blocked },
        "query_project",
        {},
        "read",
      );
      expect(result.nextAction).toBeNull();
    }
  });
  it("compiles review and adoption for a single new delivery while keeping legacy plans unchanged", () => {
    const steps = [
      {
        title: "生成",
        action: "generate_candidates",
        deliveryId: "one",
        input: { name: "集合", instructions: "完整自然", outputCount: 5 },
      },
    ];
    expect(completeDocumentDeliveries(steps)).toHaveLength(1);
    const compiled = completeDocumentDeliveries(steps, true);
    expect(compiled.map((step) => step.action)).toEqual([
      "generate_candidates",
      "read_processing",
      "request_processing_apply",
    ]);
    expect(compiled[2].input).toEqual({
      allTask: true,
      allValid: true,
      target: { kind: "draft" },
    });
  });
});
