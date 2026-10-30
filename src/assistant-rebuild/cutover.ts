import type { Database } from "../db/pool.js";
import { ExecutionStore } from "./execution-store.js";

/** Operator-only, no HTTP/model tool. Call with old Web processes stopped; never downgrade the schema. */
export async function changeAssistantMode(
  db: Database,
  mode: "manual" | "rebuild",
) {
  const ownedRun = `j.payload->>'executionOrigin' IS DISTINCT FROM 'manual' AND (EXISTS(SELECT 1 FROM assistant_runtime_operation o WHERE o.run_id=r.id AND o.kind='processing')
    OR EXISTS(SELECT 1 FROM assistant_session s WHERE s.task->>'runId'=r.id OR coalesce(s.task->'runIds','[]') ? r.id)
    OR EXISTS(SELECT 1 FROM assistant_task_checkpoint c WHERE c.task->>'runId'=r.id OR coalesce(c.task->'runIds','[]') ? r.id))`;
  const lock = await db.connect();
  try {
    await lock.query(
      "SELECT pg_advisory_lock(hashtext('assistant-runtime-cutover'))",
    );
    // Commit the write barrier separately before touching execution rows: no lock-order cycle with business commits.
    await lock.query(
      "UPDATE assistant_runtime_mode SET mode='manual',changed_at=now() WHERE id=true",
    );
    const execution = new ExecutionStore(db);
    await execution.recoverConfirmations();
    const active = (
      await db.query(
        "SELECT s.id,s.project_id,s.actor_id,s.runtime_version FROM assistant_runtime_session s LEFT JOIN assistant_runtime_execution e ON e.session_id=s.id WHERE s.deleted_at IS NULL AND (e.status IN('pending','running','waiting','confirmation') OR EXISTS(SELECT 1 FROM assistant_runtime_turn t WHERE t.session_id=s.id AND t.status IN('pending','running','waiting','confirmation')))",
      )
    ).rows;
    for (const s of active) await execution.quiesce(s.id);
    await execution.recoverConfirmations();
    await lock.query("BEGIN");
    await lock.query(
      "UPDATE assistant_turn SET execution_token=NULL,status='interrupted',error_code='assistant_runtime_retired' WHERE status IN('queued','running')",
    );
    await lock.query(
      "UPDATE assistant_proposal SET status='invalid',lease_until=NULL,lease_token=NULL WHERE status IN('pending','executing') AND receipt IS NULL",
    );
    await lock.query(
      "UPDATE assistant_runtime_confirmation SET status='expired' WHERE status IN('pending','executing') AND receipt IS NULL",
    );
    // Stop only assistant-owned jobs; ordinary manual jobs and successful batches remain untouched.
    await lock.query(`UPDATE job j SET status='cancel_requested',updated_at=now()
      WHERE j.status IN('queued','running','retry_wait') AND EXISTS(
        SELECT 1 FROM processing_run r WHERE r.job_id=j.id AND (${ownedRun}))`);
    await lock.query("COMMIT");
    const inflight = Number(
      (
        await db.query(`SELECT count(*) FROM job j JOIN processing_run r ON r.job_id=j.id
      WHERE j.status IN('queued','running','retry_wait','cancel_requested') AND (${ownedRun})`)
      ).rows[0].count,
    );
    if (mode === "rebuild" && inflight)
      throw Error("assistant_jobs_not_settled_mode_remains_manual");
    if (mode === "rebuild")
      await lock.query(
        "UPDATE assistant_runtime_mode SET mode='rebuild',changed_at=now() WHERE id=true",
      );
    return {
      mode,
      pausedSessions: active.map((s) => s.id),
      unsettledJobs: inflight,
      policy:
        "Paused checkpoints and budgets retained; enabling never resumes them automatically.",
    };
  } finally {
    await lock.query("ROLLBACK").catch(() => undefined);
    await lock
      .query("SELECT pg_advisory_unlock(hashtext('assistant-runtime-cutover'))")
      .catch(() => undefined);
    lock.release();
  }
}
