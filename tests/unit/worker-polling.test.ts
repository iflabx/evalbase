import { expect, it } from "vitest";
import { loadConfig, workerIdleDelayMs } from "../../src/config.js";

it("bounds idle polling to one second and returns to the initial delay after work", () => {
  expect([0, 1, 2, 3, 4, 5, 100_000].map(workerIdleDelayMs)).toEqual([
    50, 100, 200, 400, 800, 1000, 1000,
  ]);
  expect(workerIdleDelayMs(0)).toBe(50);
});
it("keeps orphan grace beyond retry, lease and maximum idle polling windows", () => {
  expect(() =>
    loadConfig({
      JOB_MAX_ATTEMPTS: "1",
      JOB_LEASE_DURATION_MS: "1000",
      JOB_HEARTBEAT_INTERVAL_MS: "1000",
      JOB_CLAIM_DELAY_MS: "0",
      JOB_ORPHAN_GRACE_MS: "1500",
    }),
  ).toThrow(RangeError);
});
