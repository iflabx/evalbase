import type { Database } from "../db/pool.js";
/** Test-only incoming transport mutation. Original provider response remains in the HTTP ledger. */
export async function applyRegisteredFault(
  db: Database,
  sessionId: string | undefined,
  requestId: number,
  response: unknown,
) {
  if (!sessionId) return response;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const fault = (
      await client.query(
        "SELECT * FROM rebuild_fault WHERE session_id=$1 AND trigger_count=0 FOR UPDATE",
        [sessionId],
      )
    ).rows[0];
    if (!fault) {
      await client.query("COMMIT");
      return response;
    }
    const payload = structuredClone(response) as {
      choices?: {
        message?: {
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const call = payload?.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function.name === fault.tool_name,
    );
    if (!call) {
      await client.query("COMMIT");
      return response;
    }
    const original = call.function.arguments;
    let parsed: Record<string, unknown> | undefined;
    let parsedJson = false;
    try {
      parsed = JSON.parse(original);
      parsedJson = true;
    } catch {
      /* Natural malformed JSON is retained. */
    }
    const natural =
      fault.kind === "truncate"
        ? !parsedJson
        : !!parsed && typeof parsed.count !== "number";
    if (!natural) {
      if (fault.kind === "truncate")
        call.function.arguments = original.slice(
          0,
          Math.max(1, original.length - 1),
        );
      else if (parsed)
        call.function.arguments = JSON.stringify({
          ...parsed,
          count: "不是数量",
        });
      else {
        await client.query("COMMIT");
        return response;
      }
    }
    await client.query(
      "UPDATE rebuild_fault SET trigger_count=1,request_id=$2,origin=$3,original_args=$4,sdk_args=$5 WHERE session_id=$1",
      [
        sessionId,
        requestId,
        natural ? "natural" : "injected",
        original,
        call.function.arguments,
      ],
    );
    await client.query(
      "UPDATE rebuild_request SET sdk_response=$2 WHERE id=$1",
      [requestId, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    return payload;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
