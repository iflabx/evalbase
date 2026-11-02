import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(script: string, overrides: NodeJS.ProcessEnv = {}, input = "{}") {
  const env = { ...process.env, ...overrides };
  // These tests must fail at local preflight, before a request or database write.
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    env,
    input,
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("private setup input preflight", () => {
  it.each([undefined, "", "  "])(
    "rejects absent admin credentials (%s)",
    (password) => {
      const result = run("scripts/seed-architecture-checkpoint.mjs", {
        ARCHITECTURE_CHECKPOINT_URL: "http://127.0.0.1:4217",
        ARCHITECTURE_ADMIN_PASSWORD: password,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Set ARCHITECTURE_ADMIN_PASSWORD");
      expect(result.stderr).not.toContain("fetch failed");
    },
  );

  it("requires the editor credential before accessing a server", () => {
    const result = run("scripts/seed-architecture-checkpoint.mjs", {
      ARCHITECTURE_CHECKPOINT_URL: "http://127.0.0.1:4217",
      ARCHITECTURE_ADMIN_PASSWORD: "synthetic-input-only",
      ARCHITECTURE_EDITOR_PASSWORD: "",
    });
    expect(result.stderr).toContain("Set ARCHITECTURE_EDITOR_PASSWORD");
    expect(result.stderr).not.toContain("fetch failed");
  });

  it("requires an explicit fixture in a public checkout before installing anything", () => {
    const result = run("scripts/assistant-rebuild/prepare-validation.ts", {
      REBUILD_VALIDATION_SOURCE: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Set REBUILD_VALIDATION_SOURCE");
    expect(result.stderr).not.toContain("fetch failed");
  });

  it("rejects a nonexistent fixture before creating accounts or projects", () => {
    const result = run("scripts/assistant-rebuild/prepare-validation.ts", {
      REBUILD_VALIDATION_SOURCE:
        "tests/fixtures/does-not-exist-public-cleanup.jsonl",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain("fetch failed");
  });
});
