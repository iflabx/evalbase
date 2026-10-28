import { FORMAL_RUNTIME_VERSION } from "./session-contract.js";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SessionStore,
  SessionError,
  sessionTitleSql,
  type SessionScope,
} from "./session-store.js";
import {
  extractBackground,
  BACKGROUND_LIMITS,
} from "../processing/extract-background.js";
import type { ArtifactRepository } from "../storage/artifacts.js";

export const workspaceQuery = z
  .object({
    search: z.string().max(200).default(""),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export class WorkspaceStore {
  constructor(
    readonly sessions: SessionStore,
    readonly artifacts: ArtifactRepository,
  ) {}
  private async writable(
    scope: SessionScope,
    id: string,
    client?: PoolClient,
    lock = false,
  ) {
    const session = await this.sessions.get(scope, id, client, lock);
    if (session.invalidated_at) throw new SessionError("context_deleted");
    if (session.runtime_version !== FORMAL_RUNTIME_VERSION)
      throw new SessionError("runtime_contract_changed");
    return session;
  }
  private async write<T>(
    scope: SessionScope,
    id: string,
    action: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.sessions.db.connect();
    try {
      await client.query("BEGIN");
      await this.writable(scope, id, client, true);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async manage<T>(
    scope: SessionScope,
    id: string,
    action: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.sessions.db.connect();
    try {
      await client.query("BEGIN");
      await this.sessions.get(scope, id, client, true);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async list(scope: SessionScope, input: unknown) {
    const q = workspaceQuery.safeParse(input);
    if (!q.success) throw new SessionError("query_invalid", 422);
    await this.sessions.access(scope);
    const rows = await this.sessions.db.query(
      `SELECT id,revision,status,${sessionTitleSql} AS title,updated_at FROM assistant_runtime_session WHERE project_id=$1 AND actor_id=$2 AND deleted_at IS NULL AND (${sessionTitleSql} ILIKE $3 OR requirements->>'objective' ILIKE $3) ORDER BY updated_at DESC,id LIMIT 21 OFFSET $4`,
      [
        scope.projectId,
        scope.actorId,
        "%" + q.data.search.replace(/[\\%_]/g, "\\$&") + "%",
        q.data.offset,
      ],
    );
    return {
      sessions: rows.rows.slice(0, 20),
      nextOffset: rows.rows.length > 20 ? q.data.offset + 20 : null,
    };
  }
  async rename(scope: SessionScope, id: string, input: unknown) {
    const v = z
      .object({
        title: z.string().trim().min(1).max(80),
        expectedRevision: z.number().int().min(1),
      })
      .strict()
      .safeParse(input);
    if (!v.success) throw new SessionError("rename_invalid", 422);
    return this.manage(scope, id, async (client) => {
      const result = await client.query(
        "UPDATE assistant_runtime_session SET title=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND revision=$5 RETURNING revision,title",
        [
          id,
          scope.projectId,
          scope.actorId,
          v.data.title,
          v.data.expectedRevision,
        ],
      );
      if (!result.rowCount)
        throw new SessionError("conversation_revision_conflict");
      return result.rows[0];
    });
  }
  async attachments(scope: SessionScope, id: string) {
    await this.sessions.get(scope, id);
    return (
      await this.sessions.db.query(
        "SELECT id,name,created_at FROM assistant_runtime_attachment WHERE session_id=$1 AND removed_at IS NULL ORDER BY created_at,id",
        [id],
      )
    ).rows;
  }
  async attach(scope: SessionScope, id: string, name: string, bytes: Buffer) {
    await this.sessions.access(scope, true);
    await this.writable(scope, id);
    const extracted = await extractBackground(name, bytes);
    const stored = await this.artifacts.storeImmutable(bytes);
    const c = await this.sessions.db.connect();
    try {
      await c.query("BEGIN");
      await this.sessions.access(scope, true, c, true);
      await this.writable(scope, id, c, true);
      const n = await c.query(
        "SELECT id,object_ref FROM assistant_runtime_attachment WHERE session_id=$1 AND removed_at IS NULL",
        [id],
      );
      if ((n.rowCount ?? 0) >= BACKGROUND_LIMITS.files)
        throw new SessionError("attachment_capacity", 413);
      const existingBytes = (
        await Promise.all(
          n.rows.map((row) => this.artifacts.size(row.object_ref)),
        )
      ).reduce((sum, size) => sum + size, 0);
      if (existingBytes + bytes.byteLength > BACKGROUND_LIMITS.bytes)
        throw new SessionError("attachment_capacity", 413);
      const attachmentId = "attachment_" + randomUUID();
      await c.query(
        "INSERT INTO assistant_runtime_attachment(id,session_id,name,object_ref,extracted) VALUES($1,$2,$3,$4,$5)",
        [attachmentId, id, name, stored.objectRef, JSON.stringify(extracted)],
      );
      await c.query("COMMIT");
      return { id: attachmentId, name };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async document(
    scope: SessionScope,
    id: string,
    attachmentId: string,
    offset = 0,
  ) {
    const before = await this.sessions.get(scope, id);
    const row = (
      await this.sessions.db.query(
        "SELECT id,name,extracted FROM assistant_runtime_attachment WHERE id=$1 AND session_id=$2 AND removed_at IS NULL",
        [attachmentId, id],
      )
    ).rows[0];
    if (!row) throw new SessionError("attachment_not_found", 404);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
      throw new SessionError("query_invalid", 422);
    const after = await this.sessions.get(scope, id);
    if (after.revision !== before.revision)
      throw new SessionError("snapshot_revision_conflict");
    const fragments = row.extracted.fragments;
    return {
      ...row,
      extracted: {
        ...row.extracted,
        fragments: fragments.slice(offset, offset + 5),
      },
      offset,
      total: fragments.length,
      nextOffset: offset + 5 < fragments.length ? offset + 5 : null,
      truncated: offset > 0 || offset + 5 < fragments.length,
    };
  }
  async detach(scope: SessionScope, id: string, attachmentId: string) {
    return this.manage(scope, id, async (client) => {
      const prior = (
        await client.query(
          "SELECT removed_at FROM assistant_runtime_attachment WHERE session_id=$1 AND id=$2 FOR UPDATE",
          [id, attachmentId],
        )
      ).rows[0];
      if (!prior) throw new SessionError("attachment_not_found", 404);
      if (prior.removed_at) return { removed: true };
      await client.query(
        "UPDATE assistant_runtime_attachment SET removed_at=now() WHERE session_id=$1 AND id=$2 AND removed_at IS NULL",
        [id, attachmentId],
      );
      await client.query(
        "SELECT purge_runtime_content($1,'background_deleted')",
        [id],
      );
      return { removed: true };
    });
  }
  async view(scope: SessionScope, id: string) {
    await this.sessions.get(scope, id);
    const events = (
      await this.sessions.db.query(
        "SELECT id,turn_id,kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id DESC LIMIT 300",
        [id],
      )
    ).rows.reverse();
    // Public projection deliberately excludes raw tool arguments, provider requests and checkpoints.
    const process = events
      .filter((e) =>
        [
          "tool_call",
          "tool_result",
          "tool_error",
          "parameter_feedback",
          "execution_paused",
          "execution_error",
          "requirements_saved",
        ].includes(e.kind),
      )
      .map((e) => ({
        id: String(e.id),
        turnId: e.turn_id,
        kind: e.kind,
        name: typeof e.detail?.name === "string" ? e.detail.name : undefined,
        code: typeof e.detail?.code === "string" ? e.detail.code : undefined,
      }));
    const textRows = (
      await this.sessions.db.query(
        "SELECT detail->>'requestId' AS id,turn_id AS \"turnId\",string_agg(detail->>'text','' ORDER BY id) AS text FROM assistant_runtime_event WHERE session_id=$1 AND kind='message_delta' AND detail ? 'text' GROUP BY detail->>'requestId',turn_id ORDER BY min(id) DESC LIMIT 50",
        [id],
      )
    ).rows;
    return {
      cursor: String(events.at(-1)?.id ?? 0),
      process,
      streams: textRows.reverse(),
      attachments: await this.attachments(scope, id),
      nativeActions: events
        .filter(
          (e) =>
            e.kind === "tool_result" &&
            [
              "open_material_upload",
              "open_material_mapping",
              "navigate_project",
            ].includes(e.detail?.name),
        )
        .flatMap((e) => {
          const r = e.detail?.result;
          let value: any = r;
          try {
            const content = r?.kwargs?.content ?? r?.content;
            if (typeof content === "string") value = JSON.parse(content);
          } catch {
            return [];
          }
          const action = value?.nativeAction;
          if (
            !action ||
            !["upload", "mapping", "navigation"].includes(action.kind)
          )
            return [];
          if (
            action.kind === "navigation" &&
            (typeof action.href !== "string" ||
              !/^\/projects\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_/?=&%.-]*)?$/.test(
                action.href,
              ))
          )
            return [];
          return [
            {
              id: String(e.id),
              kind: action.kind,
              ...(typeof action.assetId === "string"
                ? { assetId: action.assetId }
                : {}),
              ...(typeof action.collectionId === "string"
                ? { collectionId: action.collectionId }
                : {}),
              ...(typeof action.href === "string" ? { href: action.href } : {}),
              ...(typeof action.name === "string" ? { name: action.name } : {}),
            },
          ];
        }),
    };
  }
}
