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
