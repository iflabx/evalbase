import { describe, expect, it } from "vitest";
import {
  createGenerationPlan,
  generationContext,
  remainingGenerationPositions,
  generationBudget,
} from "../../src/processing/generation.js";
import {
  processingPrompt,
  processingOptions,
  validateModelRows,
} from "../../src/processing/protocol.js";
import { deduplicate } from "../../src/processing/deduplication.js";

const options = {
  operation: "generate",
  instructions: "依据用户要求生成",
  outputCount: 50,
  allowedFields: ["question", "expectedOutput", "metadata"],
  scenarios: ["支付失败", "重复支付", "部分退款", "取消未发货订单", "到账进度"],
};
describe("OPT30 frozen generation allocation", () => {
  it("keeps the root goal's shared call and time ceiling on a completion child", async () => {
    const row = {
      id: "root",
      options: { outputCount: 50 },
      used: 14,
      started: new Date(),
      blocked: false,
    };
    const db = { query: async () => ({ rows: [row] }) } as any;
    expect(await generationBudget(db, "child-requesting-2")).toMatchObject({
      targetCount: 50,
      limit: 15,
      used: 14,
      remaining: 1,
      exhausted: false,
    });
    row.used = 15;
    expect((await generationBudget(db, "child"))?.exhausted).toBe(true);
    row.used = 1;
    row.started = new Date(Date.now() - 300001);
    expect(await generationBudget(db, "child")).toMatchObject({
      remaining: 14,
      exhausted: true,
    });
  });
  it("persists the goal and allocates different ranges without a theme-specific planner", () => {
    const plan = createGenerationPlan("run", 50, options.scenarios);
    expect(
      generationContext(plan, plan.positions.slice(0, 10), []).slots.every(
        (s) => s.scenario === "支付失败",
      ),
    ).toBe(true);
    expect(
      generationContext(plan, plan.positions.slice(10, 20), []).slots.every(
        (s) => s.scenario === "重复支付",
      ),
    ).toBe(true);
    expect(plan.total).toBe(50);
    const accepted = plan.positions
      .filter((p) => ![7, 39].includes(p))
      .map((p) => ({
        sourceId: `generated:${p}`,
        question: `问题${p}`,
        expectedOutput: "核实后处理",
        metadata: [],
      }));
    expect(remainingGenerationPositions(plan, accepted)).toEqual([7, 39]);
    expect(
      generationContext(plan, [7, 39], accepted).scenarios.map(
        (s) => s.accepted,
      ),
    ).toEqual([9, 10, 10, 9, 10]);
    expect(
      remainingGenerationPositions(plan, accepted.slice(0, 20)),
    ).toHaveLength(30);
  });
  it("keeps the original position through a local rewrite", () => {
    const plan = createGenerationPlan("run", 5, ["通用意图"]);
    expect(
      remainingGenerationPositions(plan, [
        {
          result: {
            sourceId: "candidate:0:0",
            question: "已修改",
            expectedOutput: "核对",
            metadata: [],
          },
          original: { baseline: { id: "generated:2" } },
        },
        {
          result: {
            sourceId: "draft-extra",
            question: "后续另行扩充的记录",
            expectedOutput: "核对",
            metadata: [],
          },
          original: { id: "draft-extra" },
        },
      ]),
    ).toEqual([0, 1, 3, 4]);
  });
  it("allocates classification deficits from actual accepted rows rather than slot order", () => {
    const prompt = processingPrompt(
      [],
      processingOptions({ ...options, outputCount: 2 }),
      1,
      {
        documents: [],
        classifications: [
          {
            field: "expectedOutput",
            basis: "requirements",
            allowedValues: ["A", "B"],
            quotas: [
              { value: "A", count: 1 },
              { value: "B", count: 1 },
            ],
          },
        ],
      } as any,
      {
        offset: 0,
        total: 2,
        positions: [1],
        accepted: [
          {
            sourceId: "generated:0",
            question: "先返回B",
            expectedOutput: "B",
            metadata: [],
          },
        ],
      },
    );
    expect(JSON.parse(prompt.prompt).batchQuotas[0].quotas).toEqual([
      { value: "A", count: 1 },
      { value: "B", count: 0 },
    ]);
  });
  it("accepts an equivalent root array only for v9, without relaxing row validation", () => {
    const rows = [
      {
        question: "退款应如何申请？",
        expectedOutput: "说明申请方式",
        metadata: [],
      },
      { question: 123, expectedOutput: "不能采用", metadata: [] },
    ];
    expect(
      validateModelRows(
        rows,
        [],
        processingOptions(options),
        2,
        [7, 39],
      ).records.map((r) => r.sourceId),
    ).toEqual(["generated:7"]);
    expect(() =>
      validateModelRows(rows, [], processingOptions(options), 2),
    ).toThrow("model_output_invalid");
  });
  it("binds output array positions on the server and preserves holes after malformed rows", () => {
    const validated = validateModelRows(
      {
        records: [
          { question: 123 },
          {
            question: "第二场景的完整问题？",
            expectedOutput: "核对",
            metadata: [],
          },
        ],
      },
      [],
      processingOptions(options),
      2,
      [7, 39],
    );
    expect(validated.records.map((r) => r.sourceId)).toEqual(["generated:39"]);
    expect(validated.issues).toContainEqual({
      code: "missing_output",
      count: 1,
    });
    expect(() => processingOptions({ ...options, scenarios: [" "] })).toThrow();
    expect(() =>
      processingOptions({ ...options, operation: "rewrite" }),
    ).toThrow();
  });
  it("does not remove a same-question different-answer contrast sample", () => {
    const rows = ["建议核实原订单", "建议核实原订单", "按新的订单状态核实"].map(
      (expectedOutput, i) => ({
        id: `${i}`,
        question: "请问退款进度？",
        expectedOutput,
        metadata: [],
      }),
    );
    expect(deduplicate(rows)).toMatchObject({
      keptIds: ["0", "2"],
      excludedIds: ["1"],
      questionCollisionIds: ["0", "1", "2"],
    });
  });
});
