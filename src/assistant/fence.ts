import type { Database } from "../db/pool.js";
import { AssistantError, assistantAccess } from "./store.js";
import { carryCandidateScope } from "./candidates.js";

/** Supplied only by server-side assistant callers, after locking domain sources. */
export type AssistantGuard = {
  sessionId: string;
  revision: number;
  turnId?: string;
  token?: string;
  proposalId?: string;
  leaseToken?: string;
};
export async function guardAssistantCommit(
  db: Pick<Database, "query">,
  scope: {
    projectId: string;
    actorId: string;
    assistantGuard?: AssistantGuard;
  },
) {
  const guard = scope.assistantGuard;
  if (!guard) return;
  await db.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
    scope.actorId,
  ]);
  await db.query(
    "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
    [scope.projectId, scope.actorId],
  );
  await assistantAccess(db, scope, true);
  const session = (
    await db.query(
      "SELECT task_revision FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE",
      [guard.sessionId, scope.projectId, scope.actorId],
    )
  ).rows[0];
  if (session?.task_revision !== guard.revision)
    throw new AssistantError(409, "assistant_interrupted");
  if (
    guard.turnId &&
    !(
      await db.query(
        "SELECT id FROM assistant_turn WHERE id=$1 AND session_id=$2 AND task_revision=$3 AND execution_token=$4 AND status='running' AND expires_at>now() FOR SHARE",
        [guard.turnId, guard.sessionId, guard.revision, guard.token],
      )
    ).rowCount
  )
    throw new AssistantError(409, "assistant_interrupted");
  if (
    guard.proposalId &&
    !(
      await db.query(
        "SELECT id FROM assistant_proposal WHERE id=$1 AND session_id=$2 AND task_revision=$3 AND lease_token=$4 AND status='executing' AND lease_until>now() FOR SHARE",
        [guard.proposalId, guard.sessionId, guard.revision, guard.leaseToken],
      )
    ).rowCount
  )
    throw new AssistantError(409, "assistant_confirmation_expired");
}
/** Bind the actual processing receipt in the same transaction as its job. */
export async function linkAssistantProcessing(
  db: Pick<Database, "query">,
  scope: {
    projectId: string;
    actorId: string;
    assistantGuard?: AssistantGuard;
  },
  runId: string,
) {
  if (!scope.assistantGuard) return;
  await guardAssistantCommit(db, scope);
  const state = (
    await db.query("SELECT task FROM assistant_session WHERE id=$1", [
      scope.assistantGuard.sessionId,
    ])
  ).rows[0].task;
  const parent = (
    await db.query("SELECT parent_run_id FROM processing_run WHERE id=$1", [
      runId,
    ])
  ).rows[0]?.parent_run_id;
  const prior: string[] = state.runIds ?? (state.runId ? [state.runId] : []);
  const runs = [
    ...new Set(prior.map((id) => (id === parent ? runId : id)).concat(runId)),
  ];
  if (runs.length > 12) throw new AssistantError(422, "assistant_task_limit");
  const capacity = (
    await db.query(
      "SELECT sum(coalesce((options->>'outputCount')::integer,input_count))::integer AS total FROM processing_run WHERE id=ANY($1::text[])",
      [runs],
    )
  ).rows[0];
  if (capacity.total > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  await db.query(
    "UPDATE assistant_session SET task=task||jsonb_build_object('runId',$2::text,'runIds',$3::jsonb,'stage','processing','error',NULL,'review',NULL,'checkedStatus',NULL,'candidateScope',$4::jsonb),updated_at=now() WHERE id=$1",
    [
      scope.assistantGuard.sessionId,
      runId,
      JSON.stringify(runs),
      JSON.stringify(carryCandidateScope(state.candidateScope, runId, parent)),
    ],
  );
}
