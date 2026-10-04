import { acceptProcessingResults } from "../../processing/accept.js";
import type { FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";
import type { AuthenticatedRequest } from "../support.js";
import {
  previewProcessingInput,
  createProcessingRun,
  readProcessingRun,
  listProcessingRuns,
  controlProcessingRun,
  ProcessingError,
} from "../../processing/store.js";

export function registerProcessing({
  app,
  db,
  artifacts,
  authenticate,
  writeAllowed,
}: Pick<
  ServerContext,
  "app" | "db" | "artifacts" | "authenticate" | "writeAllowed"
>) {
  const path = "/api/projects/:projectId/processing-runs";
  type Params = { projectId: string; runId: string };
  async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ProcessingError)
        return reply.code(error.status).send({ error: { code: error.code } });
      throw error;
    }
  }
  app.post<{Params:Params;Body:unknown}>("/api/projects/:projectId/processing-inputs",{preHandler:authenticate},async(request,reply)=>{
    const actor=(request as AuthenticatedRequest).actor;
    if(!writeAllowed(request,actor))return reply.code(403).send({error:{code:"csrf_rejected"}});
    return respond(reply,()=>previewProcessingInput(db,{projectId:request.params.projectId,actorId:actor.id},request.body));
  });
  app.post<{ Params: Params; Body: unknown }>(
    path,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      return respond(reply, async () => {
        const result = await createProcessingRun(
          db,
          artifacts,
          { projectId: request.params.projectId, actorId: actor.id },
          request.headers["idempotency-key"],
          request.body,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      });
    },
  );
  app.get<{ Params: Params }>(
    path,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, () =>
        listProcessingRuns(db, {
          projectId: request.params.projectId,
          actorId: (request as AuthenticatedRequest).actor.id,
        }),
      ),
  );
  app.get<{ Params: Params; Querystring: { offset?: string; limit?: string } }>(
    `${path}/:runId`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, () =>
        readProcessingRun(
          db,
          artifacts,
          {
            projectId: request.params.projectId,
            actorId: (request as AuthenticatedRequest).actor.id,
          },
          request.params.runId,
          request.query,
        ),
      ),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/:runId/accept`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      return respond(reply, async () => {
        const result = await acceptProcessingResults(
          db,
          artifacts,
          { projectId: request.params.projectId, actorId: actor.id },
          request.params.runId,
          request.headers["idempotency-key"],
          request.body,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      });
    },
  );
  for (const action of ["cancel", "retry"] as const)
    app.post<{ Params: Params }>(
      `${path}/:runId/${action}`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = (request as AuthenticatedRequest).actor;
        if (!writeAllowed(request, actor))
          return reply.code(403).send({ error: { code: "csrf_rejected" } });
        return respond(reply, () =>
          controlProcessingRun(
            db,
            { projectId: request.params.projectId, actorId: actor.id },
            request.params.runId,
            action,
          ),
        );
      },
    );
}
