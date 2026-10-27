import { randomUUID } from "node:crypto";
import type { Database } from "../db/pool.js";
import { BusinessError } from "../operations/errors.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  previewProcessingInput,
  processingSourceAvailable,
  processingSourceRows,
} from "../processing/store.js";
import {
  emptyRequirements,
  messageSubmissionSchema,
  requirementChangeSchema,
  validateDelivery,
  type Source,
  type Delivery,
  type SessionRequirements,
} from "./session-contract.js";

export type SessionScope = { projectId: string; actorId: string };
export type TurnProof = SessionScope & {
  sessionId: string;
  turnId: string;
  token: string;
};
export class SessionError extends BusinessError {
  constructor(code: string, status = 409) {
    super(status, code);
  }
}
const opaque = (kind: string) => kind + "_" + randomUUID().replaceAll("-", "");
type Query = Pick<Database, "query">;
export class SessionStore {
  constructor(readonly db: Database) {}
  async access(
    scope: SessionScope,
    write = false,
    client: Query = this.db,
    lock = false,
  ) {
    if (lock) {
      await client.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
        scope.actorId,
      ]);
      await client.query(
        "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
        [scope.projectId, scope.actorId],
      );
    }
    if (
      !(await hasProjectCapability(
        client,
        scope.projectId,
        scope.actorId,
        write ? "write" : "read",
      ))
    )
      throw new SessionError("project_not_found", 404);
  }
  async get(
    scope: SessionScope,
    id: string,
    client: Query = this.db,
    lock = false,
  ) {
    await this.access(scope, false, client, lock);
    const row = (
      await client.query(
        "SELECT * FROM assistant_runtime_session WHERE id=$1 AND project_id=$2 AND actor_id=$3" +
          (lock ? " FOR UPDATE" : ""),
        [id, scope.projectId, scope.actorId],
      )
    ).rows[0];
    if (!row) throw new SessionError("conversation_not_found", 404);
    if (row.runtime_version !== "deepagents-v1")
      throw new SessionError("runtime_version_not_supported");
    // Deny cached history when a read source is no longer visible. Full lifecycle cleanup belongs to R08.
    const refs = (
      await client.query(
        "SELECT DISTINCT detail->'source' AS source FROM assistant_runtime_event WHERE session_id=$1 AND kind='source_read'",
        [id],
      )
    ).rows;
    for (const ref of refs) {
      if (ref.source.kind === "draft") await this.access(scope, true, client);
      await processingSourceAvailable(
        client,
        scope.projectId,
        ref.source,
        lock,
      );
    }
    return row as {
      id: string;
      runtime_version: string;
      revision: number;
      requirements_revision: number;
      requirements: SessionRequirements;
      status: string;
      project_id: string;
      actor_id: string;
    };
  }
  async create(scope: SessionScope) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await this.access(scope, false, client, true);
      const id = opaque("assistant");
      await client.query(
        "INSERT INTO assistant_runtime_session(id,project_id,actor_id) VALUES($1,$2,$3)",
        [id, scope.projectId, scope.actorId],
      );
      await client.query("COMMIT");
      return this.present(scope, id);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async list(scope: SessionScope) {
    await this.access(scope);
    return (
      await this.db.query(
        "SELECT id,revision,status,requirements->>'objective' AS objective,updated_at FROM assistant_runtime_session WHERE project_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id LIMIT 50",
        [scope.projectId, scope.actorId],
      )
    ).rows;
  }
  async present(scope: SessionScope, id: string) {
    const session = await this.get(scope, id);
    const messages = (
      await this.db.query(
        "SELECT id,turn_id,role,content,created_at FROM assistant_runtime_message WHERE session_id=$1 ORDER BY id DESC LIMIT 100",
        [id],
      )
    ).rows.reverse();
    const turns = (
      await this.db.query(
        "SELECT id,submission_id,accepted_revision,status,error_code,created_at,finished_at FROM assistant_runtime_turn WHERE session_id=$1 ORDER BY created_at DESC,id LIMIT 50",
        [id],
      )
    ).rows;
    return {
      session: {
        id: session.id,
        runtime_version: session.runtime_version,
        revision: session.revision,
        requirements_revision: session.requirements_revision,
        requirements: session.requirements,
        status: session.status,
      },
      messages: messages.map((m) => ({
        ...m,
        kind: m.role === "assistant" ? "model_explanation" : "user_input",
        isBusinessReceipt: false,
      })),
      turns,
      capabilities: [
        "read_project",
        "list_sources",
        "read_records",
        ...((await hasProjectCapability(
          this.db,
          scope.projectId,
          scope.actorId,
          "write",
        ))
          ? ["update_requirements"]
          : []),
      ],
      execution: "pending-executor-integration",
    };
  }
  async accept(scope: SessionScope, id: string, input: unknown) {
    const parsed = messageSubmissionSchema.safeParse(input);
    if (!parsed.success) throw new SessionError("message_invalid", 422);
    const payload = parsed.data;
    if (payload.attachments?.length)
      throw new SessionError("attachments_not_available", 422);
    const hash = sha256(canonicalJson({ ...scope, sessionId: id, payload }));
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const session = await this.get(scope, id, client, true);
      // Check a known submission before busy/revision checks: HTTP retries return the original acceptance.
      const old = (
        await client.query(
          "SELECT id,session_id,request_hash,accepted_revision FROM assistant_runtime_turn WHERE submission_id=$1",
          [payload.submissionId],
        )
      ).rows[0];
      if (old) {
        if (old.session_id !== id || old.request_hash !== hash)
          throw new SessionError("submission_conflict");
        await client.query("COMMIT");
        return {
          accepted: true,
          turnId: old.id,
          revision: old.accepted_revision,
          replayed: true,
        };
      }
      if (session.status !== "idle")
        throw new SessionError("conversation_busy");
      if (session.revision !== payload.expectedRevision)
        throw new SessionError("conversation_revision_conflict");
      if (payload.context) {
        if (payload.context.recordIds)
          await this.freezeSource(scope, payload.context);
        await processingSourceAvailable(
          client,
          scope.projectId,
          { ...payload.context, recordIds: payload.context.recordIds ?? [] },
          true,
        );
      }
      const turnId = opaque("turn"),
        revision = session.revision + 1;
      await client.query(
        "INSERT INTO assistant_runtime_turn(id,session_id,submission_id,request_hash,payload,accepted_revision) VALUES($1,$2,$3,$4,$5,$6)",
        [
          turnId,
          id,
          payload.submissionId,
          hash,
          JSON.stringify(payload),
          revision,
        ],
      );
      await client.query(
        "INSERT INTO assistant_runtime_message(session_id,turn_id,role,content) VALUES($1,$2,'user',$3)",
        [id, turnId, payload.text],
      );
      await client.query(
        "UPDATE assistant_runtime_session SET revision=$2,status='busy',updated_at=now() WHERE id=$1",
        [id, revision],
      );
      if (payload.context)
        await client.query(
          "INSERT INTO assistant_runtime_event(session_id,turn_id,kind,detail) VALUES($1,$2,'source_read',$3)",
          [id, turnId, JSON.stringify({ source: payload.context })],
        );
      await client.query("COMMIT");
      return { accepted: true, turnId, revision, replayed: false };
    } catch (e) {
      await client.query("ROLLBACK");
      if ((e as { code?: string }).code === "23505")
        throw new SessionError("submission_conflict");
      throw e;
    } finally {
      client.release();
    }
  }
  async claim(
    scope: SessionScope,
    id: string,
    turnId: string,
  ): Promise<TurnProof> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await this.get(scope, id, client, true);
      const token = opaque("runner");
      const row = (
        await client.query(
          "UPDATE assistant_runtime_turn SET status='running',runner_token=$3 WHERE id=$1 AND session_id=$2 AND status='pending' RETURNING id",
          [turnId, id, token],
        )
      ).rows[0];
      if (!row) throw new SessionError("turn_not_pending");
      await client.query("COMMIT");
      return { ...scope, sessionId: id, turnId, token };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async guard(
    proof: TurnProof,
    write = false,
    client: Query = this.db,
    lock = false,
  ) {
    await this.access(proof, write, client, lock);
    await this.get(proof, proof.sessionId, client, lock);
    const row = (
      await client.query(
        "SELECT payload FROM assistant_runtime_turn WHERE id=$1 AND session_id=$2 AND runner_token=$3 AND status='running'" +
          (lock ? " FOR UPDATE" : ""),
        [proof.turnId, proof.sessionId, proof.token],
      )
    ).rows[0];
    if (!row) throw new SessionError("runtime_interrupted");
    return row.payload as { text: string; context?: Source };
  }
  async event(
    proof: TurnProof,
    kind: string,
    detail: unknown,
    client: Query = this.db,
    key?: string,
  ) {
    await client.query(
      "INSERT INTO assistant_runtime_event(session_id,turn_id,kind,detail,operation_key) VALUES($1,$2,$3,$4,$5)",
      [
        proof.sessionId,
        proof.turnId,
        kind,
        JSON.stringify(detail),
        key ?? null,
      ],
    );
  }
  async finish(
    proof: TurnProof,
    content: string,
    errorCode: string | null = null,
  ) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Status cleanup is server-owned: revocation blocks business writes, not terminalizing our own token.
      const active = (
        await client.query(
          "SELECT t.id FROM assistant_runtime_session s JOIN assistant_runtime_turn t ON t.session_id=s.id WHERE s.id=$1 AND s.project_id=$2 AND s.actor_id=$3 AND t.id=$4 AND t.runner_token=$5 AND t.status='running' FOR UPDATE OF s,t",
          [
            proof.sessionId,
            proof.projectId,
            proof.actorId,
            proof.turnId,
            proof.token,
          ],
        )
      ).rows[0];
      if (!active) throw new SessionError("runtime_interrupted");
      await client.query(
        "INSERT INTO assistant_runtime_message(session_id,turn_id,role,content) VALUES($1,$2,'assistant',$3) ON CONFLICT(turn_id,role) DO NOTHING",
        [proof.sessionId, proof.turnId, content],
      );
      await client.query(
        "UPDATE assistant_runtime_turn SET status=$3,error_code=$4,runner_token=NULL,finished_at=now() WHERE id=$1 AND runner_token=$2",
        [
          proof.turnId,
          proof.token,
          errorCode ? "failed" : "succeeded",
          errorCode,
        ],
      );
      await client.query(
        "UPDATE assistant_runtime_session SET status='idle',updated_at=now() WHERE id=$1",
        [proof.sessionId],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async freezeSource(scope: SessionScope, source: Source) {
    const preview = await previewProcessingInput(
      this.db,
      scope,
      { source, limit: 10000 },
      "read",
      true,
    );
    const selected = source.recordIds ? new Set(source.recordIds) : null;
    const records = preview.records.filter(
      (row) => !selected || selected.has(row.id),
    );
    if (!records.length || (selected && records.length !== selected.size))
      throw new SessionError("processing_scope_invalid", 422);
    return {
      source: { ...source, recordIds: records.map((row) => row.id) },
      sourceSnapshot: {
        hash: sha256(
          canonicalJson({ records, revision: preview.revision ?? null }),
        ),
        revision: preview.revision ?? null,
      },
    };
  }
  async change(proof: TurnProof, input: unknown) {
    const parsed = requirementChangeSchema.safeParse(input);
    if (!parsed.success) throw new SessionError("requirements_invalid", 422);
    const request = parsed.data,
      key = "requirements:" + sha256(canonicalJson(request));
    await this.guard(proof, true);
    const before = await this.get(proof, proof.sessionId);
    const next = structuredClone(before.requirements ?? emptyRequirements());
    if (request.changes.objective !== undefined)
      next.objective = request.changes.objective;
    if (request.changes.mode !== undefined) next.mode = request.changes.mode;
    const changedIds: string[] = [];
    for (const item of request.changes.deliveries ?? []) {
      let value: Delivery;
      if (item.deliveryId) {
        const existing = next.deliveries.find((d) => d.id === item.deliveryId);
        if (!existing) throw new SessionError("delivery_not_found", 404);
        value = { ...existing, ...item.patch };
        if (
          value.source &&
          !Object.hasOwn(item.patch, "source") &&
          existing.sourceSnapshot
        ) {
          const snapshot = await this.freezeSource(proof, value.source);
          if (snapshot.sourceSnapshot.hash !== existing.sourceSnapshot.hash)
            throw new SessionError("source_revision_conflict");
        }
      } else {
        value = { id: opaque("delivery"), status: "active", ...item.patch };
        next.deliveries.push(value);
      }
      if (Object.hasOwn(item.patch, "source")) {
        delete value.sourceSnapshot;
        if (value.source)
          Object.assign(value, await this.freezeSource(proof, value.source));
      }
      validateDelivery(value);
      const index = next.deliveries.findIndex((d) => d.id === value.id);
      next.deliveries[index] = value;
      changedIds.push(value.id);
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await this.guard(proof, true, client, true);
      const old = (
        await client.query(
          "SELECT detail FROM assistant_runtime_event WHERE turn_id=$1 AND operation_key=$2",
          [proof.turnId, key],
        )
      ).rows[0];
      if (old) {
        await client.query("COMMIT");
        return old.detail.receipt;
      }
      const current = await this.get(proof, proof.sessionId, client);
      if (current.requirements_revision !== request.expectedRevision)
        throw new SessionError("requirements_revision_conflict");
      for (const value of next.deliveries) {
        const priorTarget = before.requirements.deliveries.find(
          (d) => d.id === value.id,
        )?.saveTarget;
        const retainedCancelledTarget =
          value.status === "cancelled" &&
          canonicalJson(priorTarget ?? null) ===
            canonicalJson(value.saveTarget ?? null);
        if (value.saveTarget?.kind === "draft" && !retainedCancelledTarget) {
          const target = (
            await client.query(
              "SELECT d.id FROM collaborative_draft d WHERE d.id=$1 AND d.project_id=$2 AND d.status='editing' AND NOT EXISTS(SELECT 1 FROM deletion_lock l WHERE l.project_id=$2 AND l.object_id=d.id) FOR SHARE OF d",
              [value.saveTarget.id, proof.projectId],
            )
          ).rows[0];
          const available = await processingSourceRows(
            client,
            proof.projectId,
            [{ kind: "draft", id: value.saveTarget.id, recordIds: [] }],
            true,
          );
          if (!target || !available.draft.length)
            throw new SessionError("save_target_unavailable", 404);
        }
        if (value.source) {
          await processingSourceAvailable(
            client,
            proof.projectId,
            { ...value.source, recordIds: value.source.recordIds ?? [] },
            true,
          );
          if (value.source.kind === "draft" && value.sourceSnapshot) {
            const row = (
              await client.query(
                "SELECT revision FROM collaborative_draft WHERE id=$1 FOR SHARE",
                [value.source.id],
              )
            ).rows[0];
            if (row?.revision !== value.sourceSnapshot.revision)
              throw new SessionError("source_revision_conflict");
          }
        }
      }
      const unchanged =
        canonicalJson(current.requirements) === canonicalJson(next);
      const revision = current.requirements_revision + (unchanged ? 0 : 1);
      const receipt = {
        saved: true,
        unchanged,
        revision,
        requirements: next,
        changedDeliveryIds: unchanged ? [] : changedIds,
      };
      if (!unchanged)
        await client.query(
          "UPDATE assistant_runtime_session SET requirements=$2,requirements_revision=$3,revision=revision+1,updated_at=now() WHERE id=$1",
          [proof.sessionId, JSON.stringify(next), revision],
        );
      await this.event(
        proof,
        "requirements_saved",
        { request, receipt },
        client,
        key,
      );
      for (const value of next.deliveries)
        if (value.source)
          await this.event(
            proof,
            "source_read",
            { source: value.source },
            client,
          );
      await client.query("COMMIT");
      return receipt;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
