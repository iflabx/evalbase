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
import { modelRequest } from "../../src/processing/execute.js";
import { newQuestionPolicy } from "../../src/processing/deduplication.js";
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

it("OPT40 excludes exact question collisions only under a frozen new-question policy", () => {
  const rows = ["问题一", "问题一", "问题二"].map((question, i) => ({
    id: String(i),
    sourceId: "generated:" + i,
    question,
    expectedOutput: "答案" + i,
    metadata: [{ key: "类型", value: String(i) }],
  }));
  const plan = createGenerationPlan("root", 3, ["语境"]);
  expect(remainingGenerationPositions(plan, rows, "distinct-v1")).toEqual([1]);
  expect(remainingGenerationPositions(plan, rows)).toEqual([]);
  expect(deduplicate(rows, [], "distinct-v1").keptIds).toEqual(["0", "2"]);
  expect(deduplicate(rows, [], "variants-v1").keptIds).toEqual(["0", "1", "2"]);
  expect(
    deduplicate(
      [...rows, { ...rows[2], id: "3", question: "近义但不同的问题" }],
      [],
      "distinct-v1",
    ).keptIds,
  ).toEqual(["0", "2", "3"]);
});

it("OPT40 freezes variants only from affirmative user requests and keeps old/import semantics", () => {
  expect(newQuestionPolicy("generate", ["生成同题多答案对照样本"])).toBe(
    "variants-v1",
  );
  for (const request of [
    "不需要生成同题多答案",
    "不要保留同题不同答案",
    "请解释什么是生成对照样本",
    "是否可以生成同题多答案",
    "按照文档创建普通新题",
  ])
    expect(newQuestionPolicy("generate", [request])).toBe("distinct-v1");
  expect(
    newQuestionPolicy("augment", ["生成同题多答案", "不要保留同题多答案"]),
  ).toBe("distinct-v1");
  expect(newQuestionPolicy("rewrite", ["生成同题多答案"])).toBeUndefined();
  expect(newQuestionPolicy("clean", ["生成同题多答案"])).toBeUndefined();
});
it("OPT40 trims exclusion hints but preserves full criteria and byte limits", () => {
  const background: any = {
    questionPolicy: "distinct-v1",
    requirements: ["保留共同条件" + "说明".repeat(500)],
    documents: [
      {
        id: "doc",
        fileName: "通用规范",
        sha256: "hash",
        extractorVersion: "text",
        fragments: [{ index: 1, text: "原文".repeat(2800) }],
      },
    ],
  };
  const prior = Array.from({ length: 200 }, (_, index) => ({
    sourceId: "generated:" + index,
    question: "唯一问题" + index + "场景".repeat(149),
    expectedOutput: "答案".repeat(150),
    metadata: [],
  }));
  const plan = createGenerationPlan("root", 201, ["中性情境"]);
  const req = modelRequest(
    [],
    processingOptions({
      ...options,
      outputCount: 1,
      instructions: "要求".repeat(1000),
    }),
    1,
    1,
    background,
    [],
    { offset: 200, total: 201, positions: [200] },
    true,
    true,
    prior,
    undefined,
    plan,
    "distinct-v1",
  );
  const body = JSON.parse(req.prompt);
  expect(Buffer.byteLength(req.system + req.prompt)).toBeLessThanOrEqual(40000);
  expect(body.previousBatchExamples.length).toBeLessThan(20);
  expect(body.background).toEqual(background);
  expect(body.categoryCriteria.source).toContain("background.classifications");
  expect(
    body.previousBatchExamples.every(
      (row: any) => !Object.hasOwn(row, "expectedOutput"),
    ),
  ).toBe(true);
  expect(
    deduplicate(
      [{ ...prior[0], id: "new", expectedOutput: "另外答案" }],
      prior,
      "distinct-v1",
    ).keptIds,
  ).toEqual([]);
});

it("OPT40 keeps explicit variant authorization within its named delivery", () => {
  const requests = ["甲交付创建普通新问题，乙交付需要生成同题多答案对照样本"];
  expect(
    newQuestionPolicy("generate", requests, {
      name: "甲交付",
      names: ["甲交付", "乙交付"],
    }),
  ).toBe("distinct-v1");
  expect(
    newQuestionPolicy("generate", requests, {
      name: "乙交付",
      names: ["甲交付", "乙交付"],
    }),
  ).toBe("variants-v1");
  for (const request of [
    "生成时避免同题多答案",
    "请生成不含对照样本的测试集",
    "请生成没有同题多答案的测试集",
  ])
    expect(newQuestionPolicy("generate", [request])).toBe("distinct-v1");
});

it("OPT40 revokes an unqualified exception and does not expand a subset to other deliveries", () => {
  const two = { name: "乙交付", names: ["甲交付", "乙交付"] };
  expect(
    newQuestionPolicy(
      "generate",
      ["两份都需要生成同题多答案", "不需要生成同题多答案"],
      two,
    ),
  ).toBe("distinct-v1");
  const three = { name: "丙交付", names: ["甲交付", "乙交付", "丙交付"] };
  expect(
    newQuestionPolicy("generate", ["前两份需要生成同题多答案"], three),
  ).toBe("distinct-v1");
  expect(
    newQuestionPolicy("generate", ["全部交付需要生成同题多答案"], three),
  ).toBe("variants-v1");
  expect(
    newQuestionPolicy(
      "generate",
      ["全部交付需要生成同题多答案", "甲交付不需要生成同题多答案"],
      three,
    ),
  ).toBe("variants-v1");
  expect(
    newQuestionPolicy("generate", ["其中两份需要生成同题多答案"], two),
  ).toBe("distinct-v1");
});
