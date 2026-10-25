import {
  budgetAllowance,
  createBudgetLedger,
  budgetPresentation,
} from "./budget-ledger.js";
import {
  prepareTaskBoundary,
  taskIdentity,
  taskDependencies,
  taskTurnFilter,
} from "./task-boundary.js";
import { planningContinuation } from "./intent.js";
import { turnDiagnostics } from "./diagnostics.js";
import { assistantFeedback } from "./feedback.js";
import { unresolvedFailure } from "./receipts.js";
import { queueRecovery, closeBudget } from "./tasks.js";
import type { Database } from "../db/pool.js";
import { hasProjectCapability } from "../security/project-access.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { isPlainObject, opaqueId } from "../server/support.js";
import {
  processingSourceRows,
  previewProcessingInput,
  processingSourceAvailable,
} from "../processing/store.js";
import { processingAcceptanceHash } from "../processing/accept.js";
import {
  planSource,
  advancePlan,
  planRequirementsKey,
  planVerificationCurrent,
} from "./plan.js";
import {
  recoveryDecision,
  backgroundVersion,
  liveExecutionBudget,
} from "./recovery.js";
import { backgroundCatalog } from "./background.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  deliveryProgress,
  readWorkspaceFacts,
  confirmationStatus,
  type WorkspaceFacts,
} from "./workspace.js";
import { currentDeliveryId, taskForDelivery } from "./delivery-plan.js";
import {
  taskCandidateCollection,
  resolveTaskSelection,
  type TaskCandidateSelection,
} from "./review.js";
import { guardProcessingTask } from "../processing/task-state.js";
import {
  RequirementError,
  effectiveRules,
  requirementSummary,
  validateRules,
} from "./requirements.js";

export const ASSISTANT_SESSION_TURN_LIMIT = 100;
export type AssistantScope = { projectId: string; actorId: string };
function initialTaskTitle(text: string) {
  const named = text.match(/本会话命名为[“"「]([^”"」\n]{1,40})[”"」]/u)?.[1];
  return named ?? "新任务";
}
export function taskPresentation(
  task: Record<string, any> | null,
  processing?: Parameters<typeof requirementSummary>[1],
  workspace?: WorkspaceFacts,
) {
  if (!task || !Object.keys(task).length) return task;
  const focus = currentDeliveryId(task.executionPlan);
  const delivery = focus && taskForDelivery(task, focus);
  if (delivery)
    task = {
      ...task,
      targetCount: delivery.targetCount,
      countKind: delivery.countKind,
      classifications: delivery.classifications,
      allowedLabels: [],
    };
  const presented = { ...task };
  if (task.executionPlan?.contractVersion === 1) {
    const steps = task.executionPlan.steps;
    // A generation name is not a source-object name. Keep the original task
    // and receipts intact; project focus and historical candidates separately.
    if (!task.target) delete presented.targetName;
    const currentDeliveryName = steps.find(
      (step: any) =>
        step.deliveryId === focus && step.action === "generate_candidates",
    )?.input.name;
    if (currentDeliveryName === undefined) delete presented.currentDeliveryName;
    else presented.currentDeliveryName = currentDeliveryName;
    presented.candidateHistory = Boolean(
      task.runId &&
      !steps.some((step: any) => step.receipt?.runId === task.runId),
    );
  }
  delete presented.selectedCandidates;
  delete presented.backgroundDefinitions;
  delete presented.observations;
  delete presented.budgetCheckpoint;
  delete presented.planningCheckpointTurnId;
  delete presented.planValidationRequired;
  delete presented.parameterRepairLimits;
  delete presented.parameterRepairStatus;
  delete presented.planningRecovery;
  delete presented.requirementSave;
  delete presented.requirementCheck;
  delete presented.recoverySegment;
  delete presented.recoveryRequests;
  delete presented.budgetSegments;
  delete presented.budgetLedger;
  delete presented.grantResume;
  presented.budget = budgetPresentation({
    ...task,
    executionBudget: liveExecutionBudget(task),
  });
  if (presented.executionPlan) {
    presented.executionPlan = {
      ...presented.executionPlan,
      steps: presented.executionPlan.steps.map(
        ({
          operation: _operation,
          command: _command,
          ...step
        }: Record<string, any>) => step,
      ),
    };
    delete presented.executionPlan.requirementsKey;
  }
  let requirementProblem = task.requirementProblem ?? null;
  let requirementProblemKind = task.requirementProblemKind ?? "diagnostic";
  try {
    presented.classifications = validateRules(task);
  } catch (error) {
    if (!(error instanceof RequirementError)) throw error;
    requirementProblem = error.hint;
    requirementProblemKind = "business";
    presented.classifications = effectiveRules(task);
  }
  delete presented.allowedLabels;
  return {
    ...presented,
    ...(workspace ? { deliveries: deliveryProgress(task, workspace) } : {}),
    requirementSummary: requirementSummary(task, processing),
    canContinueExecution: recoveryDecision(
      { ...task, requirementProblem },
      undefined,
      {
        revision: Number(task.turnControl?.taskRevision ?? 0),
        canWrite: true,
        dependenciesValid: true,
      },
    ).canExecutePlan,
    requirementProblem,
    requirementProblemKind,
    ...(task.candidateScope
      ? {
          candidateScope: {
            runId: task.candidateScope.runId,
            count: task.candidateScope.resultIds.length,
            hash: task.candidateScope.hash,
            targetCount: task.candidateScope.targetCount,
            sourceCount: task.candidateScope.sourceCount,
            groups: task.candidateScope.groups,
          },
          runIds: task.runIds ?? [task.candidateScope.runId],
        }
      : {}),
    ...(task.processingScope
      ? {
          processingScope: {
            source: task.processingScope.source,
            ...(task.processingScope.configuration !== undefined
              ? { configuration: task.processingScope.configuration }
              : {}),
            count: task.processingScope.recordIds.length,
            hash: task.processingScope.hash,
          },
        }
      : {}),
    ...(task.goal?.length > 40 &&
    !Object.hasOwn(task, "nextAction") &&
    task.title === task.goal.slice(0, 40)
      ? { title: initialTaskTitle(task.goal) }
      : {}),
    ...(task.review && task.review.runId !== task.runId
      ? { review: null, checkedStatus: null }
      : {}),
  };
}
export type Dependency = {
  kind: "asset" | "draft" | "version" | "testSet";
  id: string;
  focus?: true;
};
/** Compatibility projection; server callers load current access and document facts below. */
export function canResumeAssistantTurn(
  turn: Record<string, any> | undefined,
  task: Record<string, any>,
) {
  return Boolean(
    recoveryDecision(task, turn, {
      revision: Number(turn?.task_revision ?? 0),
      canWrite: true,
      dependenciesValid: true,
      documentsKey: task.planningRecovery?.documentsKey,
    }).action,
  );
}
export async function assistantRecovery(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  session: Record<string, any>,
  turn: Record<string, any> | undefined,
  options: {
    phase?: "offer" | "claim" | "request" | "event" | "commit";
    token?: string;
    reservedModelStep?: boolean;
    requestEstimateMs?: number;
    event?: string;
  } = {},
) {
  const { phase = "offer", token, reservedModelStep = false, event } = options;
  const canWrite = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  let dependenciesValid = true;
  try {
    if (turn) await dependenciesAvailable(db, scope, turn.dependencies ?? []);
  } catch (error) {
    if (!(error instanceof AssistantError)) throw error;
    dependenciesValid = false;
  }
  const documents = (
    await db.query(
      'SELECT id,sha256,extractor_version AS "extractorVersion" FROM assistant_background_document WHERE session_id=$1',
      [session.id],
    )
  ).rows;
  const state = (
    await db.query(
      "SELECT count(*)::int n,count(*) FILTER(WHERE status IN('queued','running') AND id<>$2)::int busy FROM assistant_turn WHERE session_id=$1",
      [session.id, turn?.id ?? null],
    )
  ).rows[0];
  let eventReady = false;
  if (event === "budget_yield")
    eventReady =
      session.task?.budgetCheckpoint?.turnId === turn?.id &&
      Boolean(session.task.budgetCheckpoint.pendingAction) &&
      Boolean(session.task.budgetCheckpoint.progressHashes?.length);
  if (event === "processing_completed")
    eventReady = Boolean(
      (
        await db.query(
          "SELECT 1 FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.project_id=$1 AND r.actor_id=$2 AND r.id=ANY($3::text[]) GROUP BY r.project_id HAVING bool_and(j.status IN('succeeded','failed','cancelled'))",
          [
            scope.projectId,
            scope.actorId,
            session.task?.runIds ??
              (session.task?.runId ? [session.task.runId] : []),
          ],
        )
      ).rowCount,
    );
  if (event === "confirmed")
    eventReady = Boolean(
      (
        await db.query(
          "SELECT 1 FROM assistant_proposal WHERE session_id=$1 AND task_revision=$2 AND status='succeeded'",
          [session.id, session.task_revision],
        )
      ).rowCount,
    );
  return recoveryDecision(session.task ?? {}, turn, {
    event,
    eventReady,
    revision: Number(session.task_revision),
    canWrite:
      ["request", "commit"].includes(phase) && !turn?.requires_write
        ? true
        : canWrite,
    dependenciesValid,
    documentsKey: backgroundVersion(documents),
    legacyDocumentsKey: backgroundVersion(documents, true),
    turnCount: state?.n ?? 0,
    busy: Number(state?.busy ?? 0) > 0,
    phase,
    token,
    reservedModelStep,
    requestEstimateMs: options.requestEstimateMs,
  });
}
export class AssistantError extends Error {
  constructor(
    public status: number,
    public code: string,
    public hint?: string,
  ) {
    super(code);
  }
}
export async function assistantAccess(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  write = false,
) {
  if (
    !(await hasProjectCapability(
      db,
      scope.projectId,
      scope.actorId,
      write ? "write" : "read",
    ))
  )
    throw new AssistantError(404, "assistant_not_found");
}
export async function sessionRow(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  id: string,
  lock = false,
) {
  await assistantAccess(db, scope);
  const row = (
    await db.query(
      `SELECT * FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [id, scope.projectId, scope.actorId],
    )
  ).rows[0];
  if (!row) throw new AssistantError(404, "assistant_not_found");
  return row;
}
/** Batch source checks are shared by execution and bounded history redaction. */
export async function availableDependencies(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  refs: Dependency[],
) {
  const unique = [
    ...new Map(refs.map((r) => [r.kind + ":" + r.id, r])).values(),
  ];
  const writable = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const sources = unique
    .filter((r) => r.kind !== "testSet" && (writable || r.kind !== "draft"))
    .map((r) =>
      r.kind === "asset"
        ? { kind: "assets" as const, assetIds: [r.id], recordIds: [] }
        : { kind: r.kind as "draft" | "version", id: r.id, recordIds: [] },
    );
  const rows = await processingSourceRows(db, scope.projectId, sources);
  const sets = unique.filter((r) => r.kind === "testSet");
  const testSets = sets.length
    ? (
        await db.query(
          "SELECT id FROM test_set WHERE project_id=$1 AND id=ANY($2::text[]) AND status='available' AND NOT EXISTS(SELECT 1 FROM deletion_lock WHERE project_id=$1 AND object_id=test_set.id)",
          [scope.projectId, sets.map((r) => r.id)],
        )
      ).rows
    : [];
  return new Set([
    ...rows.assets.map((r) => "asset:" + r.id),
    ...rows.version.map((r) => "version:" + r.id),
    ...rows.draft.map((r) => "draft:" + r.id),
    ...testSets.map((r) => "testSet:" + r.id),
  ]);
}
export async function dependenciesAvailable(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  dependencies: Dependency[],
) {
  const keys = await availableDependencies(db, scope, dependencies);
  if (dependencies.some((ref) => !keys.has(ref.kind + ":" + ref.id)))
    throw new AssistantError(409, "assistant_context_unavailable");
}
export async function readSession(
  db: Database,
  scope: AssistantScope,
  id: string,
  readContext?: () => Promise<unknown>,
  view?: { mode: "status" | "messages"; before?: string; limit: number },
) {
  const session = await sessionRow(db, scope, id);
  await db.query(
    "UPDATE assistant_turn SET status='interrupted',error_code='assistant_interrupted' WHERE session_id=$1 AND status='running' AND expires_at<=now() AND execution_token IS NULL",
    [id],
  );
  const limit = view?.limit ?? 50;
  const cursor = view?.before
    ? (
        await db.query(
          "SELECT created_at,id FROM assistant_turn WHERE session_id=$1 AND id=$2",
          [id, view.before],
        )
      ).rows[0]
    : null;
  if (view?.before && !cursor)
    throw new AssistantError(422, "assistant_message_page_invalid");
  const stats = (
    await db.query(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE event='user')::int AS users,count(*) FILTER(WHERE event<>'user')::int AS automatic FROM assistant_turn WHERE session_id=$1",
      [id],
    )
  ).rows[0];
  const pageRows = (
    await db.query(
      "SELECT *,xmin::text AS revision FROM assistant_turn WHERE session_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4",
      [
        id,
        cursor?.created_at ?? null,
        cursor?.id ?? null,
        view?.mode === "status" ? 1 : limit + 1,
      ],
    )
  ).rows;
  const more = pageRows.length > limit;
  const rawTurns = pageRows
    .slice(0, view?.mode === "status" ? 1 : limit)
    .reverse();
  const writable = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const currentDeps = await taskDependencies(db, session);
  const allowed = await availableDependencies(db, scope, [
    ...rawTurns.flatMap((t) => t.dependencies),
    ...currentDeps.dependencies,
  ]);
  const permitted = (t: Record<string, any>) =>
    (!t.requires_write || writable) &&
    t.dependencies.every((r: Dependency) => allowed.has(r.kind + ":" + r.id));
  const currentSafe =
    (!currentDeps.requiresWrite || writable) &&
    currentDeps.dependencies.every((r) => allowed.has(r.kind + ":" + r.id));
  const turns = rawTurns.map((t) =>
    permitted(t)
      ? t
      : {
          ...t,
          user_text: "",
          assistant_text: "此历史内容当前不可访问。",
          tool_results: [],
          dependencies: [],
          restricted: true,
        },
  );
  const metadata = rawTurns;
  const ids = turns.filter((t) => !t.restricted).map((t) => t.id);
  const checkedTurns = turns.filter((t) => !t.restricted);
  await reconcileReceipts(db, scope, checkedTurns);
  const pending = currentSafe
    ? (
        await db.query(
          "SELECT id FROM assistant_proposal WHERE session_id=$1 AND task_revision=$2 AND (status IN('pending','executing') OR (status='invalid' AND lease_token IS NOT NULL)) AND (lease_until IS NULL OR lease_until<=now())",
          [id, session.task_revision],
        )
      ).rows
    : [];
  for (const item of pending) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await sessionRow(client, scope, id, true);
      const proposal = (
        await client.query(
          "SELECT * FROM assistant_proposal WHERE id=$1 FOR UPDATE",
          [item.id],
        )
      ).rows[0];
      await recoverProposalReceipt(client, scope, proposal);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const proposals = (
    await db.query(
      "SELECT id,turn_id,action,summary,status,receipt,expires_at,task_revision FROM assistant_proposal WHERE session_id=$1 AND actor_id=$2 AND turn_id=ANY($3::text[]) ORDER BY created_at,id",
      [id, scope.actorId, ids],
    )
  ).rows;
  const context = !view && currentSafe ? await readContext?.() : undefined;
  const backgroundDocuments = await backgroundCatalog(db, scope, id);
  await assistantAccess(
    db,
    scope,
    checkedTurns.some((t) => t.requires_write),
  );
  // Compatibility for pre-contract publication receipts. New delivery plans settle
  // only in advanceExecution; reading a workspace must not become a second controller.
  await db.query(
    `UPDATE assistant_session s SET task=task||'{"stage":"complete"}'::jsonb
     WHERE s.id=$1 AND s.content_revision=$2
       AND s.task->'executionPlan'->>'contractVersion' IS DISTINCT FROM '1'
       AND s.task->>'stage' IN ('awaiting_review','waiting_input')
       AND (s.task->'review'->>'deliveryComplete') IS DISTINCT FROM 'false'
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.task->'executionPlan'->'steps','[]'::jsonb)) step WHERE step->>'status' IS DISTINCT FROM 'executed')
       AND NOT coalesce((s.task->'executionPlan'->>'needsReview')::boolean,false)
       AND NOT coalesce((s.task->>'executionPaused')::boolean,false)
       AND s.task->>'question' IS NULL
       AND EXISTS(SELECT 1 FROM assistant_proposal p WHERE p.session_id=s.id
         AND p.task_revision=s.task_revision AND p.action='publish' AND p.status='succeeded'
         AND p.receipt->'version'->>'id' IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM assistant_turn t WHERE t.session_id=s.id
         AND t.task_revision=s.task_revision AND t.status IN ('queued','running'))
       AND NOT EXISTS(SELECT 1 FROM assistant_proposal p WHERE p.session_id=s.id
         AND p.task_revision=s.task_revision AND p.status IN ('pending','executing'))`,
    [id, session.content_revision],
  );
  const processing = session.task?.runId
    ? (
        await db.query(
          `SELECT r.id,r.options,r.input_count,t.task_revision
           FROM assistant_session s
           JOIN processing_run r ON r.id=s.task->>'runId'
             AND r.project_id=s.project_id AND r.actor_id=s.actor_id
           JOIN assistant_turn t ON t.id=split_part(r.idempotency_key,':',2)
             AND split_part(r.idempotency_key,':',1)='assistant'
             AND t.session_id=s.id AND t.task_revision=s.task_revision
           WHERE s.id=$1 AND s.project_id=$2 AND s.actor_id=$3`,
          [id, scope.projectId, scope.actorId],
        )
      ).rows[0]
    : undefined;
  const current = await sessionRow(db, scope, id);
  if (current.content_revision !== session.content_revision)
    throw new AssistantError(409, "assistant_context_deleted");
  const latestTurn = (
    await db.query(
      "SELECT * FROM assistant_turn WHERE session_id=$1 AND " +
        taskTurnFilter +
        " ORDER BY created_at DESC,id DESC LIMIT 1",
      [id, taskIdentity(current)],
    )
  ).rows[0];
  const recovery = await assistantRecovery(db, scope, current, latestTurn);
  const canRetryTurn = Boolean(recovery.action);
  // Display only the actual failed request and persisted unfinished steps; never reconstruct scope from chat wording.
  const pendingRequest =
    currentSafe && current.task?.planningRecovery?.requestTurnId
      ? ((
          await db.query(
            "SELECT user_text FROM assistant_turn WHERE session_id=$1 AND id=$3 AND " +
              taskTurnFilter,
            [
              id,
              taskIdentity(current),
              current.task.planningRecovery.requestTurnId,
            ],
          )
        ).rows[0]?.user_text ?? null)
      : null;
  const continuation = {
    pendingRequest,
    remainingSteps: (current.task?.executionPlan?.steps ?? [])
      .filter((step: Record<string, any>) => step.status !== "executed")
      .map((step: Record<string, any>) => String(step.title)),
  };
  const workspace = currentSafe
    ? await readWorkspaceFacts(db, scope, current)
    : undefined;
  const presentedTask = taskPresentation(
    currentSafe ? current.task : null,
    processing?.id === current.task?.runId &&
      processing?.task_revision === current.task_revision
      ? processing
      : undefined,
    workspace,
  );
  if (view && presentedTask) {
    delete presentedTask.observations;
    delete presentedTask.turnBudget;
    delete presentedTask.executionBudget;
    delete presentedTask.retryOperations;
    delete presentedTask.supplements;
    delete presentedTask.classifications;
    delete presentedTask.diagnostics;
    if (presentedTask.executionPlan)
      presentedTask.executionPlan.steps = presentedTask.executionPlan.steps.map(
        ({
          input: _input,
          backgroundRead: _backgroundRead,
          ...step
        }: Record<string, any>) => step,
      );
    if (presentedTask.processingScope?.source) {
      presentedTask.processingScope.source = {
        ...presentedTask.processingScope.source,
      };
      delete presentedTask.processingScope.source.recordIds;
    }
  }
  const feedback = presentedTask
    ? assistantFeedback(
        {
          ...current.task,
          requirementProblem: presentedTask.requirementProblem,
          requirementProblemKind: presentedTask.requirementProblemKind,
        },
        {
          revision: Number(current.task_revision),
          workspace,
          recovery,
          hasBackground: backgroundDocuments.length > 0,
          documentsKey: backgroundVersion(backgroundDocuments),
          recoveryReason: recovery.reason,
          summaryFailed:
            latestTurn?.status === "failed" &&
            current.task?.requirementSave?.turnId === latestTurn.id &&
            !unresolvedFailure(latestTurn.tool_results ?? []),
        },
      )
    : undefined;
  const complete = feedback?.kind === "complete";
  return {
    sessionId: id,
    ...(view
      ? {
          taskRevision: Number(current.task_revision),
          latestTurn: metadata!.length
            ? { id: metadata!.at(-1)!.id, status: metadata!.at(-1)!.status }
            : null,
          active: metadata!.some((turn) =>
            ["queued", "running"].includes(turn.status),
          ),
          messageRevision: sha256(
            canonicalJson(
              metadata!.map(({ id, revision }) => ({ id, revision })),
            ),
          ),
        }
      : {}),
    task: presentedTask
      ? {
          ...presentedTask,
          ...(complete
            ? { stage: "complete", error: null, recovery: null }
            : {}),
          canRetryTurn: !complete && canRetryTurn,
          canContinueExecution: !complete && recovery.canExecutePlan,
          recoveryDecision: complete
            ? {
                ...recovery,
                action: null,
                canExecutePlan: false,
                reason: "complete",
                grantOffers: undefined,
              }
            : recovery,
          continuation,
          feedback,
        }
      : presentedTask,
    title: currentSafe
      ? (current.custom_title ?? presentedTask?.title ?? current.title)
      : "历史内容受限",
    ...(view?.mode === "status"
      ? {}
      : {
          turns: turns.map((t) => ({
            id: t.id,
            event: t.event,
            taskId: t.task_id ?? "legacy:" + id,
            restricted: Boolean(t.restricted),
            userText: t.user_text,
            assistantText: t.assistant_text,
            status: t.status,
            errorCode: t.error_code,
            diagnostics: turnDiagnostics(current.task?.observations, t.id),
            tools: t.tool_results,
            createdAt: t.created_at,
          })),
          ...(view
            ? {
                pagination: {
                  total: stats.total,
                  userTurns: stats.users,
                  automaticTurns: stats.automatic,
                  nextBefore: more ? rawTurns[0]?.id : null,
                },
              }
            : {}),
        }),
    proposals: proposals.map((p) => ({
      ...p,
      status: confirmationStatus(p, current),
    })),
    context,
    backgroundDocuments,
  };
}
/** Apply the same historical-content boundary as the detail route, without receipt mutations. */
export async function listSessions(
  db: Database,
  scope: AssistantScope,
  page?: { search: string; offset: number; limit: number },
) {
  await assistantAccess(db, scope);
  const sessions = (
    await db.query(
      `SELECT s.id,s.title,s.custom_title,CASE WHEN $3::boolean THEN jsonb_build_object('title',s.task->'title') ELSE s.task END AS task,s.content_revision,s.created_at,s.updated_at,
    (row_number() OVER(ORDER BY s.created_at,s.id))::int AS ordinal,
    coalesce((SELECT bool_or(t.requires_write) FROM assistant_turn t WHERE t.session_id=s.id AND coalesce(t.task_id,'legacy:'||t.session_id)=coalesce(s.task->>'taskId','legacy:'||s.id)),false) AS requires_write,
    coalesce((SELECT jsonb_agg(t.dependencies) FROM assistant_turn t WHERE t.session_id=s.id AND coalesce(t.task_id,'legacy:'||t.session_id)=coalesce(s.task->>'taskId','legacy:'||s.id)),'[]'::jsonb) AS dependencies
    FROM assistant_session s WHERE project_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id DESC ${page ? "" : "LIMIT 50"}`,
      [scope.projectId, scope.actorId, Boolean(page)],
    )
  ).rows;
  const writable = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const visible: Record<string, any>[] = [];
  const allowed = await availableDependencies(
    db,
    scope,
    sessions.flatMap((s) => s.dependencies.flat()),
  );
  const writableVisible = new Set<string>();
  for (const { requires_write, dependencies, ...session } of sessions) {
    const safe =
      (!requires_write || writable) &&
      dependencies
        .flat()
        .every((r: Dependency) => allowed.has(r.kind + ":" + r.id));
    if (safe) {
      visible.push(session);
      if (requires_write) writableVisible.add(session.id);
    } else
      visible.push({
        ...session,
        task: null,
        title: "历史内容受限",
        custom_title: null,
      });
  }
  await assistantAccess(db, scope, writableVisible.size > 0);
  const current = new Map(
    (
      await db.query(
        "SELECT id,content_revision FROM assistant_session WHERE id=ANY($1::text[])",
        [visible.map((s) => s.id)],
      )
    ).rows.map((s) => [s.id, s.content_revision]),
  );
  const result = visible
    .filter((s) => current.get(s.id) === s.content_revision)
    .map((row) => {
      const session = { ...row };
      session.task = taskPresentation(row.task);
      session.title =
        session.custom_title ?? session.task?.title ?? session.title;
      delete session.custom_title;
      delete session.content_revision;
      return session;
    });
  if (!page) return result;
  const matches = result.filter((session) =>
    (session.title || `会话 ${session.ordinal}`)
      .toLocaleLowerCase()
      .includes(page.search.toLocaleLowerCase()),
  );
  return {
    sessions: matches
      .slice(page.offset, page.offset + page.limit)
      .map(({ id, title, ordinal, updated_at }) => ({
        id,
        title,
        ordinal,
        updated_at,
      })),
    pagination: {
      total: matches.length,
      offset: page.offset,
      limit: page.limit,
    },
  };
}
export async function renameSession(
  db: Database,
  scope: AssistantScope,
  id: string,
  body: unknown,
) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some((key) => key !== "title") ||
    typeof body.title !== "string" ||
    !body.title.trim() ||
    body.title.trim().length > 80
  )
    throw new AssistantError(422, "assistant_title_invalid");
  await sessionRow(db, scope, id);
  const result = await db.query(
    "UPDATE assistant_session SET custom_title=$4,updated_at=now() WHERE id=$1 AND project_id=$2 AND actor_id=$3 RETURNING id,title,custom_title",
    [id, scope.projectId, scope.actorId, body.title.trim()],
  );
  if (!result.rowCount) throw new AssistantError(404, "assistant_not_found");
  return { sessionId: id, title: result.rows[0].custom_title };
}
export async function startTurn(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  key: unknown,
  text: unknown,
  pageContext?: unknown,
  candidateSelection?: unknown,
  expectedTaskRevision?: unknown,
  artifacts?: ArtifactRepository,
  operation?: unknown,
  restoreTaskId?: unknown,
) {
  if (
    expectedTaskRevision !== undefined &&
    (!Number.isSafeInteger(expectedTaskRevision) ||
      Number(expectedTaskRevision) < 0)
  )
    throw new AssistantError(422, "assistant_message_invalid");
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 4000
  )
    throw new AssistantError(422, "assistant_message_invalid");
  if (
    operation !== undefined &&
    (![
      "execute_plan",
      "resume",
      "save_candidates",
      "save_candidates_new",
    ].includes(String(operation)) ||
      typeof operation !== "string" ||
      expectedTaskRevision === undefined)
  )
    throw new AssistantError(422, "assistant_message_invalid");
  if (
    restoreTaskId !== undefined &&
    (typeof restoreTaskId !== "string" ||
      !restoreTaskId.trim() ||
      restoreTaskId.length > 250 ||
      expectedTaskRevision === undefined ||
      operation !== undefined ||
      pageContext !== undefined ||
      candidateSelection !== undefined)
  )
    throw new AssistantError(422, "assistant_message_invalid");
  let page: Dependency | undefined;
  let inputSelection:
    | { recordIds: string[]; sourceRevision: string; total?: number }
    | undefined;
  if (pageContext !== undefined) {
    if (
      !isPlainObject(pageContext) ||
      Object.keys(pageContext).some(
        (k) => !["kind", "id", "inputSelection"].includes(k),
      ) ||
      !["asset", "draft", "version", "testSet"].includes(
        String(pageContext.kind),
      ) ||
      typeof pageContext.id !== "string" ||
      !pageContext.id.trim() ||
      pageContext.id.length > 250
    )
      throw new AssistantError(422, "assistant_message_invalid");
    if (pageContext.inputSelection !== undefined) {
      const selection = pageContext.inputSelection;
      if (
        pageContext.kind === "testSet" ||
        !isPlainObject(selection) ||
        Object.keys(selection).some(
          (k) => !["recordIds", "sourceRevision", "total"].includes(k),
        ) ||
        !Array.isArray(selection.recordIds) ||
        !selection.recordIds.length ||
        selection.recordIds.length > 10000 ||
        selection.recordIds.some(
          (v) => typeof v !== "string" || !v || v.length > 250,
        ) ||
        new Set(selection.recordIds).size !== selection.recordIds.length ||
        typeof selection.sourceRevision !== "string" ||
        !/^[a-f0-9]{64}$/u.test(selection.sourceRevision)
      )
        throw new AssistantError(422, "assistant_input_selection_invalid");
      inputSelection = selection as typeof inputSelection;
      await assistantAccess(db, scope, true);
    }
    page = {
      kind: pageContext.kind as Dependency["kind"],
      id: pageContext.id,
      focus: true,
    };
    await assistantAccess(db, scope, page.kind === "draft");
  }
  const taskSelection =
    isPlainObject(candidateSelection) && candidateSelection.scope === "task";
  if (
    taskSelection &&
    (!artifacts ||
      Object.keys(candidateSelection).some(
        (k) => !["scope", "reviewRevision", "resultIds"].includes(k),
      ) ||
      typeof candidateSelection.reviewRevision !== "string" ||
      !/^[a-f0-9]{64}$/u.test(candidateSelection.reviewRevision) ||
      !Array.isArray(candidateSelection.resultIds) ||
      !candidateSelection.resultIds.length ||
      candidateSelection.resultIds.length > 10000 ||
      candidateSelection.resultIds.some(
        (id) => typeof id !== "string" || !id || id.length > 250,
      ) ||
      new Set(candidateSelection.resultIds).size !==
        candidateSelection.resultIds.length)
  )
    throw new AssistantError(422, "assistant_candidate_selection_invalid");
  if (
    candidateSelection !== undefined &&
    candidateSelection !== null &&
    !taskSelection &&
    (!isPlainObject(candidateSelection) ||
      Object.keys(candidateSelection).some(
        (k) => !["runId", "resultIds"].includes(k),
      ) ||
      typeof candidateSelection.runId !== "string" ||
      !Array.isArray(candidateSelection.resultIds) ||
      !candidateSelection.resultIds.length ||
      candidateSelection.resultIds.length > 10000 ||
      candidateSelection.resultIds.some(
        (id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id),
      ) ||
      new Set(candidateSelection.resultIds).size !==
        candidateSelection.resultIds.length)
  )
    throw new AssistantError(422, "assistant_candidate_selection_invalid");
  const legacyRequestHash =
    candidateSelection === null
      ? sha256(
          canonicalJson({
            message: text,
            ...(page ? { context: { kind: page.kind, id: page.id } } : {}),
            candidates: null,
          }),
        )
      : candidateSelection
        ? sha256(
            canonicalJson({
              message: text,
              ...(page ? { context: { kind: page.kind, id: page.id } } : {}),
              candidates: candidateSelection,
            }),
          )
        : page
          ? sha256(
              canonicalJson({
                message: text,
                context: { kind: page.kind, id: page.id },
              }),
            )
          : sha256(text);
  const contextRequestHash = inputSelection
    ? sha256(canonicalJson({ legacyRequestHash, inputSelection }))
    : legacyRequestHash;
  const requestHash =
    expectedTaskRevision === undefined
      ? contextRequestHash
      : sha256(
          canonicalJson({
            legacyRequestHash: contextRequestHash,
            expectedTaskRevision,
            ...(operation ? { operation } : {}),
            ...(restoreTaskId !== undefined ? { restoreTaskId } : {}),
          }),
        );
  await readSession(db, scope, sessionId, undefined, {
    mode: "status",
    limit: 1,
  });
  let prepared:
      | {
          selection: TaskCandidateSelection;
          states: { id: string; revision: number }[];
          revision: number;
        }
      | undefined,
    selectionError: unknown;
  if (taskSelection) {
    try {
      const current = await sessionRow(db, scope, sessionId);
      const collection = await taskCandidateCollection(
        db,
        artifacts!,
        scope,
        current.task,
      );
      prepared = {
        selection: resolveTaskSelection(
          collection,
          candidateSelection as TaskCandidateSelection,
          Number(current.task_revision),
        ),
        states: collection.states,
        revision: Number(current.task_revision),
      };
    } catch (error) {
      selectionError = error;
    } // Receipt replay still wins over a changed live collection.
  }
  let inputScope: Record<string, any> | undefined;
  let inputScopeError: unknown;
  if (inputSelection && page) {
    try {
      const source =
        page.kind === "asset"
          ? { kind: "assets", assetIds: [page.id] }
          : { kind: page.kind, id: page.id };
      const data = await previewProcessingInput(
        db,
        scope,
        { source, limit: 10000 },
        "write",
        true,
      );
      if (data.sourceRevision !== inputSelection.sourceRevision)
        throw new AssistantError(409, "assistant_input_selection_changed");
      const wanted = new Set(inputSelection.recordIds);
      const records = data.records.filter((r) => wanted.has(r.id));
      if (records.length !== wanted.size)
        throw new AssistantError(409, "assistant_input_selection_changed");
      inputScope = {
        source,
        recordIds: inputSelection.recordIds,
        hash: sha256(
          canonicalJson({ records, revision: data.revision ?? null }),
        ),
        origin: "ui",
        sourceRevision: inputSelection.sourceRevision,
      };
    } catch (error) {
      inputScopeError = error;
    }
  }
  const observedRevision = Number(
    (await sessionRow(db, scope, sessionId)).task_revision,
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('assistant-concurrency'))",
    );
    if (taskSelection)
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `processing-candidates:${scope.projectId}`,
      ]);
    const session = await sessionRow(client, scope, sessionId, true);
    const prior = (
      await client.query(
        "SELECT * FROM assistant_turn WHERE session_id=$1 AND operation_key=$2",
        [sessionId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AssistantError(409, "idempotency_conflict");
      await client.query("COMMIT");
      return { turn: prior, replayed: true };
    }
    if (inputScopeError) throw inputScopeError;
    const recoveryReceipt = session.task?.recoveryRequests?.[sha256(key)];
    if (recoveryReceipt) {
      if (recoveryReceipt.requestHash !== requestHash)
        throw new AssistantError(409, "idempotency_conflict");
      const recovered = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 AND id=$2",
          [sessionId, recoveryReceipt.turnId],
        )
      ).rows[0];
      if (!recovered)
        throw new AssistantError(409, "assistant_retry_unavailable");
      await client.query("COMMIT");
      return { turn: recovered, replayed: true };
    }
    if (
      expectedTaskRevision !== undefined &&
      Number(session.task_revision) !== expectedTaskRevision
    )
      throw new AssistantError(409, "assistant_plan_revalidation_required");
    if (
      (
        await client.query(
          "SELECT id FROM assistant_proposal WHERE session_id=$1 AND status='executing' AND lease_until>now()",
          [sessionId],
        )
      ).rowCount
    )
      throw new AssistantError(409, "assistant_confirmation_running");
    if (Number(session.task_revision) !== observedRevision)
      throw new AssistantError(409, "assistant_task_changed");
    const boundary = await prepareTaskBoundary(
      client,
      scope,
      session,
      text.trim(),
      restoreTaskId as string | undefined,
    );
    if (
      boundary.switched &&
      (candidateSelection !== undefined || operation !== undefined)
    )
      throw new AssistantError(409, "assistant_task_boundary_required");
    if (boundary.switched && !/当前|这个来源/u.test(text)) {
      page = undefined;
      inputScope = undefined;
    }
    const effectiveText = boundary.request;
    if (boundary.question) {
      const task = {
        ...session.task,
        boundaryQuestion: session.task.boundaryQuestion ?? {
          request: effectiveText,
          taskId: taskIdentity(session),
          kind: boundary.kind ?? "choice",
        },
      };
      const turn = (
        await client.query(
          "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,expires_at,task_revision,task_id) VALUES($1,$2,$3,$4,$5,$6,'succeeded',now(),$7,$8) RETURNING *",
          [
            opaqueId("turn"),
            sessionId,
            key,
            requestHash,
            effectiveText,
            boundary.question,
            session.task_revision,
            taskIdentity(session),
          ],
        )
      ).rows[0];
      await client.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
        sessionId,
        task,
      ]);
      await client.query("COMMIT");
      return { turn, replayed: false };
    }
    if (!boundary.switched && budgetAllowance(session.task)?.reason) {
      const latest = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [sessionId, taskIdentity(session)],
        )
      ).rows[0];
      const recoveryDecision = await assistantRecovery(
        client,
        scope,
        session,
        latest,
      );
      await client.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [sessionId, JSON.stringify({ recoveryDecision })],
      );
      await client.query("COMMIT");
      throw new AssistantError(
        409,
        "assistant_retry_unavailable",
        recoveryDecision.reason,
      );
    }
    const plainContinuation =
      !boundary.switched && Boolean(planningContinuation(effectiveText.trim()));
    if (
      plainContinuation &&
      (session.task?.planningRecovery ||
        session.task?.budgetLedger?.grants?.some(
          (g: any) =>
            g.id === session.task.budgetLedger.activeId &&
            g.purpose !== "initial",
        )) &&
      !candidateSelection &&
      !operation &&
      // Pause/query turns have their own revision and no failed request to retry.
      // A new ordinary turn resumes the original business amendment in the agent,
      // retaining its identity and accumulated allowance instead of retrying a query.
      (!session.task.planningRecovery ||
        session.task.planningRecovery.taskRevision === session.task_revision)
    ) {
      const latest = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (
        Object.keys(session.task.recoveryRequests ?? {}).length >=
        ASSISTANT_SESSION_TURN_LIMIT
      )
        throw new AssistantError(422, "assistant_session_full");
      const replayed = Boolean(
        latest?.resuming && ["queued", "running"].includes(latest.status),
      );
      let turnId = latest?.id;
      if (!replayed) {
        const decision = await assistantRecovery(
          client,
          scope,
          session,
          latest,
        );
        if (planningContinuation(effectiveText) === "plan")
          decision.mode = "plan";
        turnId = (await queueRecovery(client, session, latest, decision))
          .turnId;
      }
      await client.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{recoveryRequests}',coalesce(task->'recoveryRequests','{}'::jsonb)||$2::jsonb) WHERE id=$1",
        [sessionId, JSON.stringify({ [sha256(key)]: { requestHash, turnId } })],
      );
      const recovered = (
        await client.query("SELECT * FROM assistant_turn WHERE id=$1", [turnId])
      ).rows[0];
      await client.query("COMMIT");
      return { turn: recovered, replayed };
    }
    if (taskSelection) {
      if (selectionError) throw selectionError;
      if (!prepared || Number(session.task_revision) !== prepared.revision)
        throw new AssistantError(409, "assistant_candidate_selection_changed");
      await guardProcessingTask(client, {
        ...scope,
        assistantResultsGuard: { states: prepared.states },
      });
    }
    await client.query(
      "UPDATE assistant_turn SET status='interrupted',error_code='assistant_interrupted' WHERE session_id=$1 AND status='running' AND expires_at<=now() AND execution_token IS NULL",
      [sessionId],
    );
    if (
      candidateSelection &&
      !taskSelection &&
      !(
        (session.task?.runIds ??
          (session.task?.runId ? [session.task.runId] : [])) as string[]
      ).includes((candidateSelection as { runId: string }).runId)
    )
      throw new AssistantError(409, "assistant_candidate_selection_changed");
    if (operation && !String(operation).startsWith("save_candidates")) {
      await assistantAccess(client, scope, true);
      const task = session.task;
      const latest = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [sessionId],
        )
      ).rows[0];
      const eligibility = await assistantRecovery(
        client,
        scope,
        session,
        latest,
      );
      if (!eligibility.canExecutePlan)
        throw new AssistantError(
          409,
          "assistant_plan_revalidation_required",
          eligibility.reason,
        );
      if (
        !task?.executionPlan?.steps?.length ||
        task.question ||
        task.requirementProblem ||
        task.planValidationRequired ||
        (operation === "resume"
          ? !task.executionPaused
          : task.executionPlan.mode !== "plan" ||
            task.executionPlan.needsReview)
      )
        throw new AssistantError(409, "assistant_plan_revalidation_required");
    }
    const activeTurns = (
      await client.query(
        "SELECT id FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
        [sessionId],
      )
    ).rows;
    if (activeTurns.length)
      throw new AssistantError(409, "assistant_turn_running");
    const inherited = await taskDependencies(client, session);
    if (inherited.requiresWrite) await assistantAccess(client, scope, true);
    await dependenciesAvailable(client, scope, inherited.dependencies);
    const dependencies = inherited.dependencies.map(({ kind, id }) => ({
      kind,
      id,
    })) as Dependency[];
    if (page) {
      await dependenciesAvailable(client, scope, [page]);
      dependencies.push(page);
    }
    const active = await client.query(
      "SELECT s.actor_id FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.status IN('queued','running') AND t.expires_at>now()",
    );
    if (
      active.rows.length >= 3 ||
      active.rows.some((r) => r.actor_id === scope.actorId)
    )
      throw new AssistantError(409, "assistant_busy");
    const turn = (
      await client.query(
        "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,requires_write,dependencies,task_revision,candidate_selection) VALUES($1,$2,$3,$4,$5,'queued',now()+interval '90 seconds',$6,$7,$8,$9) RETURNING *",
        [
          opaqueId("turn"),
          sessionId,
          key,
          requestHash,
          effectiveText.trim(),
          page?.kind === "draft" || inherited.requiresWrite,
          JSON.stringify(dependencies),
          Number(session.task_revision) + 1,
          prepared?.selection ?? candidateSelection ?? null,
        ],
      )
    ).rows[0];
    await client.query("UPDATE assistant_turn SET task_id=$2 WHERE id=$1", [
      turn.id,
      taskIdentity(session),
    ]);
    turn.task_id = taskIdentity(session);
    // Preserve a committed confirmation before a new turn invalidates pending
    // proposals and requires the remaining plan to be checked again.
    const priorStep =
      session.task?.executionPlan?.steps[session.task.executionPlan.current];
    if (
      priorStep?.status === "waiting" &&
      priorStep.action.startsWith("request_") &&
      priorStep.receipt?.proposalId
    ) {
      const committed = (
        await client.query(
          "SELECT id,status,receipt FROM assistant_proposal WHERE id=$1 AND session_id=$2 AND project_id=$3 AND actor_id=$4 AND task_revision=$5 AND status='succeeded'",
          [
            priorStep.receipt.proposalId,
            sessionId,
            scope.projectId,
            scope.actorId,
            session.task_revision,
          ],
        )
      ).rows[0];
      if (committed)
        session.task = {
          ...session.task,
          executionPlan: advancePlan(
            session.task.executionPlan,
            "confirmed",
            committed,
            priorStep.receipt.key,
            session.task_revision,
          ),
        };
    }
    const continuing = Boolean(session.task?.goal);
    const task: Record<string, any> = continuing
      ? {
          ...session.task,
          supplements: planningContinuation(effectiveText.trim())
            ? (session.task.supplements ?? [])
            : [...(session.task.supplements ?? []), effectiveText.trim()],
          autoCount: session.task.autoCount,
        }
      : {
          goal: effectiveText.trim(),
          originTurnId: turn.id,
          title: initialTaskTitle(effectiveText.trim()),
          supplements: [],
          requirements: [],
          stage: "inspecting",
          autoCount: 0,
          autoEventLimit: null,
          observations: session.task?.observations ?? [],
          ...(session.task?.processingScope
            ? { processingScope: session.task.processingScope }
            : {}),
          ...(session.task?.backgroundEvidence
            ? { backgroundEvidence: session.task.backgroundEvidence }
            : {}),
          ...(page ? { target: { kind: page.kind, id: page.id } } : {}),
        };
    if (inputScope) {
      if (
        continuing &&
        task.uiInputScope &&
        canonicalJson(task.uiInputScope) !== canonicalJson(inputScope)
      )
        throw new AssistantError(409, "assistant_input_selection_changed");
      if (
        continuing &&
        task.target &&
        canonicalJson(
          planSource(task.processingScope?.source ?? task.target),
        ) !== canonicalJson(planSource(inputScope.source))
      )
        throw new AssistantError(409, "assistant_task_boundary_required");
      task.uiInputScope = inputScope;
      task.processingScope = inputScope;
      task.target = inputScope.source;
    }
    task.taskId = taskIdentity(session);
    task.taskContractVersion = 2;
    if (!continuing)
      task.budgetLedger = createBudgetLedger(
        task.taskId,
        scope.actorId,
        Number(turn.task_revision),
      );
    task.boundaryQuestion = null;
    task.turnControl = {
      turnId: turn.id,
      taskRevision: turn.task_revision,
      source: "pending",
    };
    const activeGrant = task.budgetLedger?.grants?.find(
      (g: any) => g.id === task.budgetLedger.activeId,
    );
    if (
      continuing &&
      activeGrant?.purpose !== "initial" &&
      activeGrant &&
      activeGrant.revision !== turn.task_revision
    ) {
      if (session.task.turnBudget?.turnId)
        await closeBudget(client, session, session.task.turnBudget.turnId);
      task.budgetLedger = session.task.budgetLedger;
      task.executionBudget = session.task.executionBudget;
      const now = Date.now(),
        documents = (
          await client.query(
            'SELECT id,sha256,extractor_version AS "extractorVersion" FROM assistant_background_document WHERE session_id=$1',
            [sessionId],
          )
        ).rows;
      task.turnControl = {
        mode: "plan",
        source: "ui",
        turnId: turn.id,
        taskRevision: turn.task_revision,
        requiresUpdate: true,
        updateSaved: false,
      };
      task.planningRecovery = {
        amendment: Boolean(task.executionPlan?.steps?.length),
        planKey: planRequirementsKey(task),
        turnId: turn.id,
        requestTurnId: turn.id,
        taskRevision: turn.task_revision,
        baseRevision: turn.task_revision,
        documentsKey: backgroundVersion(documents),
        evidenceKey: sha256(canonicalJson(task.backgroundEvidence ?? [])),
      };
      task.planValidationRequired = true;
      task.executionPaused = true;
      task.stage = "waiting_input";
      task.budgetPause = "grant_revision_changed";
      // No work is dispatched. This zero-use checkpoint retains the exact new user request for an explicitly authorized planning attempt.
      task.turnBudget = {
        turnId: turn.id,
        startedAt: now,
        deadlineAt: now,
        accountingVersion: 2,
        activeMs: 0,
        modelSteps: 0,
        toolCalls: 0,
        transportRetries: 0,
        requestAttempts: 0,
        requests: [],
        retryWaits: [],
      };
      await client.query(
        "UPDATE assistant_turn SET status='failed',error_code='assistant_budget_exhausted',assistant_text=$2 WHERE id=$1",
        [
          turn.id,
          "新要求已保留；原追加额度仅适用此前要求。请核对新要求后决定是否授权一段有限规划。",
        ],
      );
      turn.status = "failed";
    }
    // A new revision invalidates only uncommitted confirmation cards. Restore
    // their pending preparation; committed receipts above remain historical facts.
    if (task.executionPlan)
      task.executionPlan = {
        ...task.executionPlan,
        steps: task.executionPlan.steps.map((step: Record<string, any>) => {
          if (step.status !== "waiting" || !step.action.startsWith("request_"))
            return step;
          const pending = { ...step };
          delete pending.receipt;
          delete pending.operation;
          delete pending.revision;
          return { ...pending, status: "pending" };
        }),
      };
    if (operation)
      task.turnControl = {
        mode: "execute",
        source: "ui",
        turnId: turn.id,
        taskRevision: turn.task_revision,
        updateSaved: true,
      };
    if (String(operation).startsWith("save_candidates")) {
      if (!prepared?.selection || prepared.selection.scope !== "task")
        throw new AssistantError(422, "assistant_candidate_selection_invalid");
      await assistantAccess(client, scope, true);
      task.uiCandidateSave = {
        turnId: turn.id,
        newDraft: operation === "save_candidates_new",
      };
    }
    if (candidateSelection !== undefined)
      task.selectedCandidates = prepared?.selection ?? candidateSelection;
    await client.query(
      "UPDATE assistant_proposal SET status='invalid' WHERE session_id=$1 AND status='pending'",
      [sessionId],
    );
    await client.query(
      "UPDATE assistant_session SET updated_at=now(),task=$2,title=$3,task_revision=task_revision+1 WHERE id=$1",
      [sessionId, task, task.title],
    );
    await client.query("COMMIT");
    return { turn, replayed: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function turnFence(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  turnId: string,
  token?: string,
  purpose: "execute" | "settle" = "execute",
) {
  await assistantAccess(db, scope);
  const row = (
    await db.query(
      "SELECT t.*,s.task,s.task_revision AS session_revision,s.task->'turnBudget' AS budget FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.id=$1 AND s.project_id=$2 AND s.actor_id=$3 AND t.status='running' AND t.expires_at>now() AND t.task_revision=s.task_revision AND ($4::text IS NULL OR t.execution_token=$4)",
      [turnId, scope.projectId, scope.actorId, token ?? null],
    )
  ).rows[0];
  if (!row) throw new AssistantError(409, "assistant_interrupted");
  if (row.budget?.turnId === turnId && row.budget.deadlineAt <= Date.now())
    throw new AssistantError(409, "assistant_budget_exhausted");
  if (row.requires_write) await assistantAccess(db, scope, true);
  if (row.task?.recoverySegment?.turnId === turnId) {
    const d = await assistantRecovery(
      db,
      scope,
      {
        id: row.session_id,
        task: row.task,
        task_revision: row.session_revision,
      },
      row,
      { phase: "commit", token },
    );
    if (!d.action && !(purpose === "settle" && d.reason === "complete"))
      throw new AssistantError(409, "assistant_retry_unavailable", d.reason);
  }
  await dependenciesAvailable(db, scope, row.dependencies);
  return row;
}
export async function saveProposal(
  db: Database,
  scope: AssistantScope,
  turnId: string,
  action: string,
  parameters: Record<string, unknown>,
  summary: Record<string, unknown>,
  token?: string,
) {
  await turnFence(db, scope, turnId, token);
  await assistantAccess(db, scope, true);
  const digest = sha256(canonicalJson({ action, parameters }));
  const row = (
    await db.query(
      `INSERT INTO assistant_proposal(id,turn_id,session_id,project_id,actor_id,action,parameters,digest,summary,expires_at,task_revision)
    SELECT $1,t.id,t.session_id,$2,$3,$4,$5,$6,$7,now()+interval '20 minutes'  ,t.task_revision FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.id=$8 AND ($9::text IS NULL OR t.execution_token=$9) AND t.task_revision=s.task_revision AND t.status='running' AND t.expires_at>now()
    ON CONFLICT(turn_id,digest) DO UPDATE SET digest=excluded.digest RETURNING id,summary,status`,
      [
        opaqueId("proposal"),
        scope.projectId,
        scope.actorId,
        action,
        parameters,
        digest,
        summary,
        turnId,
        token ?? null,
      ],
    )
  ).rows[0];
  if (!row) throw new AssistantError(409, "assistant_interrupted");
  return { ...row, requiresUserConfirmation: true };
}

/** Read already committed domain receipts only; expiration never authorizes a new effect. */
export async function clearConfirmedCandidateSelection(
  db: Pick<Database, "query">,
  proposal: Record<string, any>,
) {
  if (proposal.action !== "processing") return;
  await db.query(
    "UPDATE assistant_session SET task=task||'{\"selectedCandidates\":null}'::jsonb WHERE id=$1 AND task_revision=$2",
    [proposal.session_id, proposal.task_revision],
  );
}

export async function recoverProposalReceipt(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  proposal: Record<string, any>,
) {
  // Processing-page confirmation can fulfill the exact same frozen operation.
  // Selection and publication still require this proposal's own confirmation lease.
  if (!proposal.lease_token && proposal.action !== "processing") return;
  if (
    !["pending", "executing", "invalid"].includes(proposal.status) ||
    (proposal.lease_until &&
      new Date(proposal.lease_until).getTime() > Date.now())
  )
    return;
  if (proposal.status === "invalid" && !proposal.lease_token) return;
  if (
    sha256(
      canonicalJson({
        action: proposal.action,
        parameters: proposal.parameters,
      }),
    ) !== proposal.digest
  )
    return;
  await assistantAccess(db, scope, true);
  const p = proposal.parameters;
  let receipt: Record<string, any> | undefined;
  const refs: Dependency[] = [];
  if (proposal.action === "processing") {
    let row = proposal.lease_token
      ? (
          await db.query(
            "SELECT receipt,asset_id,draft_id FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND run_id=$4",
            [scope.projectId, scope.actorId, proposal.id, p.runId],
          )
        ).rows[0]
      : undefined;
    if (!row && proposal.status !== "invalid") {
      const ids = [...p.resultIds].sort(
        (a: string, b: string) =>
          Number(a.split(":")[0]) - Number(b.split(":")[0]) ||
          Number(a.split(":")[1]) - Number(b.split(":")[1]),
      );
      const requestHash = processingAcceptanceHash(
        ids,
        p.target,
        p.resultGroups,
      );
      row = (
        await db.query(
          `SELECT receipt,asset_id,draft_id FROM processing_acceptance
          WHERE project_id=$1 AND actor_id=$2 AND run_id=$3 AND request_hash=$4
          AND EXISTS(SELECT 1 FROM assistant_session WHERE id=$5 AND task_revision=$6)
          ORDER BY created_at,id LIMIT 1`,
          [
            scope.projectId,
            scope.actorId,
            p.runId,
            requestHash,
            proposal.session_id,
            proposal.task_revision,
          ],
        )
      ).rows[0];
    }
    if (row) {
      receipt = { receipt: row.receipt, replayed: true };
      refs.push({ kind: "asset", id: row.asset_id });
      if (row.draft_id) refs.push({ kind: "draft", id: row.draft_id });
    }
  } else if (proposal.action === "selection") {
    const row = (
      await db.query(
        "SELECT receipt,apply_digest FROM selection_preview WHERE id=$1 AND project_id=$2 AND draft_id=$3 AND applied_by=$4 AND (receipt->>'revision')::bigint=$5",
        [
          p.previewId,
          scope.projectId,
          p.draftId,
          scope.actorId,
          p.expectedRevision + 1,
        ],
      )
    ).rows[0];
    if (
      row?.receipt &&
      row.apply_digest === sha256(canonicalJson([...p.selectedIds].sort()))
    ) {
      receipt = { ...row.receipt, replayed: true };
      refs.push({ kind: "draft", id: p.draftId });
    }
  } else if (proposal.action === "publish") {
    const row = (
      await db.query(
        "SELECT ts.id AS test_set_id,ts.name,ts.purpose,v.id,v.version_label,v.item_count FROM collaborative_draft d JOIN test_set_version v ON v.id=d.published_version_id JOIN test_set ts ON ts.id=v.test_set_id WHERE d.id=$1 AND d.project_id=$2 AND d.status='published' AND d.revision=$3 AND d.updated_by=$4 AND v.status='published' AND ts.status='available'",
        [p.draftId, scope.projectId, p.revision + 1, scope.actorId],
      )
    ).rows[0];
    if (row) {
      receipt = {
        testSet: { id: row.test_set_id, name: row.name, purpose: row.purpose },
        version: {
          id: row.id,
          label: row.version_label,
          recordCount: Number(row.item_count),
        },
        replayed: true,
      };
      refs.push({ kind: "version", id: row.id });
    }
  }
  if (!receipt) {
    // The revoked lease cannot commit later; avoid repeatedly looking up an absent receipt.
    if (proposal.status === "invalid")
      await db.query(
        "UPDATE assistant_proposal SET lease_token=NULL WHERE id=$1 AND status='invalid'",
        [proposal.id],
      );
    return;
  }
  for (const ref of refs)
    await processingSourceAvailable(
      db,
      scope.projectId,
      ref.kind === "asset"
        ? { kind: "assets", assetIds: [ref.id], recordIds: [] }
        : { kind: ref.kind as "draft" | "version", id: ref.id, recordIds: [] },
      true,
    );
  await db.query(
    "UPDATE assistant_turn SET dependencies=dependencies||$2::jsonb WHERE id=$1 AND error_code IS DISTINCT FROM 'assistant_context_deleted'",
    [proposal.turn_id, JSON.stringify(refs)],
  );
  await db.query(
    "UPDATE assistant_proposal SET status='succeeded',receipt=$2,lease_until=NULL WHERE id=$1 AND status IN('pending','executing','invalid')",
    [proposal.id, receipt],
  );
  await clearConfirmedCandidateSelection(db, proposal);
  return receipt;
}

/** Only committed domain receipts establish partial submission, never an error-code guess. */
export async function recoverAssistantPartialReceipt(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  item: Record<string, any>,
) {
  if (item.name !== "generate_candidates") return;
  await assistantAccess(db, scope, true);
  const target = (
    await db.query(
      "SELECT d.id,d.name FROM draft_creation_receipt r JOIN collaborative_draft d ON d.id=r.draft_id WHERE r.project_id=$1 AND r.actor_id=$2 AND r.operation_key=$3",
      [scope.projectId, scope.actorId, item.key + ":target"],
    )
  ).rows[0];
  const prepared = (
    await db.query(
      "SELECT 1 FROM assistant_session WHERE project_id=$1 AND actor_id=$2 AND task->'generationPreparation'->>'key'=$3",
      [scope.projectId, scope.actorId, item.key],
    )
  ).rowCount;
  if (!target && !prepared) return;
  if (target)
    await processingSourceAvailable(
      db,
      scope.projectId,
      { kind: "draft", id: target.id, recordIds: [] },
      true,
    );
  return {
    effect: "partial" as const,
    result: {
      requirementsSaved: !!prepared,
      ...(target ? { draftId: target.id, name: target.name } : {}),
    },
    references: target ? [{ kind: "draft" as const, id: target.id }] : [],
  };
}

export async function recoverAssistantReceipt(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  item: Record<string, any>,
) {
  let result: unknown;
  let references: Dependency[] = [];
  if (item.name === "plan_task") {
    // Query control is available to viewers; recovery cannot grant write access.
    await assistantAccess(db, scope);
    const row = (
      await db.query(
        "SELECT id,task,task_revision FROM assistant_session WHERE project_id=$1 AND actor_id=$2 AND ((task->'requirementSave'->>'key'=$3 AND task->'requirementSave'->>'taskRevision'=task_revision::text) OR (task->'requirementCheck'->>'key'=$3 AND task->'requirementCheck'->>'taskRevision'=task_revision::text))",
        [scope.projectId, scope.actorId, item.key],
      )
    ).rows[0];
    let verification =
      row?.task.requirementCheck?.key === item.key &&
      row.task.requirementCheck.requirementsKey ===
        planRequirementsKey(row.task)
        ? row.task.requirementCheck.verification
        : undefined;
    if (verification) {
      const documents = (
        await db.query(
          'SELECT id,sha256,extractor_version AS "extractorVersion" FROM assistant_background_document WHERE session_id=$1',
          [row.id],
        )
      ).rows;
      // The task revision alone does not prove the selected documents are unchanged.
      if (
        !planVerificationCurrent(
          row.task,
          Number(row.task_revision),
          backgroundVersion(documents),
        )
      )
        verification = undefined;
    }
    if (row && (row.task.requirementSave?.key === item.key || verification))
      result = {
        recovered: true,
        ...(verification ? { verification } : {}),
        control: row.task.turnControl,
        task: {
          executionPlan: row.task.executionPlan,
          requirements: row.task.requirements,
          targetCount: row.task.targetCount,
          overallTargetCount: row.task.overallTargetCount,
          summary: requirementSummary(row.task),
        },
      };
  } else if (item.name === "create_draft") {
    await assistantAccess(db, scope, true);
    const row = (
      await db.query(
        "SELECT d.id,d.name,d.revision FROM draft_creation_receipt receipt JOIN collaborative_draft d ON d.id=receipt.draft_id WHERE receipt.project_id=$1 AND receipt.actor_id=$2 AND receipt.operation_key=$3",
        [scope.projectId, scope.actorId, item.key],
      )
    ).rows[0];
    if (row) {
      references = [{ kind: "draft", id: row.id }];
      await processingSourceAvailable(
        db,
        scope.projectId,
        { kind: "draft", id: row.id, recordIds: [] },
        true,
      );
      result = {
        draftId: row.id,
        name: row.name,
        revision: Number(row.revision),
        recovered: true,
        url: `/projects/${scope.projectId}/test-sets/drafts/${row.id}`,
      };
    }
  } else if (
    ["submit_processing", "generate_candidates", "refine_candidates"].includes(
      item.name,
    )
  ) {
    await assistantAccess(db, scope, true);
    const rows = (
      await db.query(
        "SELECT r.id,r.source,r.input_ref,r.input_count,r.target_draft_id,j.status FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.project_id=$1 AND r.actor_id=$2 AND (r.idempotency_key=$3 OR ($4 AND left(r.idempotency_key,length($3)+1)=$3||':')) ORDER BY (r.idempotency_key=$3) DESC,r.created_at,r.id",
        [
          scope.projectId,
          scope.actorId,
          item.key,
          item.name === "refine_candidates",
        ],
      )
    ).rows;
    const row = rows.at(-1);
    if (row?.input_ref) {
      for (const found of rows) {
        await processingSourceAvailable(
          db,
          scope.projectId,
          found.source,
          true,
        );
        references.push(
          ...(found.source.kind === "assets"
            ? found.source.assetIds.map((id: string) => ({
                kind: "asset" as const,
                id,
              }))
            : found.source.kind === "background"
              ? []
              : [{ kind: found.source.kind, id: found.source.id }]),
        );
      }
      result = {
        runId: row.id,
        ...(rows.length > 1 ? { runIds: rows.map((found) => found.id) } : {}),
        status: row.status,
        inputCount: row.input_count,
        ...(item.name === "generate_candidates"
          ? { draftId: row.target_draft_id }
          : {}),
        recovered: true,
        url: `/projects/${scope.projectId}/processing?run=${row.id}`,
      };
    }
  }
  return result ? { result, references } : undefined;
}

async function reconcileReceipts(
  pool: Database,
  scope: AssistantScope,
  turns: Record<string, any>[],
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const turn of turns) {
      if (turn.status === "running") continue;
      for (const item of turn.tool_results as Record<string, any>[]) {
        if (!["started", "failed"].includes(item.status)) continue;
        const recovered = await recoverAssistantReceipt(db, scope, item);
        const result = recovered?.result;
        const references = recovered?.references ?? [];
        if (result) {
          const restored = { ...item, status: "succeeded", result };
          const saved = await db.query(
            "UPDATE assistant_turn SET dependencies=dependencies||$4::jsonb,requires_write=true,tool_results=(SELECT coalesce(jsonb_agg(CASE WHEN x->>'key'=$2 THEN $3::jsonb ELSE x END),'[]') FROM jsonb_array_elements(tool_results) x) WHERE id=$1 AND status<>'running' AND error_code IS DISTINCT FROM 'assistant_context_deleted' RETURNING id",
            [
              turn.id,
              item.key,
              JSON.stringify(restored),
              JSON.stringify(references),
            ],
          );
          if (saved.rowCount) Object.assign(item, restored);
        }
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** Explicit historical reads never update the current task or authorization. */
export async function readTaskCheckpoint(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  taskId: string,
) {
  await sessionRow(db, scope, sessionId);
  const row = (
    await db.query(
      "SELECT * FROM assistant_task_checkpoint WHERE session_id=$1 AND id=$2",
      [sessionId, taskId],
    )
  ).rows[0];
  if (!row) throw new AssistantError(404, "assistant_not_found");
  await assistantAccess(db, scope, row.requires_write);
  await dependenciesAvailable(db, scope, row.dependencies);
  return {
    active: false,
    taskId: row.id,
    taskRevision: row.revision,
    task: {
      ...taskPresentation(row.task),
      canContinueExecution: false,
      canRetryTurn: false,
    },
    savedAt: row.saved_at,
  };
}
