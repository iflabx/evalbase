import type { registerDrafts } from "./drafts.js";
import { createSharedDraft } from "../../drafts/create.js";
import {
  claimAssistantTurn,
  collectProcessingEvents,
  controlAssistantTask,
  queueContinuation,
} from "../../assistant/tasks.js";
import { readProcessingRun } from "../../processing/store.js";
import {
  reviewTask,
  taskCompatibilityProblem,
  effectiveTaskRuns,
  scopeRunToTask,
  presentTaskCandidates,
  taskCandidateCollection,
} from "../../assistant/review.js";
import { presentProcessingReview } from "../../processing/presentation.js";
import { reviewCandidates } from "../../processing/review.js";
import {
  scopeCandidateRun,
  candidateScopeForRun,
} from "../../assistant/candidates.js";
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
import { executeAssistantTurn } from "../../assistant/agent.js";
import { assistantContext } from "../../assistant/context.js";
import {
  uploadBackground,
  readBackground,
  removeBackground,
} from "../../assistant/background.js";
import { BACKGROUND_LIMITS } from "../../assistant/extract-background.js";
import { cleanupProcessingObjects } from "../../processing/cleanup.js";
import {
  assistantAccess,
  AssistantError,
  dependenciesAvailable,
  readSession,
  listSessions,
  renameSession,
  recoverProposalReceipt,
  clearConfirmedCandidateSelection,
  sessionRow,
  startTurn,
  turnFence,
  type AssistantScope,
} from "../../assistant/store.js";

export function registerAssistant({
  app,
  db,
  artifacts,
  config,
  authenticate,
  writeAllowed,
  publishDraft,
}: Pick<
  ServerContext,
  "app" | "db" | "artifacts" | "config" | "authenticate" | "writeAllowed"
> & { publishDraft: ReturnType<typeof registerDrafts> }) {
  const path = "/api/projects/:projectId/assistant",
    running = new Set<Promise<void>>();
  const cancellations = new Map<
    string,
    {
      controller: AbortController;
      turn: Record<string, any>;
      scope: AssistantScope;
    }
  >();
  type Params = {
    projectId: string;
    sessionId: string;
    proposalId: string;
    documentId: string;
  };
  const scope = (
    request: FastifyRequest<{ Params: Params }>,
  ): AssistantScope => ({
    projectId: request.params.projectId,
    actorId: (request as AuthenticatedRequest).actor.id,
  });
  let polling: Promise<void> | undefined,
    closed = false;
  function dispatch(): Promise<void> {
    if (polling || closed) return polling ?? Promise.resolve();
    polling = dispatchWork().finally(() => {
      polling = undefined;
    });
    return polling;
  }
  async function dispatchWork() {
    // Reuse the existing supervisor tick for stopping in-flight model waits.
    for (const { controller, turn, scope } of cancellations.values()) {
      try {
        await turnFence(db, scope, turn.id, turn.execution_token);
      } catch (error) {
        controller.abort(error);
      }
    }
    await collectProcessingEvents(db);
    for (let i = 0; i < 3; i++) {
      if (closed) break;
      const turn = await claimAssistantTurn(db);
      if (!turn) break;
      const currentScope = {
        projectId: turn.project_id,
        actorId: turn.actor_id,
      };
      const controller = new AbortController();
      cancellations.set(turn.id, { controller, turn, scope: currentScope });
      const work = executeAssistantTurn(
        db,
        artifacts,
        config,
        currentScope,
        turn,
        async (action, input, key) => {
          if (action !== "create")
            throw new AssistantError(422, "assistant_confirmation_required");
          return createSharedDraft(
            db,
            {
              ...currentScope,
              assistantGuard: {
                sessionId: turn.session_id,
                revision: turn.task_revision,
                turnId: turn.id,
                token: turn.execution_token,
              },
            },
            input,
            key,
          );
        },
        controller.signal,
      );
      running.add(work);
      void work
        .catch(() => undefined)
        .finally(() => {
          running.delete(work);
          cancellations.delete(turn.id);
          void dispatch().catch((error) => app.log.error(error));
        });
    }
  }
  const timer = setInterval(
    () => void dispatch().catch((error) => app.log.error(error)),
    1000,
  );
  timer.unref();
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
  app.patch<{ Params: Params; Body: unknown }>(
    `${path}/sessions/:sessionId`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, () =>
        renameSession(
          db,
          scope(request),
          request.params.sessionId,
          request.body,
        ),
      );
    },
  );
  app.get<{ Params: Params }>(
    `${path}/sessions/:sessionId/status`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, async () => {
        const context = scope(request);
        await assistantAccess(db, context);
        const result = await db.query(
          "SELECT id FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3",
          [request.params.sessionId, context.projectId, context.actorId],
        );
        return { exists: Boolean(result.rowCount) };
      }),
  );
  app.delete<{ Params: Params }>(
    `${path}/sessions/:sessionId`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        const context = scope(request);
        await controlAssistantTask(
          db,
          context,
          request.params.sessionId,
          "delete",
        );
        try {
          await cleanupProcessingObjects(db, artifacts, context.projectId);
        } catch {
          // The committed deletion revoked access. Worker retries the durable cleanup queue.
          app.log.warn(
            {
              sessionId: request.params.sessionId,
              projectId: context.projectId,
            },
            "Assistant session cleanup pending",
          );
          return { deleted: true, cleanupPending: true };
        }
        return { deleted: true };
      });
    },
  );
  app.get<{
    Params: Params;
    Querystring: {
      search?: string;
      offset?: string;
      limit?: string;
      sourceKind?: string;
      sourceId?: string;
    };
  }>(`${path}/sessions`, { preHandler: authenticate }, async (request, reply) =>
    respond(reply, async () => {
      const context = scope(request);
      const { search = "", offset = "0", limit = "20" } = request.query;
      if (
        Object.keys(request.query).some(
          (key) =>
            !["search", "offset", "limit", "sourceKind", "sourceId"].includes(
              key,
            ),
        ) ||
        search.length > 100 ||
        !/^\d+$/u.test(offset) ||
        !/^\d+$/u.test(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 50 ||
        !Number.isSafeInteger(Number(offset))
      )
        throw new AssistantError(422, "assistant_request_invalid");
      let pageContext: { kind: string; id: string; name: string } | undefined;
      const { sourceKind, sourceId } = request.query;
      if (sourceKind !== undefined || sourceId !== undefined) {
        if (
          !sourceKind ||
          !["asset", "draft", "version", "testSet"].includes(sourceKind) ||
          !sourceId ||
          sourceId.length > 250
        )
          throw new AssistantError(422, "assistant_source_invalid");
        await assistantAccess(
          db,
          context,
          ["asset", "draft"].includes(sourceKind),
        );
        await dependenciesAvailable(db, context, [
          {
            kind: sourceKind as "asset" | "draft" | "version" | "testSet",
            id: sourceId,
          },
        ]);
        const queries: Record<string, string> = {
          asset:
            "SELECT file_name AS name FROM data_asset WHERE id=$1 AND project_id=$2",
          draft:
            "SELECT name FROM collaborative_draft WHERE id=$1 AND project_id=$2",
          version:
            "SELECT t.name||' · '||v.version_label AS name FROM test_set_version v JOIN test_set t ON t.id=v.test_set_id WHERE v.id=$1 AND t.project_id=$2",
          testSet: "SELECT name FROM test_set WHERE id=$1 AND project_id=$2",
        };
        const found = (
          await db.query(queries[sourceKind]!, [sourceId, context.projectId])
        ).rows[0];
        if (!found) throw new AssistantError(404, "assistant_source_invalid");
        await assistantAccess(
          db,
          context,
          ["asset", "draft"].includes(sourceKind),
        );
        pageContext = {
          kind: sourceKind,
          id: sourceId,
          name: found.name || "未命名资料",
        };
      }
      return Object.keys(request.query).length
        ? {
            ...(await listSessions(db, context, {
              search: search.trim(),
              offset: Number(offset),
              limit: Number(limit),
            })),
            ...(pageContext ? { pageContext } : {}),
          }
        : { sessions: await listSessions(db, context) };
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
  app.get<{
    Params: Params;
    Querystring: { view?: string; before?: string; limit?: string };
  }>(
    `${path}/sessions/:sessionId`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, async () => {
        const currentScope = scope(request);
        const { view, before, limit = "20" } = request.query;
        if (
          Object.keys(request.query).some(
            (key) => !["view", "before", "limit"].includes(key),
          ) ||
          (view !== undefined && !["status", "messages"].includes(view)) ||
          (before !== undefined &&
            (view !== "messages" || !before || before.length > 250)) ||
          !/^\d+$/u.test(limit) ||
          Number(limit) < 1 ||
          Number(limit) > 50 ||
          (!view && Object.keys(request.query).length)
        )
          throw new AssistantError(422, "assistant_request_invalid");
        return readSession(
          db,
          currentScope,
          request.params.sessionId,
          async () => {
            const context = await assistantContext(
              db,
              currentScope,
              request.params.sessionId,
            );
            await assistantAccess(db, currentScope, context.drafts.length > 0);
            await dependenciesAvailable(db, currentScope, context.dependencies);
            return context.state;
          },
          view
            ? {
                mode: view as "status" | "messages",
                ...(before ? { before } : {}),
                limit: Number(limit),
              }
            : undefined,
        );
      }),
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/sessions/:sessionId/background-documents`,
    {
      preHandler: authenticate,
      bodyLimit: Math.ceil(BACKGROUND_LIMITS.bytes / 3) * 4 + 2048,
    },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        const body = request.body;
        if (
          !isPlainObject(body) ||
          Object.keys(body).some(
            (key) => !["fileName", "contentBase64"].includes(key),
          ) ||
          typeof body.fileName !== "string" ||
          typeof body.contentBase64 !== "string" ||
          body.contentBase64.length >
            Math.ceil(BACKGROUND_LIMITS.bytes / 3) * 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.contentBase64)
        )
          throw new AssistantError(422, "assistant_document_invalid");
        const bytes = Buffer.from(body.contentBase64, "base64");
        if (bytes.toString("base64") !== body.contentBase64)
          throw new AssistantError(422, "assistant_document_invalid");
        const result = await uploadBackground(
          db,
          scope(request),
          request.params.sessionId,
          body.fileName,
          bytes,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      });
    },
  );
  app.get<{
    Params: Params;
    Querystring: { from?: string; limit?: string; query?: string };
  }>(
    `${path}/sessions/:sessionId/background-documents/:documentId`,
    { preHandler: authenticate },
    (request, reply) =>
      respond(reply, () =>
        readBackground(
          db,
          scope(request),
          request.params.sessionId,
          request.params.documentId,
          Number(request.query.from ?? 1),
          Number(request.query.limit ?? 3),
          request.query.query,
        ),
      ),
  );
  app.delete<{ Params: Params }>(
    `${path}/sessions/:sessionId/background-documents/:documentId`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        const result = await removeBackground(
          db,
          scope(request),
          request.params.sessionId,
          request.params.documentId,
        );
        await cleanupProcessingObjects(db, artifacts, request.params.projectId);
        return result;
      });
    },
  );
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/sessions/:sessionId/turns`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!write(request, reply)) return;
      return respond(reply, async () => {
        if (
          !isPlainObject(request.body) ||
          Object.keys(request.body).some(
            (k) =>
              ![
                "message",
                "context",
                "candidates",
                "expectedTaskRevision",
              ].includes(k),
          )
        )
          throw new AssistantError(422, "assistant_message_invalid");
        const context = scope(request),
          started = await startTurn(
            db,
            context,
            request.params.sessionId,
            request.headers["idempotency-key"],
            request.body.message,
            request.body.context,
            request.body.candidates,
            request.body.expectedTaskRevision,
            artifacts,
          );
        if (!started.replayed)
          void dispatch().catch((error) => app.log.error(error));
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
          const located = (
            await client.query(
              "SELECT session_id FROM assistant_proposal WHERE id=$1 AND project_id=$2 AND actor_id=$3",
              [request.params.proposalId, context.projectId, context.actorId],
            )
          ).rows[0];
          if (!located) throw new AssistantError(404, "assistant_not_found");
          const session = await sessionRow(
            client,
            context,
            located.session_id,
            true,
          );
          proposal = (
            await client.query(
              "SELECT * FROM assistant_proposal WHERE id=$1 FOR UPDATE",
              [request.params.proposalId],
            )
          ).rows[0];
          if (
            proposal.status !== "succeeded" &&
            proposal.task_revision !== session.task_revision
          )
            throw new AssistantError(409, "assistant_confirmation_expired");
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
          const effectScope = {
            ...context,
            assistantGuard: {
              sessionId: proposal.session_id,
              revision: proposal.task_revision,
              proposalId: proposal.id,
              leaseToken,
            },
          };
          let receipt: unknown;
          const task = (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              proposal.session_id,
            ])
          ).rows[0]?.task;
          if (proposal.action === "processing" && task?.runId) {
            const runs = [];
            for (const group of p.resultGroups ?? [
              { runId: p.runId, resultIds: p.resultIds },
            ]) {
              const data = await readProcessingRun(
                db,
                artifacts,
                context,
                group.runId,
                { limit: "10000" },
                true,
              );
              const records = data.records.filter((row) =>
                group.resultIds.includes(row.id),
              );
              runs.push({ ...data, records, total: records.length });
            }
            const checked = reviewCandidates(
              runs[0]!,
              {
                ...task,
                targetCount: null,
                classifications: task.classifications?.map((rule: any) => ({
                  ...rule,
                  quotas: undefined,
                  requiredValues: undefined,
                })),
              },
              runs,
              undefined,
              true,
            );
            if (
              taskCompatibilityProblem(task, runs) ||
              checked.emptyQuestions ||
              checked.duplicates ||
              checked.protectedFieldChanges ||
              checked.outsideLabels ||
              checked.classifications.some((rule) => !rule.satisfied)
            )
              throw new AssistantError(
                409,
                "assistant_processing_context_changed",
              );
          }
          if (proposal.action === "publish" && task?.runId) {
            const data = await readProcessingRun(
              db,
              artifacts,
              context,
              task.runId,
              { limit: "10000" },
              true,
            );
            const checked = await reviewTask(
              db,
              artifacts,
              context,
              { ...task, targetDraftId: p.draftId },
              data,
              true,
            );
            if (!checked.review.complete)
              throw new AssistantError(
                422,
                "assistant_candidate_review_incomplete",
              );
            await db.query(
              "UPDATE assistant_session SET task=jsonb_set(task,'{review}',$2::jsonb) WHERE id=$1 AND task_revision=$3",
              [
                proposal.session_id,
                JSON.stringify(checked.review),
                proposal.task_revision,
              ],
            );
          }
          if (proposal.action === "selection")
            receipt = await applySelectionPreview(
              db,
              { ...effectScope, draftId: p.draftId },
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
              {
                ...effectScope,
                ...(p.resultGroups ? { acceptanceGroups: p.resultGroups } : {}),
                ...(p.resultsGuard
                  ? { assistantResultsGuard: p.resultsGuard }
                  : {}),
              },
              p.runId,
              proposal.id,
              { resultIds: p.resultIds, target: p.target },
            );
          else if (proposal.action === "publish") {
            let status = 200,
              payload: unknown;
            const output = {
              code(value: number) {
                status = value;
                return this;
              },
              send(value: unknown) {
                payload = value;
                return this;
              },
            } as FastifyReply;
            const returned = await publishDraft(
              Object.assign(Object.create(request), {
                params: { projectId: context.projectId, draftId: p.draftId },
                body: { revision: p.revision },
              }),
              output,
              effectScope.assistantGuard,
            );
            receipt = payload ?? returned;
            if (status >= 400)
              throw new AssistantError(
                status,
                (receipt as any)?.error?.code ?? "assistant_operation_failed",
              );
            const published = (
              await db.query(
                "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2 AND status='published'",
                [p.draftId, context.projectId],
              )
            ).rows[0];
            if (
              !published ||
              Number(published.revision) !== Number(p.revision) + 1
            )
              throw new AssistantError(409, "draft_revision_conflict");
          } else
            throw new AssistantError(422, "assistant_confirmation_invalid");
          await assistantAccess(db, context, true);
          const saved = await db.query(
            "UPDATE assistant_proposal SET status='succeeded',receipt=$2,lease_until=NULL WHERE id=$1 AND status='executing' AND digest=$3 AND lease_token=$4 RETURNING id",
            [proposal.id, receipt, proposal.digest, leaseToken],
          );
          if (!saved.rowCount)
            throw new AssistantError(409, "assistant_context_unavailable");
          await clearConfirmedCandidateSelection(db, proposal);
          await queueContinuation(
            db,
            proposal.session_id,
            "confirmed",
            proposal.id,
            proposal.task_revision,
          );
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
          "UPDATE assistant_proposal SET status='rejected' WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND status='pending' RETURNING id,session_id",
          [request.params.proposalId, context.projectId, context.actorId],
        );
        if (!result.rowCount)
          throw new AssistantError(409, "assistant_confirmation_unavailable");
        await db.query(
          "UPDATE assistant_session SET task=task||'{\"stage\":\"waiting_input\"}'::jsonb WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM assistant_proposal WHERE session_id=$1 AND status IN('pending','executing'))",
          [result.rows[0].session_id],
        );
        return { rejected: true };
      });
    },
  );
  for (const action of ["stop", "retry"] as const)
    app.post<{ Params: Params; Body: unknown }>(
      `${path}/sessions/:sessionId/${action}`,
      { preHandler: authenticate },
      async (request, reply) => {
        if (!write(request, reply)) return;
        return respond(reply, async () => {
          if (!isPlainObject(request.body) || Object.keys(request.body).length)
            throw new AssistantError(422, "assistant_request_invalid");
          const currentScope = scope(request);
          await controlAssistantTask(
            db,
            currentScope,
            request.params.sessionId,
            action,
          );
          void dispatch().catch((error) => app.log.error(error));
          return { accepted: true };
        });
      },
    );
  app.get<{
    Params: Params;
    Querystring: {
      offset?: string;
      limit?: string;
      run?: string;
      view?: string;
      search?: string;
      scope?: string;
    };
  }>(
    `${path}/sessions/:sessionId/candidates`,
    { preHandler: authenticate },
    async (request, reply) =>
      respond(reply, async () => {
        const currentScope = scope(request),
          session = await sessionRow(
            db,
            currentScope,
            request.params.sessionId,
          );
        await assistantAccess(db, currentScope, true);
        const finishRead = async () => {
          const after = await sessionRow(
            db,
            currentScope,
            request.params.sessionId,
          );
          await assistantAccess(db, currentScope, true);
          if (after.content_revision !== session.content_revision)
            throw new AssistantError(409, "assistant_context_deleted");
          if (
            after.task_revision !== session.task_revision ||
            after.task.candidateScope?.hash !==
              session.task.candidateScope?.hash
          )
            throw new AssistantError(
              409,
              "assistant_candidate_selection_changed",
            );
        };
        if (!session.task?.runId)
          throw new AssistantError(404, "processing_not_found");
        if (
          request.query.scope !== undefined &&
          !["task", "run"].includes(request.query.scope)
        )
          throw new AssistantError(422, "query_parameter_invalid");
        if (
          request.query.scope === "task" ||
          (!request.query.scope && !request.query.run)
        ) {
          if (request.query.run)
            throw new AssistantError(422, "query_parameter_invalid");
          const result = await presentTaskCandidates(
            db,
            artifacts,
            currentScope,
            session.task,
            Number(session.task_revision),
            request.query,
          );
          await finishRead();
          return result;
        }
        const runId = request.query.run ?? session.task.runId;
        if (request.query.scope === "run") {
          const current = await taskCandidateCollection(
            db,
            artifacts,
            currentScope,
            session.task,
          );
          if (
            !current.history.some((item) => item.runId === runId) &&
            !(session.task.runIds ?? [session.task.runId]).includes(runId)
          )
            throw new AssistantError(
              409,
              "assistant_candidate_selection_changed",
            );
          const result = {
            ...(await presentProcessingReview(
              db,
              artifacts,
              currentScope,
              await readProcessingRun(
                db,
                artifacts,
                currentScope,
                runId,
                { limit: "10000" },
                true,
              ),
              request.query,
            )),
            scope: "run",
          };
          await finishRead();
          return result;
        }
        if (!(session.task.runIds ?? [session.task.runId]).includes(runId))
          throw new AssistantError(
            409,
            "assistant_candidate_selection_changed",
          );
        const offset = Number(request.query.offset ?? 0),
          limit = Number(request.query.limit ?? 20);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          throw new AssistantError(422, "query_parameter_invalid");
        const fixedScope = candidateScopeForRun(session.task, runId);
        let result = await readProcessingRun(
          db,
          artifacts,
          currentScope,
          runId,
          fixedScope || request.query.view !== undefined
            ? { offset: "0", limit: "10000" }
            : request.query,
          Boolean(fixedScope || request.query.view !== undefined),
        );
        if (fixedScope) {
          result = scopeCandidateRun(result, fixedScope);
          if (request.query.view === undefined)
            result = {
              ...result,
              records: result.records.slice(offset, offset + limit),
              offset,
              limit,
            };
        }
        if (request.query.view !== undefined) {
          const taskRuns = [];
          for (const id of session.task.runIds ?? [session.task.runId]) {
            const run =
              id === runId
                ? result
                : scopeCandidateRun(
                    await readProcessingRun(
                      db,
                      artifacts,
                      currentScope,
                      id,
                      { limit: "10000" },
                      true,
                    ),
                    candidateScopeForRun(session.task, id),
                  );
            taskRuns.push(scopeRunToTask(session.task, run));
          }
          const effective = effectiveTaskRuns(taskRuns);
          if (effective.reduce((total, item) => total + item.total, 0) > 10000)
            throw new AssistantError(422, "processing_capacity_exceeded");
          const current = effective.find((item) => item.run.id === runId) ?? {
            ...result,
            records: [],
            allIds: [],
            total: 0,
          };
          const page = await presentProcessingReview(
            db,
            artifacts,
            currentScope,
            current,
            request.query,
          );
          await finishRead();
          return {
            ...page,
            taskTotal: effective.reduce((total, item) => total + item.total, 0),
            effectiveRuns: effective.map((item) => ({
              runId: item.run.id,
              total: item.total,
            })),
          };
        }
        const sources = result.records.map((row) => {
          const source = row.original?.baseline?.source ?? row.original?.source;
          return isPlainObject(source) ? source : {};
        });
        const assetIds = [
          ...new Set(
            sources.flatMap((source) =>
              typeof source.assetId === "string" ? [source.assetId] : [],
            ),
          ),
        ];
        const assets = assetIds.length
          ? await db.query(
              "SELECT id,file_name FROM data_asset WHERE project_id=$1 AND status='stored' AND id=ANY($2::text[])",
              [currentScope.projectId, assetIds],
            )
          : { rows: [] };
        const assetNames = new Map(
          assets.rows.map((asset) => [asset.id, asset.file_name]),
        );
        const sourceName =
          result.run.source.kind === "draft"
            ? (
                await db.query(
                  "SELECT name FROM collaborative_draft WHERE project_id=$1 AND id=$2",
                  [currentScope.projectId, result.run.source.id],
                )
              ).rows[0]?.name
            : result.run.source.kind === "version"
              ? (
                  await db.query(
                    "SELECT concat(t.name,' · ',v.version_label) AS name FROM test_set_version v JOIN test_set t ON t.id=v.test_set_id WHERE t.project_id=$1 AND v.id=$2",
                    [currentScope.projectId, result.run.source.id],
                  )
                ).rows[0]?.name
              : undefined;
        const records = result.records.map((row, index) => {
          const source = sources[index]!,
            name = assetNames.get(source.assetId);
          return {
            ...row,
            sourceLabel: name
              ? `${name}${Number.isSafeInteger(source.ordinal) ? ` · 第 ${source.ordinal} 条` : ""}`
              : (sourceName ?? "来源未记录"),
          };
        });
        await finishRead();
        return { ...result, records };
      }),
  );
  app.addHook("onClose", async () => {
    closed = true;
    for (const { controller } of cancellations.values())
      controller.abort(new AssistantError(409, "assistant_interrupted"));
    clearInterval(timer);
    if (polling) await polling.catch((error) => app.log.error(error));
    await Promise.allSettled([...running]);
  });
}
