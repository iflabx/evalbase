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
}: Pick<
  ServerContext,
  "app" | "db" | "config" | "authenticate" | "writeAllowed" | "artifacts"
> & { dispatch?: boolean }) {
  const host = new FormalSessionHost(db, config, { artifacts });
  if (dispatch)
    app.addHook("onReady", async () => {
      host.start();
    });
  app.addHook("onClose", () => host.close());
  const base = "/api/projects/:projectId/assistant-runtime/sessions";
  type Params = { projectId: string; sessionId: string };
  const invoke = async (
    request: unknown,
    reply: any,
    write: boolean,
    run: (scope: SessionScope) => Promise<unknown>,
  ) => {
    const req = request as AuthenticatedRequest & { params: Params };
    if (write && !writeAllowed(req, req.actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      return await run({
        projectId: req.params.projectId,
        actorId: req.actor.id,
      });
    } catch (error) {
      if (error instanceof SessionError || error instanceof ProcessingError)
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
        sessions: await host.store.list(scope),
      })),
  );
  app.get<{ Params: Params }>(
    base + "/:sessionId",
    { preHandler: authenticate },
    (req, reply) =>
      invoke(req, reply, false, (scope) =>
        host.present(scope, req.params.sessionId),
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
        return host.present(scope, req.params.sessionId);
      }),
  );
  return host;
}
