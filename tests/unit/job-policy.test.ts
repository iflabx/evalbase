import { describe, expect, it } from "vitest";

import { jobRetrySchedule, loadConfig } from "../../src/config.js";

describe("Ticket 09 job policy configuration", () => {
  it("freezes bounded defaults and an orphan grace longer than retry and lease windows", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      jobMaxAttempts: 3,
      jobClaimDelayMs: 250,
      jobInitialBackoffMs: 1_000,
      jobBackoffMultiplier: 4,
      jobLeaseDurationMs: 30_000,
      jobHeartbeatIntervalMs: 10_000,
      jobOrphanGraceMs: 120_000,
      orphanScanCadenceMs: 3_600_000,
    });

    const retryWindowMs = Array.from(
      { length: config.jobMaxAttempts - 1 },
      (_, attempt) =>
        config.jobInitialBackoffMs * config.jobBackoffMultiplier ** attempt,
    ).reduce((total, delay) => total + delay, 0);
    expect(config.jobOrphanGraceMs).toBeGreaterThan(
      config.jobLeaseDurationMs + config.jobClaimDelayMs + retryWindowMs,
    );
  });

  it("rejects a non-finite backoff multiplier", () => {
    expect(() => loadConfig({ JOB_BACKOFF_MULTIPLIER: "NaN" })).toThrow(
      RangeError,
    );
  });

  it("rejects invalid Worker health and consistency scan settings", () => {
    expect(() => loadConfig({ WORKER_HEALTH_PORT: "not-a-port" })).toThrow(
      RangeError,
    );
    expect(() => loadConfig({ WORKER_HEALTH_PORT: "65536" })).toThrow(
      RangeError,
    );
    expect(() => loadConfig({ CONSISTENCY_SCAN_CADENCE_MS: "0" })).toThrow(
      RangeError,
    );
    expect(() => loadConfig({ CONSISTENCY_SCAN_CADENCE_MS: "NaN" })).toThrow(
      RangeError,
    );
  });

  it("uses a controlled Clock for the bounded retry schedule", () => {
    const config = loadConfig({
      JOB_MAX_ATTEMPTS: "5",
      JOB_INITIAL_BACKOFF_MS: "100",
      JOB_BACKOFF_MULTIPLIER: "3",
    });

    expect(jobRetrySchedule(config, 10_000)).toEqual([
      10_100, 10_400, 11_300, 14_000,
    ]);
  });
});
