import type { Database } from "../db/pool.js";
import {
  guardOperationCommit,
  readOperationReceipt,
  writeOperationReceipt,
  type OperationScope,
} from "../operations/commit.js";

/** Manual pages and runtime tools share the same transaction and optional runtime receipt. */
export async function managementMutation<T>(
  db: Database,
  scope: OperationScope,
  run: (c: Pick<Database, "query">) => Promise<T>,
  self = false,
  check?: (c: Pick<Database, "query">) => Promise<void>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Serialize replays before reading the transactionally committed receipt.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      self
        ? "account:" + scope.actorId
        : "management:" + scope.actorId + ":" + scope.projectId,
    ]);
    await guardOperationCommit(c, scope, self ? "account" : "management");
    const prior = await readOperationReceipt(c, scope);
    if (prior) {
      await c.query("COMMIT");
      return prior as T;
    }
    await check?.(c);
    const result = await run(c);
    await guardOperationCommit(c, scope, self ? "account" : "management");
    await writeOperationReceipt(c, scope, result);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
