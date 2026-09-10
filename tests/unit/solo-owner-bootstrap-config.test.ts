import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";

describe("Ticket 18 solo Owner bootstrap configuration", () => {
  it("requires an explicit non-production environment and opt-in", () => {
    expect(loadConfig({}).soloOwnerMode).toBe(false);
    expect(loadConfig({ NODE_ENV: "development" }).soloOwnerMode).toBe(false);
    expect(
      loadConfig({ NODE_ENV: "development", SOLO_OWNER_MODE: "true" })
        .soloOwnerMode,
    ).toBe(true);
    expect(
      loadConfig({ NODE_ENV: "production", SOLO_OWNER_MODE: "true" })
        .soloOwnerMode,
    ).toBe(false);
  });

  it("stays disabled when the opt-in is false", () => {
    expect(
      loadConfig({ NODE_ENV: "development", SOLO_OWNER_MODE: "false" })
        .soloOwnerMode,
    ).toBe(false);
  });
});
