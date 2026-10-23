import {
  deduplicateCandidateCollection,
  candidateCollectionHashValid,
} from "../../src/assistant/candidates.js";
import { unresolvedFailure } from "../../src/assistant/receipts.js";
import { describe, it, expect } from "vitest";
import { turnNeedsWork } from "../../src/assistant/intent.js";
import { normalizePlanContent } from "../../src/assistant/plan-content.js";
import { preparePlanAmendment } from "../../src/assistant/plan-request.js";
const goal = {
  id: "one",
  name: "客服",
  count: 2,
  countKind: "final" as const,
  instructions: "生成2条完整的问题。",
  scenarios: ["首次咨询"],
  classifications: [],
};
describe("batch3 observed contracts", () => {
  it("accepts the actual flat processing tool receipt but not another run", () => {
    const task = { runId: "r", stage: "awaiting_review" };
    const receipt = {
      name: "read_processing",
      status: "succeeded",
      result: {
        runId: "r",
        status: "succeeded",
        partial: false,
        missingCount: 0,
        total: 2,
      },
    };
    expect(turnNeedsWork({ mode: "execute" } as any, task, [receipt])).toBe(
      false,
    );
    expect(
      turnNeedsWork({ mode: "execute" } as any, task, [
        { ...receipt, result: { ...receipt.result, runId: "other" } },
      ]),
    ).toBe(true);
  });
  it.each(["只制作2条", "出2条完整的问题", "准备2条测试数据"])(
    "binds ordinary output count %s",
    (text) => {
      expect(() => normalizePlanContent([goal], [text])).not.toThrow();
    },
  );
  it("retains a non-output quantity without claiming a conflict", () => {
    expect(
      normalizePlanContent([goal], ["每个场景附带2条背景事实"]).requirements[0],
    ).toContain("2条背景事实");
  });
  it("keeps instructions in truncated style amendments", () => {
    const task = {
      executionPlan: {
        contractVersion: 1,
        steps: [
          {
            deliveryId: "one",
            action: "generate_candidates",
            countKind: "final",
            input: { ...goal, outputCount: 2 },
          },
        ],
      },
    };
    const properties = {
      deliveries: {
        items: {
          properties: {
            id: { type: "string" },
            instructions: { type: "string" },
            classifications: { type: "array" },
          },
        },
      },
    };
    const result = preparePlanAmendment(
      task,
      properties,
      "太像标准模板了，换成日常聊天的说法，意思别变。",
      3,
      true,
    )!;
    expect(result.facts.deliveries[0]).toHaveProperty(
      "instructions",
      goal.instructions,
    );
    expect(result.properties.deliveries.items.required).toContain(
      "instructions",
    );
  });
});

it("B3 exact duplicate exclusion keeps stable identity and different answers", () => {
  const records = [
    ["a", "问", "答"],
    ["b", "问", "答"],
    ["c", "问", "另一答"],
  ].map(([id, question, expectedOutput]) => ({
    id,
    candidateOrigin: { runId: "r", resultId: id },
    result: { sourceId: id, question, expectedOutput, metadata: [] },
  }));
  const data: any = {
    run: { id: "r", status: "succeeded" },
    records,
    total: 3,
  };
  const { candidateScope, excluded } = deduplicateCandidateCollection(data, [
    data,
  ]);
  expect(excluded).toBe(1);
  expect(candidateScope.members![0].resultIds).toEqual(["a", "c"]);
  expect(candidateCollectionHashValid(candidateScope)).toBe(true);
  expect(data.records).toHaveLength(3);
});
it("B3 an explicit recovered proposal supersedes only the no-effect wrong action", () => {
  const failure = {
    key: "bad",
    name: "request_publish",
    status: "failed",
    binding: { revision: 1 },
    error: { code: "assistant_candidate_review_incomplete" },
  };
  const success = {
    key: "good",
    name: "request_processing_apply",
    status: "succeeded",
    binding: { revision: 1 },
    resolves: ["bad"],
  };
  expect(unresolvedFailure([failure, success])).toBeUndefined();
  expect(
    unresolvedFailure([{ ...failure, effect: "unknown" }, success]),
  ).toBeDefined();
  expect(
    unresolvedFailure([failure, { ...success, binding: { revision: 2 } }]),
  ).toBeDefined();
});

it.each([
  "每个场景准备3条背景事实",
  "每个场景列出3条参考事实",
  "每个场景共3条参考事实",
])("B3 preserves non-output object %s", (text) => {
  for (const count of [2, 3])
    expect(
      normalizePlanContent(
        [{ ...goal, count, instructions: "自然提问" }],
        [text],
      ).requirements,
    ).toEqual([text]);
});

it("B3 completed processing can advance to review, but not after missing or malformed results", async () => {
  const { advancePlan } = await import("../../src/assistant/plan.js");
  const plan: any = {
    mode: "execute",
    current: 0,
    steps: [
      {
        title: "改写",
        action: "refine_candidates",
        status: "waiting",
        receipt: { runId: "r", key: "x" },
      },
      { title: "核对", action: "read_processing", status: "pending" },
    ],
  };
  const result = {
    runId: "r",
    status: "succeeded",
    partial: true,
    executionComplete: true,
    missingCount: 0,
    review: {
      emptyQuestions: 0,
      formatIssueCount: 0,
      outsideLabels: 0,
      protectedFieldChanges: 0,
    },
  };
  expect(advancePlan(plan, "read_processing", result, "read")?.current).toBe(1);
  for (const patch of [
    { executionComplete: false },
    { missingCount: 1 },
    { review: { ...result.review, protectedFieldChanges: 1 } },
  ])
    expect(
      advancePlan(plan, "read_processing", { ...result, ...patch }, "read"),
    ).toEqual(plan);
});

it.each(["只制作3条即可", "总共3条就行"])(
  "B3 rejects conflicting bare output counts with conversational suffix %s",
  (text) => {
    expect(() => normalizePlanContent([goal], [text])).toThrow();
    expect(
      normalizePlanContent(
        [{ ...goal, count: 3, instructions: "自然提问" }],
        [text],
      ).requirements.join(""),
    ).not.toContain("3条");
  },
);
