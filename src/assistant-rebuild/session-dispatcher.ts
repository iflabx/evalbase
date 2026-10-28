import { SessionError, type SessionScope } from "./session-store.js";
import type { ExecutionStore } from "./execution-store.js";

/** Process scheduling only. Persistent claims, recovery and budgets belong to ExecutionStore. */
export class SessionDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private scan: Promise<void> | undefined;
  private running = new Set<string>();
  constructor(
    private readonly execution: Pick<
      ExecutionStore,
      "recoverConfirmations" | "wake" | "pending"
    >,
    private readonly run: (
      scope: SessionScope,
      sessionId: string,
      turnId: string,
    ) => Promise<unknown>,
  ) {}
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatch().catch(() => undefined);
    }, 500);
    this.timer.unref();
  }
  dispatch(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.scan) return this.scan;
    const scan = this.sweep();
    this.scan = scan;
    void scan
      .finally(() => {
        if (this.scan === scan) this.scan = undefined;
      })
      .catch(() => undefined);
    return scan;
  }
  private async sweep() {
    let phase = "recover_confirmations";
    try {
      await this.execution.recoverConfirmations();
      if (this.closed) return;
      phase = "wake";
      await this.execution.wake();
      if (this.closed) return;
      phase = "pending";
      const turns = await this.execution.pending();
      for (const t of turns) {
        if (this.closed) return;
        if (this.running.has(t.id)) continue;
        this.running.add(t.id);
        // Register before asynchronous claim; only the store can grant an execution token.
        void Promise.resolve()
          .then(() => {
            if (!this.closed)
              return this.run(
                { projectId: t.project_id, actorId: t.actor_id },
                t.session_id,
                t.id,
              );
          })
          .catch((error: unknown) => {
            if (
              error instanceof SessionError &&
              error.code === "turn_not_pending"
            )
              return;
            console.error("assistant_execution_dispatch_failed", {
              sessionId: t.session_id,
              turnId: t.id,
              code:
                error instanceof SessionError
                  ? error.code
                  : "execution_dispatch_failed",
            });
          })
          .finally(() => this.running.delete(t.id));
      }
    } catch (error) {
      console.error("assistant_dispatch_failed", {
        phase,
        code:
          error instanceof SessionError ? error.code : "dispatch_scan_failed",
      });
      throw error;
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.scan?.catch(() => undefined);
    // The executor owns cancellation/draining; the server closes it after this scan stops.
  }
}
