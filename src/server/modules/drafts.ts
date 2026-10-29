import {
  draftOperations,
  DraftOperationError,
} from "../../drafts/operations.js";
import type { AssistantGuard } from "../../operations/commit.js";

import { createSharedDraft, DraftCreateError } from "../../drafts/create.js";

import { type FastifyReply, type FastifyRequest } from "fastify";
import { hasProjectCapability } from "../../security/project-access.js";

import type { ServerContext } from "../context.js";
import { AuthenticatedRequest, isPlainObject } from "../support.js";

export function registerDrafts(
  context: Pick<
    ServerContext,
    | "db"
    | "artifacts"
    | "now"
    | "app"
    | "authenticate"
    | "writeAllowed"
    | "publishInitial"
  >,
) {
  const { db, artifacts, now, app, authenticate, writeAllowed } = context;
  const domain = draftOperations(db, artifacts);
  type PresenceEntry = {
    projectId: string;
    userId: string;
    clientId: string;
    seenAt: number;
    draftId: string | null;
    recordId: string | null;
    field: string | null;
  };
  const presence = new Map<string, PresenceEntry>();
  const expirePresence = () => {
    const cutoff = now().getTime() - 15_000;
    for (const [key, entry] of presence)
      if (entry.seenAt <= cutoff) presence.delete(key);
  };
  const presencePath = "/api/projects/:projectId/presence";
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    presencePath,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        typeof body.clientId !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(body.clientId) ||
        (body.draftId !== undefined &&
          body.draftId !== null &&
          typeof body.draftId !== "string") ||
        (body.recordId !== undefined &&
          body.recordId !== null &&
          typeof body.recordId !== "string") ||
        (body.field !== undefined &&
          body.field !== null &&
          ![
            "question",
            "expectedOutput",
            "metadata",
            "name",
            "purpose",
          ].includes(String(body.field))) ||
        (body.recordId && !body.draftId) ||
        (body.field && !body.draftId)
      )
        return reply.code(422).send({ error: { code: "presence_invalid" } });
      const draftId = body.draftId ? String(body.draftId) : null;
      if (draftId) {
        if (
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "write",
          ))
        )
          return reply.code(404).send({ error: { code: "project_not_found" } });
        const draft = await db.query(
          `SELECT d.id FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id
           LEFT JOIN test_set_version v ON v.id=d.parent_version_id
           WHERE d.id=$1 AND d.project_id=$2 AND d.status='editing'
             AND (ts.status IS NULL OR ts.status='available')
             AND (v.status IS NULL OR v.status='published')`,
          [draftId, request.params.projectId],
        );
        if (!draft.rowCount)
          return reply.code(404).send({ error: { code: "draft_not_found" } });
      }
      expirePresence();
      const clientId = String(body.clientId);
      presence.set(`${actor.id}:${clientId}`, {
        projectId: request.params.projectId,
        userId: actor.id,
        clientId,
        seenAt: now().getTime(),
        draftId,
        recordId: body.recordId ? String(body.recordId) : null,
        field: body.field ? String(body.field) : null,
      });
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { projectId: string; clientId: string } }>(
    `${presencePath}/:clientId`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const key = `${actor.id}:${request.params.clientId}`;
      if (presence.get(key)?.projectId === request.params.projectId)
        presence.delete(key);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { projectId: string }; Querystring: { draftId?: string } }>(
    presencePath,
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
      const draftId = request.query.draftId;
      if (
        draftId &&
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      expirePresence();
      const entries = [...presence.values()].filter(
        (entry) => entry.projectId === request.params.projectId,
      );
      const ids = [...new Set(entries.map((entry) => entry.userId))];
      if (!ids.length) return { users: [] };
      const people = await db.query(
        `SELECT u.id,coalesce(u.display_name,u.username) AS name,u.avatar_color,
                u.role AS account_role,pm.role AS project_role
         FROM app_user u LEFT JOIN project_member pm ON pm.user_id=u.id AND pm.project_id=$1
         WHERE u.id=ANY($2::text[]) AND (u.role='admin' OR pm.role IN ('owner','editor','viewer'))`,
        [request.params.projectId, ids],
      );
      const users = people.rows.map((person) => {
        const active = entries.filter((entry) => entry.userId === person.id);
        const role =
          person.account_role === "admin"
            ? "admin"
            : String(person.project_role);
        const focused =
          draftId && role !== "viewer"
            ? active
                .filter((entry) => entry.draftId === draftId && entry.field)
                .sort((a, b) => b.seenAt - a.seenAt)[0]
            : undefined;
        return {
          id: String(person.id),
          name: String(person.name),
          avatarColor: String(person.avatar_color),
          role,
          ...(focused
            ? {
                focus: {
                  draftId,
                  recordId: focused.recordId,
                  field: focused.field,
                },
              }
            : {}),
        };
      });
      return { users };
    },
  );

  // V2 shared draft identities are separate from legacy lease-based working_draft.
  const draftPath = "/api/projects/:projectId/collaborative-drafts";
  const draftByIdPath = `${draftPath}/:draftId`;
  const draftWrite = async (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor)) {
      reply.code(403).send({ error: { code: "csrf_rejected" } });
      return false;
    }
    if (!(await hasProjectCapability(db, projectId, actor.id, "write"))) {
      reply.code(404).send({ error: { code: "project_not_found" } });
      return false;
    }
    return true;
  };
  const draftRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    // Drafts are editable workspace content, not published content for viewers.
    if (!(await hasProjectCapability(db, projectId, actor.id, "write"))) {
      reply.code(404).send({ error: { code: "project_not_found" } });
      return false;
    }
    return true;
  };
  app.get<{
    Params: { projectId: string };
    Querystring: { testSetId?: string };
  }>(draftPath, { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (request.method !== "GET" && !writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      const result = await domain.list(
        { ...request.params, actorId: actor.id },
        request.body,
        request.query as Record<string, any>,
        request.headers["idempotency-key"] as string | undefined,
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof DraftOperationError)
        return reply.code(error.status).send(error.body);
      throw error;
    }
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    draftPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      try {
        const value = await createSharedDraft(
          db,
          {
            projectId: request.params.projectId,
            actorId: (request as AuthenticatedRequest).actor.id,
          },
          request.body,
          request.headers["idempotency-key"],
        );
        const { statusCode, ...body } = value;
        return reply.code(statusCode).send(body);
      } catch (error) {
        if (error instanceof DraftCreateError)
          return reply.code(error.status).send({ error: { code: error.code } });
        throw error;
      }
    },
  );

  app.get<{
    Params: { projectId: string; draftId: string };
    Querystring: { limit?: string; offset?: string; search?: string };
  }>(draftByIdPath, { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (request.method !== "GET" && !writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      const result = await domain.read(
        { ...request.params, actorId: actor.id },
        request.body,
        request.query as Record<string, any>,
        request.headers["idempotency-key"] as string | undefined,
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof DraftOperationError)
        return reply.code(error.status).send(error.body);
      throw error;
    }
  });

  app.get<{
    Params: { projectId: string; draftId: string };
    Querystring: { after?: string };
  }>(
    `${draftByIdPath}/events`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const after = Number(request.query.after ?? "0");
      if (!Number.isSafeInteger(after) || after < 0)
        return reply
          .code(422)
          .send({ error: { code: "draft_cursor_invalid" } });
      const draft = await db.query(
        `SELECT revision,status FROM collaborative_draft WHERE id=$1 AND project_id=$2`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const result = await db.query(
        `SELECT revision,status,changed_by,created_at,change_scope FROM collaborative_draft_event
         WHERE draft_id=$1 AND revision>$2 ORDER BY revision LIMIT 101`,
        [request.params.draftId, after],
      );
      const events = result.rows.slice(0, 100).map((row) => ({
        draftId: request.params.draftId,
        revision: Number(row.revision),
        status: String(row.status),
        changedBy: row.changed_by ? String(row.changed_by) : null,
        at: row.created_at,
        scope: row.change_scope,
      }));
      return {
        events,
        cursor: events.at(-1)?.revision ?? after,
        hasMore: result.rows.length > 100,
        needsSnapshot:
          Number(draft.rows[0].revision) < after ||
          (events.length > 0 && events[0].revision > after + 1) ||
          (events.length === 0 && Number(draft.rows[0].revision) > after),
        status: String(draft.rows[0].status),
      };
    },
  );

  app.patch<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.update(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/records`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.addRecord(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.patch<{
    Params: { projectId: string; draftId: string; recordId: string };
    Body: unknown;
  }>(
    `${draftByIdPath}/records/:recordId`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.updateRecord(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.delete<{
    Params: { projectId: string; draftId: string; recordId: string };
    Body: unknown;
  }>(
    `${draftByIdPath}/records/:recordId`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.removeRecord(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(204).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.delete<{ Params: { projectId: string; draftId: string } }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.discard(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(204).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  const publishDraft = async (
    request: FastifyRequest<{
      Params: { projectId: string; draftId: string };
      Body: unknown;
    }>,
    reply: FastifyReply,
    assistantGuard?: AssistantGuard,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      const result = await domain.publishDraft(
        { ...request.params, actorId: actor.id, assistantGuard },
        request.body,
      );
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof DraftOperationError)
        return reply.code(error.status).send(error.body);
      throw error;
    }
  };
  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/publish`,
    { preHandler: authenticate },
    publishDraft,
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { search?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/collaborative-draft-source-files",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.sourceFiles(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );
  app.get<{
    Params: { projectId: string };
    Querystring: {
      assetId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/collaborative-draft-source-records",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.sourceRecords(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    `${draftByIdPath}/selected-sources`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.selectedSources(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/source-selection`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.sourceSelection(
          { ...request.params, actorId: actor.id },
          request.body,
          request.query as Record<string, any>,
          request.headers["idempotency-key"] as string | undefined,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof DraftOperationError)
          return reply.code(error.status).send(error.body);
        throw error;
      }
    },
  );
  return publishDraft;
}
