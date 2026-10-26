import type { ServerContext } from "../context.js";
import type { AuthenticatedRequest } from "../support.js";
import { RebuildHost } from "../../assistant-rebuild/host.js";
import { RuntimeCommitError } from "../../operations/runtime-guard.js";
import { isPauseRequest } from "../../shared/assistant-control.js";

export async function registerRebuild({
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
  const campaignId = process.env.REBUILD_VALIDATION_CAMPAIGN_ID;
  if (!campaignId) throw new Error("validation_campaign_required");
  const host = new RebuildHost(db, artifacts, config, campaignId);
  await host.initialize();
  app.addHook("onClose", () => host.close());
  const base = "/api/projects/:projectId/assistant-validation";
  type Params = {
    projectId: string;
    sessionId: string;
    confirmationId: string;
  };
  async function execute(
    req: any,
    reply: any,
    write: boolean,
    action: (scope: { projectId: string; actorId: string }) => Promise<unknown>,
  ) {
    const actor = (req as AuthenticatedRequest).actor;
    if (write && !writeAllowed(req, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      return await action({
        projectId: req.params.projectId,
        actorId: actor.id,
      });
    } catch (e) {
      const status =
        e instanceof RuntimeCommitError
          ? e.status
          : ((e as any)?.status ?? 500);
      const code = (e as any)?.code ?? "runtime_operation_failed";
      return reply.code(status).send({ error: { code } });
    }
  }
  app.post<{ Params: Params }>(
    base,
    { preHandler: authenticate },
    (req, reply) => execute(req, reply, true, (scope) => host.create(scope)),
  );
  app.get<{ Params: Params }>(
    base + "/:sessionId",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, false, (scope) =>
        host.present(scope, req.params.sessionId),
      ),
  );
  app.post<{ Params: Params; Body: { text: string } }>(
    base + "/:sessionId/messages",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, true, async (scope) => {
        if (
          !req.body ||
          typeof req.body.text !== "string" ||
          Object.keys(req.body).some((k) => k !== "text")
        )
          throw new RuntimeCommitError("message_invalid", 422);
        if (isPauseRequest(req.body.text))
          return host.stop(scope, req.params.sessionId);
        await host.message(scope, req.params.sessionId, req.body.text);
        return { accepted: true };
      }),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/stop",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, true, (scope) =>
        host.stop(scope, req.params.sessionId),
      ),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/continue",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, true, async (scope) => {
        await host.resume(scope, req.params.sessionId);
        return { accepted: true };
      }),
  );
  app.post<{ Params: Params; Body: { name: string; content: string } }>(
    base + "/:sessionId/documents",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, true, (scope) => {
        if (
          !req.body ||
          typeof req.body.name !== "string" ||
          typeof req.body.content !== "string" ||
          Object.keys(req.body).some((k) => !["name", "content"].includes(k))
        )
          throw new RuntimeCommitError("document_invalid", 422);
        return host.upload(
          scope,
          req.params.sessionId,
          req.body.name,
          Buffer.from(req.body.content, "base64"),
        );
      }),
  );
  app.post<{ Params: Params }>(
    base + "/:sessionId/confirmations/:confirmationId",
    { preHandler: authenticate },
    (req, reply) =>
      execute(req, reply, true, (scope) =>
        host.confirm(scope, req.params.sessionId, req.params.confirmationId),
      ),
  );
  return host;
}
