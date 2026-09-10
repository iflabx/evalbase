import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compareFormalSchemaBundles,
  compareFormalSchemas,
  validateFormalItems,
} from "../../src/schema/formal.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/formal-schema-contract-v1.json", import.meta.url),
    "utf8",
  ),
);
const invalid = contract.invalid as Array<{
  name: string;
  schema: object;
  error: string;
}>;
const compatibility = contract.compatibility as Array<{
  from: keyof typeof contract.schemas;
  to: keyof typeof contract.schemas;
  result: "compatible" | "requires_new_test_set";
}>;

describe("Formal Schema G-08 public contract", () => {
  it("validates the frozen Draft 2020-12 subset with local references", () => {
    expect(
      validateFormalItems(
        contract.schemas.baseInput,
        contract.schemas.answer,
        contract.items,
        "gold_required",
      ),
    ).toEqual({ valid: true, errors: [] });
  });

  it("allows an empty expected output only in input_only mode", () => {
    expect(
      validateFormalItems(
        { type: "string" },
        { type: "string" },
        [{ input: "prompt", expected_output: null }],
        "input_only",
      ),
    ).toEqual({ valid: true, errors: [] });
  });

  it.each(invalid)("rejects $name", ({ schema, error }) => {
    expect(() =>
      validateFormalItems(schema, contract.schemas.answer, []),
    ).toThrow(error);
  });

  it.each(compatibility)(
    "returns $result for $from to $to",
    ({ from, to, result }) => {
      expect(
        compareFormalSchemas(contract.schemas[from], contract.schemas[to]),
      ).toBe(result);
    },
  );

  it("keeps destructive mode, reference, item, and new constraints out of an existing Test Set", () => {
    const definitions = {
      text: { type: "string" },
      count: { type: "integer" },
    };
    expect(
      compareFormalSchemas(
        { $defs: definitions, $ref: "#/$defs/text" },
        { $defs: definitions, $ref: "#/$defs/count" },
      ),
    ).toBe("requires_new_test_set");
    expect(
      compareFormalSchemas(
        { type: "array", items: { type: "string" } },
        { type: "array", items: { type: "integer" } },
      ),
    ).toBe("requires_new_test_set");
    expect(
      compareFormalSchemas(
        { type: "string" },
        { type: "string", minLength: 1 },
      ),
    ).toBe("requires_new_test_set");
    expect(
      compareFormalSchemas(
        { $defs: { text: { type: "string" } }, $ref: "#/$defs/text" },
        {
          $defs: { text: { type: "string" } },
          $ref: "#/$defs/text",
          minLength: 1,
        },
      ),
    ).toBe("requires_new_test_set");
    expect(
      compareFormalSchemaBundles(
        { mode: "gold_required", input: {}, expectedOutput: {} },
        { mode: "input_only", input: {}, expectedOutput: {} },
      ),
    ).toBe("requires_new_test_set");
  });

  it("accepts a referenced definition once when it is below the property limit", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [
        `p${index}`,
        { type: "string" },
      ]),
    );
    expect(() =>
      validateFormalItems(
        { $defs: { row: { type: "object", properties } }, $ref: "#/$defs/row" },
        {},
        [],
      ),
    ).not.toThrow();
  });

  it("enforces the frozen byte, depth, property, and keyword limits", () => {
    const nested = (depth: number): object =>
      depth === 0
        ? { type: "string" }
        : { type: "object", properties: { x: nested(depth - 1) } };
    expect(() =>
      validateFormalItems({ note: "x".repeat(33_000) }, {}, []),
    ).toThrow("formal_schema_size_exceeded");
    expect(() => validateFormalItems(nested(9), {}, [])).toThrow(
      "formal_schema_depth_exceeded",
    );
    expect(() =>
      validateFormalItems(
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [
              `p${index}`,
              { type: "string" },
            ]),
          ),
        },
        {},
        [],
      ),
    ).toThrow("formal_schema_property_limit_exceeded");
    expect(() =>
      validateFormalItems(
        {
          type: "object",
          $defs: Object.fromEntries(
            Array.from({ length: 300 }, (_, index) => [
              `d${index}`,
              { type: "string" },
            ]),
          ),
        },
        {},
        [],
      ),
    ).toThrow("formal_schema_keyword_limit_exceeded");
  });
});
