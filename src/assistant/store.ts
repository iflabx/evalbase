import type { Database } from "../db/pool.js";
import { hasProjectCapability } from "../security/project-access.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { isPlainObject, opaqueId } from "../server/support.js";
import { processingSourceAvailable } from "../processing/store.js";

export type AssistantScope = { projectId: string; actorId: string };
function initialTaskTitle(text: string) {
  const named = text.match(/本会话命名为[“"「]([^”"」\n]{1,40})[”"」]/u)?.[1];
  return named ?? "新任务";
}
function taskPresentation(task: Record<string, any> | null) {
  if (!task) return task;
  return {
    ...task,
    ...(task.goal && task.title === task.goal.slice(0, 40)
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
export class AssistantError extends Error {
  constructor(
    public status: number,
    public code: string,
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
) {
  const session = await sessionRow(db, scope, id);
  await db.query(
    "UPDATE assistant_turn SET status='interrupted',error_code='assistant_interrupted' WHERE session_id=$1 AND status='running' AND expires_at<=now() AND execution_token IS NULL",
    [id],
  );
  const turns = (
    await db.query(
      "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at,id LIMIT 50",
      [id],
    )
  ).rows;
  for (const turn of turns) {
    if (turn.requires_write) await assistantAccess(db, scope, true);
    await dependenciesAvailable(db, scope, turn.dependencies);
  }
  await reconcileReceipts(db, scope, turns);
  const pending = (
    await db.query(
      "SELECT id FROM assistant_proposal WHERE session_id=$1 AND status IN('pending','executing') AND (lease_until IS NULL OR lease_until<=now())",
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
      "SELECT id,turn_id,action,summary,status,receipt,expires_at FROM assistant_proposal WHERE session_id=$1 AND actor_id=$2 ORDER BY created_at,id",
      [id, scope.actorId],
    )
  ).rows;
  const context = await readContext?.();
  await assistantAccess(
    db,
    scope,
    turns.some((t) => t.requires_write),
  );
  const current = await sessionRow(db, scope, id);
  if (current.content_revision !== session.content_revision)
    throw new AssistantError(409, "assistant_context_deleted");
  return {
    sessionId: id,
    task: taskPresentation(current.task),
    title: taskPresentation(current.task)?.title ?? current.title,
    turns: turns.map((t) => ({
      id: t.id,
      event: t.event,
      userText: t.user_text,
      assistantText: t.assistant_text,
      status: t.status,
      errorCode: t.error_code,
      tools: t.tool_results,
      createdAt: t.created_at,
    })),
    proposals,
    context,
  };
}
/** Apply the same historical-content boundary as the detail route, without receipt mutations. */
export async function listSessions(db: Database, scope: AssistantScope) {
  await assistantAccess(db, scope);
  const sessions = (
    await db.query(
      `SELECT s.id,s.title,s.task,s.content_revision,s.created_at,s.updated_at,
    (row_number() OVER(ORDER BY s.created_at,s.id))::int AS ordinal,
    coalesce((SELECT bool_or(t.requires_write) FROM assistant_turn t WHERE t.session_id=s.id),false) AS requires_write,
    coalesce((SELECT jsonb_agg(t.dependencies) FROM assistant_turn t WHERE t.session_id=s.id),'[]'::jsonb) AS dependencies
    FROM assistant_session s WHERE project_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 50`,
      [scope.projectId, scope.actorId],
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
  return visible
    .filter((s) => current.get(s.id) === s.content_revision)
    .map((row) => {
      const session = { ...row };
      session.task = taskPresentation(row.task);
      session.title = session.task?.title ?? session.title;
      delete session.content_revision;
      return session;
    });
}
export async function startTurn(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  key: unknown,
  text: unknown,
  pageContext?: unknown,
  candidateSelection?: unknown,
) {
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
  if (
    candidateSelection !== undefined &&
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
  const requestHash = candidateSelection
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
  await readSession(db, scope, sessionId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('assistant-concurrency'))",
    );
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
    await client.query(
      "UPDATE assistant_turn SET status='interrupted',error_code='assistant_interrupted' WHERE session_id=$1 AND status='running' AND expires_at<=now() AND execution_token IS NULL",
      [sessionId],
    );
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
      (candidateSelection as { runId: string }).runId !== session.task?.runId
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
    if (turns.length >= 50)
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
          candidateSelection ?? null,
        ],
      )
    ).rows[0];
    const continuing =
      session.task?.goal &&
      !["complete", "stopped"].includes(session.task.stage);
    const task = continuing
      ? {
          ...session.task,
          supplements: [...(session.task.supplements ?? []), text.trim()],
          stage: "inspecting",
          error: null,
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
          ...(page ? { target: { kind: page.kind, id: page.id } } : {}),
        };
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
      "SELECT t.dependencies,t.requires_write FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.id=$1 AND s.project_id=$2 AND s.actor_id=$3 AND t.status='running' AND t.expires_at>now() AND t.task_revision=s.task_revision AND ($4::text IS NULL OR t.execution_token=$4)",
      [turnId, scope.projectId, scope.actorId, token ?? null],
    )
  ).rows[0];
  if (!row) throw new AssistantError(409, "assistant_interrupted");
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
export async function recoverProposalReceipt(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  proposal: Record<string, any>,
) {
  // A proposal that was never confirmed must never claim another action's result.
  if (!proposal.lease_token) return;
  if (
    !["pending", "executing"].includes(proposal.status) ||
    (proposal.lease_until &&
      new Date(proposal.lease_until).getTime() > Date.now())
  )
    return;
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
    const row = (
      await db.query(
        "SELECT receipt,asset_id,draft_id FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND run_id=$4",
        [scope.projectId, scope.actorId, proposal.id, p.runId],
      )
    ).rows[0];
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
  if (!receipt) return;
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
    "UPDATE assistant_proposal SET status='succeeded',receipt=$2,lease_until=NULL WHERE id=$1 AND status IN('pending','executing')",
    [proposal.id, receipt],
  );
  return receipt;
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
        } else if (item.name === "submit_processing") {
          await assistantAccess(db, scope, true);
          const row = (
            await db.query(
              "SELECT r.id,r.source,r.input_ref,r.input_count,j.status FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.project_id=$1 AND r.actor_id=$2 AND r.idempotency_key=$3",
              [scope.projectId, scope.actorId, item.key],
            )
          ).rows[0];
          if (row?.input_ref) {
            await processingSourceAvailable(
              db,
              scope.projectId,
              row.source,
              true,
            );
            references =
              row.source.kind === "assets"
                ? row.source.assetIds.map((id: string) => ({
                    kind: "asset",
                    id,
                  }))
                : [{ kind: row.source.kind, id: row.source.id }];
            result = {
              runId: row.id,
              status: row.status,
              inputCount: row.input_count,
              recovered: true,
              url: `/projects/${scope.projectId}/processing?run=${row.id}`,
            };
          }
        }
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
