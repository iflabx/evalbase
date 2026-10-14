import type { Database } from "../db/pool.js";
import { hasProjectCapability } from "../security/project-access.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { isPlainObject, opaqueId } from "../server/support.js";
import { processingSourceAvailable } from "../processing/store.js";
import { processingAcceptanceHash } from "../processing/accept.js";
import { backgroundCatalog } from "./background.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
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
) {
  if (!task || !Object.keys(task).length) return task;
  const presented = { ...task };
  delete presented.selectedCandidates;
  delete presented.backgroundDefinitions;
  delete presented.observations;
  delete presented.budgetCheckpoint;
  delete presented.planningCheckpointTurnId;
  delete presented.planValidationRequired;
  if (presented.executionPlan) {
    presented.executionPlan = {
      ...presented.executionPlan,
      steps: presented.executionPlan.steps.map(
        ({ operation: _operation, ...step }: Record<string, any>) => step,
      ),
    };
    delete presented.executionPlan.requirementsKey;
  }
  let requirementProblem = task.requirementProblem ?? null;
  try {
    presented.classifications = validateRules(task);
  } catch (error) {
    if (!(error instanceof RequirementError)) throw error;
    requirementProblem = error.hint;
    presented.classifications = effectiveRules(task);
  }
  delete presented.allowedLabels;
  return {
    ...presented,
    requirementSummary: requirementSummary(task, processing),
    requirementProblem,
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
/** Budget capability only; callers still enforce access and source permissions. */
export function canResumeAssistantTurn(
  turn: Record<string, any> | undefined,
  task: Record<string, any>,
) {
  const budget = task?.turnBudget?.turnId === turn?.id ? task.turnBudget : null;
  return Boolean(
    turn &&
    (["failed", "interrupted"].includes(turn.status) ||
      (task?.error === "assistant_task_limit" &&
        turn.status === "succeeded")) &&
    Number(turn.execution_attempt) < 3 &&
    turn.user_text &&
    (!budget || (budget.deadlineAt > Date.now() && budget.modelSteps < 10)) &&
    task?.stage !== "stopped",
  );
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
export async function dependenciesAvailable(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  dependencies: Dependency[],
) {
  for (const ref of dependencies) {
    try {
      if (ref.kind === "testSet") {
        if (
          !(
            await db.query(
              "SELECT id FROM test_set WHERE id=$1 AND project_id=$2 AND status='available'",
              [ref.id, scope.projectId],
            )
          ).rowCount
        )
          throw new Error("unavailable");
      } else
        await processingSourceAvailable(
          db,
          scope.projectId,
          ref.kind === "asset"
            ? { kind: "assets", assetIds: [ref.id], recordIds: [] }
            : { kind: ref.kind, id: ref.id, recordIds: [] },
        );
    } catch {
      throw new AssistantError(409, "assistant_context_unavailable");
    }
  }
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
  const metadata = view
    ? (
        await db.query(
          "SELECT id,status,requires_write,dependencies,xmin::text AS revision FROM assistant_turn WHERE session_id=$1 ORDER BY created_at,id LIMIT $2",
          [id, ASSISTANT_SESSION_TURN_LIMIT],
        )
      ).rows
    : undefined;
  const end = view?.before
    ? metadata!.findIndex((turn) => turn.id === view.before)
    : metadata?.length;
  if (view?.before && end === -1)
    throw new AssistantError(422, "assistant_message_page_invalid");
  const ids = metadata
    ?.slice(Math.max(0, end! - view!.limit), end)
    .map((turn) => turn.id);
  const turns = (
    await db.query(
      view
        ? "SELECT * FROM assistant_turn WHERE session_id=$1 AND id=ANY($2::text[]) ORDER BY created_at,id"
        : "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at,id LIMIT $2",
      [
        id,
        view
          ? view.mode === "status"
            ? metadata!.slice(-1).map((turn) => turn.id)
            : ids
          : ASSISTANT_SESSION_TURN_LIMIT,
      ],
    )
  ).rows;
  const checkedTurns = metadata ?? turns;
  for (const turn of checkedTurns) {
    if (turn.requires_write) await assistantAccess(db, scope, true);
    await dependenciesAvailable(db, scope, turn.dependencies);
  }
  await reconcileReceipts(db, scope, turns);
  const pending = (
    await db.query(
      "SELECT id FROM assistant_proposal WHERE session_id=$1 AND (status IN('pending','executing') OR (status='invalid' AND lease_token IS NOT NULL)) AND (lease_until IS NULL OR lease_until<=now())",
      [id],
    )
  ).rows;
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
      `SELECT id,turn_id,action,summary,status,receipt,expires_at FROM assistant_proposal WHERE session_id=$1 AND actor_id=$2 ${view ? (view.mode === "status" ? "AND task_revision=$3" : "AND turn_id=ANY($3::text[])") : ""} ORDER BY created_at,id`,
      view
        ? [
            id,
            scope.actorId,
            view.mode === "status" ? session.task_revision : ids,
          ]
        : [id, scope.actorId],
    )
  ).rows;
  const context = !view ? await readContext?.() : undefined;
  const backgroundDocuments = await backgroundCatalog(db, scope, id);
  await assistantAccess(
    db,
    scope,
    checkedTurns.some((t) => t.requires_write),
  );
  // The confirmed publication is the completion fact, even when the model only rereads candidates.
  // A later request has a new task revision and cannot inherit this completion.
  await db.query(
    `UPDATE assistant_session s SET task=task||'{"stage":"complete"}'::jsonb
     WHERE s.id=$1 AND s.content_revision=$2
       AND s.task->>'stage' IN ('awaiting_review','waiting_input')
       AND (s.task->'review'->>'deliveryComplete') IS DISTINCT FROM 'false'
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
  const latestTurn = turns.at(-1);
  const canRetryTurn = Boolean(
    canResumeAssistantTurn(latestTurn, current.task) &&
    (await hasProjectCapability(db, scope.projectId, scope.actorId, "write")),
  );
  const presentedTask = taskPresentation(
    current.task,
    processing?.id === current.task?.runId &&
      processing?.task_revision === current.task_revision
      ? processing
      : undefined,
  );
  if (view && presentedTask) {
    delete presentedTask.observations;
    delete presentedTask.turnBudget;
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
    task: presentedTask ? { ...presentedTask, canRetryTurn } : presentedTask,
    title: current.custom_title ?? presentedTask?.title ?? current.title,
    ...(view?.mode === "status"
      ? {}
      : {
          turns: turns.map((t) => ({
            id: t.id,
            event: t.event,
            userText: t.user_text,
            assistantText: t.assistant_text,
            status: t.status,
            errorCode: t.error_code,
            diagnostics: current.task?.observations?.find(
              (observation: { turnId: string }) => observation.turnId === t.id,
            ),
            tools: t.tool_results,
            createdAt: t.created_at,
          })),
          ...(view
            ? {
                pagination: {
                  total: metadata!.length,
                  nextBefore: end! > view.limit ? ids![0] : null,
                },
              }
            : {}),
        }),
    proposals,
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
    coalesce((SELECT bool_or(t.requires_write) FROM assistant_turn t WHERE t.session_id=s.id),false) AS requires_write,
    coalesce((SELECT jsonb_agg(t.dependencies) FROM assistant_turn t WHERE t.session_id=s.id),'[]'::jsonb) AS dependencies
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
  for (const { requires_write, dependencies, ...session } of sessions) {
    if (requires_write && !writable) continue;
    try {
      await dependenciesAvailable(db, scope, dependencies.flat());
      visible.push(session);
    } catch (error) {
      if (!(error instanceof AssistantError)) throw error;
    }
  }
  await assistantAccess(
    db,
    scope,
    visible.length > 0 &&
      sessions.some(
        (s) => visible.some((v) => v.id === s.id) && s.requires_write,
      ),
  );
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
  let page: Dependency | undefined;
  if (pageContext !== undefined) {
    if (
      !isPlainObject(pageContext) ||
      Object.keys(pageContext).some((k) => !["kind", "id"].includes(k)) ||
      !["asset", "draft", "version", "testSet"].includes(
        String(pageContext.kind),
      ) ||
      typeof pageContext.id !== "string" ||
      !pageContext.id.trim() ||
      pageContext.id.length > 250
    )
      throw new AssistantError(422, "assistant_message_invalid");
    page = {
      kind: pageContext.kind as Dependency["kind"],
      id: pageContext.id,
      focus: true,
    };
    await assistantAccess(db, scope, page.kind === "draft");
    await dependenciesAvailable(db, scope, [page]);
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
  const requestHash =
    expectedTaskRevision === undefined
      ? legacyRequestHash
      : sha256(canonicalJson({ legacyRequestHash, expectedTaskRevision }));
  await readSession(db, scope, sessionId);
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
    if (
      candidateSelection &&
      !taskSelection &&
      !(
        (session.task?.runIds ??
          (session.task?.runId ? [session.task.runId] : [])) as string[]
      ).includes((candidateSelection as { runId: string }).runId)
    )
      throw new AssistantError(409, "assistant_candidate_selection_changed");
    const turns = (
      await client.query(
        "SELECT status,dependencies,requires_write FROM assistant_turn WHERE session_id=$1 ORDER BY created_at,id",
        [sessionId],
      )
    ).rows;
    if (turns.some((t) => ["queued", "running"].includes(t.status)))
      throw new AssistantError(409, "assistant_turn_running");
    if (turns.length >= ASSISTANT_SESSION_TURN_LIMIT)
      throw new AssistantError(422, "assistant_session_full");
    for (const t of turns) {
      if (t.requires_write) await assistantAccess(client, scope, true);
      await dependenciesAvailable(client, scope, t.dependencies);
    }
    const dependencies = [
      ...new Map(
        turns
          .flatMap((t) => t.dependencies)
          .map((d: Dependency) => [
            `${d.kind}:${d.id}`,
            { kind: d.kind, id: d.id },
          ]),
      ).values(),
    ];
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
          text.trim(),
          page?.kind === "draft" || turns.some((t) => t.requires_write),
          JSON.stringify(dependencies),
          Number(session.task_revision) + 1,
          prepared?.selection ?? candidateSelection ?? null,
        ],
      )
    ).rows[0];
    const continuing =
      session.task?.goal &&
      (!["complete", "stopped"].includes(session.task.stage) ||
        (session.task.stage === "stopped" &&
          Array.isArray(candidateSelection?.resultIds) &&
          candidateSelection.resultIds.length > 0));
    const task: Record<string, any> = continuing
      ? {
          ...session.task,
          supplements: [...(session.task.supplements ?? []), text.trim()],
          stage: "inspecting",
          error: null,
          budgetCheckpoint: null,
          ...(session.task.executionPlan
            ? {
                nextAction: null,
                review: null,
                checkedStatus: null,
                executionPlan: {
                  ...session.task.executionPlan,
                  needsReview: true,
                  steps: session.task.executionPlan.steps.map(
                    (step: {
                      action: string;
                      title: string;
                      status: string;
                    }) =>
                      step.status === "waiting" &&
                      step.action.startsWith("request_")
                        ? {
                            title: step.title,
                            action: step.action,
                            status: "pending",
                          }
                        : step,
                  ),
                },
              }
            : {}),
          autoCount:
            session.task.error === "assistant_task_limit"
              ? 0
              : session.task.autoCount,
        }
      : {
          goal: text.trim(),
          title: initialTaskTitle(text.trim()),
          supplements: [],
          requirements: [],
          stage: "inspecting",
          autoCount: 0,
          observations: session.task?.observations ?? [],
          ...(session.task?.processingScope
            ? { processingScope: session.task.processingScope }
            : {}),
          ...(session.task?.backgroundEvidence
            ? { backgroundEvidence: session.task.backgroundEvidence }
            : {}),
          ...(page ? { target: { kind: page.kind, id: page.id } } : {}),
        };
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
  db: Database,
  scope: AssistantScope,
  turnId: string,
  token?: string,
) {
  await assistantAccess(db, scope);
  const row = (
    await db.query(
      "SELECT t.dependencies,t.requires_write,s.task->'turnBudget' AS budget FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.id=$1 AND s.project_id=$2 AND s.actor_id=$3 AND t.status='running' AND t.expires_at>now() AND t.task_revision=s.task_revision AND ($4::text IS NULL OR t.execution_token=$4)",
      [turnId, scope.projectId, scope.actorId, token ?? null],
    )
  ).rows[0];
  if (!row) throw new AssistantError(409, "assistant_interrupted");
  if (row.budget?.turnId === turnId && row.budget.deadlineAt <= Date.now())
    throw new AssistantError(409, "assistant_budget_exhausted");
  if (row.requires_write) await assistantAccess(db, scope, true);
  await dependenciesAvailable(db, scope, row.dependencies);
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

export async function recoverAssistantReceipt(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  item: Record<string, any>,
) {
  let result: unknown;
  let references: Dependency[] = [];
  if (item.name === "create_draft") {
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
  } else if (["submit_processing", "refine_candidates"].includes(item.name)) {
    await assistantAccess(db, scope, true);
    const rows = (
      await db.query(
        "SELECT r.id,r.source,r.input_ref,r.input_count,j.status FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.project_id=$1 AND r.actor_id=$2 AND (r.idempotency_key=$3 OR ($4 AND left(r.idempotency_key,length($3)+1)=$3||':')) ORDER BY (r.idempotency_key=$3) DESC,r.created_at,r.id",
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
            : [{ kind: found.source.kind, id: found.source.id }]),
        );
      }
      result = {
        runId: row.id,
        ...(rows.length > 1 ? { runIds: rows.map((found) => found.id) } : {}),
        status: row.status,
        inputCount: row.input_count,
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
