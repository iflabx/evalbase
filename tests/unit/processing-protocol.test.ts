import { describe, expect, it } from "vitest";
import {
  cleanRecords,
  validateModelRows,
  processingOptions,
  processingPrompt,
} from "../../src/processing/protocol.js";

const inputs = [
  {
    id: "row-a",
    question: "  Question A  ",
    expectedOutput: "Gold A",
    metadata: [{ key: "kind", value: "" }],
  },
  {
    id: "row-b",
    question: "Question B",
    expectedOutput: "Gold B",
    metadata: [],
  },
];
describe("model processing output boundary", () => {
  it("OPT29 writes expected behavior as criteria rather than invented performed actions", () => {
    const prompt = processingPrompt(
      [],
      processingOptions({
        operation: "generate",
        instructions: "按文档生成",
        outputCount: 5,
        allowedFields: ["question", "expectedOutput", "metadata"],
      }),
      5,
    );
    expect(prompt.system).toContain(
      "expectedOutput describes evaluation criteria",
    );
    expect(prompt.system).toContain(
      "Never assert that contact, queries, feedback, refunds or other external actions have already happened",
    );
  });
  it("adds only authorized classification keys without relabeling sources to satisfy quotas", () => {
    const options = processingOptions({
      operation: "rewrite",
      instructions: "按问题真实含义分类",
      allowedFields: ["metadata"],
      metadataKeys: ["riskCode"],
    });
    const original = {
      ...inputs[0]!,
      metadata: [{ key: "subject", value: "原标签" }],
    };
    const result = validateModelRows(
      {
        records: [
          {
            sourceId: original.id,
            question: "伪造题目",
            expectedOutput: "伪造标签",
            metadata: [
              { key: "subject", value: "改坏的原标签" },
              { key: "riskCode", value: "A.2.a" },
              { key: "extra", value: "非授权字段" },
            ],
          },
        ],
      },
      [original],
      options,
      1,
    );
    expect(result.records[0]).toEqual({
      sourceId: original.id,
      question: original.question,
      expectedOutput: original.expectedOutput,
      metadata: [...original.metadata, { key: "riskCode", value: "A.2.a" }],
    });
    const prompt = JSON.parse(
      processingPrompt(
        [original],
        options,
        1,
        {
          requirements: [],
          documents: [],
          classifications: [
            {
              field: "metadata",
              key: "riskCode",
              quotas: [{ value: "A.1.a", count: 1 }],
            },
          ],
        },
        { offset: 0, total: 1 },
      ).prompt,
    );
    expect(prompt.metadataKeys).toEqual(["riskCode"]);
    expect(prompt.batchQuotas).toBeUndefined();
    expect(prompt.background.classifications[0].quotas).toBeUndefined();
    const compact = processingPrompt(
      [original],
      options,
      1,
      undefined,
      undefined,
      true,
    );
    expect(compact.system).toContain("Each record has sourceId and metadata");
    expect(
      validateModelRows(
        {
          records: [
            {
              sourceId: original.id,
              metadata: [{ key: "riskCode", value: "A.2.a" }],
            },
          ],
        },
        [original],
        options,
        1,
      ).records,
    ).toEqual(result.records);
    expect(processingPrompt([original], options, 1).system).toContain(
      "question (string)",
    );
    const oldOptions = processingOptions({
      operation: "rewrite",
      instructions: "按已确认配额整理",
      allowedFields: ["metadata"],
    });
    expect(
      JSON.parse(
        processingPrompt(
          [original],
          oldOptions,
          1,
          {
            requirements: [],
            documents: [],
            classifications: [
              {
                field: "metadata",
                key: "riskCode",
                quotas: [{ value: "A.1.a", count: 1 }],
              },
            ],
          },
          { offset: 0, total: 1 },
        ).prompt,
      ).batchQuotas,
    ).toHaveLength(1);
    expect(() =>
      processingOptions({ ...options, allowedFields: ["question"] }),
    ).toThrow("processing_configuration_invalid");
  });
  it("sends only mapped record data and exact candidate ids in the new wire recipe", () => {
    const row = {
      ...inputs[0]!,
      id: "candidate:0:0",
      raw: { question: "raw data" },
      baseline: { id: "original-row", question: "old question" },
      candidateOrigin: { runId: "old-run", resultId: "0:0" },
      source: { assetId: "old-asset" },
      revisions: { question: 3 },
    };
    const options = processingOptions({
      operation: "rewrite",
      instructions: "修正题目",
      allowedFields: ["question"],
    });
    const current = processingPrompt(
      [row],
      options,
      1,
      undefined,
      undefined,
      true,
    );
    expect(JSON.parse(current.prompt).records).toEqual([
      {
        id: row.id,
        question: row.question,
        expectedOutput: row.expectedOutput,
        metadata: row.metadata,
        raw: row.raw,
      },
    ]);
    expect(current.system).toContain("records[*].id");
    const legacy = processingPrompt([row], options, 1);
    expect(JSON.parse(legacy.prompt).records).toEqual([row]);
  });
  it("scopes confirmed quotas to each batch and subtracts accepted corrections", () => {
    const background = {
      requirements: [],
      documents: [],
      classifications: [
        {
          field: "metadata" as const,
          key: "类别",
          quotas: [
            { value: "生成内容", count: 100 },
            { value: "应拒答", count: 50 },
            { value: "非拒答", count: 50 },
          ],
        },
      ],
    };
    const options = processingOptions({
      operation: "rewrite",
      instructions: "改写为对应类别的完整题目",
      allowedFields: ["question", "expectedOutput", "metadata"],
    });
    const totals = new Map<string, number>();
    for (let offset = 0; offset < 200; offset += 20) {
      const prompt = JSON.parse(
        processingPrompt(inputs, options, 20, background, {
          offset,
          total: 200,
        }).prompt,
      );
      for (const quota of prompt.batchQuotas[0].quotas)
        totals.set(quota.value, (totals.get(quota.value) ?? 0) + quota.count);
    }
    expect(Object.fromEntries(totals)).toEqual({
      生成内容: 100,
      应拒答: 50,
      非拒答: 50,
    });
    const retry = JSON.parse(
      processingPrompt(inputs, options, 19, background, {
        offset: 0,
        total: 200,
        originalCount: 20,
        accepted: [
          {
            sourceId: "row-a",
            question: "已保留",
            expectedOutput: "标准",
            metadata: [{ key: "类别", value: "生成内容" }],
          },
        ],
      }).prompt,
    );
    expect(
      retry.batchQuotas[0].quotas.reduce((n: number, q: any) => n + q.count, 0),
    ).toBe(19);
    const accepted = {
      sourceId: "row-a",
      question: "已保留",
      expectedOutput: "标准",
      metadata: [{ key: "类别", value: "范围外" }],
    };
    expect(
      JSON.parse(
        processingPrompt(inputs, options, 19, background, {
          offset: 0,
          total: 200,
          originalCount: 20,
          accepted: [accepted],
        }).prompt,
      ).batchQuotas,
    ).toBeUndefined();
    expect(
      JSON.parse(
        processingPrompt(inputs, options, 12, background, {
          offset: 0,
          total: 200,
          originalCount: 20,
          accepted: Array.from({ length: 8 }, (_, i) => ({
            ...accepted,
            sourceId: `row-${i}`,
            metadata: [{ key: "类别", value: "生成内容" }],
          })),
        }).prompt,
      ).batchQuotas,
    ).toBeUndefined();
    expect(
      JSON.parse(
        processingPrompt(
          inputs,
          { ...options, allowedFields: ["question"] },
          20,
          background,
          { offset: 0, total: 200 },
        ).prompt,
      ).batchQuotas,
    ).toBeUndefined();
    expect(
      JSON.parse(
        processingPrompt(inputs, options, 20, background, {
          offset: 0,
          total: 100,
        }).prompt,
      ).batchQuotas,
    ).toBeUndefined();
    expect(
      JSON.parse(processingPrompt(inputs, options, 20, background).prompt)
        .batchQuotas,
    ).toBeUndefined();
  });
  it("preserves protected fields and reports missing, duplicate, foreign and excess output", () => {
    const options = processingOptions({
      operation: "rewrite",
      instructions: "Rephrase",
      allowedFields: ["question"],
    });
    const output = validateModelRows(
      {
        records: [
          {
            sourceId: "row-a",
            question: "Rephrased A",
            expectedOutput: "Forged",
            metadata: [{ key: "forged", value: "x" }],
          },
          { sourceId: "row-a", question: "Second answer" },
          { sourceId: "foreign", question: "Unrelated" },
        ],
      },
      inputs,
      options,
      2,
    );
    expect(output.records).toEqual([
      {
        sourceId: "row-a",
        question: "Rephrased A",
        expectedOutput: "Gold A",
        metadata: [{ key: "kind", value: "" }],
      },
    ]);
    expect(output.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duplicate_source",
        "unknown_source",
        "missing_output",
      ]),
    );
    const expand = processingOptions({
      operation: "augment",
      instructions: "Add variants",
      allowedFields: ["question"],
      outputCount: 1,
    });
    expect(
      validateModelRows(
        {
          records: [
            { sourceId: "row-a", question: "Variant 1" },
            { sourceId: "row-b", question: "Variant 2" },
          ],
        },
        inputs,
        expand,
        1,
      ).issues,
    ).toContainEqual({ code: "excess_output", count: 1 });
    expect(() =>
      validateModelRows({ records: "not rows" }, inputs, options, 2),
    ).toThrow("model_output_invalid");
    expect(() =>
      processingOptions({ operation: ["rewrite"], instructions: "bad enum" }),
    ).toThrow("processing_configuration_invalid");
  });
  it("cleans permitted fields deterministically without deleting duplicate sources or empty metadata", () => {
    const options = processingOptions({
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
    });
    const result = cleanRecords(
      [
        ...inputs,
        { ...inputs[0]!, id: "row-c" },
        { ...inputs[0]!, id: "row-d", question: "  " },
      ],
      options,
    );
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toEqual({
      sourceId: "row-a",
      question: "Question A",
      expectedOutput: "Gold A",
      metadata: [{ key: "kind", value: "" }],
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { code: "duplicate_content", sourceId: "row-c" },
        { code: "empty_question", sourceId: "row-d" },
      ]),
    );
    expect(inputs[0]!.question).toBe("  Question A  ");
  });
});

describe("OPT29 document generation boundary", () => {
  it("validates three fields without invented input IDs and assigns stable server identities", () => {
    const options = processingOptions({
      operation: "generate",
      instructions: "按背景生成自然问法",
      allowedFields: ["question", "expectedOutput", "metadata"],
      outputCount: 2,
    });
    const value = {
      records: [
        {
          question: "如何辨认可疑链接？",
          expectedOutput: "说明核验来源的方法",
          metadata: [{ key: "risk", value: "A.1.a" }],
        },
        {
          question: "怎样确认这则消息可靠？",
          expectedOutput: "建议交叉核验",
          metadata: [],
        },
      ],
    };
    const result = validateModelRows(value, [], options, 2);
    expect(result.records.map((r) => r.sourceId)).toEqual([
      "generated:0",
      "generated:1",
    ]);
    expect(validateModelRows(value, [], options, 2)).toEqual(result);
    expect(result.issues).toEqual([]);
    expect(
      validateModelRows(
        { records: [{ ...value.records[0], sourceId: "made-up" }] },
        [],
        options,
        1,
      ).records,
    ).toEqual([]);
    expect(processingPrompt([], options, 2).system).not.toContain(
      "sourceId must reference",
    );
    expect(JSON.parse(processingPrompt([], options, 2).prompt).rule).toContain(
      "background",
    );
  });
  it("rejects record inheritance and incomplete generation configuration", () => {
    for (const change of [
      { outputCount: undefined },
      { allowedFields: ["question"] },
    ])
      expect(() =>
        processingOptions({
          operation: "generate",
          instructions: "按文档生成",
          allowedFields: ["question", "expectedOutput", "metadata"],
          outputCount: 1,
          ...change,
        }),
      ).toThrow();
  });
});
