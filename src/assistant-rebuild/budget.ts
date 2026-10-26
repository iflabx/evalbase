import { applyRegisteredFault } from "./fault.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "../db/pool.js";
import { RuntimeCommitError } from "../operations/runtime-guard.js";
export const processingCost = new AsyncLocalStorage<{
  rows: number;
  generated: number;
}>();
export const validationEnabled = () =>
  process.env.REBUILD_VALIDATION_ENABLED === "true";
export async function event(
  db: Pick<Database, "query">,
  sessionId: string,
  kind: string,
  detail: unknown,
) {
  await db.query(
    "INSERT INTO rebuild_event(session_id,kind,detail) VALUES($1,$2,$3)",
    [sessionId, kind, JSON.stringify(detail)],
  );
}
/** One reservation at the HTTP boundary, shared by LangChain and the existing Worker. */
export function validationFetch(
  db: Database,
  campaignId: string,
  context: {
    sessionId?: string;
    runId?: string;
    kind: "assistant" | "worker" | "probe";
  },
  request: typeof fetch = fetch,
): typeof fetch {
  return async (url, init) => {
    const cost = processingCost.getStore() ?? { rows: 0, generated: 0 };
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const owner =
      context.sessionId ??
      (context.runId
        ? (
            await db.query(
              "SELECT session_id FROM rebuild_operation WHERE run_id=$1 ORDER BY revision DESC LIMIT 1",
              [context.runId],
            )
          ).rows[0]?.session_id
        : undefined);
    const client = await db.connect();
    let id: number;
    try {
      await client.query("BEGIN");
      const c = (
        await client.query(
          "SELECT * FROM rebuild_campaign WHERE id=$1 FOR UPDATE",
          [campaignId],
        )
      ).rows[0];
      if (
        !c ||
        c.closed_at ||
        c.requests >= c.max_requests ||
        c.rows + cost.rows > c.max_rows ||
        c.generated + cost.generated > c.max_generated ||
        (c.started_at &&
          Date.now() >=
            new Date(c.started_at).getTime() + c.max_minutes * 60000)
      )
        throw new RuntimeCommitError("validation_budget_exhausted");
      if (
        context.kind === "probe" &&
        Number(
          (
            await client.query(
              "SELECT count(*) FROM rebuild_request WHERE campaign_id=$1 AND kind='probe'",
              [campaignId],
            )
          ).rows[0].count,
        ) >= 4
      )
        throw new RuntimeCommitError("validation_probe_limit");
      if (owner) {
        const fault = (
          await client.query(
            "SELECT request_limit FROM rebuild_fault WHERE session_id=$1",
            [owner],
          )
        ).rows[0];
        if (
          fault &&
          Number(
            (
              await client.query(
                "SELECT count(*) FROM rebuild_request WHERE campaign_id=$1 AND session_id=$2",
                [campaignId, owner],
              )
            ).rows[0].count,
          ) >= fault.request_limit
        )
          throw new RuntimeCommitError("validation_case_budget_exhausted");
      }
      await client.query(
        "UPDATE rebuild_request SET ended_at=now(),error_code='request_outcome_unknown' WHERE campaign_id=$1 AND ended_at IS NULL AND started_at<now()-interval '180 seconds'",
        [campaignId],
      );
      const inFlight = (
        await client.query(
          "SELECT count(*)::int AS n FROM rebuild_request WHERE campaign_id=$1 AND kind=$2 AND ended_at IS NULL",
          [campaignId, context.kind],
        )
      ).rows[0].n;
      if (inFlight >= 1)
        throw new RuntimeCommitError("validation_concurrency_limit");
      await client.query(
        "UPDATE rebuild_campaign SET requests=requests+1,rows=rows+$2,generated=generated+$3,started_at=coalesce(started_at,now()) WHERE id=$1",
        [campaignId, cost.rows, cost.generated],
      );
      id = Number(
        (
          await client.query(
            "INSERT INTO rebuild_request(campaign_id,session_id,run_id,kind,request) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              campaignId,
              owner ?? null,
              context.runId ?? null,
              context.kind,
              JSON.stringify(body),
            ],
          )
        ).rows[0].id,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(180000),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const response = await request(url, {
        ...init,
        signal,
        redirect: "error",
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 8000000)
        throw new Error("model_response_too_large");
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { stream: text };
      }
      await db.query(
        "UPDATE rebuild_request SET response=$2,status=$3,ended_at=now() WHERE id=$1",
        [id, JSON.stringify(payload), response.status],
      );
      const sdkPayload = await applyRegisteredFault(db, owner, id, payload);
      const sdkText =
        sdkPayload === payload ? text : JSON.stringify(sdkPayload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(sdkText, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      await db.query(
        "UPDATE rebuild_request SET error_code=$2,ended_at=now() WHERE id=$1",
        [id, error instanceof Error ? error.name : "request_unknown"],
      );
      throw error;
    }
  };
}
