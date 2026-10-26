import type { Database } from "../db/pool.js";
import { hasProjectCapability } from "../security/project-access.js";

/** Never accepted from an HTTP/model body: supplied only by the runtime host. */
export type RuntimeGuard = {
  sessionId: string;
  revision: number;
  token: string;
  confirmationId?: string;
  operationId?: string;
  control?: true;
};
export class RuntimeCommitError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export async function guardRuntimeCommit(
  db: Pick<Database, "query">,
  scope: { projectId: string; actorId: string; runtimeGuard?: RuntimeGuard },
) {
  const proof = scope.runtimeGuard;
  if (!proof) return;
  await db.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
    scope.actorId,
  ]);
  await db.query(
    "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
    [scope.projectId, scope.actorId],
  );
  if (
    !(await hasProjectCapability(db, scope.projectId, scope.actorId, "write"))
  )
    throw new RuntimeCommitError("project_not_found", 404);
  const s = (
    await db.query(
      "SELECT s.*,c.closed_at,c.started_at,c.max_minutes FROM rebuild_session s JOIN rebuild_campaign c ON c.id=s.campaign_id WHERE s.id=$1 AND s.project_id=$2 AND s.actor_id=$3 FOR SHARE OF s,c",
      [proof.sessionId, scope.projectId, scope.actorId],
    )
  ).rows[0];
  if (
    !s ||
    s.revision !== proof.revision ||
    s.token !== proof.token ||
    (s.status !== "running" && !(proof.control && s.status === "paused"))
  )
    throw new RuntimeCommitError("runtime_interrupted");
  if (
    !proof.control &&
    (s.closed_at ||
      (s.started_at &&
        Date.now() >= new Date(s.started_at).getTime() + s.max_minutes * 60000))
  )
    throw new RuntimeCommitError("validation_budget_exhausted");
  if (proof.confirmationId) {
    const confirmation = (
      await db.query(
        "SELECT id FROM rebuild_confirmation WHERE id=$1 AND session_id=$2 AND revision=$3 AND status='executing' AND expires_at>now() FOR SHARE",
        [proof.confirmationId, proof.sessionId, proof.revision],
      )
    ).rows[0];
    if (!confirmation) throw new RuntimeCommitError("confirmation_expired");
  }
}
export async function linkRuntimeProcessing(
  db: Pick<Database, "query">,
  scope: { projectId: string; actorId: string; runtimeGuard?: RuntimeGuard },
  runId: string,
) {
  if (!scope.runtimeGuard) return;
  await guardRuntimeCommit(db, scope);
  const proof = scope.runtimeGuard;
  if (!proof.operationId)
    throw new RuntimeCommitError("runtime_operation_required");
  const updated = await db.query(
    "UPDATE rebuild_operation SET run_id=$2 WHERE id=$1 AND session_id=$3 AND revision=$4 AND (run_id IS NULL OR run_id=$2) RETURNING id",
    [proof.operationId, runId, proof.sessionId, proof.revision],
  );
  if (!updated.rowCount)
    throw new RuntimeCommitError("runtime_operation_conflict");
  await db.query("UPDATE rebuild_session SET waiting_run_id=$2 WHERE id=$1", [
    proof.sessionId,
    runId,
  ]);
}
