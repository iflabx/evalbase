import { describe, expect, it } from "vitest";
import {
  cleanRecords,
  validateModelRows,
  processingOptions,
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
