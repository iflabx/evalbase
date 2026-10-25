import { describe, it, expect } from "vitest";
import {
  cleanRecords,
  processingOptions,
} from "../../src/processing/protocol.js";
describe("explicit whitespace preservation", () => {
  it("preserves all line breaks, internal spacing and protected fields", () => {
    const input = {
      id: "r",
      question: " \r\n内部  空格\n末行\r\n ",
      expectedOutput: " 原值 ",
      metadata: [{ key: "k", value: " v " }],
    };
    const options = processingOptions({
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
      cleanWhitespace: "preserve_newlines",
    });
    expect(cleanRecords([input], options).records[0]).toEqual({
      ...input,
      id: undefined,
      sourceId: "r",
      question: "\r\n内部  空格\n末行\r\n",
    });
  });
  it("keeps legacy default and rejects mixing a deterministic policy with model processing", () => {
    expect(
      cleanRecords(
        [
          {
            id: "r",
            question: " \n问题\n ",
            expectedOutput: "x",
            metadata: [],
          },
        ],
        { operation: "clean", instructions: "", allowedFields: ["question"] },
      ).records[0].question,
    ).toBe("问题");
    expect(() =>
      processingOptions({
        operation: "rewrite",
        instructions: "改写",
        allowedFields: ["question"],
        cleanWhitespace: "trim_edges",
      }),
    ).toThrow();
  });
});
