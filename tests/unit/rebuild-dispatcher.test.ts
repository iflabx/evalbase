import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDispatcher } from "../../src/assistant-rebuild/session-dispatcher.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe("formal dispatch process lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["recover", "wake", "pending"])(
    "starts one timer and fences close during %s",
    async (phase) => {
      vi.useFakeTimers();
      const gate = deferred(),
        entered = deferred();
      const execution = {
        recoverConfirmations: vi.fn(async () => {
          if (phase === "recover") {
            entered.resolve();
            await gate.promise;
          }
        }),
        wake: vi.fn(async () => {
          if (phase === "wake") {
            entered.resolve();
            await gate.promise;
          }
        }),
        pending: vi.fn(async () => {
          if (phase === "pending") {
            entered.resolve();
            await gate.promise;
          }
          return [
            {
              id: "turn",
              session_id: "session",
              actor_id: "actor",
              project_id: "project",
            },
          ];
        }),
      };
      const run = vi.fn(async () => {});
      const dispatcher = new SessionDispatcher(execution, run);
      dispatcher.start();
      dispatcher.start();
      expect(vi.getTimerCount()).toBe(1);
      const a = dispatcher.dispatch(),
        b = dispatcher.dispatch();
      expect(a).toBe(b);
      await entered.promise;
      const closed = dispatcher.close();
      gate.resolve();
      await Promise.all([a, closed]);
      dispatcher.start();
      await dispatcher.dispatch();
      expect(vi.getTimerCount()).toBe(0);
      expect(execution.recoverConfirmations).toHaveBeenCalledTimes(1);
      expect(execution.wake).toHaveBeenCalledTimes(phase === "recover" ? 0 : 1);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("logs a safe dispatch failure and can retry the scan", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const execution = {
      recoverConfirmations: vi
        .fn()
        .mockRejectedValueOnce(Error("private-key and model text"))
        .mockResolvedValue(undefined),
      wake: vi.fn(async () => {}),
      pending: vi.fn(async () => []),
    };
    const dispatcher = new SessionDispatcher(
      execution,
      vi.fn(async () => {}),
    );
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-key");
    expect(log).toHaveBeenCalledWith("assistant_dispatch_failed", {
      phase: "recover_confirmations",
      code: "dispatch_scan_failed",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(execution.pending).toHaveBeenCalledTimes(1);
    await dispatcher.close();
  });
});
