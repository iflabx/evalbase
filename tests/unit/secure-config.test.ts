import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { configEnv } from "../support/config-env.js";

describe("explicit deployment credentials", () => {
  it.each(["DATABASE_URL", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"])(
    "rejects missing, empty and whitespace-only %s without echoing values",
    (name) => {
      for (const value of [undefined, "", "   "]) {
        expect(() => loadConfig({ ...configEnv, [name]: value })).toThrow(
          `Missing required configuration: ${name}`,
        );
      }
    },
  );

  it("has no default test identities or login passwords", () => {
    const config = loadConfig({ ...configEnv, OWNER_PASSWORD: undefined });
    expect(config).toMatchObject({
      soloOwnerMode: false,
      allowTestIdentity: false,
      ownerPassword: "",
      editorPassword: "",
      viewerPassword: "",
    });
  });

  it.each([undefined, "production", "staging"])(
    "rejects test identities outside an explicitly local/test environment (%s)",
    (NODE_ENV) => {
      expect(() =>
        loadConfig({ ...configEnv, NODE_ENV, ALLOW_TEST_IDENTITY: "true" }),
      ).toThrow("Test identities require NODE_ENV=development or test");
    },
  );

  it("requires all explicitly enabled test credentials", () => {
    const env = { ...configEnv, NODE_ENV: "test", ALLOW_TEST_IDENTITY: "true" };
    expect(() => loadConfig({ ...env, OWNER_PASSWORD: "" })).toThrow(
      "OWNER_PASSWORD",
    );
    expect(() => loadConfig(env)).toThrow("EDITOR_PASSWORD");
    expect(() =>
      loadConfig({ ...env, EDITOR_PASSWORD: "unit-editor-only" }),
    ).toThrow("VIEWER_PASSWORD");
    expect(
      loadConfig({
        ...env,
        EDITOR_PASSWORD: "unit-editor-only",
        VIEWER_PASSWORD: "unit-viewer-only",
      }).allowTestIdentity,
    ).toBe(true);
  });

  it("requires the local solo-owner credential but does not activate it in production", () => {
    expect(() =>
      loadConfig({
        ...configEnv,
        NODE_ENV: "development",
        SOLO_OWNER_MODE: "true",
        OWNER_PASSWORD: "",
      }),
    ).toThrow("OWNER_PASSWORD");
    expect(
      loadConfig({
        ...configEnv,
        NODE_ENV: "production",
        SOLO_OWNER_MODE: "true",
        OWNER_PASSWORD: undefined,
      }).soloOwnerMode,
    ).toBe(false);
  });

  it("uses supplied credentials unchanged and omits them from validation errors", () => {
    const env = {
      ...configEnv,
      NODE_ENV: "production",
      MINIO_SECRET_KEY: "synthetic-test-secret-not-for-deployment",
    };
    expect(loadConfig(env).minio.secretKey).toBe(env.MINIO_SECRET_KEY);
    try {
      loadConfig({ ...env, DATABASE_URL: "" });
      expect.fail("missing database configuration must be rejected");
    } catch (error) {
      expect(String(error)).not.toContain(env.MINIO_SECRET_KEY);
    }
  });
});
