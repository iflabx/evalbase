import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import type { AuthenticatedRequest } from "../support.js";
import { hasProjectCapability } from "../../security/project-access.js";
import {
  availableModelConnection,
  modelConnectionSettings,
  saveModelConnection,
  testModelConnection,
  ModelConnectionError,
} from "../../model/connection.js";

export function registerModelConnection({
  app,
  db,
  config,
  authenticate,
  writeAllowed,
}: Pick<
  ServerContext,
  "app" | "db" | "config" | "authenticate" | "writeAllowed"
>) {
  const path = "/api/settings/model-connection";
  async function authorized(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    action: (actorId: string) => Promise<unknown>,
  ) {
    const actor = (request as AuthenticatedRequest).actor;
    if (actor.role !== "admin")
      return reply
        .code(403)
        .send({ error: { code: "administrator_required" } });
    if (write && !writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      return await action(actor.id);
    } catch (error) {
      if (error instanceof ModelConnectionError)
        return reply.code(error.status).send({ error: { code: error.code } });
      throw error;
    }
  }
  app.get(path, { preHandler: authenticate }, (request, reply) =>
    authorized(request, reply, false, () =>
      modelConnectionSettings(db, config),
    ),
  );
  app.put<{ Body: unknown }>(
    path,
    { preHandler: authenticate },
    (request, reply) =>
      authorized(request, reply, true, (actorId) =>
        saveModelConnection(db, config, actorId, request.body),
      ),
  );
  app.post<{ Body: unknown }>(
    `${path}/test`,
    { preHandler: authenticate },
    (request, reply) =>
      authorized(request, reply, true, () =>
        testModelConnection(db, config, request.body),
      ),
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/model-connection",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      return availableModelConnection(db);
    },
  );
}
