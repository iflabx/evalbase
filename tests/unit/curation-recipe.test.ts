import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evaluateRecipe, validateRecipe } from "../../src/recipe/index.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/curation-recipe-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("Curation Recipe public contract", () => {
  for (const fixture of contract.cases) {
    it(`applies ${fixture.name}`, () => {
      expect(contract.contractVersion).toBe("curation-recipe-contract-v1");
      validateRecipe(fixture.steps);
      const first = evaluateRecipe(contract.records, fixture.steps);
      const second = evaluateRecipe(contract.records, fixture.steps);

      expect(first.records.map((record) => record.id)).toEqual(
        fixture.expected.recordIds,
      );
      expect(first.records).toEqual(second.records);
      expect(first.steps).toEqual(fixture.expected.steps);
      if (fixture.expected.exits)
        expect(first.exits).toEqual(fixture.expected.exits);
    });
  }

  it.each([
    [{ kind: "filter", filter: { field: "/kind", operator: "script" } }],
    [{ kind: "filter", filter: { all: "not-an-array" } }],
    [{ kind: "sample", mode: "ratio", value: 2, seed: "fixture" }],
    [{ kind: "manual", include: [{ id: "" }] }],
  ])("rejects an invalid recipe shape", (steps) => {
    expect(() => validateRecipe(steps)).toThrow("recipe_invalid");
  });
});
