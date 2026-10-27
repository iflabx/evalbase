import {
  operationScope,
  guardOperationCommit,
  linkOperationProcessing,
  type AssistantGuard,
  type CommitAction,
  type OperationScope,
} from "../operations/commit.js";
import { freezeBackground } from "./background.js";
import type { ProcessingScope } from "../processing/store.js";
export type { AssistantGuard } from "../operations/commit.js";

/** Only the legacy controller calls this adapter; shared business never reads a legacy plan. */
export function legacyOperationScope<
  T extends OperationScope & { assistantGuard: AssistantGuard },
>(scope: T) {
  const guard = { ...scope.assistantGuard };
  const fixed = { ...scope, assistantGuard: guard };
  return operationScope(scope, {
    origin: "legacy",
    sessionId: guard.sessionId,
    guard: (db, action) =>
      guardLegacyCommit(db, fixed, action === "cancel" ? undefined : action),
    link: (db, runId) => linkLegacyProcessing(db, fixed, runId),
    background: (db, request) =>
      freezeBackground(db, fixed, guard.sessionId, request),
    results: (db, runIds, actual) =>
      guardLegacyResults(
        db,
        {
          ...fixed,
          assistantResultsGuard: (actual as ProcessingScope)
            .assistantResultsGuard,
        },
        runIds,
      ),
  });
}
export async function guardAssistantCommit(
  db: Pick<Database, "query">,
  scope: OperationScope,
) {
  return guardOperationCommit(
    db,
    scope.assistantGuard && !scope.operation
      ? legacyOperationScope({ ...scope, assistantGuard: scope.assistantGuard })
      : scope,
  );
}
export async function linkAssistantProcessing(
  db: Pick<Database, "query">,
  scope: OperationScope,
  runId: string,
) {
  return linkOperationProcessing(
    db,
    scope.assistantGuard && !scope.operation
      ? legacyOperationScope({ ...scope, assistantGuard: scope.assistantGuard })
      : scope,
    runId,
  );
}
async function guardLegacyResults(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  runIds: string[],
) {
  const task = (
    await db.query(
      "SELECT task FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3",
      [scope.assistantGuard!.sessionId, scope.projectId, scope.actorId],
    )
  ).rows[0]?.task;
  const anchors = (
    await db.query(
      "SELECT DISTINCT task_id FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[])",
      [scope.projectId, task?.runIds ?? []],
    )
  ).rows.map((row) => row.task_id);
  const members = scope.assistantResultsGuard
    ? (
        await db.query(
          "SELECT id FROM processing_run WHERE project_id=$1 AND task_id=ANY($2::text[]) AND task_id=ANY($3::text[])",
          [
            scope.projectId,
            anchors,
            scope.assistantResultsGuard.states.map((state) => state.id),
          ],
        )
      ).rows.map((row) => row.id)
    : [];
  if (
    !task ||
    runIds.some((id) => !task.runIds?.includes(id) && !members.includes(id))
  )
    throw new AssistantError(409, "assistant_processing_context_changed");
}
import type { Database } from "../db/pool.js";
import { AssistantError } from "./store.js";
import { carryCandidateScope } from "./candidates.js";
import {
  settleExecutionPlan,
  pendingPlanAction,
  planRequirementsKey,
} from "./plan.js";

async function guardLegacyCommit(
  db: Pick<Database, "query">,
  scope: {
    projectId: string;
    actorId: string;
    assistantGuard?: AssistantGuard;
  },
  action?: CommitAction,
) {
  const guard = scope.assistantGuard;
  if (!guard) return;
  const session = (
    await db.query(
      "SELECT task_revision,task->'turnBudget' AS budget FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE",
      [guard.sessionId, scope.projectId, scope.actorId],
    )
  ).rows[0];
  if (session?.task_revision !== guard.revision)
    throw new AssistantError(409, "assistant_interrupted");
  if (
    guard.turnId &&
    session.budget?.turnId === guard.turnId &&
    session.budget.deadlineAt <= Date.now()
  )
    throw new AssistantError(409, "assistant_budget_exhausted");
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
  if (action && !guard.proposalId)
    throw new AssistantError(422, "assistant_confirmation_required");
  if (
    guard.proposalId &&
    !(
      await db.query(
        "SELECT id FROM assistant_proposal WHERE id=$1 AND session_id=$2 AND task_revision=$3 AND lease_token=$4 AND status='executing' AND lease_until>now() AND ($5::text IS NULL OR action=$5) FOR SHARE",
        [
          guard.proposalId,
          guard.sessionId,
          guard.revision,
          guard.leaseToken,
          action ?? null,
        ],
      )
    ).rowCount
  )
    throw new AssistantError(409, "assistant_confirmation_expired");
}
/** Bind the actual processing receipt in the same transaction as its job. */
async function linkLegacyProcessing(
  db: Pick<Database, "query">,
  scope: {
    projectId: string;
    actorId: string;
    assistantGuard?: AssistantGuard;
  },
  runId: string,
) {
  if (!scope.assistantGuard) return;
  await guardLegacyCommit(db, scope);
  const state = (
    await db.query("SELECT task FROM assistant_session WHERE id=$1", [
      scope.assistantGuard.sessionId,
    ])
  ).rows[0].task;
  const run = (
    await db.query(
      "SELECT parent_run_id,source,options,target_draft_id FROM processing_run WHERE id=$1",
      [runId],
    )
  ).rows[0];
  const parent = run?.parent_run_id;
  const freshDelivery = run?.options.operation === "generate" && !parent;
  const prior: string[] = freshDelivery
    ? []
    : (state.runIds ?? (state.runId ? [state.runId] : []));
  const runs = [
    ...new Set(prior.map((id) => (id === parent ? runId : id)).concat(runId)),
  ];
  const candidateScope = carryCandidateScope(
    freshDelivery ? null : state.candidateScope,
    runId,
    parent,
  );
  if (runs.length > 12) throw new AssistantError(422, "assistant_task_limit");
  const capacity = (
    await db.query(
      "SELECT sum(CASE WHEN id=$2 THEN $3::integer ELSE coalesce((options->>'outputCount')::integer,input_count) END)::integer AS total FROM processing_run WHERE id=ANY($1::text[])",
      [
        runs,
        candidateScope?.runId ?? null,
        candidateScope?.resultIds.length ?? 0,
      ],
    )
  ).rows[0];
  if (capacity.total > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  const step = state.executionPlan?.steps[state.executionPlan.current];
  let plan = step?.operation
    ? settleExecutionPlan(
        state,
        step.action,
        {
          runId,
          draftId: run.target_draft_id,
          status: "queued",
          source: step.operation.input.source,
        },
        step.operation.key,
        scope.assistantGuard.revision,
        step.operation.input,
      ).executionPlan
    : state.executionPlan;
  if (freshDelivery && plan)
    plan = {
      ...plan,
      requirementsKey: planRequirementsKey({
        ...state,
        target: null,
        targetCount: run.options.outputCount,
        countKind: step?.countKind ?? "new",
        targetDraftId: run.target_draft_id,
      }),
    };
  await db.query(
    "UPDATE assistant_session SET task=task||jsonb_build_object('runId',$2::text,'runIds',$3::jsonb,'stage','processing','error',NULL,'review',NULL,'checkedStatus',NULL,'candidateScope',$4::jsonb)||$5::jsonb,updated_at=now() WHERE id=$1",
    [
      scope.assistantGuard.sessionId,
      runId,
      JSON.stringify(runs),
      JSON.stringify(candidateScope),
      JSON.stringify({
        ...(freshDelivery
          ? {
              target: null,
              targetName: step?.input?.name ?? "依据背景文档生成",
              targetCount: run.options.outputCount,
              countKind: step?.countKind ?? "new",
              createdDraftId: run.target_draft_id,
              targetDraftId: run.target_draft_id,
              processingScope: null,
              selectedCandidates: null,
              selectionPreview: null,
            }
          : {}),
        ...(plan
          ? { executionPlan: plan, nextAction: pendingPlanAction(plan) ?? null }
          : {}),
      }),
    ],
  );
}
