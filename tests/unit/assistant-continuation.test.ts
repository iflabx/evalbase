import { describe, expect, it } from "vitest";
import { reconcileExecutionConfirmations } from "../../src/assistant/receipts.js";
import {
  currentDeliveryId,
  continuationEventCount,
  generationSteps,
} from "../../src/assistant/delivery-plan.js";
import {
  deliverySharedRequirementsKey,
  completeDocumentDeliveries,
} from "../../src/assistant/plan.js";
import {
  canResumeAssistantTurn,
  taskPresentation,
} from "../../src/assistant/store.js";

function fixture() {
  const task: any = {
    goal: "保存两份测试集",
    stage: "awaiting_confirmation",
    autoCount: 18,
    autoEventLimit: 18,
    executionPlan: {
      contractVersion: 1,
      mode: "execute",
      needsReview: false,
      current: 5,
      steps: ["A", "H"].flatMap((id, index) => [
        {
          action: "generate_candidates",
          deliveryId: id,
          status: "executed",
          revision: 3,
          input: { outputCount: 50 },
          receipt: { runId: "run-" + id, draftId: "draft-" + id },
        },
        {
          action: "read_processing",
          deliveryId: id,
          status: "executed",
          revision: 3,
          receipt: { runId: "run-" + id },
        },
        {
          action: "request_processing_apply",
          deliveryId: id,
          status: index === 0 ? "executed" : "waiting",
          revision: 3,
          receipt: {
            key: "key-" + id,
            proposalId: "proposal-" + id,
            draftId: "draft-" + id,
          },
        },
      ]),
    },
  };
  const facts: any[] = ["A", "H"].map((id) => ({
    id: "proposal-" + id,
    status: "succeeded",
    task_revision: 3,
    summary: { range: "task" },
    receipt: { receipt: { draftId: "draft-" + id, adopted: 50 } },
  }));
  const queries: string[] = [];
  const db: any = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes("FROM assistant_proposal")
          ? facts
          : [{ tool_results: [] }],
        rowCount: sql.includes("FROM assistant_proposal") ? facts.length : 1,
      };
    },
  };
  return {
    task,
    facts,
    db,
    queries,
    session: {
      id: "session",
      project_id: "project",
      actor_id: "actor",
      task_revision: 3,
      task,
    },
  };
}

describe("OPT-39 receipt settlement and continuation scope", () => {
  it("closes at the event ceiling from scoped committed receipts without a new event or model", async () => {
    const f = fixture(),
      original = structuredClone(f.task);
    const result = await reconcileExecutionConfirmations(f.db, f.session);
    expect(result).toMatchObject({
      stage: "complete",
      autoCount: 18,
      autoEventLimit: 18,
      executionPlan: { current: 6 },
    });
    expect(f.task).toEqual(original);
    expect(f.queries.every((sql) => sql.startsWith("SELECT"))).toBe(true);
    const again = await reconcileExecutionConfirmations(f.db, {
      ...f.session,
      task: result,
    });
    expect(again).toBe(result);
  });
  it.each(["partial", "unknown", "wrong-draft", "short-save", "old-revision"])(
    "retains incomplete state for %s confirmation evidence",
    async (kind) => {
      const f = fixture();
      if (kind === "partial") f.facts[1].summary.range = "partial";
      if (kind === "unknown") f.facts[1].status = "executing";
      if (kind === "wrong-draft")
        f.facts[1].receipt.receipt.draftId = "draft-other";
      if (kind === "short-save") f.facts[1].receipt.receipt.adopted = 49;
      if (kind === "old-revision") f.facts[1].task_revision = 2;
      expect(
        (await reconcileExecutionConfirmations(f.db, f.session)).stage,
      ).not.toBe("complete");
    },
  );
  it("retains pause and stop while reconciling no new business effect", async () => {
    const f = fixture();
    f.task.executionPaused = true;
    const paused = await reconcileExecutionConfirmations(f.db, f.session);
    expect(paused.stage).toBe("awaiting_confirmation");
    expect(paused.executionPaused).toBe(true);
    f.task.stage = "stopped";
    expect(await reconcileExecutionConfirmations(f.db, f.session)).toBe(f.task);
  });
  it("keeps terminal focus on the last receipted delivery without guessing an unbound goal", () => {
    const f = fixture();
    f.task.executionPlan.current = 6;
    expect(currentDeliveryId(f.task.executionPlan)).toBe("H");
    f.task.executionPlan.steps.forEach((step: any) => delete step.receipt);
    expect(currentDeliveryId(f.task.executionPlan)).toBeUndefined();
  });
  it("presents terminal goal rules from the last committed delivery without changing the task", () => {
    const f = fixture();
    f.task.executionPlan.current = 6;
    f.task.executionPlan.steps[0].input.classifications = [
      { field: "expectedOutput", basis: "user", allowedValues: ["A"] },
    ];
    f.task.executionPlan.steps[3].input.classifications = [
      { field: "expectedOutput", basis: "user", allowedValues: ["H"] },
    ];
    f.task.executionPlan.steps[0].input.name = "集合A";
    f.task.executionPlan.steps[3].input.name = "集合H";
    f.task.classifications =
      f.task.executionPlan.steps[0].input.classifications;
    const original = structuredClone(f.task);
    expect(taskPresentation(f.task)!.classifications[0].allowedValues).toEqual([
      "H",
    ]);
    expect(f.task).toEqual(original);
  });
  it("counts eight processing completions and eight confirmations, excluding synchronous reads", () => {
    const goals = Array.from({ length: 8 }, (_, i) => ({
      id: "delivery-" + i,
      name: "集合" + i,
      count: 50,
      countKind: "new" as const,
      instructions: "自然完整",
      scenarios: [],
      classifications: [],
    }));
    const plan = { steps: completeDocumentDeliveries(generationSteps(goals)) };
    expect(continuationEventCount(plan)).toBe(16);
    const reads = {
      steps: [
        ...plan.steps,
        ...Array.from({ length: 10 }, () => ({ action: "read_records" })),
      ],
    };
    expect(continuationEventCount(reads)).toBe(16);
  });
  it("does not offer a retry when cumulative model or active-time budget is exhausted", () => {
    const turn = {
      id: "turn",
      status: "failed",
      execution_attempt: 1,
      user_text: "继续",
    };
    const task = {
      stage: "failed",
      executionBudget: {
        modelSteps: 130,
        toolCalls: 0,
        transportRetries: 0,
        activeMs: 0,
      },
    };
    expect(canResumeAssistantTurn(turn, task)).toBe(false);
    expect(
      canResumeAssistantTurn(turn, {
        ...task,
        executionBudget: {
          ...task.executionBudget,
          modelSteps: 1,
          activeMs: 1040000,
        },
      }),
    ).toBe(false);
  });
});

it("compares shared constraints independently from each delivery and its bound destination", () => {
  const original = {
    requirements: ["保留 TokenABC"],
    allowedFields: ["question"],
    metadataKeys: ["riskCategory"],
    backgroundEvidence: [{ documentId: "doc", fragmentIndex: 1 }],
    target: { kind: "draft", id: "A" },
    targetCount: 5,
    classifications: [],
    executionPlan: { contractVersion: 1, steps: [] },
  };
  const changed = {
    ...original,
    target: { kind: "draft", id: "H" },
    targetCount: 50,
    classifications: [
      { field: "metadata", key: "riskCategory", allowedValues: ["H"] },
    ],
  };
  expect(deliverySharedRequirementsKey(changed)).toBe(
    deliverySharedRequirementsKey(original),
  );
  for (const patch of [
    { requirements: ["保留 tokenabc"] },
    { allowedFields: ["question", "metadata"] },
    { metadataKeys: ["other"] },
    { backgroundEvidence: [{ documentId: "doc", fragmentIndex: 2 }] },
  ])
    expect(deliverySharedRequirementsKey({ ...changed, ...patch })).not.toBe(
      deliverySharedRequirementsKey(original),
    );
});

import {
  planningContinuation,
  requestsBusinessAmendment,
} from "../../src/assistant/intent.js";
it("OPT45 recognizes planning-only continuation without treating a new amendment as recovery", () => {
  for (const text of [
    "继续规划",
    "继续规划，先不要生成",
    "继续规划\n先不要生成",
    "继续规划，暂时不要生成",
    "请继续，先不执行",
    "继续按最后要求保存方案",
  ])
    expect(planningContinuation(text)).toBe("plan");
  expect(planningContinuation("继续执行")).toBe("continue");
  for (const text of [
    "物流改成3条，地址不变",
    "继续规划，物流改成3条",
    "不要继续",
    "解释继续规划是什么意思",
  ])
    expect(planningContinuation(text)).toBeNull();
});

it("OPT45 control-only cancellations do not get a new correction identity", () => {
  for (const text of [
    "继续规划，取消自动生成",
    "继续规划，取消后续生成",
    "继续规划\n先不要生成",
    "继续规划，暂时不要生成",
  ])
    expect(requestsBusinessAmendment(text)).toBe(false);
  expect(requestsBusinessAmendment("物流改成3条，地址不变")).toBe(true);
});
