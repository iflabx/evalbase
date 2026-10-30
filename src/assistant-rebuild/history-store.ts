import { guardAssistantMode } from "../operations/assistant-mode.js";
import { hasProjectCapability } from "../security/project-access.js";
import { processingSourceAvailable } from "../processing/store.js";
import { workspaceQuery } from "./workspace-store.js";
import { sessionTitleSql } from "./session-store.js";
import type { Database } from "../db/pool.js";
import {
  SessionStore,
  SessionError,
  type SessionScope,
} from "./session-store.js";
import { FORMAL_RUNTIME_VERSION } from "./session-contract.js";
import { ExecutionStore } from "./execution-store.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

export const isLegacyHistory = (id: string) => id.startsWith("legacy:");
const numericBudget = (value: unknown): unknown => {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(numericBudget);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, v]) =>
            typeof v === "number" || (v !== null && typeof v === "object"),
        )
        .map(([k, v]) => [k, numericBudget(v)]),
    );
  return null;
};
/** Read-only compatibility, explicit management and migration. No old executor imports. */
export class HistoryStore {
  constructor(
    readonly sessions: SessionStore,
    readonly execution: ExecutionStore,
  ) {}
  private async legacy(
    scope: SessionScope,
    id: string,
    db: Pick<Database, "query"> = this.sessions.db,
    lock = false,
  ) {
    await this.sessions.access(scope, false, db, lock);
    const row = (
      await db.query(
        "SELECT * FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND history_deleted_at IS NULL" +
          (lock ? " FOR UPDATE" : ""),
        [id.slice(7), scope.projectId, scope.actorId],
      )
    ).rows[0];
    if (!row) throw new SessionError("conversation_not_found", 404);
    const turns = (
      await db.query(
        "SELECT dependencies,requires_write FROM assistant_turn WHERE session_id=$1",
        [row.id],
      )
    ).rows;
    if (turns.some((t) => t.requires_write))
      await this.sessions.access(scope, true, db, lock);
    for (const ref of turns.flatMap((t) => t.dependencies ?? [])) {
      if (ref.kind === "asset")
        await processingSourceAvailable(
          db,
          scope.projectId,
          { kind: "assets", assetIds: [ref.id], recordIds: [] },
          lock,
        );
      if (["draft", "version"].includes(ref.kind))
        await processingSourceAvailable(
          db,
          scope.projectId,
          { kind: ref.kind, id: ref.id, recordIds: [] },
          lock,
        );
    }
    return row;
  }
  private async unchanged(
    scope: SessionScope,
    id: string,
    old: { content_revision: number; task_revision: number },
  ) {
    const current = await this.legacy(scope, id);
    if (
      current.content_revision !== old.content_revision ||
      current.task_revision !== old.task_revision
    )
      throw new SessionError("snapshot_revision_conflict");
  }
  async resultAllowed(scope: SessionScope, id: string, runId: string) {
    const old = await this.legacy(scope, id);
    if (old.history_invalidated_at) throw new SessionError("context_deleted");
    if (
      !(
        await this.sessions.db.query(
          "SELECT r.id FROM processing_run r JOIN processing_task t ON t.id=r.task_id WHERE t.assistant_session_id=$1 AND r.id=$2 AND r.project_id=$3",
          [old.id, runId, scope.projectId],
        )
      ).rowCount
    )
      throw new SessionError("processing_run_not_found", 404);
    await this.unchanged(scope, id, old);
  }
  async list(scope: SessionScope, input: unknown) {
    const q = workspaceQuery.parse(input);
    await this.sessions.access(scope);
    const writable = await hasProjectCapability(
      this.sessions.db,
      scope.projectId,
      scope.actorId,
      "write",
    );
    const rows = (
      await this.sessions.db.query(
        `WITH history AS (
   SELECT id,revision,status,${sessionTitleSql} AS title,runtime_version,updated_at,requirements->>'objective' AS goal
   FROM assistant_runtime_session WHERE project_id=$1 AND actor_id=$2 AND deleted_at IS NULL
   UNION ALL
   SELECT 'legacy:'||id,content_revision+1,'history',CASE WHEN history_invalidated_at IS NOT NULL THEN '内容已清理的历史会话' WHEN NOT $5::boolean AND EXISTS(SELECT 1 FROM assistant_turn t WHERE t.session_id=assistant_session.id AND t.requires_write) THEN '历史内容受限' ELSE coalesce(nullif(custom_title,''),nullif(title,''),'历史会话') END,'legacy-ai-sdk',updated_at,''
   FROM assistant_session WHERE project_id=$1 AND actor_id=$2 AND history_deleted_at IS NULL)
   SELECT id,revision,status,title,runtime_version FROM history WHERE title ILIKE $3 OR goal ILIKE $3 ORDER BY updated_at DESC,id LIMIT 21 OFFSET $4`,
        [
          scope.projectId,
          scope.actorId,
          "%" + q.search.replace(/[\\%_]/g, "\\$&") + "%",
          q.offset,
          writable,
        ],
      )
    ).rows;
    return {
      sessions: rows.slice(0, 20),
      nextOffset: rows.length > 20 ? q.offset + 20 : null,
    };
  }
  async messages(scope: SessionScope, id: string, before?: string) {
    const old = await this.legacy(scope, id);
    const rows = (
      await this.sessions.db.query(
        `WITH turns AS (SELECT *,row_number() OVER(ORDER BY created_at,id) AS ordinal FROM assistant_turn WHERE session_id=$1), messages AS (
   SELECT (ordinal*2-1)::bigint AS seq,id AS turn_id,'user' AS role,user_text AS content,created_at FROM turns
   UNION ALL SELECT ordinal*2,id,'assistant',assistant_text,created_at FROM turns)
   SELECT seq::text AS id,turn_id,role,content,created_at FROM messages WHERE ($2::bigint IS NULL OR seq<$2) ORDER BY seq DESC LIMIT 101`,
        [old.id, before ?? null],
      )
    ).rows;
    await this.unchanged(scope, id, old);
    return {
      messages: rows.slice(0, 100).reverse(),
      hasEarlier: rows.length > 100,
    };
  }
  async document(
    scope: SessionScope,
    id: string,
    documentId: string,
    offset = 0,
  ) {
    const old = await this.legacy(scope, id);
    const row = (
      await this.sessions.db.query(
        "SELECT id,file_name AS name,fragments FROM assistant_background_document WHERE session_id=$1 AND id=$2 AND actor_id=$3",
        [old.id, documentId, scope.actorId],
      )
    ).rows[0];
    if (!row) throw new SessionError("attachment_not_found", 404);
    if (!Number.isInteger(offset) || offset < 0)
      throw new SessionError("query_invalid", 422);
    await this.unchanged(scope, id, old);
    return {
      id: row.id,
      name: row.name,
      extracted: { fragments: row.fragments.slice(offset, offset + 5) },
      offset,
      total: row.fragments.length,
      nextOffset: offset + 5 < row.fragments.length ? offset + 5 : null,
      truncated: offset > 0 || offset + 5 < row.fragments.length,
    };
  }
  async present(scope: SessionScope, id: string) {
    const old = await this.legacy(scope, id);
    const turns = (
      await this.sessions.db.query(
        "SELECT id,user_text,assistant_text,status,error_code,created_at FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
        [old.id],
      )
    ).rows.reverse();
    const invalid =
      !!old.history_invalidated_at ||
      turns.some((t) => t.error_code === "assistant_context_deleted");
    const proposals = (
      await this.sessions.db.query(
        "SELECT id,action,status,receipt FROM assistant_proposal WHERE session_id=$1 AND status='succeeded' ORDER BY created_at",
        [old.id],
      )
    ).rows;
    const results = invalid
      ? []
      : (
          await this.sessions.db.query(
            "SELECT r.id,r.id AS run_id,j.status,(SELECT coalesce(sum(b.output_count),0)::int FROM processing_batch b WHERE b.run_id=r.id) AS output_count FROM processing_run r JOIN processing_task t ON t.id=r.task_id JOIN job j ON j.id=r.job_id WHERE t.assistant_session_id=$1 AND r.project_id=$2 ORDER BY r.created_at,r.id",
            [old.id, scope.projectId],
          )
        ).rows;
    const messages = invalid ? [] : (await this.messages(scope, id)).messages;
    const attachments = invalid
      ? []
      : (
          await this.sessions.db.query(
            "SELECT id,file_name AS name FROM assistant_background_document WHERE session_id=$1",
            [old.id],
          )
        ).rows;
    await this.unchanged(scope, id, old);
    return {
      contentInvalidated: invalid,
      invalidationReason: invalid ? "context_deleted" : null,
      currentRuntime: FORMAL_RUNTIME_VERSION,
      canWrite: false,
      canResumeCompleted: false,
      session: {
        id,
        runtime_version: "legacy-ai-sdk",
        revision: old.content_revision + 1,
        title: invalid
          ? "来源已失效的历史会话"
          : old.custom_title || old.title || "历史会话",
        requirements_revision: old.task_revision,
        status: "history",
        requirements: {
          objective: invalid ? "" : (old.task?.goal ?? ""),
          mode: "plan",
          deliveries: [],
        },
      },
      messages,
      turns: turns.map((t) => ({
        id: t.id,
        submission_id: t.id,
        status: t.status,
        error_code: t.error_code,
      })),
      execution: null,
      executionReadiness: { ready: false, complete: false, issues: [] },
      confirmations: [],
      receipts: proposals
        .filter((p) => p.receipt)
        .map((p) => ({ ...p.receipt, isCurrent: false })),
      results,
      history: {
        runtime: "legacy-ai-sdk",
        budget: numericBudget(
          old.task?.budgetLedger ?? old.task?.executionBudget,
        ),
        invalidated: invalid,
      },
      workspace: {
        cursor: "0",
        process: [],
        streams: [],
        attachments,
        nativeActions: [],
      },
    };
  }
  async rename(scope: SessionScope, id: string, input: unknown) {
    const v = z
      .object({
        title: z.string().trim().min(1).max(80),
        expectedRevision: z.number().int().min(1),
      })
      .strict()
      .parse(input);
    const c = await this.sessions.db.connect();
    try {
      await c.query("BEGIN");
      const old = await this.legacy(scope, id, c, true);
      if (old.content_revision + 1 !== v.expectedRevision)
        throw new SessionError("conversation_revision_conflict");
      await c.query(
        "UPDATE assistant_session SET custom_title=$2,title=$2,content_revision=content_revision+1,updated_at=now() WHERE id=$1",
        [old.id, v.title],
      );
      await c.query("COMMIT");
      return { title: v.title, revision: v.expectedRevision + 1 };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async remove(scope: SessionScope, id: string, input: unknown) {
    const v = z
      .object({ expectedRevision: z.number().int().min(1) })
      .strict()
      .parse(input);
    const c = await this.sessions.db.connect();
    try {
      await c.query("BEGIN");
      if (isLegacyHistory(id)) {
        const old = await this.legacy(scope, id, c, true);
        if (old.content_revision + 1 !== v.expectedRevision)
          throw new SessionError("conversation_revision_conflict");
        await c.query(
          "SELECT purge_legacy_history($1,'conversation_deleted',true)",
          [old.id],
        );
      } else {
        const current = await this.sessions.get(scope, id, c, true);
        if (current.revision !== v.expectedRevision)
          throw new SessionError("conversation_revision_conflict");
        await c.query(
          "SELECT purge_runtime_content($1,'conversation_deleted',true)",
          [id],
        );
      }
      await c.query("COMMIT");
      return { deleted: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async handoff(scope: SessionScope, id: string, input: unknown) {
    const v = z
      .object({
        expectedRevision: z.number().int().min(1),
        remainingGoal: z.string().trim().min(1).max(10000),
        authorizeNewBudget: z.literal(true),
      })
      .strict()
      .parse(input);
    const c = await this.sessions.db.connect();
    try {
      await c.query("BEGIN");
      await guardAssistantMode(c);
      await this.sessions.access(scope, true, c, true);
      const source = isLegacyHistory(id)
        ? await this.legacy(scope, id, c, true)
        : await this.sessions.get(scope, id, c, true);
      const revision = isLegacyHistory(id)
        ? source.content_revision + 1
        : source.revision;
      if (revision !== v.expectedRevision)
        throw new SessionError("conversation_revision_conflict");
      if (
        !isLegacyHistory(id) &&
        source.runtime_version === FORMAL_RUNTIME_VERSION
      )
        throw new SessionError("same_runtime_continue_required");
      const kind = isLegacyHistory(id) ? "legacy" : "formal";
      const prior = (
        await c.query(
          "SELECT target_id,source_revision,remaining_goal FROM assistant_runtime_handoff WHERE source_kind=$1 AND source_id=$2 AND actor_id=$3",
          [kind, id, scope.actorId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.source_revision !== revision ||
          prior.remaining_goal !== v.remainingGoal
        )
          throw new SessionError("handoff_already_created");
        await c.query("COMMIT");
        return { sessionId: prior.target_id, replayed: true };
      }
      const target = "assistant_" + randomUUID().replaceAll("-", "");
      // Only the user's explicitly reviewed remainder is carried. No tools, checkpoints, old cards or balance.
      await c.query(
        "INSERT INTO assistant_runtime_session(id,project_id,actor_id,runtime_version,requirements) VALUES($1,$2,$3,$4,$5)",
        [
          target,
          scope.projectId,
          scope.actorId,
          FORMAL_RUNTIME_VERSION,
          JSON.stringify({
            objective: v.remainingGoal,
            mode: "plan",
            deliveries: [],
          }),
        ],
      );
      await this.execution.ensure(c, scope, target);
      await c.query(
        "INSERT INTO assistant_runtime_handoff(source_kind,source_id,target_id,actor_id,project_id,source_revision,remaining_goal) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          kind,
          id,
          target,
          scope.actorId,
          scope.projectId,
          revision,
          v.remainingGoal,
        ],
      );
      await c.query("COMMIT");
      return { sessionId: target, replayed: false };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
