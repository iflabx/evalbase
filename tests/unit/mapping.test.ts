import { describe, expect, it } from "vitest";

import {
  mappedSourceFields,
  replayMapping,
  sourceLeafPaths,
  sourcePathIsMapped,
  suggestFormalSchema,
} from "../../src/mapping/index.js";

describe("Mapping public module", () => {
  it("uses RFC 6901 leaf paths for nested unmapped-field confirmation", () => {
    const mapping = { input: { source: "/profile/name" } };
    expect(mappedSourceFields(mapping)).toEqual(["/profile/name"]);
    expect(
      sourceLeafPaths({ profile: { name: "owner", locale: "zh-CN" } }),
    ).toEqual(["/profile/locale", "/profile/name"]);
  });

  it("covers descendants when a container is mapped and enumerates arrays", () => {
    expect(
      sourceLeafPaths({ profile: { name: "A" }, tags: ["x", "y"], empty: {} }),
    ).toEqual(["/empty", "/profile/name", "/tags/0", "/tags/1"]);
    expect(sourcePathIsMapped("/profile/name", new Set(["/profile"]))).toBe(
      true,
    );
    expect(sourcePathIsMapped("/profiled/name", new Set(["/profile"]))).toBe(
      false,
    );
  });

  it("replays explicit nested fields, constants, and basic type interpretation", () => {
    expect(
      replayMapping(
        { question: "Refund?", answer: "Yes", priority: "2" },
        {
          input: {
            object: {
              message: { source: "/question" },
              context: {
                object: {
                  priority: { source: "/priority", interpretAs: "integer" },
                },
              },
            },
          },
          expectedOutput: { source: "/answer" },
          metadata: { object: { source: { constant: "synthetic" } } },
        },
      ),
    ).toEqual({
      item: {
        input: { message: "Refund?", context: { priority: 2 } },
        expected_output: "Yes",
        metadata: { source: "synthetic" },
      },
      errors: [],
    });
  });

  it("returns stable target errors without reading missing source values", () => {
    expect(
      replayMapping({ answer: "Yes" }, { input: { source: "/question" } }),
    ).toMatchObject({
      errors: [
        { target: "input", path: "/input", code: "mapping_source_missing" },
      ],
    });
  });

  it("rejects reserved metadata and malformed mapping shapes", () => {
    expect(
      replayMapping(
        { question: "Refund?" },
        {
          input: { source: "/question" },
          metadata: { object: { _agentbench: { constant: true } } },
        },
      ),
    ).toMatchObject({ errors: [{ code: "mapping_metadata_invalid" }] });
  });

  it("suggests a schema only from all mapped items without confirming it", () => {
    expect(
      suggestFormalSchema([
        {
          input: { message: "one", nested: { count: 1 } },
          expected_output: null,
        },
        {
          input: { message: "two", nested: { count: 2 } },
          expected_output: null,
        },
      ]),
    ).toEqual({
      input: {
        type: "object",
        properties: {
          message: { type: "string" },
          nested: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        },
        required: ["message", "nested"],
      },
      expectedOutput: {},
    });
  });
});
