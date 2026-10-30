import { cleanupProcessingObjects } from "../../processing/cleanup.js";
import {
  HistoryStore,
  isLegacyHistory,
} from "../../assistant-rebuild/history-store.js";
import { SessionDispatcher } from "../../assistant-rebuild/session-dispatcher.js";
import { FORMAL_RUNTIME_VERSION } from "../../assistant-rebuild/session-contract.js";
import { fixedMaterialInput } from "../../assistant-rebuild/input-scope.js";
import { sessionHash } from "../support.js";
import { WorkspaceStore } from "../../assistant-rebuild/workspace-store.js";
import { BusinessError } from "../../operations/errors.js";
import { ProcessingError } from "../../processing/store.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import type { AuthenticatedRequest } from "../support.js";
import { FormalSessionHost } from "../../assistant-rebuild/session-host.js";
import {
  SessionError,
  type SessionScope,
} from "../../assistant-rebuild/session-store.js";

export function registerAssistantRuntime({
  app,
  db,
  config,
  authenticate,
  writeAllowed,
  artifacts,
  dispatch = true,
  summaryTokens,
}: Pick<
  ServerContext,
  "app" | "db" | "config" | "authenticate" | "writeAllowed" | "artifacts"
> & { dispatch?: boolean; summaryTokens?: number }) {
  const host = new FormalSessionHost(db, config, { artifacts });
  const dispatcher = new SessionDispatcher(
    host.execution,
    (scope, sessionId, turnId) =>
      host.runPending(scope, sessionId, turnId, { summaryTokens }),
  );
  if (dispatch)
    app.addHook("onReady", async () => {
      dispatcher.start();
    });
  app.addHook("onClose", async () => {
    await dispatcher.close();
    await host.close();
  });
  const workspace = new WorkspaceStore(host.store, artifacts);
  const history = new HistoryStore(host.store, host.execution);
  const present = (scope: SessionScope, id: string) =>
    isLegacyHistory(id) ? history.present(scope, id) : host.present(scope, id);
  const validateHistory = async (scope: SessionScope, id: string) => {
    if (isLegacyHistory(id)) await history.present(scope, id);
    else await host.store.get(scope, id);
  };
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/assistant-runtime/input-scope",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, (scope) =>
        fixedMaterialInput(host.store, scope, req.body),
      ),
  );
  const base = "/api/projects/:projectId/assistant-runtime/sessions";
  type Params = { projectId: string; sessionId: string };
  const invoke = async (
    request: unknown,
    reply: any,
    write: boolean,
    run: (scope: SessionScope) => Promise<unknown>,
    management = false,
  ) => {
    reply.header("Cache-Control", "no-store");
    const req = request as AuthenticatedRequest & { params: Params };
    if (write && !writeAllowed(req, req.actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      const scope = { projectId: req.params.projectId, actorId: req.actor.id };
      if (write && req.params.sessionId && !management) {
        if (isLegacyHistory(req.params.sessionId))
          throw new SessionError("runtime_contract_changed");
        const session = await host.store.get(scope, req.params.sessionId);
        if (session.invalidated_at) throw new SessionError("context_deleted");
        if (session.runtime_version !== FORMAL_RUNTIME_VERSION)
          throw new SessionError("runtime_contract_changed");
      }
      return await run(scope);
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(422).send({ error: { code: "request_invalid" } });
      if (
        error instanceof BusinessError ||
        error instanceof SessionError ||
        error instanceof ProcessingError
      )
        return reply.code(error.status).send({ error: { code: error.code } });
      throw error;
    }
  };
  app.post<{ Params: Params }>(
    base,
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, (scope) => host.store.create(scope)),
  );
  app.get<{ Params: Params }>(
    base,
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, async (scope) => ({
        ...(await history.list(scope, req.query)),
      })),
  );
  app.get<{ Params: Params }>(
    base + "/:sessionId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, (scope) =>
        present(scope, req.params.sessionId),
      ),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/messages",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, async (scope) => {
        const result = await host.store.accept(
          scope,
          req.params.sessionId,
          req.body,
        );
        return reply.code(result.replayed ? 200 : 202).send(result);
      }),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/control",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, async (scope) => {
        const data = z
          .object({ action: z.enum(["stop", "continue"]) })
          .strict()
          .safeParse(req.body);
        if (!data.success) throw new SessionError("control_invalid", 422);
        return data.data.action === "stop"
          ? host.stop(scope, req.params.sessionId)
          : host.continue(scope, req.params.sessionId);
      }),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/budget-offer",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, (scope) =>
        host.execution.offer(scope, req.params.sessionId),
      ),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/confirmations/:confirmationId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, true, async (scope) => {
        const data = z
          .object({ accept: z.boolean() })
          .strict()
          .safeParse(req.body);
        if (!data.success) throw new SessionError("confirmation_invalid", 422);
        const confirmationId = (
          req.params as Params & { confirmationId: string }
        ).confirmationId;
        if (data.data.accept)
          return host.execution.approve(
            scope,
            req.params.sessionId,
            confirmationId,
            artifacts,
          );
        await host.execution.reject(
          scope,
          req.params.sessionId,
          confirmationId,
        );
        return present(scope, req.params.sessionId);
      }),
  );
  app.patch<{ Params: Params }>(
    base + "/:sessionId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(
        req,
        reply,
        true,
        (scope) =>
          isLegacyHistory(req.params.sessionId)
            ? history.rename(scope, req.params.sessionId, req.body)
            : workspace.rename(scope, req.params.sessionId, req.body),
        true,
      ),
  );
  app.delete<{ Params: Params }>(
    base + "/:sessionId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(
        req,
        reply,
        true,
        async (scope) => {
          const result = await history.remove(
            scope,
            req.params.sessionId,
            req.body,
          );
          await cleanupProcessingObjects(db, artifacts, scope.projectId).catch(
            () => undefined,
          );
          return result;
        },
        true,
      ),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/handoff",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(
        req,
        reply,
        true,
        (scope) => history.handoff(scope, req.params.sessionId, req.body),
        true,
      ),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/attachments",
    {
      preHandler: authenticate,
      bodyLimit: Math.ceil((10 * 1024 * 1024) / 3) * 4 + 2048,
    },
    (req, reply) =>
      invoke(req, reply, true, async (scope) => {
        await host.store.get(scope, req.params.sessionId);
        const body = z
          .object({
            fileName: z.string().max(200),
            contentBase64: z
              .string()
              .max(Math.ceil((10 * 1024 * 1024) / 3) * 4),
          })
          .strict()
          .safeParse(req.body);
        if (!body.success) throw new SessionError("attachment_invalid", 422);
        const bytes = Buffer.from(body.data.contentBase64, "base64");
        if (bytes.toString("base64") !== body.data.contentBase64)
          throw new SessionError("attachment_invalid", 422);
        return workspace.attach(
          scope,
          req.params.sessionId,
          body.data.fileName,
          bytes,
        );
      }),
  );
  type AttachmentParams = Params & { attachmentId: string };
  app.get<{ Params: AttachmentParams }>(
    base + "/:sessionId/attachments/:attachmentId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, (scope) =>
        (isLegacyHistory(req.params.sessionId) ? history : workspace).document(
          scope,
          req.params.sessionId,
          req.params.attachmentId,
          Number((req.query as { offset?: string }).offset ?? 0),
        ),
      ),
  );
  app.delete<{ Params: AttachmentParams }>(
    base + "/:sessionId/attachments/:attachmentId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(
        req,
        reply,
        true,
        (scope) =>
          workspace
            .detach(scope, req.params.sessionId, req.params.attachmentId)
            .then(async (result) => {
              await cleanupProcessingObjects(
                db,
                artifacts,
                scope.projectId,
              ).catch(() => undefined);
              return result;
            }),
        true,
      ),
  );
  app.get<{ Params: Params }>(
    base + "/:sessionId/events",
    { preHandler: authenticate },
    async (req, reply) => {
      const scope = {
        projectId: req.params.projectId,
        actorId: (req as unknown as AuthenticatedRequest).actor.id,
      };
      try {
        await validateHistory(scope, req.params.sessionId);
      } catch (error) {
        if (error instanceof BusinessError)
          return reply.code(error.status).send({ error: { code: error.code } });
        throw error;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false,
        last = "",
        writing = false;
      const timer = setInterval(() => {
        void publish();
      }, 300);
      timer.unref();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        reply.raw.end();
      };
      reply.raw.on("close", close);
      const publish = async () => {
        if (closed || writing) return;
        writing = true;
        try {
          const valid = await db.query(
            "SELECT 1 FROM app_session WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
            [sessionHash(req.cookies.agentbench_session ?? ""), scope.actorId],
          );
          if (!valid.rowCount)
            throw new SessionError("authentication_required", 401);
          const snapshot = await present(scope, req.params.sessionId);
          const data = JSON.stringify(snapshot);
          if (data !== last) {
            last = data;
            reply.raw.write(
              "id: " +
                snapshot.workspace.cursor +
                "\n" +
                "event: snapshot\n" +
                "data: " +
                data +
                "\n\n",
            );
          }
        } catch (error) {
          // A concurrent revision is retried by the next poll, never presented as lost authorization.
          if (
            error instanceof SessionError &&
            error.code === "snapshot_revision_conflict"
          )
            return;
          reply.raw.write("event: access_lost\ndata: {}\n\n");
          close();
        } finally {
          writing = false;
        }
      };
      await publish();
    },
  );
  app.get<{
    Params: Params & { runId: string };
    Querystring: { offset?: string; limit?: string };
  }>(
    base + "/:sessionId/results/:runId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, async (scope) => {
        if (isLegacyHistory(req.params.sessionId))
          await history.resultAllowed(
            scope,
            req.params.sessionId,
            req.params.runId,
          );
        else {
          const session = await host.store.get(scope, req.params.sessionId);
          if (session.invalidated_at) throw new SessionError("context_deleted");
          if (
            !(
              await db.query(
                "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND run_id=$2",
                [req.params.sessionId, req.params.runId],
              )
            ).rowCount
          )
            throw new SessionError("processing_run_not_found", 404);
        }
        const { readProcessingRun } = await import("../../processing/store.js");
        const result = await readProcessingRun(
          db,
          artifacts,
          scope,
          req.params.runId,
          {
            limit: req.query.limit ?? "20",
            offset: req.query.offset ?? "0",
          },
        );
        if (isLegacyHistory(req.params.sessionId))
          await history.resultAllowed(
            scope,
            req.params.sessionId,
            req.params.runId,
          );
        else if (
          (await host.store.get(scope, req.params.sessionId)).invalidated_at
        )
          throw new SessionError("context_deleted");
        return result;
      }),
  );
  app.get<{ Params: Params }>(
    base + "/:sessionId/history",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, async (scope) => {
        await validateHistory(scope, req.params.sessionId);
        const q = z
          .object({ before: z.string().regex(/^[0-9]+$/) })
          .strict()
          .safeParse(req.query);
        if (!q.success) throw new SessionError("query_invalid", 422);
        if (isLegacyHistory(req.params.sessionId))
          return history.messages(scope, req.params.sessionId, q.data.before);
        const before = await host.store.get(scope, req.params.sessionId);
        const rows = (
          await db.query(
            "SELECT id,turn_id,role,content,created_at FROM assistant_runtime_message WHERE session_id=$1 AND id<$2 ORDER BY id DESC LIMIT 101",
            [req.params.sessionId, q.data.before],
          )
        ).rows;
        const after = await host.store.get(scope, req.params.sessionId);
        if (after.revision !== before.revision)
          throw new SessionError("snapshot_revision_conflict");
        return {
          messages: rows.slice(0, 100).reverse(),
          hasEarlier: rows.length > 100,
        };
      }),
  );
  return host;
}
