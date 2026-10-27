import type { Database } from "../db/pool.js";
/** A read-only follow-up has its own turn; the suspended execution remains authoritative. */
export async function restoreSuspended(
  db: Pick<Database, "query">,
  sessionId: string,
  requirementsRevision: number,
) {
  const row = (
    await db.query(
      "SELECT suspended,resume_suspended FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
      [sessionId],
    )
  ).rows[0];
  const saved = row?.suspended;
  if (!saved) return false;
  if (saved.requirementsRevision !== requirementsRevision) {
    await db.query(
      "UPDATE assistant_runtime_execution SET suspended=NULL,resume_suspended=false WHERE session_id=$1",
      [sessionId],
    );
    return false;
  }
  const status = row.resume_suspended ? "pending" : "paused";
  await db.query(
    "UPDATE assistant_runtime_execution SET turn_id=$2,status=$3,reason=$4,feedback=$5,no_progress=$6,seen=$7,progress_revision=$8,progress_version=$9,suspended=NULL,resume_suspended=false,resume_requested=$10,lease_until=NULL WHERE session_id=$1",
    [
      sessionId,
      saved.turnId,
      status,
      row.resume_suspended ? null : saved.reason,
      JSON.stringify(saved.feedback ?? null),
      saved.noProgress,
      JSON.stringify(saved.seen ?? []),
      saved.progressRevision,
      saved.progressVersion,
      !!row.resume_suspended,
    ],
  );
  if (row.resume_suspended)
    await db.query(
      "UPDATE assistant_runtime_turn SET status='pending',runner_token=NULL,error_code=NULL WHERE id=$1 AND session_id=$2 AND status IN('paused','failed')",
      [saved.turnId, sessionId],
    );
  await db.query("UPDATE assistant_runtime_session SET status=$2 WHERE id=$1", [
    sessionId,
    row.resume_suspended ? "busy" : "paused",
  ]);
  return true;
}
