import { expect, it } from "vitest";
import {
  bindPlanProposal,
  preparePlanProposal,
} from "../../src/assistant/plan-preparation.js";
import {
  generationSteps,
  taskForDelivery,
  effectiveDeliveryTask,
} from "../../src/assistant/delivery-plan.js";
import { sourceScopeRequest } from "../../src/assistant/processing-preparation.js";
import { planningContinuation } from "../../src/assistant/intent.js";
import { pendingPlanningAmendment } from "../../src/assistant/recovery.js";
import { planRequirementsKey } from "../../src/assistant/plan.js";
import { requirementSummary } from "../../src/assistant/requirements.js";
import {
  historicalContractRecheck,
  taskCompatibilityProblem,
} from "../../src/assistant/review.js";

const goal = {
  id: "old",
  name: "查物流",
  count: 2,
  countKind: "new",
  instructions: "完整用户问题及处理行为",
  scenarios: ["正常查询", "信息不足", "物流延迟"],
  classifications: [],
};
const task = {
  executionPlan: {
    contractVersion: 1,
    current: 1,
    steps: generationSteps([goal as any]),
  },
};
const request =
  "按原来的要求，再做一份测试集测改地址，2条。保留查物流的候选，不要重新生成。";
it("B3v3 incomplete new delivery never acquires the only old delivery ID", () => {
  const value = bindPlanProposal(
    { deliveries: [{ classifications: [] }, { id: "old" }] },
    task,
    request,
    10,
  );
  expect(value.deliveries[0].id).toBeUndefined();
  expect(value.deliveries[1].id).toBe("old");
});
it("B3v3 complete create repair accepts an inferred name absent literally from the request", () => {
  const proposed = {
    ...goal,
    id: undefined,
    name: "改地址测试集",
    scenarios: ["发货前修改", "信息不全", "已经发货"],
  };
  const result = preparePlanProposal(
    { deliveries: [proposed] },
    {
      task,
      request,
      revision: 10,
      canUpdate: true,
      resolve: (v) => v,
      validate: () => {},
      knownValues: [],
    },
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    expect(result.goals).toHaveLength(2);
    expect(result.goals?.[0]).toMatchObject(goal);
    expect(result.goals?.[1].id).not.toBe("old");
  }
});
it("B3v3 malformed model scope parameters do not revoke confirmed source scope", () => {
  const source = { kind: "assets", assetIds: ["file"] };
  const history = [
    {
      user_text: "整份文件都处理",
      status: "succeeded",
      tool_results: [
        {
          name: "plan_task",
          status: "succeeded",
          result: { task: { target: source }, control: { mode: "plan" } },
        },
      ],
    },
    {
      user_text: "继续",
      status: "failed",
      tool_results: [
        {
          name: "submit_processing",
          status: "failed",
          error: { code: "processing_scope_invalid" },
        },
      ],
    },
  ];
  expect(sourceScopeRequest(history, source)).toBe("整份文件都处理");
});
it("B3v3 ordinary continuation and no-redo constraint preserve the pending amendment", () => {
  expect(planningContinuation("继续未完成的部分，已经生成的不要重做。")).toBe(
    "continue",
  );
  expect(planningContinuation("继续，第二份改成5条。")).toBeNull();
});
it("B3v3 amendment checkpoint survives control revisions without changing its budget identity", () => {
  const pending = {
    ...task,
    planningRecovery: {
      amendment: true,
      taskRevision: 7,
      requestTurnId: "original",
      planKey: planRequirementsKey(task),
      documentsKey: "docs",
      evidenceKey: "evidence",
    },
    parameterRepairLimits: { plan_task: { identity: "original", used: 1 } },
  };
  expect(
    pendingPlanningAmendment(pending, "docs", "evidence")?.requestTurnId,
  ).toBe("original");
  expect(
    pendingPlanningAmendment(pending, "other", "evidence"),
  ).toBeUndefined();
  expect(
    pendingPlanningAmendment(
      { ...pending, requirements: ["新的约束"] },
      "docs",
      "evidence",
    ),
  ).toBeUndefined();
  expect(
    pendingPlanningAmendment(
      {
        ...pending,
        planningRecovery: { ...pending.planningRecovery, amendment: false },
      },
      "docs",
      "evidence",
    )?.requestTurnId,
  ).toBe("original");
  expect(pending.parameterRepairLimits.plan_task.used).toBe(1);
});
it("B3v3 missing historical classification gets new structural proof, never a changed snapshot", () => {
  const rule = {
    field: "metadata",
    key: "意图",
    basis: "user",
    allowedValues: ["查物流"],
    quotas: [{ value: "查物流", count: 2 }],
  };
  const steps: any[] = generationSteps([
    { ...goal, classifications: [rule] } as any,
  ]);
  steps[0].receipt = { runId: "root", draftId: "draft" };
  steps[0].status = "executed";
  const current: any = {
    allowedFields: ["question"],
    backgroundEvidence: [
      { documentId: "doc", fragmentIndex: 0, sha256: "same" },
    ],
    executionPlan: { contractVersion: 1, steps, current: 1 },
  };
  const owned = taskForDelivery(current, "old")!;
  expect(
    effectiveDeliveryTask(
      current,
      "later-round-without-an-assistant-receipt",
      "root",
    ).classifications,
  ).toEqual([rule]);
  expect(() =>
    effectiveDeliveryTask(current, "unrelated-round", "unrelated-root"),
  ).toThrow();
  const root: any = {
    run: {
      id: "root",
      options: {
        ...steps[0].input,
        operation: "generate",
        allowedFields: ["question", "expectedOutput", "metadata"],
      },
      source: { kind: "background", id: "session", recordIds: [] },
      targetDraftId: "draft",
    },
    backgroundEvidence: current.backgroundEvidence,
    backgroundGoal: {
      requirements: requirementSummary(owned),
      classifications: [rule],
    },
  };
  const data: any = {
    ...root,
    run: {
      ...root.run,
      id: "refined",
      options: {
        operation: "rewrite",
        instructions: "自然问法",
        allowedFields: ["question"],
      },
    },
    deliveryRoot: root.run,
    backgroundGoal: {
      requirements: requirementSummary({
        ...owned,
        classifications: [],
        allowedLabels: [],
      }),
      classifications: [],
    },
    records: [
      {
        id: "0:0",
        result: {
          question: "我的包裹在哪？",
          expectedOutput: "查询物流",
          metadata: [{ key: "意图", value: "查物流" }],
        },
      },
    ],
  };
  const frozen = JSON.stringify(data.backgroundGoal);
  const proof = historicalContractRecheck(current, data, root);
  expect(proof?.kind).toBe("structural");
  expect(
    taskCompatibilityProblem(
      { ...current, review: { contractRechecks: [proof] } },
      [data],
    ),
  ).toBeNull();
  expect(JSON.stringify(data.backgroundGoal)).toBe(frozen);
  expect(
    historicalContractRecheck(
      { ...current, requirements: ["新的业务约束"] },
      data,
      root,
    ),
  ).toBeUndefined();
  expect(
    historicalContractRecheck(
      {
        ...current,
        backgroundEvidence: [
          { documentId: "doc", fragmentIndex: 0, sha256: "changed" },
        ],
      },
      data,
      root,
    ),
  ).toBeUndefined();
  const changed = {
    ...data,
    records: [
      {
        ...data.records[0],
        result: { ...data.records[0].result, question: "新内容" },
      },
    ],
  };
  expect(
    taskCompatibilityProblem(
      { ...current, review: { contractRechecks: [proof] } },
      [changed],
    ),
  ).not.toBeNull();
});
