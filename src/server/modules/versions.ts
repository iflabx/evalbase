import { versionOperations } from "../../version/store.js";
import { DraftOperationError } from "../../drafts/operations.js";
import { type AssistantGuard } from "../../operations/commit.js";

import type { FastifyRequest, FastifyReply } from "fastify";

import { hasProjectCapability } from "../../security/project-access.js";
import {
  publishSparseVersion,
  type SparseOperation,
} from "../../version/publish-sparse.js";
import { storedRecord } from "../../version/snapshot-record.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  isPlainObject,
  metadataText,
} from "../support.js";

export function registerVersions(
  context: Pick<
    ServerContext,
    "db" | "artifacts" | "app" | "authenticate" | "writeAllowed"
  >,
) {
  const { db, artifacts, app, authenticate, writeAllowed } = context;
  const domain = versionOperations(db, artifacts);
  const {
    dataCheck,
    soloVersionChanges,
    soloVersionExportEvidence,
    csvDocument,
  } = domain;
  const publishInitial = async (
    request: FastifyRequest<{ Params: { projectId: string }; Body: unknown }>,
    reply: FastifyReply,
    assistantGuard?: AssistantGuard,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    try {
      const result = await domain.publishInitial(
        { ...request.params, actorId: actor.id, assistantGuard },
        request.body,
        request.headers["idempotency-key"] as string | undefined,
      );
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof DraftOperationError)
        return reply.code(error.status).send(error.body);
      throw error;
    }
  };
  app.post<{
    Params: { projectId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets",
    { preHandler: authenticate },
    publishInitial,
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/derived-versions",
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
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some((key) => key !== "operations") ||
        !Array.isArray(body.operations) ||
        body.operations.length > 10_000
      )
        return reply
          .code(422)
          .send({ error: { code: "test_set_payload_invalid" } });
      const operations = body.operations;
      for (const operation of operations) {
        if (!isPlainObject(operation))
          return reply
            .code(422)
            .send({ error: { code: "test_record_invalid" } });
        const fields =
          operation.operation === "add"
            ? ["operation", "after"]
            : operation.operation === "update"
              ? ["operation", "caseId", "beforeRevisionId", "after"]
              : operation.operation === "delete"
                ? ["operation", "caseId", "beforeRevisionId"]
                : [];
        if (
          !fields.length ||
          Object.keys(operation).length !== fields.length ||
          Object.keys(operation).some((field) => !fields.includes(field)) ||
          (operation.operation !== "delete" &&
            !isPlainObject(operation.after)) ||
          (operation.operation !== "add" &&
            (typeof operation.caseId !== "string" ||
              !operation.caseId ||
              typeof operation.beforeRevisionId !== "string" ||
              !operation.beforeRevisionId))
        )
          return reply
            .code(422)
            .send({ error: { code: "test_record_invalid" } });
      }
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 200)
        return reply
          .code(422)
          .send({ error: { code: "idempotency_key_required" } });
      try {
        const published = await publishSparseVersion(db, artifacts, {
          projectId: request.params.projectId,
          testSetId: request.params.testSetId,
          parentVersionId: request.params.versionId,
          actorId: actor.id,
          idempotencyKey: key,
          operations: operations as SparseOperation[],
        });
        const result = await db.query(
          `SELECT v.item_count, cr.input, cr.expected_output, cr.metadata,
                  cr.origin_kind, cr.origin_ref
             FROM test_set_version v
             JOIN LATERAL resolve_version_members(v.id) vm ON true
             JOIN case_revision cr ON cr.id=vm.case_revision_id
            WHERE v.id=$1 ORDER BY vm.ordinal`,
          [published.id],
        );
        const version = {
          id: published.id,
          label: published.label,
          recordCount: Number(result.rows[0]?.item_count ?? 0),
          parentVersionId: request.params.versionId,
        };
        return reply.code(published.replayed ? 200 : 201).send({
          version,
          dataCheck: dataCheck(result.rows.map(storedRecord)),
          ...(published.replayed ? { replayed: true } : {}),
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "test_set_not_found" || code === "version_not_found")
          return reply.code(404).send({ error: { code } });
        if (code === "idempotency_conflict")
          return reply.code(409).send({ error: { code } });
        if (
          code === "sparse_publication_request_invalid" ||
          code === "parent_record_invalid" ||
          code === "test_record_invalid" ||
          code === "source_selection_invalid" ||
          code === "test_set_capacity_exceeded" ||
          code === "version_position_exhausted"
        )
          return reply.code(422).send({ error: { code } });
        if (code === "checkpoint_hard_limit_failed")
          return reply.code(503).send({ error: { code } });
        throw error;
      }
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      search?: string;
      limit?: string;
      offset?: string;
      sourceAssetId?: string | string[];
      question?: string;
      origin?: string;
      metadataField?: string;
      metadata?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/records",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.records(
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
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      sourceAssetId?: string;
      sourceOrdinal?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/editing-records",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.editingRecords(
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
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
      ordinal: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/records/:ordinal",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.record(
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
    Querystring: { name?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/solo-test-sets",
    { preHandler: authenticate },
    async (request, reply) => {
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
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId",
    { preHandler: authenticate },
    async (request, reply) => {
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
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      status?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/provenance",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.provenance(
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
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
      changeId: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/provenance/:changeId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (request.method !== "GET" && !writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await domain.change(
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

  for (const [name, rows] of [
    [
      "data.csv",
      (result: Awaited<ReturnType<typeof soloVersionChanges>>) => [
        ["question", "expected_output", "metadata"],
        ...result!.current.map((record) => [
          record.question,
          record.expectedOutput,
          metadataText(record.metadata),
        ]),
      ],
    ],
    [
      "provenance.csv",
      (result: Awaited<ReturnType<typeof soloVersionChanges>>) => [
        [
          "change_type",
          "question",
          "expected_output",
          "metadata",
          "previous_question",
          "previous_expected_output",
          "previous_metadata",
          "source_file",
          "source_record",
        ],
        ...result!.changes.map((change) => [
          change.changeType,
          change.current?.question ?? "",
          change.current?.expectedOutput ?? "",
          change.current ? metadataText(change.current.metadata) : "",
          change.previous?.question ?? "",
          change.previous?.expectedOutput ?? "",
          change.previous ? metadataText(change.previous.metadata) : "",
          change.source?.fileName ?? "手工新增",
          change.source ? String(change.source.ordinal) : "",
        ]),
      ],
    ],
  ] as const) {
    app.get<{
      Params: { projectId: string; testSetId: string; versionId: string };
    }>(
      `/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/${name}`,
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
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        const lock = await db.connect();
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT pg_advisory_xact_lock_shared(hashtext($1))",
            [
              `agentbench:controlled-deletion-project:${request.params.projectId}`,
            ],
          );
          await lock.query(
            `SELECT id FROM test_set WHERE id=$1 AND project_id=$2 FOR SHARE`,
            [request.params.testSetId, request.params.projectId],
          );
          const evidence = await soloVersionExportEvidence(
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
            lock,
          );
          if (!evidence) {
            await lock.query("COMMIT");
            return reply
              .code(404)
              .send({ error: { code: "version_not_found" } });
          }
          const evidenceFingerprint = evidence.fingerprint;
          await lock.query(
            `DELETE FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND (serializer_version<>2 OR evidence_fingerprint<>$3)`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          const cached = await lock.query(
            `SELECT document FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND serializer_version=2 AND evidence_fingerprint=$3`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          let document = cached.rows[0]?.document as string | undefined;
          if (document === undefined) {
            const result = await soloVersionChanges(
              request.params.projectId,
              request.params.testSetId,
              request.params.versionId,
              lock,
            );
            if (!result) {
              await lock.query("COMMIT");
              return reply
                .code(404)
                .send({ error: { code: "version_not_found" } });
            }
            document = csvDocument(rows(result));
            await lock.query(
              `INSERT INTO version_export_cache
             (version_id,export_type,serializer_version,evidence_fingerprint,document)
             SELECT v.id,$2,2,$3,$4 FROM test_set_version v
              JOIN test_set ts ON ts.id=v.test_set_id
              WHERE v.id=$1 AND v.status='published'
                AND ts.status='available' AND ts.project_id=$5
             ON CONFLICT DO NOTHING`,
              [
                request.params.versionId,
                name,
                evidenceFingerprint,
                document,
                request.params.projectId,
              ],
            );
          }
          await lock.query("COMMIT");
          return reply
            .type("text/csv; charset=utf-8")
            .header(
              "content-disposition",
              `attachment; filename="agentbench-${evidence.label}-${name}"`,
            )
            .send(document);
        } catch (error) {
          await lock.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          lock.release();
        }
      },
    );
  }

  return publishInitial;
}
