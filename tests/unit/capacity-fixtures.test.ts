import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CAPACITY_BOUNDARY_FIXTURES,
  buildCapacityFixture,
} from "../fixtures/capacity-boundaries.js";

describe("capacity boundary fixtures", () => {
  it("matches the versioned independent fixture manifest", () => {
    for (const fixture of Object.values(CAPACITY_BOUNDARY_FIXTURES)) {
      const generated = buildCapacityFixture(fixture.id);
      expect(generated.bytes.byteLength).toBe(fixture.bytes);
      expect(generated.recordCount).toBe(fixture.recordCount);
      expect(createHash("sha256").update(generated.bytes).digest("hex")).toBe(
        fixture.sha256,
      );
    }
  });
});
