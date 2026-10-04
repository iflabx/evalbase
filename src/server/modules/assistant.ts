import type { FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";
import {
  isPlainObject,
  opaqueId,
  type AuthenticatedRequest,
} from "../support.js";
import { canonicalJson, sha256 } from "../../package/contract.js";
import { applySelectionPreview } from "../../selection/store.js";
import { acceptProcessingResults } from "../../processing/accept.js";
import {
  executeAssistantTurn,
  type DraftCommand,
} from "../../assistant/agent.js";
import {
  assistantAccess,
  AssistantError,
  dependenciesAvailable,
  readSession,
  recoverProposalReceipt,
  sessionRow,
  startTurn,
  type AssistantScope,
} from "../../assistant/store.js";

export function registerAssistant({
  app,
  db,
  artifacts,
  config,
  authenticate,
  writeAllowed,
}: Pick<
  ServerContext,
  "app" | "db" | "artifacts" | "config" | "authenticate" | "writeAllowed"
>) {
  const path = "/api/projects/:projectId/assistant",
    running = new Set<Promise<void>>();
  type Params = { projectId: string; sessionId: string; proposalId: string };
  const scope = (
    request: FastifyRequest<{ Params: Params }>,
  ): AssistantScope => ({
    projectId: request.params.projectId,
    actorId: (request as AuthenticatedRequest).actor.id,
  });
  const command =
    (request: FastifyRequest<{ Params: Params }>): DraftCommand =>
    async (action, input, key) => {
      // Reuse the existing authorized application commands without duplicating either publication protocol.
      const project = encodeURIComponent(request.params.projectId);
      const response = await app.inject({
        method: "POST",
        url:
          action === "create"
            ? `/api/projects/${project}/collaborative-drafts`
            : `/api/projects/${project}/collaborative-drafts/${encodeURIComponent(String(input.draftId))}/publish`,
        headers: {
          cookie: String(request.headers.cookie ?? ""),
          origin: config.appOrigin,
          "x-csrf-token": String(request.headers["x-csrf-token"] ?? ""),
          "idempotency-key": key,
        },
        payload: action === "create" ? input : { revision: input.revision },
      });
      const body = response.json();
      if (response.statusCode >= 400)
        throw new AssistantError(
          response.statusCode,
          body.error?.code ?? "assistant_operation_failed",
        );
      if (action === "publish") {
        const saved = (
          await db.query(
            "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2 AND status='published'",
            [input.draftId, request.params.projectId],
          )
        ).rows[0];
        if (!saved || Number(saved.revision) !== Number(input.revision) + 1)
          throw new AssistantError(409, "draft_revision_conflict");
      }
      return body;
    };
  const write = (request: FastifyRequest, reply: FastifyReply) => {
    if (writeAllowed(request, (request as AuthenticatedRequest).actor))
      return true;
    reply.code(403).send({ error: { code: "csrf_rejected" } });
    return false;
  };
  async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
    try {
      return await action();
    } catch (e) {
      if (e instanceof Error && "status" in e && "code" in e)
        return reply.code(Number(e.status)).send({ error: { code: e.code } });
      throw e;
    }
  }
  app.get<{ Params: Params }>(
    `${path}/sessions`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, async () => {
        const context = scope(request);
        await assistantAccess(db, context);
        return {
          sessions: (
            await db.query(
              "SELECT id,created_at,updated_at FROM assistant_session WHERE project_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 50",
              [context.projectId, context.actorId],
            )
          ).rows,
        };
      }),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/sessions`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        if (!isPlainObject(request.body) || Object.keys(request.body).length)
          throw new AssistantError(422, "assistant_request_invalid");
        const context = scope(request);
        await assistantAccess(db, context);
        const session = (
          await db.query(
            "INSERT INTO assistant_session(id,project_id,actor_id) VALUES($1,$2,$3) RETURNING id",
            [opaqueId("conversation"), context.projectId, context.actorId],
          )
        ).rows[0];
        return reply.code(201).send({ sessionId: session.id });
      });
    },
  );
  app.get<{ Params: Params }>(
    `${path}/sessions/:sessionId`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, () =>
        readSession(db, scope(request), request.params.sessionId),
      ),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/sessions/:sessionId/turns`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        if (
          !isPlainObject(request.body) ||
          Object.keys(request.body).some((k) => k !== "message")
        )
          throw new AssistantError(422, "assistant_message_invalid");
        const context = scope(request),
          started = await startTurn(
            db,
            context,
            request.params.sessionId,
            request.headers["idempotency-key"],
            request.body.message,
          );
        if (!started.replayed) {
          const work = executeAssistantTurn(
            db,
            artifacts,
            config,
            context,
            started.turn,
            command(request),
          );
          running.add(work);
          void work.catch(() => undefined).finally(() => running.delete(work));
        }
        return reply.code(started.replayed ? 200 : 202).send({
          turnId: started.turn.id,
          status: started.turn.status,
          replayed: started.replayed,
        });
      });
    },
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/proposals/:proposalId/confirm`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        if (!isPlainObject(request.body) || Object.keys(request.body).length)
          throw new AssistantError(422, "assistant_confirmation_invalid");
        const context = scope(request);
        await assistantAccess(db, context, true);
        const client = await db.connect();
        let proposal: Record<string, any>;
        const leaseToken = opaqueId("confirmation");
        try {
          await client.query("BEGIN");
          proposal = (
            await client.query(
              "SELECT * FROM assistant_proposal WHERE id=$1 AND project_id=$2 AND actor_id=$3 FOR UPDATE",
              [request.params.proposalId, context.projectId, context.actorId],
            )
          ).rows[0];
          if (!proposal) throw new AssistantError(404, "assistant_not_found");
          await sessionRow(client, context, proposal.session_id);
          const turn = (
            await client.query(
              "SELECT dependencies FROM assistant_turn WHERE id=$1",
              [proposal.turn_id],
            )
          ).rows[0];
          await dependenciesAvailable(client, context, turn.dependencies);
          if (proposal.status === "succeeded") {
            await client.query("COMMIT");
            return { receipt: proposal.receipt, replayed: true };
          }
          const recovered = await recoverProposalReceipt(
            client,
            context,
            proposal,
          );
          if (recovered) {
            await client.query("COMMIT");
            return { receipt: recovered, replayed: true };
          }
          if (
            ["invalid", "rejected"].includes(proposal.status) ||
            new Date(proposal.expires_at).getTime() <= Date.now()
          )
            throw new AssistantError(409, "assistant_confirmation_expired");
          if (
            proposal.status === "executing" &&
            new Date(proposal.lease_until).getTime() > Date.now()
          )
            throw new AssistantError(409, "assistant_confirmation_running");
          if (
            sha256(
              canonicalJson({
                action: proposal.action,
                parameters: proposal.parameters,
              }),
            ) !== proposal.digest
          )
            throw new AssistantError(409, "assistant_confirmation_invalid");
          await client.query(
            "UPDATE assistant_proposal SET status='executing',lease_until=now()+interval '60 seconds',lease_token=$2 WHERE id=$1",
            [proposal.id, leaseToken],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
        try {
          const p = proposal.parameters;
          let receipt: unknown;
          if (proposal.action === "selection")
            receipt = await applySelectionPreview(
              db,
              { ...context, draftId: p.draftId },
              p.previewId,
              {
                selectedIds: p.selectedIds,
                expectedRevision: p.expectedRevision,
              },
            );
          else if (proposal.action === "processing")
            receipt = await acceptProcessingResults(
              db,
              artifacts,
              context,
              p.runId,
              proposal.id,
              { resultIds: p.resultIds, target: p.target },
            );
          else if (proposal.action === "publish")
            receipt = await command(request)("publish", p, proposal.id);
          else throw new AssistantError(422, "assistant_confirmation_invalid");
          await assistantAccess(db, context, true);
          const saved = await db.query(
            "UPDATE assistant_proposal SET status='succeeded',receipt=$2,lease_until=NULL WHERE id=$1 AND status='executing' AND digest=$3 AND lease_token=$4 RETURNING id",
            [proposal.id, receipt, proposal.digest, leaseToken],
          );
          if (!saved.rowCount)
            throw new AssistantError(409, "assistant_context_unavailable");
          return { receipt, replayed: false };
        } catch (e) {
          await db.query(
            "UPDATE assistant_proposal SET status='pending',lease_until=NULL WHERE id=$1 AND status='executing' AND lease_token=$2",
            [proposal.id, leaseToken],
          );
          throw e;
        }
      });
    },
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/proposals/:proposalId/reject`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        const context = scope(request);
        await assistantAccess(db, context);
        const result = await db.query(
          "UPDATE assistant_proposal SET status='rejected' WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND status='pending' RETURNING id",
          [request.params.proposalId, context.projectId, context.actorId],
        );
        if (!result.rowCount)
          throw new AssistantError(409, "assistant_confirmation_unavailable");
        return { rejected: true };
      });
    },
  );
  app.addHook("onClose", async () => {
    await Promise.allSettled([...running]);
  });
}
