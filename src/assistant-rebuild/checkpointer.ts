import type { RunnableConfig } from "@langchain/core/runnables";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Database } from "../db/pool.js";
import { RuntimeCommitError } from "../operations/runtime-guard.js";

/** Linearize checkpoint commits with stop, using the same trusted execution token as business writes.
 * The saver must own a different pool: holding its only connection while waiting for put would deadlock.
 */
export function fenceCheckpointer(saver: PostgresSaver, db: Database) {
  const guarded = async <T>(
    config: RunnableConfig,
    write: () => Promise<T>,
  ): Promise<T> => {
    const id =
        config.configurable?.runtime_session_id ??
        config.configurable?.thread_id,
      token = config.configurable?.execution_token;
    if (typeof id !== "string" || typeof token !== "string")
      throw new RuntimeCommitError("checkpoint_execution_required");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          "SELECT id FROM rebuild_session WHERE id=$1 AND token=$2 FOR SHARE",
          [id, token],
        )
      ).rows[0];
      if (!row) throw new RuntimeCommitError("runtime_interrupted");
      const result = await write();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const put = saver.put.bind(saver),
    putWrites = saver.putWrites.bind(saver);
  saver.put = async (...args: Parameters<typeof put>) =>
    guarded(args[0], () => put(...args));
  saver.putWrites = async (...args: Parameters<typeof putWrites>) =>
    guarded(args[0], () => putWrites(...args));
  return saver;
}
