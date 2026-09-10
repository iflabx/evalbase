import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/security/password.js";

describe("non-production Owner password storage", () => {
  it("stores a salted scrypt result rather than the credential", async () => {
    const encoded = await hashPassword("owner-test-password");
    expect(encoded).not.toContain("owner-test-password");
    expect(await verifyPassword("owner-test-password", encoded)).toBe(true);
    expect(await verifyPassword("wrong", encoded)).toBe(false);
  });
});
