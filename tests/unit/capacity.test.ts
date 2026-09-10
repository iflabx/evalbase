import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAPACITY_LIMITS } from "../../src/capacity.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/capacity-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("Capacity contract v1", () => {
  it("freezes the decimal Phase 1A boundaries and G-02 input cap", () => {
    const { schemaVersion, ...limits } = contract;
    expect(schemaVersion).toBe("capacity-contract-v1");
    expect(CAPACITY_LIMITS).toEqual(limits);
  });
});
