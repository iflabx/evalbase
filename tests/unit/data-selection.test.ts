import { describe, expect, it } from "vitest";

import { selectRecords } from "../../src/selection/index.js";

const records = [
  {
    assetId: "a",
    ordinal: 0,
    question: "  HELLO World  ",
    expectedOutput: " Answer ",
    metadata: [{ key: "kind", value: " SAFE " }],
  },
  {
    assetId: "a",
    ordinal: 1,
    question: "hello there",
    expectedOutput: "answer",
    metadata: [{ key: "kind", value: "other" }],
  },
  {
    assetId: "b",
    ordinal: 0,
    question: "hello",
    expectedOutput: "answer",
    metadata: [],
  },
];

describe("data selection", () => {
  it("samples reproducibly with bounded counts and floored percentages", () => {
    const config = {
      conditions: [],
      method: "random",
      mode: "count",
      value: 2,
      seed: "evalbase-2026",
    };
    const selected = selectRecords(records, config);
    expect(selected.selected).toHaveLength(2);
    // SHA-256 ranks a:1, a:0, b:0 for this seed; display order remains a:0, a:1.
    expect(
      selected.selected.map(({ assetId, ordinal }) => [assetId, ordinal]),
    ).toEqual([
      ["a", 0],
      ["a", 1],
    ]);
    expect(selectRecords([...records].reverse(), config).selected).toEqual(
      selected.selected,
    );
    expect(
      selectRecords(records, { ...config, value: 500 }).selected,
    ).toHaveLength(3);
    expect(
      selectRecords(records, { ...config, mode: "percent", value: 5 }).selected,
    ).toHaveLength(0);
    expect(
      selectRecords(records, { ...config, mode: "percent", value: 50 })
        .selected,
    ).toHaveLength(1);
    expect(selectRecords(records, { ...config, seed: "" }).seed).toBeTruthy();
    for (const overrides of [
      { value: 0 },
      { value: 1.5 },
      { mode: "percent", value: 101 },
      { mode: "invalid" },
    ]) {
      expect(() => selectRecords(records, { ...config, ...overrides })).toThrow(
        "selection_invalid",
      );
    }
  });
  it("combines visible-field conditions and treats missing metadata as empty", () => {
    const result = selectRecords(records, {
      conditions: [
        { field: "question", operator: "contains", value: " HELLO " },
        { field: "metadata", key: "kind", operator: "equals", value: "safe" },
      ],
      method: "all",
    });
    expect(
      result.candidates.map(({ assetId, ordinal }) => [assetId, ordinal]),
    ).toEqual([["a", 0]]);
    expect(result.selected).toEqual(result.candidates);
    expect(
      selectRecords(records, {
        conditions: [{ field: "metadata", key: "kind", operator: "empty" }],
        method: "all",
      }).selected.map(({ assetId }) => assetId),
    ).toEqual(["b"]);
    expect(() =>
      selectRecords(records, {
        conditions: [{ field: "question", operator: "script", value: "x" }],
        method: "all",
      }),
    ).toThrow("selection_invalid");
    expect(() =>
      selectRecords(records, {
        conditions: [{ field: "question", operator: "contains", value: "  " }],
        method: "all",
      }),
    ).toThrow("selection_invalid");
  });
  it("rejects malformed optional condition values instead of failing at runtime", () => {
    expect(() =>
      selectRecords(records, {
        method: "all",
        conditions: [{ field: "question", operator: "empty", value: 3 }],
      }),
    ).toThrow("selection_invalid");
    for (const configuration of [
      { method: ["random"], conditions: [], value: 1 },
      { method: "random", mode: ["count"], value: 1, conditions: [] },
      {
        method: "all",
        conditions: [{ field: ["metadata"], key: "kind", operator: "empty" }],
      },
      {
        method: "all",
        conditions: [{ field: "question", operator: ["empty"] }],
      },
    ])
      expect(() => selectRecords(records, configuration)).toThrow(
        "selection_invalid",
      );
  });
});
