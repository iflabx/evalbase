import {
  createRefinementRun,
  completeProcessingRun,
  previewFollowupInput,
} from "../../processing/refine.js";
import { isPlainObject } from "../support.js";
import { presentProcessingReview } from "../../processing/presentation.js";
import { reviewCandidates } from "../../processing/review.js";
import {
  acceptProcessingResults,
  previewDeduplication,
} from "../../processing/accept.js";
import type { FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";
import type { AuthenticatedRequest } from "../support.js";
import {
  previewProcessingInput,
  createProcessingRun,
  readProcessingRun,
  readProcessingStatus,
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
  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:projectId/processing-inputs",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const scope = { projectId: request.params.projectId, actorId: actor.id };
      return respond(reply, () =>
        isPlainObject(request.body) &&
        isPlainObject(request.body.source) &&
        ["results", "rerun"].includes(String(request.body.source.kind))
          ? previewFollowupInput(db, artifacts, scope, request.body)
          : previewProcessingInput(
              db,
              { projectId: request.params.projectId, actorId: actor.id },
              request.body,
            ),
      );
    },
  );
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
    `${path}/:runId/status`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, () =>
        readProcessingStatus(
          db,
          {
            projectId: request.params.projectId,
            actorId: (request as AuthenticatedRequest).actor.id,
          },
          request.params.runId,
        ),
      ),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/:runId/deduplication`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).some((key) => key !== "resultIds")
      )
        return reply
          .code(422)
          .send({ error: { code: "processing_deduplication_invalid" } });
      return respond(reply, () =>
        previewDeduplication(
          db,
          artifacts,
          { projectId: request.params.projectId, actorId: actor.id },
          request.params.runId,
          (request.body as { resultIds: unknown }).resultIds,
        ),
      );
    },
  );
  app.get<{ Params: Params }>(
    `${path}/:runId/review`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, async () => {
        const data = await readProcessingRun(
          db,
          artifacts,
          {
            projectId: request.params.projectId,
            actorId: (request as AuthenticatedRequest).actor.id,
          },
          request.params.runId,
          { limit: "10000" },
          true,
        );
        return { review: reviewCandidates(data) };
      }),
  );
  app.get<{
    Params: Params;
    Querystring: {
      limit?: string;
      offset?: string;
      search?: string;
      status?: string;
    };
  }>(path, { preHandler: authenticate }, async (request, reply) =>
    respond(reply, () =>
      listProcessingRuns(
        db,
        {
          projectId: request.params.projectId,
          actorId: (request as AuthenticatedRequest).actor.id,
        },
        request.query,
      ),
    ),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/:runId/followups`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !isPlainObject(request.body) ||
        !["continue", "rerun", "complete"].includes(String(request.body.mode))
      )
        return reply
          .code(422)
          .send({ error: { code: "processing_scope_invalid" } });
      const { mode, ...body } = request.body;
      return respond(reply, async () => {
        if (mode === "complete") {
          if (Object.keys(body).length)
            throw new ProcessingError(422, "processing_scope_invalid");
          const result = await completeProcessingRun(
            db,
            artifacts,
            { projectId: request.params.projectId, actorId: actor.id },
            request.params.runId,
            request.headers["idempotency-key"],
          );
          return reply.code(result.replayed ? 200 : 201).send(result);
        }
        const result = await createRefinementRun(
          db,
          artifacts,
          { projectId: request.params.projectId, actorId: actor.id },
          request.params.runId,
          request.headers["idempotency-key"],
          body,
          mode as "continue" | "rerun",
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      });
    },
  );
  app.get<{
    Params: Params;
    Querystring: {
      offset?: string;
      limit?: string;
      view?: string;
      search?: string;
    };
  }>(`${path}/:runId`, { preHandler: authenticate }, async (request, reply) =>
    respond(reply, async () => {
      const scope = {
        projectId: request.params.projectId,
        actorId: (request as AuthenticatedRequest).actor.id,
      };
      if (request.query.view !== undefined) {
        const data = await readProcessingRun(
          db,
          artifacts,
          scope,
          request.params.runId,
          { limit: "10000" },
          true,
        );
        return presentProcessingReview(
          db,
          artifacts,
          scope,
          data,
          request.query,
        );
      }
      return readProcessingRun(
        db,
        artifacts,
        {
          projectId: request.params.projectId,
          actorId: (request as AuthenticatedRequest).actor.id,
        },
        request.params.runId,
        request.query,
      );
    }),
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
