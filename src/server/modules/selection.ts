import type { FastifyReply } from "fastify";
import type { ServerContext } from "../context.js";
import { type AuthenticatedRequest } from "../support.js";
import {
  applySelectionPreview,
  createSelectionPreview,
  readSelectionPreview,
  readSelectionHistory,
  readVersionSelectionHistory,
  SelectionError,
} from "../../selection/store.js";

export function registerSelection({
  app,
  db,
  authenticate,
  writeAllowed,
}: Pick<ServerContext, "app" | "db" | "authenticate" | "writeAllowed">) {
  const path =
    "/api/projects/:projectId/collaborative-drafts/:draftId/selection-previews";
  type Params = { projectId: string; draftId: string; previewId: string };
  async function response(reply: FastifyReply, action: () => Promise<unknown>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SelectionError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, ...error.details } });
      throw error;
    }
  }
  app.post<{ Params: Params; Body: unknown }>(
    path,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      return response(reply, async () => {
        const result = await createSelectionPreview(
          db,
          { ...request.params, actorId: actor.id },
          request.body,
        );
        return reply.code(201).send(result);
      });
    },
  );
  app.get<{
    Params: Params;
    Querystring: {
      view?: string;
      search?: string;
      offset?: string;
      limit?: string;
    };
  }>(
    `${path}/:previewId`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      return response(reply, () =>
        readSelectionPreview(
          db,
          { ...request.params, actorId: actor.id },
          request.params.previewId,
          request.query,
        ),
      );
    },
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/:previewId/apply`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      return response(reply, () =>
        applySelectionPreview(
          db,
          { ...request.params, actorId: actor.id },
          request.params.previewId,
          request.body,
        ),
      );
    },
  );
  app.post<{
    Params: Params;
    Body: {
      view?: string;
      search?: string;
      offset?: string;
      limit?: string;
      includeIds?: string[];
    };
  }>(
    `${path}/:previewId/records`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      return response(reply, () =>
        readSelectionPreview(
          db,
          { ...request.params, actorId: actor.id },
          request.params.previewId,
          request.body,
        ),
      );
    },
  );
  app.get<{ Params: Params }>(
    "/api/projects/:projectId/collaborative-drafts/:draftId/selection-history",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      return response(reply, () =>
        readSelectionHistory(db, { ...request.params, actorId: actor.id }),
      );
    },
  );
  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/selection-history",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      return response(reply, () =>
        readVersionSelectionHistory(db, {
          ...request.params,
          actorId: actor.id,
        }),
      );
    },
  );
}
