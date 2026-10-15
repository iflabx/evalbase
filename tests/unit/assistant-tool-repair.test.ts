import { describe, expect, it } from "vitest";
import { sameRepairMeaning } from "../../src/assistant/tool-repair.js";

const schema = {
  type: "object",
  properties: {
    targetCount: { type: "integer" },
    instructions: { type: "string" },
    allowedFields: { type: "array", items: { type: "string" } },
    source: { type: "object", properties: { id: { type: "string" } } },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { enum: ["read_records"] },
          input: { type: "object", properties: { limit: { type: "integer" } } },
        },
      },
    },
  },
};

describe("argument repair meaning guard", () => {
  it("accepts only lossless wrappers, numeric types and the known spelling alias", () => {
    expect(
      sameRepairMeaning(
        {
          targetCount: "50",
          instruction: ["保留原意"],
          allowedFields: "question",
          steps: { action: "read_records", input: { limit: "2" } },
        },
        {
          targetCount: 50,
          instructions: "保留原意",
          allowedFields: ["question"],
          steps: [{ action: "read_records", input: { limit: 2 } }],
        },
        schema,
      ),
    ).toBe(true);
  });
  it.each([
    [{ targetCount: "50" }, { targetCount: 51 }],
    [{ source: { id: "original" } }, { source: { id: "another" } }],
    [
      { allowedFields: "question" },
      { allowedFields: ["question", "metadata"] },
    ],
    [{ instructions: ["保留原意"] }, { instructions: "删除原要求" }],
    [{ targetCount: "50" }, { targetCount: 50, allRecords: true }],
    [
      { targetCount: "50", unsupportedRequirement: "只修改前两条" },
      { targetCount: 50 },
    ],
    [{ targetCount: "9007199254740993" }, { targetCount: 9007199254740992 }],
  ])("rejects changes or discarded information: %j", (before, after) => {
    expect(sameRepairMeaning(before, after, schema)).toBe(false);
  });
  it("resolves the action branch even when every variant shares the same scope enum", () => {
    const step = {
      type: "object",
      oneOf: ["query_project", "submit_processing"].map((action) => ({
        type: "object",
        properties: {
          action: { enum: [action] },
          scope: { enum: ["all", "preview"] },
          input: {
            type: "object",
            properties:
              action === "submit_processing"
                ? { instructions: { type: "string" } }
                : {},
          },
        },
      })),
    };
    expect(
      sameRepairMeaning(
        {
          action: "submit_processing",
          scope: "all",
          input: { instruction: "保留原意" },
        },
        {
          action: "submit_processing",
          scope: "all",
          input: { instructions: "保留原意" },
        },
        step,
      ),
    ).toBe(true);
  });
});
