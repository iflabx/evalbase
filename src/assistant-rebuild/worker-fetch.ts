import { processingCost } from "./budget.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/pool.js";
import { sha256 } from "../package/contract.js";
import { ExecutionStore } from "./execution-store.js";
/** Worker still owns row/batch limits. This records actual provider attempts and shares only the outer activity cap. */
export function formalWorkerFetch(
  db: Database,
  runId: string,
): (request: typeof fetch) => typeof fetch {
  const ledger = new ExecutionStore(db);
  return (request) => async (url, init) => {
    const id = "worker_request_" + randomUUID();
    const admitted = await ledger.reserveWorker(
      runId,
      id,
      sha256(String(init?.body ?? "")),
      processingCost.getStore(),
    );
    if (!admitted) return request(url, init);
    let outcome = {
      id,
      status: null as number | null,
      usage: null as unknown,
      error: null as string | null,
    };
    const timeout = AbortSignal.timeout(admitted);
    try {
      const response = await request(url, {
        ...init,
        signal: AbortSignal.any([
          timeout,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      outcome.status = response.status;
      const body = (await response.clone().json()) as {
        usage?: unknown;
      } | null;
      outcome = {
        id,
        status: response.status,
        usage: body?.usage ?? null,
        error: response.ok ? null : "provider_rejected",
      };
      return response;
    } catch (error) {
      outcome.error = timeout.aborted
        ? "activity_or_request_timeout"
        : "transport_outcome_unknown";
      throw error;
    } finally {
      await ledger.outcome(outcome);
    }
  };
}
