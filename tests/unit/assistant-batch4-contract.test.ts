import { Ajv } from "ajv";
import {
  unwrapPlanningArguments,
  createPlanningProperties,
} from "../../src/assistant/planning-contract.js";
import { prepareTaskBoundary } from "../../src/assistant/task-boundary.js";
import { planningQuestionFact } from "../../src/assistant/planning-contract.js";
import { normalizePlanningInput } from "../../src/assistant/planning-contract.js";
import { minimumPlanScenes } from "../../src/assistant/requirements.js";
import { describe, it, expect } from "vitest";
import { preparePlanAmendment } from "../../src/assistant/plan-request.js";
import { planningContinuation } from "../../src/assistant/intent.js";
const task: any = {
  runId: "run",
  executionPlan: {
    contractVersion: 1,
    steps: [
      {
        deliveryId: "one",
        action: "generate_candidates",
        input: {
          name: "查物流测试集",
          outputCount: 2,
          instructions: "自然完整的查物流问题",
          scenarios: ["订单运输进度", "配送异常咨询", "预计送达时间"],
          classifications: [],
        },
      },
    ],
  },
};
const properties: any = {
  control: {},
  candidateEdit: {},
  candidateSave: {},
  question: {},
  executionMode: {},
  nextAction: {},
  requirements: {},
  deliveries: {
    items: {
      properties: {
        id: {},
        name: {},
        count: {},
        instructions: {},
        scenarios: {},
        classifications: {},
      },
    },
  },
};
describe("B4 operation and recovery contracts", () => {
  it("rename and save does not force content rewrite", () => {
    const a: any = preparePlanAmendment(
      task,
      properties,
      "叫“电商物流基础测试”，存成新的测试集草稿。",
      3,
    );
    expect(a.operation).toBe("save_candidates");
    expect(a.properties.candidateEdit).toBeUndefined();
    expect(a.properties.candidateSave).toBeDefined();
  });
  it("an unrecognized amendment never defaults to candidateEdit", () => {
    const a: any = preparePlanAmendment(task, properties, "按刚才说的办。", 3);
    expect(a.properties.candidateEdit).toBeUndefined();
  });
  it("a positive content change keeps the edit operation", () => {
    const a: any = preparePlanAmendment(
      task,
      properties,
      "问法改自然一点，意思不变。",
      3,
    );
    expect(a.operation).toBe("edit_current_candidates");
  });
  it.each(["继续刚才的任务。", "接着刚才的做", "请继续未完成的任务"])(
    "ordinary continuation uses the recovery path: %s",
    (text) => expect(planningContinuation(text)).toBe("continue"),
  );
  it("a continuation with a real amendment is not silently resumed", () =>
    expect(planningContinuation("继续，名称改成物流测试")).toBeNull());
  it("negative save authorization is not a save operation", () => {
    const a: any = preparePlanAmendment(
      task,
      properties,
      "不要保存，先把问法改自然一点。",
      3,
    );
    expect(a.operation).toBe("edit_current_candidates");
  });
});

describe("B4 local planning normalization", () => {
  const d: any = { mode: "execute", requiresUpdate: true };
  it("only drops redundant control matching the saved authorization", () => {
    const input = {
      control: {
        mode: "execute",
        requiresUpdate: true,
        explanation: "继续原授权",
      },
      executionMode: "execute",
      deliveries: [],
    };
    expect(normalizePlanningInput(input, d)).toEqual({
      executionMode: "execute",
      deliveries: [],
    });
  });
  it.each([
    { mode: "plan" },
    { mode: "execute", requiresUpdate: false },
    { mode: "execute", pauseFirst: true },
    { mode: "execute", taskBoundary: "new" },
  ])("preserves conflicting controls for rejection: %j", (control) => {
    const input = { control, deliveries: [] };
    expect(normalizePlanningInput(input, d)).toBe(input);
  });
  it("does not remove unknown fields to hide an invalid proposal", () => {
    expect(
      normalizePlanningInput({ control: { mode: "execute" }, unknown: 3 }, d),
    ).toEqual({ unknown: 3 });
  });
  it("separates output count and scene policy", () => {
    expect(minimumPlanScenes("生成2条")).toBe(3);
    expect(minimumPlanScenes("只用2个场景")).toBe(2);
    expect(minimumPlanScenes("仅使用1种情境")).toBe(1);
    expect(minimumPlanScenes("只改数量为2条", ["原有场景"])).toBe(1);
  });
});

describe("B4 reviewed intent boundaries", () => {
  it.each(["这些数据怎么保存？", "不保存。", "先别执行，保存前先给我方案。"])(
    "does not grant saving from %s",
    (text) =>
      expect(
        (preparePlanAmendment(task, properties, text, 3) as any)?.operation,
      ).not.toBe("save_candidates"),
  );
  it("preserves compound content modification for normal planning", () =>
    expect(
      preparePlanAmendment(
        task,
        properties,
        "把问法改自然一点，再保存成新草稿。",
        3,
      ),
    ).toBeUndefined());
  it("exposes the actual generated draft as a possible save target", () => {
    expect(
      (
        preparePlanAmendment(
          { ...task, targetDraftId: "real-draft" },
          properties,
          "保存回原草稿。",
          3,
        ) as any
      ).facts.draftId,
    ).toBe("real-draft");
  });
  it.each([
    "用户询问已下单商品现在运输到哪了",
    "参数错误，请稍后再试。",
    "需要多少条？",
  ])("does not turn known data or errors into missing facts: %s", (question) =>
    expect(
      planningQuestionFact(
        { ...task, targetCount: 2 },
        "制作2条",
        question,
        true,
      ),
    ).toBeUndefined(),
  );
  it("records a real missing count or unresolved choice", () => {
    expect(
      planningQuestionFact(
        {},
        "帮我设计测试集，数量等我确认",
        "想要多少条？",
        true,
      ),
    ).toBe("count");
    expect(
      planningQuestionFact(
        {},
        "风险类还是正常类我没决定",
        "要风险类还是正常类？",
        true,
      ),
    ).toBe("choice");
  });
});

it("B4 genuine document scope and changed save destination remain clarifiable", () => {
  expect(
    planningQuestionFact(
      {},
      "按附件继续规划",
      "文档缺失物流业务范围，应该覆盖查询还是修改地址？",
      true,
      { read: true, hasDefinitions: false },
    ),
  ).toBe("scope");
  expect(
    planningQuestionFact(
      { ...task, targetDraftId: "old" },
      "先别保存，我想换个地方。",
      "要存到新草稿还是已有草稿？",
      true,
    ),
  ).toBe("save_target");
  expect(
    planningQuestionFact(
      { ...task, targetDraftId: "old" },
      "保存回原草稿。",
      "要存到新草稿还是已有草稿？",
      true,
    ),
  ).toBeUndefined();
});

describe("B4B first-plan and task boundary contracts", () => {
  const input = { executionMode: "plan", deliveries: [] };
  it("unwraps only an exact native-tool envelope", () => {
    expect(unwrapPlanningArguments({ tool: "plan_task", input })).toEqual(
      input,
    );
    for (const value of [
      { tool: "other", input },
      { tool: "plan_task", input, extra: true },
      { tool: "plan_task", input: [input] },
      [input],
    ])
      expect(unwrapPlanningArguments(value)).toEqual(value);
  });
  it("does not erase a changed authorization inside an envelope", () => {
    const inner = { control: { mode: "execute" }, ...input };
    expect(
      normalizePlanningInput({ tool: "plan_task", input: inner }, {
        mode: "plan",
      } as any),
    ).toEqual(inner);
  });
  it("create schema reports illegal id, missing fields and extra delivery together", () => {
    const p: any = createPlanningProperties(
      properties,
      "设计一个测试集，2条，先给方案。",
      "plan",
    );
    expect(p.deliveries.items.properties.id).toBeUndefined();
    expect(p.deliveries.items.properties.remove).toBeUndefined();
    expect(p.deliveries.items.if).toBeUndefined();
    const validate = new Ajv({ strict: false, allErrors: true }).compile({
      type: "object",
      properties: p,
    });
    expect(
      validate({ deliveries: [{ id: "invented" }, { name: "设计方案" }] }),
    ).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === "maxItems")).toBe(true);
    expect(
      validate.errors?.some(
        (e) =>
          e.keyword === "additionalProperties" &&
          e.instancePath === "/deliveries/0",
      ),
    ).toBe(true);
    expect(validate.errors?.some((e) => e.keyword === "required")).toBe(true);
  });
  it.each([
    "继续当前任务，内容不变，另存为新的草稿。",
    "还是刚才的内容，按我说的名字保存就行。",
  ])("retains the original question and full answer: %s", async (answer) => {
    const session: any = {
      id: "session",
      task: {
        goal: "制作问题",
        taskId: "task",
        boundaryQuestion: {
          kind: "choice",
          taskId: "task",
          request: "存成名为物流的新草稿。",
        },
      },
    };
    const db: any = {
      query() {
        throw Error("Unexpected DB access");
      },
    };
    const result = await prepareTaskBoundary(db, {} as any, session, answer);
    expect(result.question).toBeUndefined();
    expect(result.switched).toBe(false);
    expect(result.request).toContain(answer);
    expect(result.request).toContain("存成名为物流的新草稿。");
  });
  it.each(["不要重新生成", "不用再生成", "无需重新生成", "别新建测试集"])(
    "negative generation still allows save: %s",
    (negative) => {
      expect(
        preparePlanAmendment(
          task,
          properties,
          negative + "，内容不变，另存为新的草稿。",
          3,
        )?.operation,
      ).toBe("save_candidates");
    },
  );
  it("new generation followed by save cannot select save-only", () => {
    expect(
      preparePlanAmendment(
        task,
        properties,
        "重新生成两条，再保存为新的草稿。",
        3,
      ),
    ).toBeUndefined();
  });
});
