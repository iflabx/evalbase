import { describe, it, expect } from "vitest";
import { preparePlanProposal } from "../../src/assistant/plan-preparation.js";
import { generationSteps } from "../../src/assistant/delivery-plan.js";
import {
  assertPlanContent,
  normalizePlanContent,
} from "../../src/assistant/plan-content.js";
import { validateRules } from "../../src/assistant/requirements.js";
const fixture = () => ({
  requirements: [
    "Metadata的“类别”字段仅使用“退款进度”或“退款到账时间”，并分别各2条。",
    "生成4条完整、自然的问题。",
    "退款进度2条：只询问处理环节，不问实际到账。",
    "退款到账时间2条：只问已发起退款何时到账，通常1至3个工作日。",
    "保留最近30天条件，每题包含2条实体信息。",
  ],
  executionPlan: {
    contractVersion: 1,
    current: 0,
    mode: "plan",
    steps: [
      {
        deliveryId: "delivery_one",
        action: "generate_candidates",
        countKind: "final",
        input: {
          name: "退款测试",
          outputCount: 4,
          instructions:
            "生成4条完整、自然的问题。其中2条为退款进度：只问处理环节；2条为退款到账时间：只问到账时间，通常1至3个工作日。",
          scenarios: ["用户首次咨询", "用户补充订单", "用户询问异常"],
          classifications: [
            {
              field: "metadata",
              key: "类别",
              basis: "user",
              allowedValues: ["退款进度", "退款到账时间"],
              quotas: [
                { value: "退款进度", count: 2 },
                { value: "退款到账时间", count: 2 },
              ],
            },
          ],
        },
      },
    ],
  },
});
function prepare(task: any, patch: any) {
  return preparePlanProposal(patch, {
    task,
    request: "退款进度先改3条，另一类不变，还是只保存方案。",
    revision: 5,
    canUpdate: true,
    resolve: (x) => x,
    validate: validateRules,
    knownValues: [],
  });
}
describe("quantity and content consistency", () => {
  it("protects only explicit per-item and input spans, never adjacent output counts", () => {
    const task = fixture(),
      raw = task.executionPlan.steps[0].input;
    const goal = {
      id: "g",
      name: "退款",
      count: 2,
      countKind: "new" as const,
      instructions: "每题生成2条实体信息并另外抽取7条问题。",
      scenarios: raw.scenarios,
      classifications: [],
    };
    expect(() => normalizePlanContent([goal], [])).toThrow();
    goal.instructions = "每题生成2条不同回复，参考数据生成2条自然问题。";
    expect(normalizePlanContent([goal], []).goals[0].instructions).toBe(
      "每题生成2条不同回复，参考数据生成自然问题。",
    );
    goal.instructions = "生成四条自然问题。";
    expect(() => normalizePlanContent([goal], [])).toThrow();
  });

  it("blocks old mixed contracts at the execution and unchanged-verification guard", () => {
    const t = fixture();
    const s = t.executionPlan.steps[0];
    const g = {
      id: s.deliveryId,
      name: s.input.name,
      count: 4,
      countKind: "final" as const,
      instructions: s.input.instructions,
      scenarios: s.input.scenarios,
      classifications: s.input.classifications as any,
    };
    expect(() => assertPlanContent([g], t.requirements)).toThrow();
    const n = normalizePlanContent([g], t.requirements);
    expect(() => assertPlanContent(n.goals, n.requirements)).not.toThrow();
  });
  it("keeps siblings and literal category names during normalization", () => {
    const a = {
      id: "a",
      name: "甲",
      count: 2,
      countKind: "new" as const,
      instructions: "生成2条自然问题，最近30天。",
      scenarios: [],
      classifications: [],
    };
    const b = {
      ...a,
      id: "b",
      name: "乙",
      count: 3,
      instructions: "生成3条意图问题，通常1至3个工作日。",
    };
    const n = normalizePlanContent(
      [a, b],
      ["每题包含2条实体信息。", "输入记录共4条。"],
    );
    expect(n.goals[0].instructions).toContain("最近30天");
    expect(n.goals[1].instructions).toContain("1至3个工作日");
    expect(n.requirements).toEqual([
      "每题包含2条实体信息。",
      "输入记录共4条。",
    ]);
  });

  it("normalizes the real mixed 2+2 text before saving a 3+2 patch", () => {
    const task = fixture(),
      before = structuredClone(task),
      rule = task.executionPlan.steps[0].input.classifications[0];
    const r = prepare(task, {
      baseRevision: 5,
      deliveries: [
        {
          id: "delivery_one",
          count: 5,
          classifications: [
            {
              ...rule,
              quotas: [
                { value: "退款进度", count: 3 },
                { value: "退款到账时间", count: 2 },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.goals![0].count).toBe(5);
    expect(r.goals![0].classifications[0].quotas!.map((q) => q.count)).toEqual([
      3, 2,
    ]);
    const text =
      r.requirements!.requirements.join("\n") +
      "\n" +
      generationSteps(r.goals!)[0].input.instructions;
    expect(text).not.toMatch(/各2条|生成4条|退款进度2条|2条为退款进度/);
    for (const semantic of [
      "完整、自然",
      "只询问处理环节",
      "不问实际到账",
      "1至3个工作日",
      "最近30天",
      "每题包含2条实体信息",
    ])
      expect(text).toContain(semantic);
    expect(task).toEqual(before);
  });
  it("normalizes initial planning too, leaving counts in structured fields", () => {
    const task = fixture();
    const raw = task.executionPlan.steps[0].input;
    const r = preparePlanProposal(
      {
        deliveries: [
          {
            name: raw.name,
            count: 4,
            countKind: "final",
            instructions: raw.instructions,
            scenarios: raw.scenarios,
            classifications: raw.classifications,
          },
        ],
        requirements: task.requirements,
      },
      {
        task: {},
        request: "做一份退款测试集，退款进度和退款到账时间各2条，先保存方案",
        revision: 1,
        canUpdate: true,
        resolve: (x) => x,
        validate: validateRules,
        knownValues: [],
      },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.goals![0].instructions).not.toContain("生成4条");
  });
  it("reports unresolved quantity prose instead of silently accepting it", () => {
    const task = fixture();
    task.executionPlan.steps[0].input.instructions +=
      "另外至少7条问题用于人工复核。";
    const r = prepare(task, { deliveries: [{ id: "delivery_one" }] });
    expect(r.ok).toBe(false);
  });
});
