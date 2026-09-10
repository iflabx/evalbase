import { describe, expect, it } from "vitest";

import {
  isValidCaseMetadata,
  validateFormalItems,
} from "../../src/schema/formal.js";

describe("Formal Schema public module", () => {
  const inputSchema = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  };

  it("validates both input and expected output with Draft 2020-12", () => {
    expect(
      validateFormalItems(inputSchema, { type: "string" }, [
        { input: { message: "hello" }, expected_output: "world" },
      ]),
    ).toEqual({ valid: true, errors: [] });

    expect(
      validateFormalItems(inputSchema, { type: "integer" }, [
        { input: { message: 4 }, expected_output: "not-an-integer" },
      ]),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          target: "input",
          keyword: "type",
          instancePath: "/message",
        }),
        expect.objectContaining({
          target: "expected_output",
          keyword: "type",
          instancePath: "/",
        }),
      ]),
    });
  });

  it("rejects remote references instead of resolving over the network", () => {
    expect(() =>
      validateFormalItems(
        { $ref: "https://example.invalid/schema.json" },
        { type: "string" },
        [],
      ),
    ).toThrow("Remote Formal Schema references");
  });

  it("accepts only public business metadata envelopes", () => {
    expect(isValidCaseMetadata({ source: "synthetic" })).toBe(true);
    expect(isValidCaseMetadata([])).toBe(false);
    expect(isValidCaseMetadata({ _agentbench: { caseId: "reserved" } })).toBe(
      false,
    );
  });

  it("rejects keywords and shapes outside the reviewed tracer subset", () => {
    expect(() =>
      validateFormalItems(
        { type: "string", pattern: "(a+)+$" },
        { type: "string" },
        [],
      ),
    ).toThrow("unsupported keyword: pattern");

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 10; index += 1)
      nested = { type: "object", properties: { child: nested } };
    expect(() => validateFormalItems(nested, { type: "string" }, [])).toThrow(
      "nesting limit",
    );
  });
});
