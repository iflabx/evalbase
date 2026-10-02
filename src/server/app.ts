import { RuntimeMetrics } from "../observability/runtime.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  isAllowedSourceAttribution,
  validateSourceAttribution,
  type SourceAttributionInput,
} from "../attribution.js";
import {
  CAPACITY_LIMITS,
  draftCapacityExceeded,
  draftCapacityFromRow,
  DRAFT_CAPACITY_SQL,
} from "../capacity.js";
import { loadConfig, type Config } from "../config.js";
import { createPool } from "../db/pool.js";
import { dependencyHealth } from "../observability/health.js";
import { metricSnapshot, renderMetrics } from "../observability/metrics.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import {
  canonicalSourcePath,
  mappedSourceFields,
  normalizeDraftMapping,
  replayMapping,
  sourceLeafPaths,
  sourcePathIsMapped,
  sourceValueAt,
  suggestFormalSchema,
} from "../mapping/index.js";
import {
  evaluateRecipe,
  recipeSteps,
  type RecipeStep,
  validateRecipe,
} from "../recipe/index.js";
import {
  capabilitiesForRole,
  hasProjectCapability,
} from "../security/project-access.js";
import {
  assertFormalSchema,
  compareFormalSchemaBundles,
  isValidCaseMetadata,
  validateFormalItems,
} from "../schema/formal.js";
import { ArtifactRepository } from "../storage/artifacts.js";
import {
  registerRun,
  trace as traceLineageGraph,
  transformationManifestHash,
  validateTransformationManifest,
} from "../transformation/index.js";
import {
  decodeUploadHeader,
  UPLOAD_HEADER_ENCODING,
} from "../upload-headers.js";
import {
  collectDeletionClosure,
  deletionPreviewHash,
  deletionReasonValid,
  DELETION_REASON_CODES,
  lockDeletionBlob,
  type DeletionTarget,
  type DeletionTargetType,
} from "../deletion/index.js";
import {
  AgentBenchApp,
  AppDependencies,
  AuthenticatedRequest,
  requestIdentifiers,
  opaqueId,
  isPlainObject,
  resetCancelledGenerationJob,
  selectedSourceRows,
  bootstrapOwner,
  ensureUnfiledCollection,
  assetResponse,
  collectionResponse,
  projectResponse,
  transformationRunResponse,
  attributionResponse,
  attributionInput,
  parsedViewNotDraftEligibleError,
  attributionFromRow,
  verifiedPromptReference,
  sourceSnapshotFromRow,
  isAllowedSourceSnapshot,
  AssetFormat,
  PARSER_VERSION,
  MATERIALIZER_VERSION,
  assetFormat,
  firstHeaderValue,
  defaultParserConfig,
  normalizeDisplayMapping,
  mapMaterialRecord,
  utf8Prefix,
  normalizeParserConfig,
} from "./support.js";
import { registerAccounts } from "./modules/accounts.js";
import { registerDrafts } from "./modules/drafts.js";
import { registerVersions } from "./modules/versions.js";
import { registerDeletion } from "./modules/deletion.js";
import { registerUploads } from "./modules/uploads.js";
export type { AgentBenchApp, AppDependencies } from "./support.js";

export async function buildApp(
  overrides: Partial<Config> = {},
  dependencies: AppDependencies = {},
): Promise<AgentBenchApp> {
  const base = loadConfig();
  const config: Config = {
    ...base,
    ...overrides,
    minio: { ...base.minio, ...overrides.minio },
  };
  const runtimeMetrics = new RuntimeMetrics(config.runtimeMetricsEnabled);
  const db = createPool(config.databaseUrl, runtimeMetrics);
  const artifacts =
    dependencies.artifacts ?? new ArtifactRepository(config.minio);
  const now = dependencies.now ?? (() => new Date());
  const app = Fastify({
    logger: false,
    bodyLimit: CAPACITY_LIMITS.dataAssetBytes,
  });
  const retiredPublicRoute = (url: string) =>
    /^\/api\/projects\/[^/]+\/(?:drafts|candidates)(?:\/|$)/u.test(url) ||
    /^\/api\/projects\/[^/]+\/test-sets(?:\/|$)/u.test(url) ||
    /^\/api\/projects\/[^/]+\/assets\/?$/u.test(url) ||
    /^\/api\/projects\/[^/]+\/assets\/[^/]+\/?$/u.test(url) ||
    /^\/api\/projects\/[^/]+\/assets\/[^/]+\/(?:archive|attribution|attributions|audit|parse-attempts|records)(?:\/|$)/u.test(
      url,
    ) ||
    /^\/api\/projects\/[^/]+\/(?:assets\/[^/]+\/archive|deletions)(?:\/|$)/u.test(
      url,
    ) ||
    /^\/api\/projects\/[^/]+\/(?:jobs|parsed-views)(?:\/|$)/u.test(url) ||
    /^\/api\/projects\/[^/]+\/lineage\/trace(?:\/|$)/u.test(url) ||
    /^\/api\/projects\/[^/]+\/versions\/[^/]+\/(?:package|packages|deliveries|langfuse-csv)(?:\/|$)/u.test(
      url,
    ) ||
    /^\/api\/projects\/[^/]+\/transformation-runs(?:\/|$)/u.test(url) ||
    /^\/api\/projects\/[^/]+\/deliveries(?:\/|$)/u.test(url);
  app.addHook("onRoute", (route) => {
    if (typeof route.url === "string" && retiredPublicRoute(route.url))
      route.url = `/internal/retired${route.url}`;
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    const publicPath = path.replace(/^\/internal\/retired/u, "");
    if (retiredPublicRoute(publicPath))
      return reply.code(404).send({ error: { code: "route_not_found" } });
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const isAssetUpload =
      request.method === "POST" &&
      /^\/api\/projects\/[^/]+\/assets(?:\?|$)/u.test(request.url ?? "");
    const isPendingUpload =
      request.method === "POST" &&
      /^\/api\/projects\/[^/]+\/pending-uploads(?:\?|$)/u.test(
        request.url ?? "",
      );
    const contentLength = Number(request.headers["content-length"]);
    if (
      !isAssetUpload &&
      !isPendingUpload &&
      Number.isFinite(contentLength) &&
      contentLength > CAPACITY_LIMITS.dataAssetBytes
    )
      return reply.code(413).send({
        error: { code: "request_too_large" },
      });
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim();
    const streamingContentType = [
      "text/csv",
      "application/x-ndjson",
      "application/octet-stream",
    ].includes(contentType);
    if (streamingContentType && !isAssetUpload && !isPendingUpload)
      return reply.code(415).send({
        error: { code: "request_content_type_invalid" },
      });
  });
  runtimeMetrics.installHttp(app);
  await app.register(cookie);
  app.addContentTypeParser(/^text\/csv(?:;.*)?$/, (_request, stream, done) =>
    done(null, stream),
  );
  app.addContentTypeParser(
    ["application/x-ndjson", "application/octet-stream"],
    (_request, stream, done) => done(null, stream),
  );
  app.addContentTypeParser("application/json", (request, stream, done) => {
    const isAssetUpload =
      request.raw.method === "POST" &&
      /^\/api\/projects\/[^/]+\/assets(?:\?|$)/u.test(request.raw.url ?? "");
    const isPendingUpload =
      request.raw.method === "POST" &&
      /^\/api\/projects\/[^/]+\/pending-uploads(?:\?|$)/u.test(
        request.raw.url ?? "",
      );
    const limit = CAPACITY_LIMITS.dataAssetBytes;
    const contentLength = Number(request.headers["content-length"]);
    const tooLarge = () => {
      const error = new RangeError(
        "Request body is too large",
      ) as RangeError & {
        code: string;
        statusCode: number;
      };
      error.code = "FST_ERR_CTP_BODY_TOO_LARGE";
      error.statusCode = 413;
      return error;
    };
    if (isAssetUpload || isPendingUpload) {
      done(null, stream);
      return;
    }
    if (Number.isFinite(contentLength) && contentLength > limit) {
      done(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) {
        settled = true;
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
        stream.resume();
        done(tooLarge());
        return;
      }
      chunks.push(buffer);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      done(error);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      try {
        done(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("request_body_invalid") as Error & {
          code: string;
          statusCode: number;
        };
        error.code = "request_body_invalid";
        error.statusCode = 400;
        done(error);
      }
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
  app.addHook("onClose", async () => {
    runtimeMetrics.close();
    await db.end();
  });
  app.addHook("onRequest", async (request) => {
    (request as { startedAt?: number }).startedAt = Date.now();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      !request.url.startsWith("/api/") ||
      reply.statusCode < 400 ||
      reply.statusCode >= 500
    )
      return;
    const serialized =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : undefined;
    if (!serialized) return;
    try {
      const body = JSON.parse(serialized) as {
        error?: { code?: unknown };
      };
      if (typeof body.error?.code === "string")
        (request as { responseErrorCode?: string }).responseErrorCode =
          body.error.code;
    } catch {
      // Non-JSON error bodies do not carry a stable application code.
    }
  });
  app.addHook("onResponse", async (request, response) => {
    const observableSuccess =
      request.method !== "GET" ||
      /\/(download|package)(?:\?|$)/.test(request.url);
    if (
      !request.url.startsWith("/api/") ||
      response.statusCode >= 500 ||
      (response.statusCode < 400 && !observableSuccess)
    )
      return;
    const startedAt = (request as { startedAt?: number }).startedAt;
    console.log(
      JSON.stringify({
        correlation_id: request.id,
        ...requestIdentifiers(request),
        stage: "http:response",
        duration_ms: startedAt ? Date.now() - startedAt : 0,
        error_code:
          (request as { responseErrorCode?: string }).responseErrorCode ?? null,
        status_code: response.statusCode,
      }),
    );
  });
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const startedAt = (request as { startedAt?: number }).startedAt;
    let errorCode = "http_error";
    if (statusCode >= 500)
      errorCode = Object.values(
        await dependencyHealth(db, artifacts).catch(() => ({
          postgresql: "failed" as const,
          minio: "failed" as const,
        })),
      ).some((dependency) => dependency === "failed")
        ? "dependency_unavailable"
        : "http_error";
    if (statusCode >= 500)
      console.error(
        JSON.stringify({
          correlation_id: request.id,
          ...requestIdentifiers(request),
          method: request.method,
          route: request.routeOptions.url,
          stage: "http:error",
          duration_ms: startedAt ? Date.now() - startedAt : 0,
          status_code: statusCode,
          error_code: errorCode,
        }),
      );
    const code =
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413
        ? "request_too_large"
        : error.code === "request_body_invalid"
          ? "request_body_invalid"
          : statusCode === 415
            ? "request_content_type_invalid"
            : statusCode >= 500
              ? errorCode
              : "request_invalid";
    return reply.code(statusCode).send({ error: { code } });
  });
  const webRoot = resolve("dist/web");
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (
      request.method === "GET" &&
      !path.startsWith("/api/") &&
      existsSync(resolve(webRoot, "index.html"))
    )
      return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send({ error: { code: "route_not_found" } });
  });
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, wildcard: false });
  }

  await artifacts.initialize();
  const legacyTestBootstrap =
    process.env.VITEST === "true" && !dependencies.disableLegacyTestBootstrap;
  if (legacyTestBootstrap) await bootstrapOwner(db, config);

  app.get("/health", async () => ({ status: "ok", git_sha: config.gitSha }));
  app.get("/health/live", async () => ({
    status: "ok",
    git_sha: config.gitSha,
  }));
  app.get("/health/ready", async (_request, reply) => {
    const dependencies = await dependencyHealth(db, artifacts);
    const healthy = Object.values(dependencies).every(
      (dependency) => dependency === "ok",
    );
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "unavailable",
      dependencies,
      git_sha: config.gitSha,
    });
  });
  app.get("/metrics", async (_request, reply) => {
    const health = await dependencyHealth(db, artifacts);
    return reply
      .header("content-type", "text/plain; version=0.0.4")
      .send(
        renderMetrics(await metricSnapshot(db, health)) +
          runtimeMetrics.render(db),
      );
  });

  const authenticate = registerAccounts({
    app,
    db,
    config,
    now,
    legacyTestBootstrap,
    writeAllowed,
    enforceDeletionLock,
  });
  const publishInitial = registerVersions({
    db,
    artifacts,
    app,
    authenticate,
    writeAllowed,
  });
  registerDrafts({
    db,
    artifacts,
    now,
    app,
    authenticate,
    writeAllowed,
    publishInitial,
  });
  registerDeletion({ db, artifacts, app, authenticate, writeAllowed });
  app.post<{ Body: unknown }>(
    "/api/projects",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        actor.role !== "admin" &&
        !(legacyTestBootstrap && actor.role === "owner")
      )
        return reply
          .code(403)
          .send({ error: { code: "administrator_required" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (key) => !["name", "description"].includes(key),
        ) ||
        typeof body.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.trim().length > 200 ||
        (body.description !== undefined &&
          (typeof body.description !== "string" ||
            body.description.length > 1_000))
      )
        return reply
          .code(422)
          .send({ error: { code: "project_payload_invalid" } });
      const id = opaqueId("project");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const project = await client.query(
          `INSERT INTO project (id, name, description, owner_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, description, updated_at`,
          [id, body.name.trim(), body.description ?? "", actor.id],
        );
        if (legacyTestBootstrap && actor.role === "owner")
          await client.query(
            `INSERT INTO project_member (project_id, user_id, role)
             VALUES ($1, $2, 'owner')`,
            [id, actor.id],
          );
        await client.query(
          `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'project_created', 'project', $1, $3)`,
          [id, actor.id, { name: body.name.trim() }],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          project: projectResponse({
            ...project.rows[0],
            dataset_count: 1,
            test_set_count: 0,
          }),
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/access",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT u.role AS account_role, pm.role AS member_role
         FROM project p JOIN app_user u ON u.id = $2
         LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = u.id
         WHERE p.id = $1`,
        [request.params.projectId, actor.id],
      );
      const row = result.rows[0];
      const role = row?.account_role === "admin" ? "admin" : row?.member_role;
      if (!role)
        return reply.code(404).send({ error: { code: "project_not_found" } });
      return {
        access: {
          role,
          capabilities: capabilitiesForRole(role === "admin" ? "owner" : role),
        },
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const project = await db.query(
        `SELECT p.id, p.name, p.description, p.updated_at,
                count(DISTINCT c.id)::int AS dataset_count,
                count(DISTINCT ts.id)::int AS test_set_count
         FROM project p
         LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = $2
         LEFT JOIN raw_material_collection c ON c.project_id = p.id
         LEFT JOIN test_set ts ON ts.project_id = p.id
         WHERE p.id = $1 AND (pm.user_id IS NOT NULL OR $3::boolean)
         GROUP BY p.id`,
        [request.params.projectId, actor.id, actor.role === "admin"],
      );
      if (!project.rowCount)
        return reply.code(404).send({ error: { code: "project_not_found" } });
      return { project: projectResponse(project.rows[0]) };
    },
  );

  app.get<{
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
    };
    Querystring: {
      caseId?: string;
      metadataKey?: string;
      metadataValue?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:versionId/cases",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const allowed = new Set([
        "caseId",
        "metadataKey",
        "metadataValue",
        "limit",
        "offset",
      ]);
      const limit = request.query.limit ? Number(request.query.limit) : 100;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      const keys = Object.keys(request.query);
      if (
        keys.some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.metadataKey && !request.query.metadataValue) ||
        (request.query.metadataValue && !request.query.metadataKey)
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const version = await db.query(
        `SELECT v.id, v.sequence
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $4
         WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
           AND v.status <> 'degraded_by_deletion'
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = ts.project_id
               AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
           )`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          actor.id,
        ],
      );
      if (!version.rowCount)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const values = [request.params.versionId];
      const conditions: string[] = [];
      if (request.query.caseId) {
        values.push(request.query.caseId);
        conditions.push(`cr.case_id = $${values.length}`);
      }
      if (request.query.metadataKey) {
        values.push(
          request.query.metadataKey,
          request.query.metadataValue as string,
        );
        conditions.push(
          `cr.metadata ->> $${values.length - 1} = $${values.length}`,
        );
      }
      const countValues = [...values];
      const cases = await db.query(
        `SELECT vm.ordinal, cr.id AS revision_id, cr.case_id, cr.metadata
         FROM resolve_version_members($1) vm
         JOIN case_revision cr ON cr.id = vm.case_revision_id
         WHERE vm.version_id = $1${
           conditions.length ? ` AND ${conditions.join(" AND ")}` : ""
         }
         ORDER BY vm.ordinal
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, String(limit), String(offset)],
      );
      const total = await db.query(
        `SELECT count(*)::text AS total
         FROM resolve_version_members($1) vm
         JOIN case_revision cr ON cr.id = vm.case_revision_id
         WHERE vm.version_id = $1${
           conditions.length ? ` AND ${conditions.join(" AND ")}` : ""
         }`,
        countValues,
      );
      return {
        version: {
          id: version.rows[0].id,
          number: Number(version.rows[0].sequence),
        },
        cases: cases.rows.map((row) => ({
          caseId: row.case_id,
          revisionId: row.revision_id,
          ordinal: Number(row.ordinal),
          metadata: row.metadata,
        })),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      name?: string;
      type?: string;
      content?: string;
      sort?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/collections",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const limit = request.query.limit ? Number(request.query.limit) : 100;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      if (
        Object.keys(request.query).some(
          (key) =>
            !["name", "type", "content", "sort", "limit", "offset"].includes(
              key,
            ),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.name !== undefined &&
          (request.query.name.trim().length === 0 ||
            request.query.name.length > 200)) ||
        (request.query.type !== undefined &&
          !["all", "dataset", "system"].includes(request.query.type)) ||
        (request.query.content !== undefined &&
          !["all", "populated", "empty"].includes(request.query.content)) ||
        (request.query.sort !== undefined &&
          !["updated_desc", "updated_asc"].includes(request.query.sort))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      await ensureUnfiledCollection(db, request.params.projectId);
      const values: string[] = [request.params.projectId];
      const conditions = ["c.project_id = $1"];
      if (request.query.name) {
        values.push(request.query.name.trim());
        conditions.push(
          `(c.name ILIKE '%' || $${values.length} || '%' OR c.description ILIKE '%' || $${values.length} || '%')`,
        );
      }
      if (request.query.type === "dataset") conditions.push("NOT c.is_unfiled");
      if (request.query.type === "system") conditions.push("c.is_unfiled");
      if (request.query.content === "populated")
        conditions.push(`EXISTS (
          SELECT 1 FROM data_asset content_asset
          WHERE content_asset.collection_id = c.id
            AND content_asset.project_id = c.project_id
            AND content_asset.status NOT IN ('deletion_pending', 'tombstoned')
        )`);
      if (request.query.content === "empty")
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM data_asset content_asset
          WHERE content_asset.collection_id = c.id
            AND content_asset.project_id = c.project_id
            AND content_asset.status NOT IN ('deletion_pending', 'tombstoned')
        )`);
      const pageLimit = values.length + 1;
      const pageOffset = values.length + 2;
      const result = await db.query(
        `SELECT c.id, c.project_id, c.name, c.description, c.is_unfiled,
                c.created_at, c.updated_at, count(da.id)::int AS file_count,
                coalesce(sum(pv.record_count), 0)::int AS unified_record_count
         FROM raw_material_collection c
         LEFT JOIN data_asset da
           ON da.collection_id = c.id AND da.project_id = c.project_id
          AND da.status NOT IN ('deletion_pending', 'tombstoned')
         LEFT JOIN LATERAL (
           SELECT record_count FROM parsed_view
           WHERE asset_id = da.id AND is_current
           ORDER BY created_at DESC, id DESC LIMIT 1
         ) pv ON true
         WHERE ${conditions.join(" AND ")}
         GROUP BY c.id
         ORDER BY c.is_unfiled DESC, c.updated_at ${
           request.query.sort === "updated_asc" ? "ASC" : "DESC"
         }, c.id DESC
         LIMIT $${pageLimit} OFFSET $${pageOffset}`,
        [...values, String(limit), String(offset)],
      );
      const total = await db.query(
        `SELECT count(*)::text AS total
         FROM raw_material_collection c
         WHERE ${conditions.join(" AND ")}`,
        values,
      );
      return {
        collections: result.rows.map(collectionResponse),
        pagination: {
          total: Number(total.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string; collectionId: string };
    Querystring: { name?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/collections/:collectionId/assets",
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
          .send({ error: { code: "collection_not_found" } });
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some(
          (key) => !["name", "limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.name !== undefined &&
          (request.query.name.trim().length < 1 ||
            request.query.name.length > 200))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const collection = await db.query(
        `SELECT 1 FROM raw_material_collection WHERE id = $1 AND project_id = $2`,
        [request.params.collectionId, request.params.projectId],
      );
      if (!collection.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "collection_not_found" } });
      const values: unknown[] = [
        request.params.projectId,
        request.params.collectionId,
      ];
      const name = request.query.name?.trim();
      const filter = name ? " AND da.file_name ILIKE '%' || $3 || '%'" : "";
      if (name) values.push(name);
      const assets = await db.query(
        `SELECT da.id, da.file_name, da.format, da.size_bytes, da.uploaded_at,
                pv.record_count, pv.status AS parsed_status
         FROM raw_material_collection c
         JOIN data_asset da ON da.collection_id = c.id AND da.project_id = c.project_id
         LEFT JOIN LATERAL (
           SELECT record_count, status FROM parsed_view
           WHERE asset_id = da.id AND is_current ORDER BY created_at DESC, id DESC LIMIT 1
         ) pv ON true
         WHERE c.project_id = $1 AND c.id = $2
           AND da.status NOT IN ('deletion_pending', 'tombstoned')${filter}
         ORDER BY da.uploaded_at DESC, da.id DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::int AS total FROM raw_material_collection c
         JOIN data_asset da ON da.collection_id = c.id AND da.project_id = c.project_id
         WHERE c.project_id = $1 AND c.id = $2
           AND da.status NOT IN ('deletion_pending', 'tombstoned')${filter}`,
        values,
      );
      return {
        assets: assets.rows.map((row) => ({
          id: row.id,
          fileName: row.file_name,
          format: row.format,
          size: Number(row.size_bytes),
          recordCount: Number(row.record_count ?? 0),
          uploadedAt: new Date(row.uploaded_at).toISOString(),
          status: row.parsed_status === "ready" ? "可浏览" : "等待解析",
        })),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.get<{
    Params: { projectId: string; collectionId: string; assetId: string };
  }>(
    "/api/projects/:projectId/collections/:collectionId/assets/:assetId",
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
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const asset = await db.query(
        `SELECT da.file_name, da.format, pv.record_count
         FROM data_asset da
         JOIN raw_material_collection c ON c.id = da.collection_id AND c.project_id = da.project_id
         LEFT JOIN LATERAL (
           SELECT record_count FROM parsed_view
           WHERE asset_id = da.id AND is_current ORDER BY created_at DESC, id DESC LIMIT 1
         ) pv ON true
         WHERE da.project_id = $1 AND da.collection_id = $2 AND da.id = $3
           AND da.status NOT IN ('deletion_pending', 'tombstoned')`,
        [
          request.params.projectId,
          request.params.collectionId,
          request.params.assetId,
        ],
      );
      if (!asset.rowCount)
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const row = asset.rows[0];
      return {
        asset: {
          fileName: row.file_name,
          format: row.format,
          recordCount: Number(row.record_count ?? 0),
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string; collectionId: string };
    Querystring: {
      search?: string;
      assetId?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/collections/:collectionId/records",
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
          .send({ error: { code: "collection_not_found" } });
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some(
          (key) => !["search", "assetId", "limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.search !== undefined &&
          (request.query.search.trim().length < 1 ||
            request.query.search.length > 200))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const collection = await db.query(
        `SELECT 1 FROM raw_material_collection WHERE id = $1 AND project_id = $2`,
        [request.params.collectionId, request.params.projectId],
      );
      if (!collection.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "collection_not_found" } });
      const rows = await db.query(
        `SELECT da.id AS asset_id, da.file_name, pv.display_mapping, sr.ordinal, sr.value
         FROM raw_material_collection c
         JOIN data_asset da ON da.collection_id = c.id AND da.project_id = c.project_id
         JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current AND pv.status = 'ready'
         JOIN source_record sr ON sr.parsed_view_id = pv.id AND sr.parse_status = 'valid'
         WHERE c.project_id = $1 AND c.id = $2
           AND da.status NOT IN ('deletion_pending', 'tombstoned')
           AND ($3::text IS NULL OR da.id = $3)
         ORDER BY da.uploaded_at DESC, da.id DESC, sr.ordinal`,
        [
          request.params.projectId,
          request.params.collectionId,
          request.query.assetId ?? null,
        ],
      );
      const search = request.query.search?.trim().toLowerCase();
      const records = rows.rows
        .map((row) => ({
          assetId: row.asset_id,
          ordinal: Number(row.ordinal),
          sourceFile: row.file_name,
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        }))
        .filter(
          (row) =>
            !search ||
            [
              row.question,
              row.expectedOutput,
              ...row.metadata.flatMap(({ key, value }) => [key, value]),
            ].some((value) => value.toLowerCase().includes(search)),
        );
      return {
        records: records.slice(offset, offset + limit),
        pagination: { total: records.length, limit, offset },
      };
    },
  );

  app.get<{
    Params: {
      projectId: string;
      collectionId: string;
      assetId: string;
      ordinal: string;
    };
  }>(
    "/api/projects/:projectId/collections/:collectionId/assets/:assetId/records/:ordinal",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const ordinal = Number(request.params.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 1)
        return reply.code(404).send({ error: { code: "record_not_found" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "record_not_found" } });
      const record = await db.query(
        `SELECT da.id AS asset_id, da.file_name, pv.display_mapping, sr.ordinal, sr.value
           FROM raw_material_collection c
           JOIN data_asset da ON da.collection_id = c.id AND da.project_id = c.project_id
           JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current AND pv.status = 'ready'
           JOIN source_record sr ON sr.parsed_view_id = pv.id AND sr.parse_status = 'valid'
          WHERE c.project_id = $1 AND c.id = $2 AND da.id = $3 AND sr.ordinal = $4
            AND da.status NOT IN ('deletion_pending', 'tombstoned')`,
        [
          request.params.projectId,
          request.params.collectionId,
          request.params.assetId,
          ordinal,
        ],
      );
      if (!record.rowCount)
        return reply.code(404).send({ error: { code: "record_not_found" } });
      const row = record.rows[0];
      return {
        record: {
          assetId: row.asset_id,
          ordinal: Number(row.ordinal),
          sourceFile: row.file_name,
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        },
      };
    },
  );

  app.patch<{
    Params: { projectId: string; assetId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/assets/:assetId/collection",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const collectionId =
        isPlainObject(request.body) &&
        Object.keys(request.body).length === 1 &&
        typeof request.body.collectionId === "string"
          ? request.body.collectionId
          : undefined;
      if (!collectionId)
        return reply
          .code(422)
          .send({ error: { code: "move_payload_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply
          .code(404)
          .send({ error: { code: "asset_or_collection_not_found" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:controlled-deletion-project:${request.params.projectId}`,
        ]);
        const moved = await client.query(
          `UPDATE data_asset da SET collection_id = $3
         WHERE da.id = $2 AND da.project_id = $1
           AND da.status NOT IN ('deletion_pending', 'tombstoned')
           AND EXISTS (SELECT 1 FROM raw_material_collection c WHERE c.id = $3 AND c.project_id = $1)
         RETURNING da.id`,
          [request.params.projectId, request.params.assetId, collectionId],
        );
        if (!moved.rowCount) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "asset_or_collection_not_found" } });
        }
        await client.query(
          `DELETE FROM version_export_cache c USING test_set_version v,test_set ts
            WHERE c.version_id=v.id AND v.test_set_id=ts.id AND ts.project_id=$1`,
          [request.params.projectId],
        );
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/collections",
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
        Object.keys(body).some(
          (key) => !["name", "description"].includes(key),
        ) ||
        typeof body.name !== "string" ||
        body.name.trim().length < 1 ||
        body.name.trim().length > 200 ||
        (body.description !== undefined &&
          (typeof body.description !== "string" ||
            body.description.length > 1_000))
      )
        return reply
          .code(422)
          .send({ error: { code: "collection_payload_invalid" } });
      const name = body.name.trim();
      if (name === "未整理")
        return reply
          .code(409)
          .send({ error: { code: "unfiled_collection_reserved" } });
      const id = opaqueId("collection");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO raw_material_collection
             (id, project_id, name, description, is_unfiled)
           VALUES ($1, $2, $3, $4, false)
           RETURNING id, project_id, name, description, is_unfiled,
                     created_at, updated_at`,
          [id, request.params.projectId, name, body.description ?? ""],
        );
        await client.query(
          `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'raw_material_collection_created',
                   'raw_material_collection', $3, $4)`,
          [request.params.projectId, actor.id, id, { name }],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          collection: collectionResponse({
            ...inserted.rows[0],
            file_count: 0,
            unified_record_count: 0,
          }),
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if ((error as { code?: string }).code === "23505")
          return reply
            .code(409)
            .send({ error: { code: "collection_name_conflict" } });
        throw error;
      } finally {
        client.release();
      }
    },
  );

  registerUploads({ db, artifacts, app, authenticate, writeAllowed });
  if (config.allowTestIdentity)
    app.post<{ Params: { projectId: string }; Body: Readable }>(
      "/api/projects/:projectId/assets",
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = (request as AuthenticatedRequest).actor;
        if (
          (request.headers.origin !== config.appOrigin &&
            !(
              config.allowTestIdentity &&
              request.headers.origin === "http://web:3000"
            )) ||
          request.headers["x-csrf-token"] !== actor.csrfToken
        ) {
          return reply.code(403).send({ error: { code: "csrf_rejected" } });
        }
        if (
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "write",
          ))
        )
          return reply.code(404).send({ error: { code: "project_not_found" } });

        const encodedUploadHeaders =
          firstHeaderValue(request.headers["x-agentbench-upload-encoding"]) ===
          UPLOAD_HEADER_ENCODING;
        const decodeHeader = (name: string, fallback = "") => {
          const raw = firstHeaderValue(request.headers[name]) ?? fallback;
          return decodeUploadHeader(raw, encodedUploadHeaders);
        };
        let fileName: string;
        let attribution: SourceAttributionInput;
        try {
          fileName = decodeHeader("x-file-name");
          attribution = {
            sourceType: decodeHeader("x-source-type").trim(),
            sourceName: decodeHeader("x-source-name").trim(),
            responsiblePerson: decodeHeader(
              "x-responsible-person",
              actor.username,
            ).trim(),
            purpose: decodeHeader("x-source-purpose").trim(),
            licenseStatus: decodeHeader("x-license-status").trim(),
            sensitivity: decodeHeader("x-sensitivity").trim(),
            sourceAddress: request.headers["x-source-address"]
              ? decodeHeader("x-source-address").trim()
              : null,
            acquiredAt: request.headers["x-acquired-at"]
              ? decodeHeader("x-acquired-at").trim()
              : null,
            deidentificationConfirmed:
              request.headers["x-deidentification-confirmed"] === "true",
          };
        } catch {
          return reply
            .code(400)
            .send({ error: { code: "upload_metadata_invalid" } });
        }
        const attributionError = validateSourceAttribution(attribution);
        if (attributionError) {
          return reply.code(422).send({ error: { code: attributionError } });
        }

        const format = assetFormat(fileName);
        if (!format) {
          return reply
            .code(415)
            .send({ error: { code: "unsupported_asset_format" } });
        }

        const key = String(request.headers["idempotency-key"] ?? "");
        if (!key)
          return reply
            .code(400)
            .send({ error: { code: "idempotency_key_required" } });
        const keyDigest = sha256(key);
        // Serialize exact-key retries and tombstone-digest lookups together.
        let storageKey = key;
        let operationId = opaqueId("upload");
        let reservationCreated = false;
        const reservationClient = await db.connect();
        try {
          await reservationClient.query("BEGIN");
          await reservationClient.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [
              `agentbench:upload-idempotency:${request.params.projectId}:${actor.id}:${keyDigest}`,
            ],
          );
          const priorReservation = await reservationClient.query(
            `SELECT idempotency_key, status FROM upload_idempotency
           WHERE project_id = $1 AND actor_id = $2 AND operation = 'asset_upload'
             AND ((status = 'tombstoned' AND idempotency_key_digest = $3)
               OR (status <> 'tombstoned' AND idempotency_key = $4))
           ORDER BY CASE WHEN status = 'tombstoned' THEN 1 ELSE 0 END
           LIMIT 1`,
            [request.params.projectId, actor.id, keyDigest, key],
          );
          if (
            priorReservation.rowCount &&
            priorReservation.rows[0].status !== "tombstoned"
          )
            storageKey = String(priorReservation.rows[0].idempotency_key);
          if (
            !priorReservation.rowCount ||
            priorReservation.rows[0].status !== "tombstoned"
          ) {
            const reservation = await reservationClient.query(
              `INSERT INTO upload_idempotency
             (project_id, actor_id, operation, idempotency_key,
              idempotency_key_digest, status, operation_id)
             VALUES ($1, $2, 'asset_upload', $3, $4, 'receiving', $5)
             ON CONFLICT DO NOTHING RETURNING operation_id`,
              [
                request.params.projectId,
                actor.id,
                storageKey,
                keyDigest,
                operationId,
              ],
            );
            if (reservation.rowCount) {
              reservationCreated = true;
              operationId = reservation.rows[0].operation_id;
            }
          }
          await reservationClient.query("COMMIT");
        } catch (error) {
          await reservationClient.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          reservationClient.release();
        }
        if (!reservationCreated) {
          const existing = await db.query(
            `SELECT idempotency_key, status, operation_id, asset_id, deleted_resource_id FROM upload_idempotency
           WHERE project_id = $1 AND actor_id = $2 AND operation = 'asset_upload'
             AND ((status = 'tombstoned' AND idempotency_key_digest = $3)
               OR (status <> 'tombstoned' AND idempotency_key = $4))
           ORDER BY CASE WHEN status = 'tombstoned' THEN 1 ELSE 0 END`,
            [request.params.projectId, actor.id, keyDigest, key],
          );
          if (existing.rows[0]?.status === "receiving") {
            return reply.code(409).send({
              error: {
                code: "idempotency_in_progress",
                operationId: existing.rows[0].operation_id,
              },
            });
          }
          if (existing.rows[0]?.status === "tombstoned") {
            return reply.code(410).send({
              error: {
                code: "idempotency_resource_gone",
                resourceId: existing.rows[0].deleted_resource_id ?? null,
              },
            });
          }
          if (
            existing.rows[0]?.status === "committed" &&
            existing.rows[0].asset_id
          ) {
            const committedAsset = await db.query(
              `SELECT status FROM data_asset WHERE id = $1 AND project_id = $2`,
              [existing.rows[0].asset_id, request.params.projectId],
            );
            if (
              !committedAsset.rowCount ||
              ["deletion_pending", "tombstoned"].includes(
                committedAsset.rows[0].status,
              ) ||
              (await hasAssetDeletionLock(
                request.params.projectId,
                String(existing.rows[0].asset_id),
              ))
            ) {
              return reply
                .code(
                  committedAsset.rows[0]?.status === "tombstoned" ? 410 : 409,
                )
                .send({
                  error: {
                    code:
                      committedAsset.rows[0]?.status === "tombstoned"
                        ? "idempotency_resource_gone"
                        : "deletion_locked",
                    resourceId: existing.rows[0].asset_id,
                  },
                });
            }
          }
          if (existing.rows[0]?.status === "failed") {
            storageKey = String(existing.rows[0].idempotency_key);
            const reclaimed = await db.query(
              `UPDATE upload_idempotency
             SET status = 'receiving', operation_id = $4, updated_at = now()
             WHERE project_id = $1 AND actor_id = $2
               AND operation = 'asset_upload' AND idempotency_key = $3
               AND status = 'failed'
             RETURNING operation_id`,
              [
                request.params.projectId,
                actor.id,
                storageKey,
                opaqueId("upload"),
              ],
            );
            if (!reclaimed.rowCount)
              return reply.code(409).send({
                error: {
                  code: "idempotency_in_progress",
                  operationId: existing.rows[0].operation_id,
                },
              });
            operationId = reclaimed.rows[0].operation_id;
          }
        }

        let stored;
        try {
          stored = await artifacts.storeOriginal(operationId, request.body);
        } catch (error) {
          await db.query(
            `UPDATE upload_idempotency SET status = 'failed', updated_at = now()
           WHERE project_id = $1 AND actor_id = $2 AND operation = 'asset_upload'
             AND idempotency_key = $3 AND status = 'receiving'
             AND operation_id = $4`,
            [request.params.projectId, actor.id, storageKey, operationId],
          );
          if ((error as { code?: string }).code === "asset_too_large") {
            const report = {
              code: "asset_too_large",
              errorCode: "asset_too_large",
              capacityBlock: true,
              object: { type: "data_asset_upload" },
              blockingPhase: "data_asset_upload",
              actualBytes: (error as { observedBytes?: number }).observedBytes,
              limitBytes: CAPACITY_LIMITS.dataAssetBytes,
              retry: "Upload an asset of at most 50 MB (50,000,000 bytes).",
            };
            await db.query(
              `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
             VALUES ($1, $2, 'asset_upload_capacity_blocked', 'asset_upload', $3, $4)`,
              [request.params.projectId, actor.id, operationId, report],
            );
            return reply.code(413).send({ error: report });
          }
          request.log.error(error);
          return reply.code(500).send({
            error: {
              code: "asset_upload_interrupted",
              blockingPhase: "data_asset_upload",
              retry: "Retry the complete upload with the same idempotency key.",
            },
          });
        }
        const metadataFingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              sha256: stored.sha256,
              size: stored.size,
              fileName,
              format,
              attribution,
            }),
          )
          .digest("hex");
        const legacyMetadataFingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              sha256: stored.sha256,
              fileName,
              mimeType: request.headers["content-type"],
              attribution,
            }),
          )
          .digest("hex");

        const existing = await db.query(
          `SELECT idempotency_key, status, request_fingerprint, asset_id, deleted_resource_id FROM upload_idempotency
         WHERE project_id = $1 AND actor_id = $2 AND operation = 'asset_upload'
           AND ((status = 'tombstoned' AND idempotency_key_digest = $3)
             OR (status <> 'tombstoned' AND idempotency_key = $4))
         ORDER BY CASE WHEN status = 'tombstoned' THEN 1 ELSE 0 END`,
          [request.params.projectId, actor.id, keyDigest, key],
        );
        if (existing.rows[0]?.status === "tombstoned") {
          return reply.code(410).send({
            error: {
              code: "idempotency_resource_gone",
              resourceId: existing.rows[0].deleted_resource_id ?? null,
            },
          });
        }
        if (existing.rows[0]?.status === "committed") {
          if (
            existing.rows[0].request_fingerprint !== metadataFingerprint &&
            existing.rows[0].request_fingerprint !== legacyMetadataFingerprint
          ) {
            return reply
              .code(409)
              .send({ error: { code: "idempotency_conflict" } });
          }
          const prior = await db.query(
            `SELECT da.*, sar.id AS attribution_id,
                  sar.source_type, sar.source_name, sar.purpose,
                  sar.responsible_actor, sar.responsible_person,
                  sar.license_status, sar.sensitivity, sar.source_address,
                  sar.acquired_at, sar.deidentification_confirmed,
                  sar.created_at AS attribution_created_at,
                  pv.id AS parsed_view_id, pv.status AS parsed_view_status,
                  job.id AS job_id, job.status AS job_status
           FROM data_asset da
           JOIN LATERAL (
             SELECT * FROM source_attribution_revision
             WHERE asset_id = da.id ORDER BY created_at, id LIMIT 1
           ) sar ON true
           LEFT JOIN LATERAL (
             SELECT id, status FROM parsed_view WHERE asset_id = da.id
             ORDER BY created_at, id LIMIT 1
           ) pv ON true
           LEFT JOIN LATERAL (
             SELECT id, status FROM job WHERE payload ->> 'assetId' = da.id
             ORDER BY created_at, id LIMIT 1
           ) job ON true
           WHERE da.id = $1`,
            [existing.rows[0].asset_id],
          );
          if (
            !prior.rowCount ||
            ["deletion_pending", "tombstoned"].includes(prior.rows[0].status) ||
            (await hasAssetDeletionLock(
              request.params.projectId,
              String(existing.rows[0].asset_id),
            ))
          ) {
            return reply
              .code(prior.rows[0]?.status === "tombstoned" ? 410 : 409)
              .send({
                error: {
                  code:
                    prior.rows[0]?.status === "tombstoned"
                      ? "idempotency_resource_gone"
                      : "deletion_locked",
                  resourceId: existing.rows[0].asset_id,
                },
              });
          }
          return {
            asset: assetResponse(prior.rows[0], actor.username),
            attribution: {
              id: prior.rows[0].attribution_id,
              ...attributionFromRow(prior.rows[0]),
            },
            parsedView: {
              id: prior.rows[0].parsed_view_id,
              status: prior.rows[0].parsed_view_status,
            },
            job: {
              id: prior.rows[0].job_id,
              status: prior.rows[0].job_status,
            },
            replayed: true,
          };
        }

        const assetId = opaqueId("asset");
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await lockDeletionBlob(client, stored.sha256);
          const lockedBlob = await client.query(
            `SELECT 1 FROM deletion_lock
           WHERE object_type = 'data_blob' AND object_id = $1 LIMIT 1`,
            [stored.sha256],
          );
          if (lockedBlob.rowCount)
            throw Object.assign(new Error("deletion_locked"), {
              code: "deletion_locked",
            });
          // The object was committed before this transaction acquired the blob
          // lock. Recheck it so a concurrent deletion cannot leave a dangling
          // Data Asset reference after the lock is released.
          try {
            await artifacts.size(stored.objectRef);
          } catch {
            throw Object.assign(new Error("deletion_locked"), {
              code: "deletion_locked",
            });
          }
          const inserted = await client.query(
            `INSERT INTO data_asset
           (id, project_id, blob_sha256, object_ref, size_bytes, mime_type, file_name, format, status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stored', $9) RETURNING *`,
            [
              assetId,
              request.params.projectId,
              stored.sha256,
              stored.objectRef,
              stored.size,
              request.headers["content-type"],
              fileName,
              format,
              actor.id,
            ],
          );
          const attributionId = opaqueId("attr");
          await client.query(
            `INSERT INTO source_attribution_revision
           (id, asset_id, source_type, source_name, purpose, responsible_actor, responsible_person,
            license_status, sensitivity, source_address, acquired_at, deidentification_confirmed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              attributionId,
              assetId,
              attribution.sourceType,
              attribution.sourceName,
              attribution.purpose,
              actor.id,
              attribution.responsiblePerson,
              attribution.licenseStatus,
              attribution.sensitivity,
              attribution.sourceAddress,
              attribution.acquiredAt,
              attribution.deidentificationConfirmed,
            ],
          );
          await client.query(
            `UPDATE upload_idempotency SET status = 'committed', request_fingerprint = $4, asset_id = $5, updated_at = now()
           WHERE project_id = $1 AND actor_id = $2 AND operation = 'asset_upload'
           AND idempotency_key = $3 AND status = 'receiving'
            AND operation_id = $6`,
            [
              request.params.projectId,
              actor.id,
              storageKey,
              metadataFingerprint,
              assetId,
              operationId,
            ],
          );
          await client.query(
            `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'asset_upload_completed', 'data_asset', $3, $4)`,
            [
              request.params.projectId,
              actor.id,
              assetId,
              { size: stored.size, sha256: stored.sha256 },
            ],
          );
          const parsedViewId = opaqueId("view");
          const jobId = opaqueId("job");
          const parserConfig = defaultParserConfig(format);
          const parserConfigHash = sha256(canonicalJson(parserConfig));
          await client.query(
            `INSERT INTO parsed_view
           (id, asset_id, format, parser_name, parser_version, parser_config, parser_config_hash, status)
           VALUES ($1, $2, $3, 'format-adapter', $4, $5, $6, 'queued')`,
            [
              parsedViewId,
              assetId,
              format,
              PARSER_VERSION,
              parserConfig,
              parserConfigHash,
            ],
          );
          await client.query(
            `INSERT INTO job
             (id, project_id, actor_id, kind, payload, status, correlation_id,
              idempotency_key, max_attempts, next_run_at)
           VALUES ($1, $2, $3, 'parse_asset', $4, 'queued', $1, $5, $6,
                   now() + ($7::bigint * interval '1 millisecond'))`,
            [
              jobId,
              request.params.projectId,
              actor.id,
              { assetId, parsedViewId },
              `parse:${assetId}:${PARSER_VERSION}:${parserConfigHash}`,
              config.jobMaxAttempts,
              config.jobClaimDelayMs,
            ],
          );
          await client.query(
            `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'parse_attempt_requested', 'parsed_view', $3, $4)`,
            [
              request.params.projectId,
              actor.id,
              parsedViewId,
              {
                parserVersion: PARSER_VERSION,
                parserConfigHash,
                correlationId: jobId,
              },
            ],
          );
          await client.query("COMMIT");
          return reply.code(201).send({
            asset: assetResponse(inserted.rows[0], actor.username),
            attribution: { id: attributionId, ...attribution },
            parsedView: { id: parsedViewId, status: "queued" },
            job: { id: jobId, status: "queued" },
          });
        } catch (error) {
          await client.query("ROLLBACK");
          if ((error as { code?: string }).code === "deletion_locked") {
            const reservationCleanup = await db.connect();
            try {
              await reservationCleanup.query("BEGIN");
              await reservationCleanup.query(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                [
                  `agentbench:upload-idempotency:${request.params.projectId}:${actor.id}:${keyDigest}`,
                ],
              );
              await reservationCleanup.query(
                `UPDATE upload_idempotency SET status = 'failed', updated_at = now()
               WHERE project_id = $1 AND actor_id = $2
                 AND operation = 'asset_upload' AND idempotency_key = $3
                 AND operation_id = $4 AND status = 'receiving'`,
                [request.params.projectId, actor.id, storageKey, operationId],
              );
              await reservationCleanup.query("COMMIT");
            } catch {
              await reservationCleanup.query("ROLLBACK").catch(() => undefined);
            } finally {
              reservationCleanup.release();
            }
            try {
              const referenced = await db.query(
                `SELECT 1 FROM data_asset
               WHERE blob_sha256 = $1 AND status <> 'tombstoned' LIMIT 1`,
                [stored.sha256],
              );
              if (!referenced.rowCount) {
                await artifacts.remove(stored.objectRef).catch(() => undefined);
                await artifacts
                  .remove(`markers/sha256/${stored.sha256}.json`)
                  .catch(() => undefined);
              }
            } catch {
              // Keep the object for the orphan scan if cleanup cannot be checked.
            }
            return reply.code(409).send({
              error: { code: "deletion_locked" },
            });
          }
          throw error;
        } finally {
          client.release();
        }
      },
    );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/test-sets",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const limit = request.query.limit ? Number(request.query.limit) : 100;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      if (
        Object.keys(request.query).some(
          (key) => !["limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `SELECT ts.id, ts.name, ts.status AS availability,
                dv.id AS default_id, dv.sequence AS default_sequence,
                dv.status AS default_status,
                lv.id AS latest_id, lv.sequence AS latest_sequence,
                lv.status AS latest_status, lv.item_count,
                lv.published_at, lv.published_by, lv.published_by_username,
                dr.status AS delivery_status,
                EXISTS (
                  SELECT 1
                  FROM deletion_lock dl
                  LEFT JOIN test_set_version locked_v
                    ON locked_v.id = dl.object_id
                   AND locked_v.test_set_id = ts.id
                  WHERE dl.project_id = ts.project_id
                    AND ((dl.object_type = 'test_set' AND dl.object_id = ts.id
                          AND ts.status <> 'unavailable_by_deletion')
                      OR (dl.object_type = 'test_set_version'
                          AND locked_v.status <> 'degraded_by_deletion'))
                ) AS deletion_locked
         FROM test_set ts
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $2
         LEFT JOIN test_set_version dv ON dv.id = ts.default_version_id
         LEFT JOIN LATERAL (
           SELECT v.id, v.sequence, v.status, v.item_count, v.published_at,
                  v.published_by, u.username AS published_by_username
           FROM test_set_version v
           JOIN app_user u ON u.id = v.published_by
           WHERE v.test_set_id = ts.id
           ORDER BY v.sequence DESC LIMIT 1
         ) lv ON true
         LEFT JOIN LATERAL (
           SELECT d.status
           FROM delivery_record d
           JOIN test_set_version v ON v.id = d.version_id
           WHERE v.test_set_id = ts.id
           ORDER BY d.created_at DESC, d.id DESC LIMIT 1
         ) dr ON true
         WHERE ts.project_id = $1
         ORDER BY ts.created_at DESC, ts.id DESC
         LIMIT $3 OFFSET $4`,
        [request.params.projectId, actor.id, String(limit), String(offset)],
      );
      const total = await db.query(
        `SELECT count(*)::text AS total
         FROM test_set ts
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $2
         WHERE ts.project_id = $1`,
        [request.params.projectId, actor.id],
      );
      return {
        testSets: result.rows.map((row) => {
          const unavailable = row.availability === "unavailable_by_deletion";
          const deletionLocked = Boolean(row.deletion_locked);
          return {
            id: row.id,
            name: row.name,
            availability: row.availability,
            defaultVersion:
              !unavailable && !deletionLocked && row.default_id
                ? {
                    id: row.default_id,
                    number: Number(row.default_sequence),
                    status: row.default_status,
                  }
                : null,
            latestVersion:
              !unavailable && !deletionLocked && row.latest_id
                ? {
                    id: row.latest_id,
                    number: Number(row.latest_sequence),
                    status: row.latest_status,
                    publishedAt: new Date(row.published_at).toISOString(),
                  }
                : null,
            testCaseCount:
              unavailable || deletionLocked || row.item_count === null
                ? null
                : Number(row.item_count),
            lastPublisher:
              unavailable || deletionLocked
                ? null
                : (row.published_by_username ?? null),
            recentDeliveryState:
              unavailable || deletionLocked
                ? null
                : (row.delivery_status ?? null),
          };
        }),
        pagination: {
          total: Number(total.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const allowed = new Set(["limit", "offset"]);
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const summary = await testSetSummary(
        request.params.projectId,
        request.params.testSetId,
        actor.id,
      );
      if (!summary)
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const locked = await db.query(
        `SELECT 1
         FROM deletion_lock dl
         JOIN test_set ts ON ts.project_id = $1 AND ts.id = $2
         LEFT JOIN test_set_version v
           ON v.test_set_id = ts.id AND v.id = dl.object_id
         WHERE dl.project_id = $1
           AND ((dl.object_type = 'test_set' AND dl.object_id = ts.id
                 AND ts.status <> 'unavailable_by_deletion')
             OR (dl.object_type = 'test_set_version' AND v.status <> 'degraded_by_deletion'))
         LIMIT 1`,
        [request.params.projectId, request.params.testSetId],
      );
      if (locked.rowCount) return deletionLocked(reply);
      const result = await db.query(
        `SELECT ts.id AS test_set_id, ts.name, ts.status AS availability, ts.default_version_id,
                v.id, v.sequence, v.parent_version_id, v.change_note, v.status,
                v.archived_at, v.archive_reason, v.item_count, v.payload_hash,
                v.evidence_hash, v.manifest_hash, v.published_at,
                app_user.username AS published_by
         FROM test_set ts
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         JOIN test_set_version v ON v.test_set_id = ts.id
         JOIN app_user ON app_user.id = v.published_by
         WHERE ts.project_id = $1 AND ts.id = $2
         ORDER BY v.sequence ASC
         LIMIT $4 OFFSET $5`,
        [
          request.params.projectId,
          request.params.testSetId,
          actor.id,
          String(limit),
          String(offset),
        ],
      );
      const total = await db.query(
        `SELECT count(*)::text AS total
         FROM test_set ts
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         JOIN test_set_version v ON v.test_set_id = ts.id
         WHERE ts.project_id = $1 AND ts.id = $2`,
        [request.params.projectId, request.params.testSetId, actor.id],
      );
      return {
        testSet: testSetSummaryResponse(summary),
        versions: result.rows.map((row) => {
          const degraded = row.status === "degraded_by_deletion";
          return {
            id: row.id,
            number: Number(row.sequence),
            parentVersionId: row.parent_version_id ?? null,
            changeNote: degraded ? "" : (row.change_note ?? ""),
            status: row.status ?? "published",
            archivedAt: row.archived_at
              ? new Date(row.archived_at).toISOString()
              : null,
            archiveReason: degraded ? null : (row.archive_reason ?? null),
            isDefault: !degraded && row.default_version_id === row.id,
            itemCount: degraded ? null : Number(row.item_count),
            payloadHash: degraded ? null : row.payload_hash,
            evidenceHash: degraded ? null : row.evidence_hash,
            manifestHash: degraded ? null : row.manifest_hash,
            publishedBy: degraded ? null : row.published_by,
            publishedAt: degraded
              ? null
              : new Date(row.published_at).toISOString(),
          };
        }),
        pagination: {
          total: Number(total.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
    },
  );

  app.post<{ Params: { projectId: string; jobId: string } }>(
    "/api/projects/:projectId/jobs/:jobId/cancel",
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
        return reply.code(404).send({ error: { code: "job_not_found" } });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const job = await client.query(
          `SELECT j.id, j.kind, j.status, j.stage
           FROM job j
           JOIN project_member pm
             ON pm.project_id = j.project_id AND pm.user_id = $3
            AND pm.role IN ('owner', 'editor')
           WHERE j.id = $1 AND j.project_id = $2
           FOR UPDATE OF j`,
          [request.params.jobId, request.params.projectId, actor.id],
        );
        if (!job.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "job_not_found" } });
        }
        if (job.rows[0].kind === "controlled_deletion") {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "deletion_cannot_be_cancelled" },
            job: { id: job.rows[0].id, status: job.rows[0].status },
          });
        }
        if (!["queued", "running", "retry_wait"].includes(job.rows[0].status)) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "job_already_finished" },
            job: { id: job.rows[0].id, status: job.rows[0].status },
          });
        }
        if (
          job.rows[0].kind === "publish_version" &&
          job.rows[0].stage === "publication_transaction"
        ) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "publication_cancel_window_closed" },
            job: { id: job.rows[0].id, status: job.rows[0].status },
          });
        }
        const cancelled = await client.query(
          `UPDATE job
           SET status = 'cancel_requested', stage = 'cancel_requested', updated_at = now()
           WHERE id = $1
           RETURNING id, kind, status, stage, progress, attempt, correlation_id`,
          [request.params.jobId],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'job_cancel_requested', 'job', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.jobId,
            { correlationId: request.params.jobId, stage: job.rows[0].stage },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          job: {
            id: cancelled.rows[0].id,
            kind: cancelled.rows[0].kind,
            status: cancelled.rows[0].status,
            stage: cancelled.rows[0].stage,
            progress: Number(cancelled.rows[0].progress),
            attempt: Number(cancelled.rows[0].attempt),
            correlationId: cancelled.rows[0].correlation_id,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { projectId: string; jobId: string } }>(
    "/api/projects/:projectId/jobs/:jobId/retry",
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
        return reply.code(404).send({ error: { code: "job_not_found" } });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const job = await client.query(
          `SELECT j.id, j.kind, j.status, j.retryable, j.error_code
           FROM job j
           JOIN project_member pm
             ON pm.project_id = j.project_id AND pm.user_id = $3
            AND pm.role IN ('owner', 'editor')
           WHERE j.id = $1 AND j.project_id = $2
           FOR UPDATE OF j`,
          [request.params.jobId, request.params.projectId, actor.id],
        );
        if (!job.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "job_not_found" } });
        }
        if (job.rows[0].status !== "failed") {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "job_not_retryable" },
            job: { id: job.rows[0].id, status: job.rows[0].status },
          });
        }
        if (
          !["infrastructure_unavailable", "job_lease_expired"].includes(
            job.rows[0].error_code,
          )
        ) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "job_not_retryable" },
            job: { id: job.rows[0].id, status: job.rows[0].status },
          });
        }
        const retried = await client.query(
          `UPDATE job
           SET status = 'queued', stage = 'queued', progress = 0, attempt = 0,
               error_code = NULL, retryable = NULL, result = NULL,
               counts = '{}'::jsonb, lease_owner = NULL,
               lease_expires_at = NULL, next_run_at = now(), updated_at = now()
           WHERE id = $1
           RETURNING id, kind, status, stage, progress, attempt, correlation_id`,
          [request.params.jobId],
        );
        if (job.rows[0].kind === "parse_asset") {
          const parsedViewId = (
            await client.query(
              "SELECT payload ->> 'parsedViewId' AS id FROM job WHERE id = $1",
              [request.params.jobId],
            )
          ).rows[0].id;
          await client.query(
            "UPDATE parsed_view SET status = 'queued' WHERE id = $1 AND status = 'parse_failed'",
            [parsedViewId],
          );
        }
        if (job.rows[0].kind === "materialize_candidate") {
          const candidateId = (
            await client.query(
              "SELECT payload ->> 'candidateId' AS id FROM job WHERE id = $1",
              [request.params.jobId],
            )
          ).rows[0].id;
          await client.query(
            `UPDATE candidate_snapshot SET status = 'materializing'
             WHERE id = $1 AND status = 'failed'`,
            [candidateId],
          );
          await client.query(
            `UPDATE working_draft SET status = 'materializing'
             WHERE id = (SELECT draft_id FROM candidate_snapshot WHERE id = $1)
               AND status = 'editing'`,
            [candidateId],
          );
        }
        if (job.rows[0].kind === "publish_version") {
          const candidateId = (
            await client.query(
              "SELECT payload ->> 'candidateId' AS id FROM job WHERE id = $1",
              [request.params.jobId],
            )
          ).rows[0].id;
          await client.query(
            `UPDATE candidate_snapshot SET status = 'publishing'
             WHERE id = $1 AND status = 'publish_failed'`,
            [candidateId],
          );
        }
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'job_retry_requested', 'job', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.jobId,
            { correlationId: request.params.jobId },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          job: {
            id: retried.rows[0].id,
            kind: retried.rows[0].kind,
            status: retried.rows[0].status,
            stage: retried.rows[0].stage,
            progress: Number(retried.rows[0].progress),
            attempt: Number(retried.rows[0].attempt),
            correlationId: retried.rows[0].correlation_id,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: { projectId: string; assetId: string };
    Querystring: { view?: string };
  }>(
    "/api/projects/:projectId/assets/:assetId/download",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        Object.keys(request.query).some((key) => key !== "view") ||
        request.query.view !== "raw"
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const client = await db.connect();
      let asset: { rows: Array<Record<string, any>>; rowCount?: number | null };
      let preview: Buffer;
      try {
        await client.query("BEGIN");
        asset = await client.query(
          `SELECT da.object_ref, da.mime_type, da.file_name FROM data_asset da
           WHERE da.project_id = $1 AND da.id = $2
             AND da.status NOT IN ('deletion_pending', 'tombstoned')
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = da.project_id
                 AND dl.object_type = 'data_asset' AND dl.object_id = da.id
             )
           FOR SHARE OF da`,
          [request.params.projectId, request.params.assetId],
        );
        if (!asset.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        if (
          await integrityBlocked(reply, request.params.projectId, [
            { type: "data_asset", id: request.params.assetId },
          ])
        ) {
          await client.query("COMMIT");
          return reply;
        }
        preview = await artifacts.readPrefix(
          asset.rows[0].object_ref,
          1_000_004,
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      await db.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'asset_raw_previewed', 'data_asset', $3, '{}')`,
        [request.params.projectId, actor.id, request.params.assetId],
      );
      return {
        rawPreview: {
          text: utf8Prefix(preview, 1_000_000),
          truncated: preview.byteLength > 1_000_000,
        },
      };
    },
  );

  app.put<{
    Params: { projectId: string; assetId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/assets/:assetId/attribution",
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
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const attribution = attributionInput(request.body);
      if (!attribution || validateSourceAttribution(attribution)) {
        return reply
          .code(422)
          .send({ error: { code: "source_attribution_incomplete" } });
      }
      const id = opaqueId("attr");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const asset = await client.query(
          `SELECT id, status FROM data_asset
           WHERE id = $1 AND project_id = $2 FOR UPDATE`,
          [request.params.assetId, request.params.projectId],
        );
        if (!asset.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        if (
          await hasDeletionLock(
            request.params.projectId,
            [{ type: "data_asset", id: request.params.assetId }],
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        if (["deletion_pending", "tombstoned"].includes(asset.rows[0].status)) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const inserted = await client.query(
          `INSERT INTO source_attribution_revision
           (id, asset_id, source_type, source_name, purpose, responsible_actor, responsible_person,
            license_status, sensitivity, source_address, acquired_at, deidentification_confirmed)
           SELECT $1, da.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
           FROM data_asset da WHERE da.id = $12 AND da.project_id = $13 RETURNING *`,
          [
            id,
            attribution.sourceType,
            attribution.sourceName,
            attribution.purpose,
            actor.id,
            attribution.responsiblePerson,
            attribution.licenseStatus,
            attribution.sensitivity,
            attribution.sourceAddress,
            attribution.acquiredAt,
            attribution.deidentificationConfirmed,
            request.params.assetId,
            request.params.projectId,
          ],
        );
        if (!inserted.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        await client.query(
          `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'source_attribution_revised', 'source_attribution_revision', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            id,
            { assetId: request.params.assetId },
          ],
        );
        await client.query("COMMIT");
        return { attribution: attributionResponse(inserted.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/attributions",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const revisions = await db.query(
        `SELECT sar.* FROM source_attribution_revision sar
         JOIN data_asset da ON da.id = sar.asset_id
         JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $3
         WHERE da.project_id = $1 AND da.id = $2
           AND da.status NOT IN ('deletion_pending', 'tombstoned')
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = da.project_id
               AND dl.object_type = 'data_asset' AND dl.object_id = da.id
           )
         ORDER BY sar.created_at, sar.id`,
        [request.params.projectId, request.params.assetId, actor.id],
      );
      if (!revisions.rowCount)
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      return { attributions: revisions.rows.map(attributionResponse) };
    },
  );

  app.get<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/audit",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const events = await db.query(
        `SELECT ae.id, ae.action, ae.object_type, ae.object_id, ae.created_at, u.username
         FROM data_asset da
         JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $3
         JOIN audit_event ae ON ae.project_id = da.project_id
         JOIN app_user u ON u.id = ae.actor_id
         WHERE da.project_id = $1 AND da.id = $2
           AND (ae.object_type = 'data_asset' AND ae.object_id = da.id
                OR ae.details ->> 'assetId' = da.id)
         ORDER BY ae.created_at, ae.id`,
        [request.params.projectId, request.params.assetId, actor.id],
      );
      if (!events.rowCount) {
        const asset = await db.query(
          `SELECT 1 FROM data_asset da
           JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $3
           WHERE da.project_id = $1 AND da.id = $2`,
          [request.params.projectId, request.params.assetId, actor.id],
        );
        if (!asset.rowCount)
          return reply.code(404).send({ error: { code: "asset_not_found" } });
      }
      return {
        events: events.rows.map((event) => ({
          id: event.id,
          action: event.action,
          objectType: event.object_type,
          objectId: event.object_id,
          actor: event.username,
          occurredAt: new Date(event.created_at).toISOString(),
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/archive",
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
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const asset = await client.query(
          `SELECT id, status FROM data_asset
           WHERE id = $1 AND project_id = $2 FOR UPDATE`,
          [request.params.assetId, request.params.projectId],
        );
        if (!asset.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        if (
          await hasDeletionLock(
            request.params.projectId,
            [{ type: "data_asset", id: request.params.assetId }],
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        if (["deletion_pending", "tombstoned"].includes(asset.rows[0].status)) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const archived = await client.query(
          `UPDATE data_asset SET status = 'archived'
           WHERE id = $1 AND project_id = $2
             AND status NOT IN ('archived', 'deletion_pending', 'tombstoned')
           RETURNING *`,
          [request.params.assetId, request.params.projectId],
        );
        if (archived.rowCount) {
          await client.query(
            `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id)
             VALUES ($1, $2, 'asset_archived', 'data_asset', $3)`,
            [request.params.projectId, actor.id, request.params.assetId],
          );
          await client.query("COMMIT");
          return { asset: assetResponse(archived.rows[0], actor.username) };
        }
        const existing = await client.query(
          "SELECT * FROM data_asset WHERE id = $1 AND project_id = $2",
          [request.params.assetId, request.params.projectId],
        );
        if (!existing.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        await client.query("COMMIT");
        return { asset: assetResponse(existing.rows[0], actor.username) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId",
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
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const asset = await db.query(
        `SELECT 1 FROM data_asset WHERE id = $1 AND project_id = $2`,
        [request.params.assetId, request.params.projectId],
      );
      if (!asset.rowCount)
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      if (
        await hasDeletionLock(request.params.projectId, [
          { type: "data_asset", id: request.params.assetId },
        ])
      )
        return deletionLocked(reply);
      const reference = await db.query(
        `SELECT 1 FROM data_asset da
         JOIN candidate_snapshot cs ON cs.asset_id = da.id
         JOIN test_set_version v ON v.candidate_id = cs.id
         WHERE da.id = $1 AND da.project_id = $2 LIMIT 1`,
        [request.params.assetId, request.params.projectId],
      );
      return reply.code(409).send({
        error: {
          code: reference.rowCount
            ? "asset_referenced_by_published_version"
            : "ordinary_asset_deletion_not_supported",
          retry: "Archive the asset or use the Controlled Deletion workflow.",
        },
      });
    },
  );

  function writeAllowed(
    request: FastifyRequest,
    actor: AuthenticatedRequest["actor"],
  ): boolean {
    return (
      (request.headers.origin === config.appOrigin ||
        (config.allowTestIdentity &&
          request.headers.origin === "http://web:3000")) &&
      request.headers["x-csrf-token"] === actor.csrfToken
    );
  }

  async function integrityBlocked(
    reply: FastifyReply,
    projectId: string,
    objects: Array<{ type: string; id: string }>,
  ): Promise<boolean> {
    if (!objects.length) return false;
    const values: unknown[] = [projectId];
    const clauses = objects.map(({ type, id }) => {
      values.push(type, id);
      return `(object_type=$${values.length - 1} AND object_id=$${values.length})`;
    });
    const finding = await db.query(
      `SELECT 1 FROM consistency_finding
       WHERE project_id=$1 AND status='open' AND (${clauses.join(" OR ")})
       LIMIT 1`,
      values,
    );
    if (!finding.rowCount) return false;
    reply.code(409).send({
      error: {
        code: "integrity_blocked",
        retry:
          "The integrity finding must be reviewed; published hashes are never rewritten automatically.",
      },
    });
    return true;
  }

  async function candidateIntegrityObjects(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    candidateId: string,
  ): Promise<Array<{ type: string; id: string }>> {
    const result = await queryable.query(
      `WITH candidate AS (
         SELECT cs.id, cs.base_version_id, cs.asset_id,
                COALESCE(cs.sources, dr.sources) AS sources
         FROM candidate_snapshot cs
         LEFT JOIN draft_revision dr ON dr.id = cs.draft_revision_id
         JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE cs.id = $1 AND ts.project_id = $2
       ), refs AS (
         SELECT 'candidate_snapshot'::text AS object_type, id AS object_id
         FROM candidate
         UNION ALL
         SELECT 'candidate_evidence', c.id
         FROM candidate c
         JOIN candidate_snapshot cs ON cs.id = c.id
         WHERE cs.evidence_object_ref IS NOT NULL
         UNION ALL
         SELECT 'data_asset', c.asset_id
         FROM candidate c
         WHERE c.asset_id IS NOT NULL
         UNION ALL
         SELECT 'data_asset', source.value ->> 'assetId'
         FROM candidate c
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(c.sources) = 'array' THEN c.sources
             ELSE '[]'::jsonb
           END
         ) AS source(value)
         UNION ALL
         SELECT 'test_set_version', base_version_id
         FROM candidate
         WHERE base_version_id IS NOT NULL
         UNION ALL
         SELECT tri.object_type, tri.object_id
         FROM candidate_transformation_run ctr
         JOIN transformation_run_input tri ON tri.run_id = ctr.run_id
         JOIN candidate c ON c.id = ctr.candidate_id
       )
       SELECT DISTINCT object_type AS type, object_id AS id
       FROM refs
       WHERE object_id IS NOT NULL`,
      [candidateId, projectId],
    );
    return result.rows.map((row: { type: string; id: string }) => ({
      type: row.type,
      id: row.id,
    }));
  }

  async function hasDeletionLock(
    projectId: string,
    refs: Array<{ type: string; id: string | undefined }>,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const usable = refs.filter((ref): ref is { type: string; id: string } =>
      Boolean(ref.id),
    );
    if (!usable.length) return false;
    const values: unknown[] = [projectId];
    const clauses = usable.map((ref) => {
      values.push(ref.type, ref.id);
      return `(object_type = $${values.length - 1} AND object_id = $${values.length})`;
    });
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock WHERE project_id = $1 AND (${clauses.join(" OR ")}) LIMIT 1`,
      values,
    );
    return Boolean(result.rowCount);
  }

  async function lockDraftDeletionReferences(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    draftId: string,
    extra: Array<{ assetId?: string; parsedViewId?: string }> = [],
  ) {
    const existing = await queryable.query(
      `SELECT ds.asset_id, ds.parsed_view_id
       FROM draft_source ds
       JOIN working_draft wd ON wd.id = ds.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ds.draft_id = $1 AND ts.project_id = $2 AND ds.removed_at IS NULL`,
      [draftId, projectId],
    );
    const assetIds = new Set<string>();
    const parsedViewIds = new Set<string>();
    for (const ref of [...existing.rows, ...extra]) {
      if (ref.asset_id || ref.assetId)
        assetIds.add(String(ref.asset_id ?? ref.assetId));
      if (ref.parsed_view_id || ref.parsedViewId)
        parsedViewIds.add(String(ref.parsed_view_id ?? ref.parsedViewId));
    }
    if (assetIds.size)
      await queryable.query(
        `SELECT da.id FROM data_asset da
         WHERE da.project_id = $2 AND da.id = ANY($1::text[])
         ORDER BY da.id FOR SHARE OF da`,
        [[...assetIds], projectId],
      );
    if (parsedViewIds.size)
      await queryable.query(
        `SELECT pv.id FROM parsed_view pv
         JOIN data_asset da ON da.id = pv.asset_id
         WHERE da.project_id = $2 AND pv.id = ANY($1::text[])
         ORDER BY pv.id FOR SHARE OF pv`,
        [[...parsedViewIds], projectId],
      );
  }

  async function draftDeletionBlocked(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    draftId: string,
  ): Promise<boolean> {
    return hasDraftDeletionLock(projectId, draftId, queryable);
  }

  async function lockAssetRow(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    assetId: string,
  ) {
    const result = await queryable.query(
      `SELECT da.* FROM data_asset da
       WHERE da.id = $1 AND da.project_id = $2
       FOR UPDATE`,
      [assetId, projectId],
    );
    return result.rows[0] as Record<string, any> | undefined;
  }

  async function lockParsedViewRow(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    viewId: string,
  ) {
    const result = await queryable.query(
      `SELECT pv.* FROM parsed_view pv
       JOIN data_asset da ON da.id = pv.asset_id
       WHERE pv.id = $1 AND da.project_id = $2
       FOR UPDATE OF pv`,
      [viewId, projectId],
    );
    return result.rows[0] as Record<string, any> | undefined;
  }

  async function lockCaseRevisionRow(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    revisionId: string,
  ) {
    const result = await queryable.query(
      `SELECT cr.* FROM case_revision cr
       JOIN test_case tc ON tc.id = cr.case_id
       JOIN test_set ts ON ts.id = tc.test_set_id
       WHERE cr.id = $1 AND ts.project_id = $2
       FOR UPDATE OF cr`,
      [revisionId, projectId],
    );
    return result.rows[0] as Record<string, any> | undefined;
  }

  async function lockVersionRow(
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    },
    projectId: string,
    versionId: string,
  ) {
    const result = await queryable.query(
      `SELECT v.* FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE v.id = $1 AND ts.project_id = $2
       FOR UPDATE OF v`,
      [versionId, projectId],
    );
    return result.rows[0] as Record<string, any> | undefined;
  }

  function deletionStateBlocked(row: Record<string, any> | undefined) {
    return Boolean(
      row && ["deletion_pending", "tombstoned"].includes(row.status),
    );
  }

  async function enforceDeletionLock(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const params = request.params as Record<string, string | undefined>;
    const projectId = params.projectId;
    const actor = (request as AuthenticatedRequest).actor;
    if (
      !projectId ||
      !(await hasProjectCapability(db, projectId, actor.id, "read"))
    )
      return false;
    const path = String(request.url ?? "").split("?", 1)[0];
    const segments = path.split("/").filter(Boolean);
    const isVersionTombstoneRead =
      request.method === "GET" &&
      segments.length === 7 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "test-sets" &&
      segments[5] === "versions";
    if (isVersionTombstoneRead) {
      const version = await db.query(
        `SELECT 1 FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
           AND v.status = 'degraded_by_deletion'`,
        [projectId, segments[4], segments[6]],
      );
      // A completed deletion intentionally leaves a tombstone-only version
      // readable; payload routes remain blocked by their own lock checks.
      if (version.rowCount) return false;
    }
    const after = (name: string) =>
      segments
        .flatMap((segment, index) =>
          segment === name ? [segments[index + 1]] : [],
        )
        .filter((id): id is string => Boolean(id));
    let locked = false;
    for (const assetId of after("assets"))
      if (assetId !== "assets") {
        locked = await hasAssetDeletionLock(projectId, assetId);
        if (locked) break;
      }
    for (const viewId of after("parsed-views")) {
      if (locked) break;
      locked = await hasParsedViewDeletionLock(projectId, viewId);
    }
    for (const draftId of after("drafts")) {
      if (locked) break;
      locked = await hasDraftDeletionLock(projectId, draftId);
    }
    for (const candidateId of after("candidates")) {
      if (locked) break;
      locked = await hasCandidateDeletionLock(projectId, candidateId);
    }
    for (const runId of after("transformation-runs")) {
      if (locked) break;
      locked = await hasRunDeletionLock(projectId, runId);
    }
    for (const deliveryId of after("deliveries")) {
      if (locked) break;
      locked = await hasDeliveryDeletionLock(projectId, deliveryId);
    }
    for (const versionId of after("versions")) {
      if (locked) break;
      locked = await hasVersionDeletionLock(projectId, versionId);
    }
    for (const versionId of after("compare")) {
      if (locked) break;
      locked = await hasVersionDeletionLock(projectId, versionId);
    }
    for (const testSetId of after("test-sets")) {
      if (locked) break;
      locked = await hasDeletionLock(projectId, [
        { type: "test_set", id: testSetId },
      ]);
    }
    if (!locked) return false;
    deletionLocked(reply);
    return true;
  }

  async function hasAssetDeletionLock(
    projectId: string,
    assetId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       WHERE dl.project_id = $1 AND (
         (dl.object_type = 'data_asset' AND dl.object_id = $2)
         OR (dl.object_type = 'parsed_view' AND EXISTS (
           SELECT 1 FROM parsed_view pv WHERE pv.id = dl.object_id AND pv.asset_id = $2
         ))
         OR (dl.object_type = 'working_draft' AND EXISTS (
           SELECT 1 FROM draft_source ds JOIN working_draft wd ON wd.id = ds.draft_id
           WHERE ds.asset_id = $2 AND ds.draft_id = dl.object_id
         ))
       ) LIMIT 1`,
      [projectId, assetId],
    );
    return Boolean(result.rowCount);
  }

  async function hasParsedViewDeletionLock(
    projectId: string,
    viewId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN parsed_view pv ON pv.id = $2
       WHERE dl.project_id = $1 AND (
         (dl.object_type = 'parsed_view' AND dl.object_id = $2)
         OR (dl.object_type = 'data_asset' AND dl.object_id = pv.asset_id)
         OR (dl.object_type = 'working_draft' AND EXISTS (
           SELECT 1 FROM draft_source ds
           WHERE ds.draft_id = dl.object_id AND ds.parsed_view_id = $2
         ))
       ) LIMIT 1`,
      [projectId, viewId],
    );
    return Boolean(result.rowCount);
  }

  async function hasDraftDeletionLock(
    projectId: string,
    draftId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN working_draft wd ON wd.id = $2
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'working_draft' AND dl.object_id = $2)
         OR (dl.object_type = 'test_set' AND dl.object_id = wd.test_set_id)
         OR (dl.object_type = 'data_asset' AND dl.object_id IN (
           SELECT ds.asset_id FROM draft_source ds WHERE ds.draft_id = $2
         ))
         OR (dl.object_type = 'parsed_view' AND dl.object_id IN (
           SELECT ds.parsed_view_id FROM draft_source ds WHERE ds.draft_id = $2
         ))
         OR (dl.object_type = 'candidate_snapshot' AND dl.object_id IN (
           SELECT cs.id FROM candidate_snapshot cs WHERE cs.draft_id = $2
         ))
         OR (dl.object_type = 'test_set_version' AND dl.object_id IN (
           SELECT wd.base_version_id
           WHERE wd.base_version_id IS NOT NULL
         ))
       ) LIMIT 1`,
      [projectId, draftId],
    );
    return Boolean(result.rowCount);
  }

  async function hasCandidateDeletionLock(
    projectId: string,
    candidateId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN candidate_snapshot cs ON cs.id = $2
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'candidate_snapshot' AND dl.object_id = $2)
         OR (dl.object_type = 'working_draft' AND dl.object_id = cs.draft_id)
         OR (dl.object_type = 'test_set' AND dl.object_id = ts.id)
         OR (dl.object_type = 'test_set_version' AND dl.object_id IN (
           SELECT v.id FROM test_set_version v WHERE v.candidate_id = $2
         ))
         OR (dl.object_type = 'data_asset' AND dl.object_id IN (
           SELECT ds.asset_id
           FROM candidate_item ci
           JOIN draft_source ds ON ds.id = ci.draft_source_id
           WHERE ci.candidate_id = $2
         ))
         OR (dl.object_type = 'parsed_view' AND dl.object_id IN (
           SELECT ci.parsed_view_id FROM candidate_item ci WHERE ci.candidate_id = $2
         ))
       ) LIMIT 1`,
      [projectId, candidateId],
    );
    return Boolean(result.rowCount);
  }

  async function hasVersionDeletionLock(
    projectId: string,
    versionId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN test_set_version v ON v.id = $2
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'test_set_version' AND dl.object_id = $2)
         OR (dl.object_type = 'test_set' AND dl.object_id = ts.id)
         OR (dl.object_type = 'candidate_snapshot' AND dl.object_id = v.candidate_id)
         OR (dl.object_type = 'delivery_record' AND dl.object_id IN (
           SELECT dr.id FROM delivery_record dr WHERE dr.version_id = $2
         ))
       ) LIMIT 1`,
      [projectId, versionId],
    );
    return Boolean(result.rowCount);
  }

  async function hasRunDeletionLock(
    projectId: string,
    runId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN transformation_run tr ON tr.id = $2
       WHERE dl.project_id = $1 AND tr.project_id = $1 AND (
         (dl.object_type = 'transformation_run' AND dl.object_id = $2)
         OR (dl.object_type = 'data_asset' AND dl.object_id IN (
           SELECT tro.asset_id FROM transformation_run_output tro WHERE tro.run_id = $2
           UNION SELECT tri.object_id FROM transformation_run_input tri
             WHERE tri.run_id = $2 AND tri.object_type = 'data_asset'
         ))
         OR (dl.object_type = 'test_set_version' AND dl.object_id IN (
           SELECT tri.object_id FROM transformation_run_input tri
           WHERE tri.run_id = $2 AND tri.object_type = 'test_set_version'
         ))
       ) LIMIT 1`,
      [projectId, runId],
    );
    return Boolean(result.rowCount);
  }

  async function hasDeliveryDeletionLock(
    projectId: string,
    deliveryId: string,
    queryable: {
      query: (text: string, values?: unknown[]) => Promise<any>;
    } = db,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN delivery_record dr ON dr.id = $2
       JOIN test_set_version v ON v.id = dr.version_id
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'delivery_record' AND dl.object_id = $2)
         OR (dl.object_type = 'test_set_version' AND dl.object_id = v.id)
         OR (dl.object_type = 'test_set' AND dl.object_id = ts.id)
       ) LIMIT 1`,
      [projectId, deliveryId],
    );
    return Boolean(result.rowCount);
  }

  function deletionLocked(reply: FastifyReply, code = "deletion_locked") {
    return reply.code(409).send({ error: { code } });
  }

  function newLease() {
    const issuedAt = now();
    return {
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(issuedAt.getTime() + config.draftLeaseDurationMs),
    };
  }

  function draftResponse(row: Record<string, any>, actorId?: string) {
    return {
      id: row.id,
      testSetId: row.test_set_id,
      status: row.status,
      baseVersionId: row.base_version_id ?? null,
      revision: Number(row.revision),
      ...(row.lease_holder_id === actorId &&
      row.lease_expires_at &&
      new Date(row.lease_expires_at).getTime() > now().getTime()
        ? { leaseToken: row.lease_token }
        : {}),
      leaseHolderId: row.lease_holder_id,
      leaseExpiresAt: row.lease_expires_at
        ? new Date(row.lease_expires_at).toISOString()
        : null,
      recipe: row.recipe,
      versionDescription: row.version_description,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at).toISOString(),
      leaseRenewIntervalMs: config.draftLeaseRenewIntervalMs,
      ...(row.capacity ? { capacity: row.capacity } : {}),
      ...(row.sources ? { sources: row.sources } : {}),
    };
  }

  async function testSetSummary(
    projectId: string,
    testSetId: string,
    actorId: string,
  ) {
    const result = await db.query(
      `SELECT ts.id, ts.name, ts.purpose, ts.owner_id,
              owner.username AS owner_username,
              ts.status AS availability, ts.default_version_id,
              dv.sequence AS default_sequence, dv.status AS default_status,
              dv.item_count AS default_item_count,
              lv.id AS latest_id, lv.sequence AS latest_sequence,
              lv.status AS latest_status, lv.item_count AS latest_item_count,
              lv.published_at AS latest_published_at,
              lv.published_by_username AS latest_publisher
       FROM test_set ts
       JOIN project_member pm
         ON pm.project_id = ts.project_id AND pm.user_id = $3
       JOIN app_user owner ON owner.id = ts.owner_id
       LEFT JOIN test_set_version dv ON dv.id = ts.default_version_id
       LEFT JOIN LATERAL (
         SELECT v.id, v.sequence, v.status, v.item_count, v.published_at,
                u.username AS published_by_username
         FROM test_set_version v
         JOIN app_user u ON u.id = v.published_by
         WHERE v.test_set_id = ts.id
         ORDER BY v.sequence DESC
         LIMIT 1
       ) lv ON true
       WHERE ts.project_id = $1 AND ts.id = $2`,
      [projectId, testSetId, actorId],
    );
    return result.rows[0] as Record<string, any> | undefined;
  }

  function testSetSummaryResponse(row: Record<string, any>) {
    const unavailable = row.availability === "unavailable_by_deletion";
    const defaultVersion =
      !unavailable &&
      row.default_version_id &&
      row.default_status !== "degraded_by_deletion"
        ? {
            id: row.default_version_id,
            number: Number(row.default_sequence),
            status: row.default_status,
            itemCount:
              row.default_item_count === null
                ? null
                : Number(row.default_item_count),
          }
        : null;
    const latestVersion =
      !unavailable &&
      row.latest_id &&
      row.latest_status !== "degraded_by_deletion"
        ? {
            id: row.latest_id,
            number: Number(row.latest_sequence),
            status: row.latest_status,
            itemCount:
              row.latest_item_count === null
                ? null
                : Number(row.latest_item_count),
            publishedAt: row.latest_published_at
              ? new Date(row.latest_published_at).toISOString()
              : null,
            publishedBy: row.latest_publisher ?? null,
          }
        : null;
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      ownerId: row.owner_id,
      owner: row.owner_username,
      availability: row.availability,
      defaultVersionId: defaultVersion?.id ?? null,
      defaultVersion,
      latestVersion,
    };
  }

  async function draftCapacity(draftId: string) {
    const result = await db.query(DRAFT_CAPACITY_SQL, [draftId]);
    const totals = draftCapacityFromRow(result.rows[0]);
    return {
      attachedAssets: totals.assets,
      assetLimit: CAPACITY_LIMITS.draftAssets,
      originalBytes: totals.originalBytes,
      originalByteLimit: CAPACITY_LIMITS.draftOriginalBytes,
      sourceRecords: totals.sourceRecords,
      sourceRecordLimit: CAPACITY_LIMITS.draftSourceRecords,
    };
  }

  async function draftSources(draftId: string) {
    const result = await db.query(
      `SELECT ds.id, ds.asset_id, ds.parsed_view_id, ds.position,
              ds.mapping, ds.unmapped_fields, ds.unmapped_confirmed
       FROM draft_source ds
       WHERE ds.draft_id = $1 AND ds.removed_at IS NULL ORDER BY ds.position`,
      [draftId],
    );
    const sourceIds = result.rows.map((row) => row.id);
    const bindings = sourceIds.length
      ? await db.query(
          `SELECT source_id, source_record_ordinal, output_slot, case_id
           FROM draft_case_binding
           WHERE source_id = ANY($1::text[])
           ORDER BY source_id, source_record_ordinal, output_slot`,
          [sourceIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const bindingsBySource = new Map<string, unknown[]>();
    for (const binding of bindings.rows) {
      const sourceBindings = bindingsBySource.get(binding.source_id) ?? [];
      sourceBindings.push({
        sourceRecordOrdinal: Number(binding.source_record_ordinal),
        outputSlot: binding.output_slot,
        caseId: binding.case_id,
      });
      bindingsBySource.set(binding.source_id, sourceBindings);
    }
    return result.rows.map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      parsedViewId: row.parsed_view_id,
      position: Number(row.position),
      mapping: row.mapping,
      unmappedFields: row.unmapped_fields ?? [],
      unmappedConfirmed: Boolean(row.unmapped_confirmed),
      caseBindings: bindingsBySource.get(row.id) ?? [],
    }));
  }

  function draftWriteError(
    draft: Record<string, any>,
    actorId: string,
    leaseToken: unknown,
    expectedRevision: unknown,
  ) {
    if (
      typeof leaseToken !== "string" ||
      draft.lease_holder_id !== actorId ||
      draft.lease_token !== leaseToken ||
      !draft.lease_expires_at ||
      new Date(draft.lease_expires_at).getTime() <= now().getTime()
    ) {
      return {
        code: "draft_lease_invalid",
        currentRevision: Number(draft.revision),
      };
    }
    if (
      !Number.isInteger(expectedRevision) ||
      Number(draft.revision) !== expectedRevision
    ) {
      return {
        code: "draft_revision_conflict",
        currentRevision: Number(draft.revision),
      };
    }
    return undefined;
  }

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { mapping?: unknown; sourceId?: string };
  }>(
    "/api/projects/:projectId/drafts/:draftId/mapping/preview",
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
      const draft = await db.query(
        `SELECT wd.recipe FROM working_draft wd
         JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         WHERE wd.id = $1 AND ts.project_id = $2`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const sources = await db.query(
        `SELECT ds.id, ds.parsed_view_id, ds.mapping FROM draft_source ds
         WHERE ds.draft_id = $1 AND ds.removed_at IS NULL
           AND ($2::text IS NULL OR ds.id = $2)
         ORDER BY ds.position`,
        [request.params.draftId, request.body?.sourceId ?? null],
      );
      const unmappedSamples = new Map<string, unknown>();
      const pairs: any[] = [];
      for (const source of sources.rows) {
        const mapping = normalizeDraftMapping(
          request.body?.mapping ?? source.mapping,
        );
        if (!mapping)
          return reply.code(422).send({ error: { code: "mapping_invalid" } });
        const records = await db.query(
          `SELECT ordinal, locator, value, record_hash FROM source_record
           WHERE parsed_view_id = $1 AND parse_status = 'valid'
           ORDER BY ordinal`,
          [source.parsed_view_id],
        );
        const mappedFields = new Set(mappedSourceFields(mapping));
        for (const record of records.rows) {
          for (const path of sourceLeafPaths(record.value)) {
            if (
              sourcePathIsMapped(path, mappedFields) ||
              unmappedSamples.has(path)
            )
              continue;
            unmappedSamples.set(path, sourceValueAt(record.value, path).value);
          }
        }
        pairs.push(
          ...selectedSourceRows(
            records.rows,
            source.parsed_view_id,
            draft.rows[0].recipe,
          )
            .slice(0, 20)
            .map((record) => ({
              sourceId: source.id,
              ordinal: Number(record.ordinal),
              locator: record.locator,
              ...replayMapping(record.value, mapping),
            })),
        );
        if (pairs.length >= 20) break;
      }
      return {
        pairs: pairs.slice(0, 20),
        unmappedFields: [...unmappedSamples]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, sample]) => ({ path, sample })),
      };
    },
  );

  app.post<{ Params: { projectId: string; versionId: string } }>(
    "/api/projects/:projectId/versions/:versionId/langfuse-csv",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const version = await client.query(
          `SELECT v.id FROM test_set_version v
           JOIN test_set ts ON ts.id=v.test_set_id
           WHERE v.id=$1 AND ts.project_id=$2
             AND v.status IN ('published','archived')
           FOR UPDATE OF v`,
          [request.params.versionId, request.params.projectId],
        );
        if (!version.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({
            error: { code: "version_not_found" },
          });
        }
        if (
          await hasVersionDeletionLock(
            request.params.projectId,
            request.params.versionId,
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const jobId = opaqueId("job");
        const idempotencyKey = `langfuse-csv:${request.params.versionId}:csv-v1`;
        await client.query(
          `INSERT INTO job
           (id,project_id,actor_id,kind,payload,status,correlation_id,
            idempotency_key,max_attempts,next_run_at)
           VALUES ($1,$2,$3,'generate_langfuse_csv',$4,'queued',$1,$5,$6,
                   now() + ($7::bigint * interval '1 millisecond'))
           ON CONFLICT (project_id,kind,idempotency_key) DO NOTHING`,
          [
            jobId,
            request.params.projectId,
            actor.id,
            { versionId: request.params.versionId },
            idempotencyKey,
            config.jobMaxAttempts,
            config.jobClaimDelayMs,
          ],
        );
        await resetCancelledGenerationJob(client, {
          projectId: request.params.projectId,
          versionId: request.params.versionId,
          packageType: "langfuse_csv",
          formatVersion: "csv-v1",
          kind: "generate_langfuse_csv",
          idempotencyKey,
        });
        const job = await client.query(
          `SELECT id,status FROM job
           WHERE project_id=$1 AND kind='generate_langfuse_csv'
             AND idempotency_key=$2
           FOR UPDATE`,
          [request.params.projectId, idempotencyKey],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          job: { id: job.rows[0].id, status: job.rows[0].status },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    "/api/projects/:projectId/drafts/:draftId/mapping/schema-suggestion",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const draft = await db.query(
        `SELECT wd.recipe FROM working_draft wd
         JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         WHERE wd.id = $1 AND ts.project_id = $2`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const sources = await db.query(
        `SELECT ds.id, ds.parsed_view_id, ds.mapping FROM draft_source ds
         WHERE ds.draft_id = $1 AND ds.removed_at IS NULL ORDER BY ds.position`,
        [request.params.draftId],
      );
      const contexts: any[] = [];
      for (const source of sources.rows) {
        const mapping = normalizeDraftMapping(
          source.mapping ?? draft.rows[0].recipe?.mapping,
        );
        if (!mapping)
          return reply.code(422).send({ error: { code: "mapping_invalid" } });
        const records = await db.query(
          `SELECT ordinal, locator, value, record_hash FROM source_record
           WHERE parsed_view_id = $1 AND parse_status = 'valid' ORDER BY ordinal`,
          [source.parsed_view_id],
        );
        const selected = selectedSourceRows(
          records.rows,
          source.parsed_view_id,
          draft.rows[0].recipe,
        );
        contexts.push({ source, mapping, selected });
      }
      const mapped = contexts.flatMap(({ mapping, selected }) =>
        selected.map((record: any) => replayMapping(record.value, mapping)),
      );
      if (mapped.some((item) => item.errors.length))
        return reply
          .code(422)
          .send({ error: { code: "mapping_records_invalid" } });
      const suggestion = suggestFormalSchema(mapped.map((item) => item.item));
      const identity = {
        mappingHash: sha256(
          canonicalJson(
            contexts.map(({ source, mapping }) => ({
              sourceId: source.id,
              mapping,
            })),
          ),
        ),
        selectedRecordsHash: sha256(
          canonicalJson(
            contexts.flatMap(({ source, selected }) =>
              selected.map((record: any) => ({
                sourceId: source.id,
                parsedViewId: source.parsed_view_id,
                ordinal: Number(record.ordinal),
                recordHash: record.record_hash,
              })),
            ),
          ),
        ),
      };
      const proposalId = opaqueId("schema_proposal");
      const proposalClient = await db.connect();
      try {
        await proposalClient.query("BEGIN");
        await lockDraftDeletionReferences(
          proposalClient,
          request.params.projectId,
          request.params.draftId,
        );
        const lockedDraft = await proposalClient.query(
          `SELECT wd.id FROM working_draft wd
           JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!lockedDraft.rowCount) {
          await proposalClient.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            proposalClient,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await proposalClient.query("ROLLBACK");
          return deletionLocked(reply);
        }
        await proposalClient.query(
          `INSERT INTO formal_schema_proposal
           (id, draft_id, mapping_hash, selected_records_hash, scanned_record_count, suggestion)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            proposalId,
            request.params.draftId,
            identity.mappingHash,
            identity.selectedRecordsHash,
            mapped.length,
            suggestion,
          ],
        );
        await proposalClient.query("COMMIT");
      } catch (error) {
        await proposalClient.query("ROLLBACK");
        throw error;
      } finally {
        proposalClient.release();
      }
      return {
        proposalId,
        scannedRecordCount: mapped.length,
        suggestion,
      };
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    "/api/projects/:projectId/drafts/:draftId/mapping/validation",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const draft = await db.query(
        `SELECT wd.recipe, fs.mode, fs.input_schema, fs.expected_output_schema
         FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         LEFT JOIN formal_schema_revision fs ON fs.id = wd.formal_schema_id
         WHERE wd.id = $1 AND ts.project_id = $2`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      if (!draft.rows[0].input_schema)
        return reply
          .code(422)
          .send({ error: { code: "draft_mapping_or_schema_missing" } });
      const sources = await db.query(
        `SELECT ds.id, ds.parsed_view_id, ds.mapping
         FROM draft_source ds
         WHERE ds.draft_id = $1 AND ds.removed_at IS NULL
         ORDER BY ds.position`,
        [request.params.draftId],
      );
      if (!sources.rowCount)
        return reply
          .code(422)
          .send({ error: { code: "draft_mapping_or_schema_missing" } });
      const errors: any[] = [];
      for (const source of sources.rows) {
        const mapping = normalizeDraftMapping(
          source.mapping ??
            (sources.rowCount === 1
              ? draft.rows[0].recipe?.mapping
              : undefined),
        );
        if (!mapping) {
          errors.push({ sourceId: source.id, code: "mapping_invalid" });
          continue;
        }
        const records = await db.query(
          `SELECT ordinal, locator, value, record_hash FROM source_record
           WHERE parsed_view_id = $1 AND parse_status = 'valid' ORDER BY ordinal`,
          [source.parsed_view_id],
        );
        errors.push(
          ...selectedSourceRows(
            records.rows,
            source.parsed_view_id,
            draft.rows[0].recipe,
          ).flatMap((record) => {
            const replay = replayMapping(record.value, mapping);
            const formal = replay.errors.length
              ? []
              : validateFormalItems(
                  draft.rows[0].input_schema,
                  draft.rows[0].expected_output_schema,
                  [replay.item],
                  draft.rows[0].mode,
                ).errors;
            return [...replay.errors, ...formal].map((error) => ({
              sourceId: source.id,
              ordinal: Number(record.ordinal),
              locator: record.locator,
              ...error,
            }));
          }),
        );
      }
      return { valid: !errors.length, errors };
    },
  );

  app.delete<{
    Params: { projectId: string; draftId: string; sourceId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/sources/:sourceId",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draftResult = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draftResult.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = draftResult.rows[0];
        const writeError = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }
        const source = await client.query(
          `UPDATE draft_source SET removed_at = $3
           WHERE id = $1 AND draft_id = $2 AND removed_at IS NULL
           RETURNING id, asset_id, parsed_view_id, position`,
          [request.params.sourceId, current.id, now()],
        );
        if (!source.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "draft_source_not_found" } });
        }
        const updated = await client.query(
          `UPDATE working_draft
           SET revision = revision + 1, mapping_revision_id = NULL,
               formal_schema_id = NULL, updated_by = $2, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [current.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_source_removed', 'draft_source', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.sourceId,
            { draftId: current.id, assetId: source.rows[0].asset_id },
          ],
        );
        await client.query("COMMIT");
        const sources = await draftSources(current.id);
        return {
          source: {
            id: source.rows[0].id,
            removed: true,
            assetId: source.rows[0].asset_id,
          },
          draft: draftResponse({ ...updated.rows[0], sources }, actor.id),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
      caseId: string;
    };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:versionId/cases/:caseId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT v.sequence, v.status, vm.ordinal, cr.*,
                ci.origin_kind AS candidate_origin_kind,
                ci.parent_case_revision_id AS candidate_parent_revision_id,
                ci.manual_reason, ci.origin_ref, sr.locator, sr.record_hash,
                pv.asset_id
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $4
         JOIN LATERAL resolve_version_members(v.id) vm ON true
         JOIN case_revision cr ON cr.id = vm.case_revision_id
         JOIN candidate_snapshot cs ON cs.id = v.candidate_id
         LEFT JOIN candidate_item ci
           ON ci.candidate_id = cs.id AND ci.ordinal = vm.ordinal
         LEFT JOIN source_record sr
           ON ci.origin_kind = 'source_record'
          AND ci.parsed_view_id = sr.parsed_view_id
          AND ci.source_record_ordinal = sr.ordinal
         LEFT JOIN parsed_view pv ON pv.id = ci.parsed_view_id
         WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
           AND cr.case_id = $5`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          actor.id,
          request.params.caseId,
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "case_not_found" } });
      const row = result.rows[0];
      return {
        version: { id: request.params.versionId, number: Number(row.sequence) },
        testCase: {
          caseId: row.case_id,
          revisionId: row.id,
          ordinal: Number(row.ordinal),
          input: row.input,
          expected_output: row.expected_output,
          metadata: row.metadata,
          contentHash: row.content_hash,
          reason: row.reason ?? row.manual_reason ?? null,
          parentCaseRevisionId:
            row.parent_revision_id ?? row.candidate_parent_revision_id ?? null,
          originKind: row.candidate_origin_kind ?? row.origin_kind,
          origin: row.origin_ref ?? {},
          sourceRecord: row.locator
            ? {
                assetId: row.asset_id,
                parsedViewId: row.parsed_view_id,
                locator: row.locator,
                recordHash: row.record_hash,
                rawAssetDownloadUrl: `/api/projects/${request.params.projectId}/assets/${row.asset_id}/download`,
              }
            : null,
        },
      };
    },
  );

  app.post<{
    Params: { projectId: string; assetId: string };
    Body: { config?: unknown };
  }>(
    "/api/projects/:projectId/assets/:assetId/parse-attempts",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor)) {
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      }
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      ) {
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const asset = await lockAssetRow(
          client,
          request.params.projectId,
          request.params.assetId,
        );
        if (!asset) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        if (
          deletionStateBlocked(asset) ||
          (await hasAssetDeletionLock(
            request.params.projectId,
            request.params.assetId,
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const format = asset.format as AssetFormat;
        const parserConfig = normalizeParserConfig(
          format,
          request.body?.config,
        );
        if (!parserConfig) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "invalid_parser_config" } });
        }
        const parserConfigHash = sha256(canonicalJson(parserConfig));
        const parsedViewId = opaqueId("view");
        const jobId = opaqueId("job");
        const inserted = await client.query(
          `INSERT INTO parsed_view
           (id, asset_id, format, parser_name, parser_version, parser_config, parser_config_hash, status)
           VALUES ($1, $2, $3, 'format-adapter', $4, $5, $6, 'queued')
           ON CONFLICT (asset_id, parser_version, parser_config_hash) DO NOTHING
           RETURNING id, status`,
          [
            parsedViewId,
            request.params.assetId,
            format,
            PARSER_VERSION,
            parserConfig,
            parserConfigHash,
          ],
        );
        if (!inserted.rowCount) {
          const existing = await client.query(
            `SELECT id, status FROM parsed_view
             WHERE asset_id = $1 AND parser_version = $2 AND parser_config_hash = $3`,
            [request.params.assetId, PARSER_VERSION, parserConfigHash],
          );
          await client.query("COMMIT");
          return {
            parsedView: existing.rows[0],
            replayed: true,
          };
        }
        await client.query(
          `INSERT INTO job
             (id, project_id, actor_id, kind, payload, status, correlation_id,
              idempotency_key, max_attempts, next_run_at)
           VALUES ($1, $2, $3, 'parse_asset', $4, 'queued', $1, $5, $6,
                   now() + ($7::bigint * interval '1 millisecond'))`,
          [
            jobId,
            request.params.projectId,
            actor.id,
            { assetId: request.params.assetId, parsedViewId },
            `parse:${request.params.assetId}:${PARSER_VERSION}:${parserConfigHash}`,
            config.jobMaxAttempts,
            config.jobClaimDelayMs,
          ],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'parse_attempt_requested', 'parsed_view', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            parsedViewId,
            {
              parserVersion: PARSER_VERSION,
              parserConfigHash,
              correlationId: jobId,
            },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          parsedView: { id: parsedViewId, status: "queued" },
          job: { id: jobId, status: "queued" },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/parse-attempts",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const attempts = await db.query(
        `SELECT pv.id, pv.status, pv.parser_version, pv.parser_config,
                pv.parser_config_hash, pv.record_count, pv.success_count,
                pv.failure_count, pv.boundary_trusted, pv.draft_eligible,
                pv.is_current, pv.error_summary, pv.created_at
         FROM data_asset da
         JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $3
         JOIN parsed_view pv ON pv.asset_id = da.id
         WHERE da.project_id = $1 AND da.id = $2
           AND da.status NOT IN ('deletion_pending', 'tombstoned')
           AND NOT EXISTS (SELECT 1 FROM deletion_lock dl
                           WHERE dl.project_id = da.project_id
                             AND dl.object_type = 'data_asset' AND dl.object_id = da.id)
         ORDER BY pv.created_at, pv.id`,
        [request.params.projectId, request.params.assetId, actor.id],
      );
      if (!attempts.rowCount) {
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      }
      return {
        attempts: attempts.rows.map((row) => ({
          id: row.id,
          status: row.status,
          parserVersion: row.parser_version,
          parserConfig: row.parser_config,
          parserConfigHash: row.parser_config_hash,
          totalCount: row.record_count,
          successCount: row.success_count,
          failureCount: row.failure_count,
          boundaryTrusted: row.boundary_trusted,
          draftEligible: row.draft_eligible,
          isCurrent: row.is_current,
          errors: row.error_summary?.errors ?? [],
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    },
  );

  app.get<{
    Params: { projectId: string; viewId: string; ordinal: string };
  }>(
    "/api/projects/:projectId/parsed-views/:viewId/records/:ordinal/location",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const located = await db.query(
        `SELECT da.id AS asset_id, sr.ordinal, sr.locator, sr.parse_status, sr.parse_error
         FROM source_record sr
         JOIN parsed_view pv ON pv.id = sr.parsed_view_id
         JOIN data_asset da ON da.id = pv.asset_id
         JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $4
         WHERE da.project_id = $1 AND pv.id = $2 AND sr.ordinal = $3
           AND da.status NOT IN ('deletion_pending', 'tombstoned')
           AND pv.status NOT IN ('deletion_pending', 'tombstoned')
           AND NOT EXISTS (SELECT 1 FROM deletion_lock dl
                           WHERE dl.project_id = da.project_id
                             AND ((dl.object_type = 'data_asset' AND dl.object_id = da.id)
                               OR (dl.object_type = 'parsed_view' AND dl.object_id = pv.id)))`,
        [
          request.params.projectId,
          request.params.viewId,
          Number(request.params.ordinal),
          actor.id,
        ],
      );
      if (!located.rowCount) {
        return reply
          .code(404)
          .send({ error: { code: "source_record_not_found" } });
      }
      const row = located.rows[0];
      return {
        object: {
          type: "source_record",
          parsedViewId: request.params.viewId,
          ordinal: row.ordinal,
        },
        locator: row.locator,
        parseStatus: row.parse_status,
        ...(row.parse_error ? { error: row.parse_error } : {}),
        rawAssetDownloadUrl: `/api/projects/${request.params.projectId}/assets/${row.asset_id}/download`,
      };
    },
  );

  app.post<{ Params: { projectId: string; viewId: string } }>(
    "/api/projects/:projectId/parsed-views/:viewId/select",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor)) {
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      }
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      ) {
        return reply
          .code(404)
          .send({ error: { code: "parsed_view_not_found" } });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query(
          `SELECT pv.id, pv.asset_id, pv.status, da.project_id FROM parsed_view pv
           JOIN data_asset da ON da.id = pv.asset_id
           WHERE pv.id = $1
           FOR UPDATE OF pv`,
          [request.params.viewId],
        );
        if (
          !target.rowCount ||
          target.rows[0].project_id !== request.params.projectId
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "parsed_view_not_found" } });
        }
        if (
          await hasDeletionLock(
            request.params.projectId,
            [
              { type: "parsed_view", id: request.params.viewId },
              { type: "data_asset", id: target.rows[0].asset_id },
            ],
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        if (!["ready", "superseded"].includes(target.rows[0].status)) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "parsed_view_not_selectable" } });
        }
        await client.query(
          `UPDATE parsed_view SET is_current = false,
             status = CASE WHEN status = 'ready' THEN 'superseded' ELSE status END
           WHERE asset_id = $1 AND id <> $2 AND is_current`,
          [target.rows[0].asset_id, request.params.viewId],
        );
        await client.query(
          "UPDATE parsed_view SET is_current = true WHERE id = $1",
          [request.params.viewId],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id)
           VALUES ($1, $2, 'parsed_view_selected', 'parsed_view', $3)`,
          [request.params.projectId, actor.id, request.params.viewId],
        );
        await client.query("COMMIT");
        return {
          parsedView: {
            id: request.params.viewId,
            status: target.rows[0].status,
            isCurrent: true,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; viewId: string };
    Body: { locators?: unknown[] };
  }>(
    "/api/projects/:projectId/parsed-views/:viewId/exclusions",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor)) {
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      }
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      ) {
        return reply
          .code(404)
          .send({ error: { code: "parsed_view_not_found" } });
      }
      if (
        !Array.isArray(request.body?.locators) ||
        request.body.locators.length === 0
      ) {
        return reply
          .code(422)
          .send({ error: { code: "invalid_parse_exclusion" } });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const viewRef = await client.query(
          `SELECT pv.asset_id FROM parsed_view pv
           JOIN data_asset da ON da.id = pv.asset_id
           WHERE pv.id = $1 AND da.project_id = $2`,
          [request.params.viewId, request.params.projectId],
        );
        if (!viewRef.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "parsed_view_not_found" } });
        }
        const asset = await lockAssetRow(
          client,
          request.params.projectId,
          String(viewRef.rows[0].asset_id),
        );
        if (!asset) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "parsed_view_not_found" } });
        }
        if (
          deletionStateBlocked(asset) ||
          (await hasAssetDeletionLock(
            request.params.projectId,
            String(viewRef.rows[0].asset_id),
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const parsedView = await lockParsedViewRow(
          client,
          request.params.projectId,
          request.params.viewId,
        );
        if (
          !parsedView ||
          deletionStateBlocked(parsedView) ||
          (await hasParsedViewDeletionLock(
            request.params.projectId,
            request.params.viewId,
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const view = await client.query(
          `SELECT pv.id, pv.record_count, pv.failure_count, pv.boundary_trusted
           FROM parsed_view pv
           WHERE pv.id = $1 AND pv.status IN ('ready', 'superseded')`,
          [request.params.viewId],
        );
        if (!view.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "parsed_view_not_found" } });
        }
        const failures = await client.query(
          `SELECT locator, parse_error FROM source_record
           WHERE parsed_view_id = $1 AND parse_status = 'invalid'`,
          [request.params.viewId],
        );
        const byLocator = new Map(
          failures.rows.map((row) => [canonicalJson(row.locator), row]),
        );
        if (
          request.body.locators.some(
            (locator) => !byLocator.has(canonicalJson(locator)),
          )
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "invalid_parse_exclusion" } });
        }
        for (const locator of request.body.locators) {
          const failure = byLocator.get(canonicalJson(locator));
          await client.query(
            `INSERT INTO parsed_view_exclusion (parsed_view_id, locator, reason)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [
              request.params.viewId,
              locator,
              failure?.parse_error?.reason ?? "Invalid Source Record.",
            ],
          );
        }
        const exclusions = await client.query(
          `SELECT locator, reason FROM parsed_view_exclusion
           WHERE parsed_view_id = $1 ORDER BY locator::text`,
          [request.params.viewId],
        );
        const excludedCount = exclusions.rows.length;
        const remainingFailures = await client.query(
          `SELECT sr.ordinal, sr.value, sr.locator, sr.record_hash, sr.parse_status, sr.parse_error
           FROM source_record sr
           WHERE sr.parsed_view_id = $1 AND sr.parse_status = 'invalid'
             AND NOT EXISTS (
               SELECT 1 FROM parsed_view_exclusion pve
               WHERE pve.parsed_view_id = sr.parsed_view_id AND pve.locator = sr.locator
             )
           ORDER BY sr.ordinal LIMIT 100`,
          [request.params.viewId],
        );
        const remainingFailureCount =
          Number(view.rows[0].failure_count) - excludedCount;
        const draftEligible =
          view.rows[0].boundary_trusted &&
          Number(view.rows[0].record_count) <=
            CAPACITY_LIMITS.parsedViewRecords &&
          remainingFailureCount === 0;
        await client.query(
          "UPDATE parsed_view SET draft_eligible = $2 WHERE id = $1",
          [request.params.viewId, draftEligible],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'parse_failures_excluded', 'parsed_view', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.viewId,
            { excludedCount },
          ],
        );
        await client.query("COMMIT");
        return {
          report: {
            excludedCount,
            remainingFailureCount,
            eligibleRecordCount:
              Number(view.rows[0].record_count) - excludedCount,
            draftEligible,
            exclusions: exclusions.rows,
            remainingFailures: remainingFailures.rows.map((row) => ({
              ordinal: row.ordinal,
              value: row.value,
              fields: row.value,
              locator: row.locator,
              recordHash: row.record_hash,
              parseStatus: row.parse_status,
              error: row.parse_error,
            })),
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string };
    Body: { baseVersionId?: string };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/drafts",
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

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id, status FROM test_set
           WHERE id = $1 AND project_id = $2 FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        if (
          testSet.rows[0].status === "unavailable_by_deletion" ||
          (await hasDeletionLock(
            request.params.projectId,
            [{ type: "test_set", id: request.params.testSetId }],
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        if (request.body?.baseVersionId) {
          const base = await client.query(
            `SELECT v.id, v.status FROM test_set_version v
             WHERE v.id = $1 AND v.test_set_id = $2
               AND v.status <> 'degraded_by_deletion'
             FOR SHARE`,
            [request.body.baseVersionId, request.params.testSetId],
          );
          if (!base.rowCount) {
            await client.query("COMMIT");
            return reply
              .code(422)
              .send({ error: { code: "draft_base_version_invalid" } });
          }
          if (
            await hasVersionDeletionLock(
              request.params.projectId,
              request.body.baseVersionId,
              client,
            )
          ) {
            await client.query("ROLLBACK");
            return deletionLocked(reply);
          }
        }
        const existing = await client.query(
          `SELECT * FROM working_draft
           WHERE test_set_id = $1 AND status IN ('editing', 'materializing')
           FOR UPDATE`,
          [request.params.testSetId],
        );
        if (existing.rowCount) {
          const draft = existing.rows[0];
          const expired =
            !draft.lease_expires_at ||
            new Date(draft.lease_expires_at).getTime() +
              config.draftTakeoverGraceMs <=
              now().getTime();
          if (draft.lease_holder_id !== actor.id && !expired) {
            await client.query("COMMIT");
            return reply.code(409).send({
              error: {
                code: "draft_lease_held",
                leaseHolderId: draft.lease_holder_id,
                leaseExpiresAt: new Date(draft.lease_expires_at).toISOString(),
              },
            });
          }
          if (draft.lease_holder_id !== actor.id) {
            const lease = newLease();
            const takenOver = await client.query(
              `UPDATE working_draft
               SET lease_holder_id = $2, lease_token = $3, lease_expires_at = $4,
                   updated_by = $2, updated_at = $5
               WHERE id = $1 RETURNING *`,
              [draft.id, actor.id, lease.token, lease.expiresAt, now()],
            );
            await client.query(
              `INSERT INTO audit_event
               (project_id, actor_id, action, object_type, object_id, details)
               VALUES ($1, $2, 'draft_lease_taken_over', 'working_draft', $3, $4)`,
              [
                request.params.projectId,
                actor.id,
                draft.id,
                { takeover: "expired" },
              ],
            );
            await client.query("COMMIT");
            return {
              draft: draftResponse(takenOver.rows[0], actor.id),
              reopened: true,
            };
          }
          await client.query("COMMIT");
          return { draft: draftResponse(draft, actor.id), reopened: true };
        }
        const lease = newLease();
        const created = await client.query(
          `INSERT INTO working_draft
           (id, test_set_id, status, lease_holder_id, lease_token, lease_expires_at, updated_by, base_version_id)
           VALUES ($1, $2, 'editing', $3, $4, $5, $3, $6) RETURNING *`,
          [
            opaqueId("draft"),
            request.params.testSetId,
            actor.id,
            lease.token,
            lease.expiresAt,
            request.body?.baseVersionId ?? null,
          ],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id)
           VALUES ($1, $2, 'draft_created', 'working_draft', $3)`,
          [request.params.projectId, actor.id, created.rows[0].id],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          draft: draftResponse(created.rows[0], actor.id),
          reopened: false,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: { name: string; purpose: string; assetId: string };
  }>(
    "/api/projects/:projectId/test-sets",
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
      const testSetId = opaqueId("testset");
      const draftId = opaqueId("draft");
      const lease = newLease();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const asset = await lockAssetRow(
          client,
          request.params.projectId,
          request.body.assetId,
        );
        if (!asset) {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "asset_not_ready" } });
        }
        if (
          deletionStateBlocked(asset) ||
          (await hasAssetDeletionLock(
            request.params.projectId,
            request.body.assetId,
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const sourceRef = await client.query(
          `SELECT pv.id AS parsed_view_id
           FROM parsed_view pv
           WHERE pv.asset_id = $1
           ORDER BY pv.is_current DESC, pv.created_at DESC LIMIT 1`,
          [request.body.assetId],
        );
        if (!sourceRef.rowCount) {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "asset_not_ready" } });
        }
        const parsedView = await lockParsedViewRow(
          client,
          request.params.projectId,
          String(sourceRef.rows[0].parsed_view_id),
        );
        if (
          !parsedView ||
          deletionStateBlocked(parsedView) ||
          (await hasParsedViewDeletionLock(
            request.params.projectId,
            String(sourceRef.rows[0].parsed_view_id),
            client,
          ))
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const source = await client.query(
          `SELECT pv.id AS parsed_view_id, pv.status, pv.boundary_trusted,
                  pv.draft_eligible, pv.error_summary, sar.source_type, sar.source_name,
                  pv.record_count,
                  sar.responsible_person, sar.purpose, sar.license_status, sar.sensitivity,
                  sar.source_address, sar.acquired_at, sar.deidentification_confirmed
           FROM data_asset da JOIN parsed_view pv ON pv.asset_id = da.id
           JOIN LATERAL (
             SELECT * FROM source_attribution_revision
             WHERE asset_id = da.id ORDER BY created_at DESC, id DESC LIMIT 1
           ) sar ON true
           WHERE da.project_id = $1 AND da.id = $2
             AND da.status NOT IN ('deletion_pending', 'tombstoned')
             AND pv.status NOT IN ('deletion_pending', 'tombstoned')
           ORDER BY pv.is_current DESC, pv.created_at DESC LIMIT 1`,
          [request.params.projectId, request.body.assetId],
        );
        if (!source.rowCount) {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "asset_not_ready" } });
        }
        const attribution = attributionFromRow(source.rows[0]);
        if (!attribution || !isAllowedSourceAttribution(attribution)) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "data_classification_not_allowed" } });
        }
        if (
          !["ready", "superseded"].includes(source.rows[0].status) ||
          !source.rows[0].draft_eligible
        ) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: parsedViewNotDraftEligibleError(
              source.rows[0].parsed_view_id,
              source.rows[0],
            ),
          });
        }
        await client.query(
          `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            testSetId,
            request.params.projectId,
            request.body.name,
            request.body.purpose,
            actor.id,
          ],
        );
        await client.query(
          `INSERT INTO working_draft
           (id, test_set_id, asset_id, parsed_view_id, status, lease_holder_id, lease_token, lease_expires_at, updated_by)
           VALUES ($1, $2, $3, $4, 'editing', $5, $6, $7, $5) RETURNING *`,
          [
            draftId,
            testSetId,
            request.body.assetId,
            source.rows[0].parsed_view_id,
            actor.id,
            lease.token,
            lease.expiresAt,
          ],
        );
        const initialSourceId = opaqueId("draftsrc");
        await client.query(
          `INSERT INTO draft_source
           (id, draft_id, asset_id, parsed_view_id, position, created_by)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [
            initialSourceId,
            draftId,
            request.body.assetId,
            source.rows[0].parsed_view_id,
            actor.id,
          ],
        );
        await client.query(
          `INSERT INTO draft_case_binding
             (test_set_id, draft_source_id, source_id, source_record_ordinal,
              output_slot, case_id)
           SELECT $1, $2, $3, sr.ordinal, 'primary',
                  'case_' || replace(gen_random_uuid()::text, '-', '')
           FROM source_record sr
           WHERE sr.parsed_view_id = $4 AND sr.parse_status = 'valid'
           ON CONFLICT DO NOTHING`,
          [testSetId, draftId, initialSourceId, source.rows[0].parsed_view_id],
        );
        await client.query(
          `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id)
           VALUES ($1, $2, 'draft_created', 'working_draft', $3)`,
          [request.params.projectId, actor.id, draftId],
        );
        await client.query("COMMIT");
        const draft = await client.query(
          "SELECT * FROM working_draft WHERE id = $1",
          [draftId],
        );
        const capacity = await draftCapacity(draftId);
        return reply.code(201).send({
          testSet: {
            id: testSetId,
            name: request.body.name,
            defaultVersionId: null,
          },
          draft: draftResponse(
            {
              ...draft.rows[0],
              capacity,
              sources: await draftSources(draftId),
            },
            actor.id,
          ),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  interface DraftConfiguration {
    leaseToken: string;
    expectedRevision: number;
    proposalId: string;
    filter: { field: string; operator: "eq"; value: string };
    mapping?: unknown;
    unmappedFields: string[];
    unmappedConfirmed: boolean;
    formalSchema: {
      mode: "gold_required" | "input_only";
      input: Record<string, unknown>;
      expectedOutput: Record<string, unknown>;
    };
  }

  app.get<{ Params: { projectId: string; draftId: string } }>(
    "/api/projects/:projectId/drafts/:draftId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT wd.* FROM working_draft wd
         JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         WHERE wd.id = $1 AND ts.project_id = $2`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      if (
        await hasDraftDeletionLock(
          request.params.projectId,
          request.params.draftId,
        )
      )
        return deletionLocked(reply);
      return {
        draft: draftResponse(
          {
            ...result.rows[0],
            capacity: await draftCapacity(request.params.draftId),
            sources: await draftSources(request.params.draftId),
          },
          actor.id,
        ),
      };
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { assetId?: string; leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/sources",
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

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
          [{ assetId: request.body?.assetId }],
        );
        const draftResult = await client.query(
          `SELECT wd.* FROM working_draft wd
           JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draftResult.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const draft = draftResult.rows[0];
        const writeError = draftWriteError(
          draft,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }

        const source = await client.query(
          `SELECT pv.id AS parsed_view_id, pv.status, pv.draft_eligible,
                  pv.error_summary, pv.record_count, da.size_bytes,
                  sar.source_type, sar.source_name, sar.responsible_person, sar.purpose,
                  sar.license_status, sar.sensitivity, sar.source_address,
                  sar.acquired_at, sar.deidentification_confirmed
           FROM data_asset da
           JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
           JOIN LATERAL (
             SELECT * FROM source_attribution_revision
             WHERE asset_id = da.id ORDER BY created_at DESC, id DESC LIMIT 1
           ) sar ON true
           WHERE da.project_id = $1 AND da.id = $2
           ORDER BY pv.created_at DESC LIMIT 1`,
          [request.params.projectId, request.body?.assetId],
        );
        if (!source.rowCount) {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "asset_not_ready" } });
        }
        const attribution = attributionFromRow(source.rows[0]);
        if (!attribution || !isAllowedSourceAttribution(attribution)) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "data_classification_not_allowed" } });
        }
        if (
          !["ready", "superseded"].includes(source.rows[0].status) ||
          !source.rows[0].draft_eligible
        ) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: parsedViewNotDraftEligibleError(
              source.rows[0].parsed_view_id,
              source.rows[0],
            ),
          });
        }

        const duplicate = await client.query(
          `SELECT 1 FROM draft_source
           WHERE draft_id = $1 AND asset_id = $2 AND removed_at IS NULL`,
          [draft.id, request.body?.assetId],
        );
        if (duplicate.rowCount) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "draft_source_already_attached" },
          });
        }

        const existing = await client.query(DRAFT_CAPACITY_SQL, [draft.id]);
        const currentTotals = draftCapacityFromRow(existing.rows[0]);
        const projected = {
          assets: currentTotals.assets + 1,
          originalBytes:
            currentTotals.originalBytes + Number(source.rows[0].size_bytes),
          sourceRecords:
            currentTotals.sourceRecords + Number(source.rows[0].record_count),
        };
        const limit = {
          assets: CAPACITY_LIMITS.draftAssets,
          originalBytes: CAPACITY_LIMITS.draftOriginalBytes,
          sourceRecords: CAPACITY_LIMITS.draftSourceRecords,
        };
        const exceeded = draftCapacityExceeded(projected);
        if (exceeded) {
          await client.query(
            `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
             VALUES ($1, $2, 'draft_capacity_blocked', 'working_draft', $3, $4)`,
            [
              request.params.projectId,
              actor.id,
              draft.id,
              {
                errorCode: "draft_capacity_exceeded",
                blockingPhase: "draft_attachment",
                exceededDimension: exceeded,
                actual: projected,
                limit,
              },
            ],
          );
          await client.query("COMMIT");
          return reply.code(422).send({
            error: {
              code: "draft_capacity_exceeded",
              blockingPhase: "draft_attachment",
              object: { type: "working_draft", id: draft.id },
              limit,
              actual: projected,
              exceededDimension: exceeded,
              retry:
                "Remove or replace a Working Draft attachment, then retry with an eligible Data Asset.",
            },
          });
        }

        const positionResult = await client.query(
          `SELECT coalesce(max(position), 0) + 1 AS position
           FROM draft_source WHERE draft_id = $1`,
          [draft.id],
        );
        const position = Number(positionResult.rows[0].position);
        const sourceId = opaqueId("draftsrc");
        await client.query(
          `INSERT INTO draft_source
           (id, draft_id, asset_id, parsed_view_id, position, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            sourceId,
            draft.id,
            request.body?.assetId,
            source.rows[0].parsed_view_id,
            position,
            actor.id,
          ],
        );
        await client.query(
          `INSERT INTO draft_case_binding
             (test_set_id, draft_source_id, source_id, source_record_ordinal,
              output_slot, case_id)
           SELECT $1, $2, $3, sr.ordinal, 'primary',
                  'case_' || replace(gen_random_uuid()::text, '-', '')
           FROM source_record sr
           WHERE sr.parsed_view_id = $4 AND sr.parse_status = 'valid'
           ON CONFLICT DO NOTHING`,
          [
            draft.test_set_id,
            draft.id,
            sourceId,
            source.rows[0].parsed_view_id,
          ],
        );
        const updated = await client.query(
          `UPDATE working_draft
           SET revision = revision + 1, mapping_revision_id = NULL,
               formal_schema_id = NULL, updated_by = $2, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [draft.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [draft.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_source_added', 'working_draft', $3, $4)`,
          [request.params.projectId, actor.id, draft.id, projected],
        );
        await client.query("COMMIT");
        const capacity = await draftCapacity(draft.id);
        return reply.code(201).send({
          source: {
            id: sourceId,
            assetId: request.body?.assetId,
            parsedViewId: source.rows[0].parsed_view_id,
            ordinal: position,
          },
          draft: draftResponse(
            {
              ...updated.rows[0],
              capacity,
              sources: await draftSources(draft.id),
            },
            actor.id,
          ),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.put<{
    Params: { projectId: string; draftId: string; sourceId: string };
    Body: {
      leaseToken?: string;
      expectedRevision?: number;
      mapping?: unknown;
      unmappedFields?: string[];
      unmappedConfirmed?: boolean;
    };
  }>(
    "/api/projects/:projectId/drafts/:draftId/sources/:sourceId/mapping",
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
      const mapping = normalizeDraftMapping(request.body?.mapping);
      if (
        !mapping ||
        !Array.isArray(request.body?.unmappedFields) ||
        request.body.unmappedFields.some(
          (field) => typeof field !== "string",
        ) ||
        typeof request.body?.unmappedConfirmed !== "boolean"
      )
        return reply.code(422).send({ error: { code: "mapping_invalid" } });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draftResult = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draftResult.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = draftResult.rows[0];
        const writeError = draftWriteError(
          current,
          actor.id,
          request.body.leaseToken,
          request.body.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }
        const source = await client.query(
          `SELECT ds.* FROM draft_source ds
           WHERE ds.id = $1 AND ds.draft_id = $2 AND ds.removed_at IS NULL`,
          [request.params.sourceId, current.id],
        );
        if (!source.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "draft_source_not_found" } });
        }
        const records = await client.query(
          `SELECT value FROM source_record
           WHERE parsed_view_id = $1 AND parse_status = 'valid'`,
          [source.rows[0].parsed_view_id],
        );
        const mappedFields = new Set(mappedSourceFields(mapping));
        const unmappedFields = [
          ...new Set(records.rows.flatMap((row) => sourceLeafPaths(row.value))),
        ]
          .filter((field) => !sourcePathIsMapped(field, mappedFields))
          .sort();
        if (
          JSON.stringify(
            request.body.unmappedFields.map(canonicalSourcePath).sort(),
          ) !== JSON.stringify(unmappedFields)
        ) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "unmapped_fields_invalid", unmappedFields },
          });
        }
        const saved = await client.query(
          `UPDATE draft_source
           SET mapping = $2, unmapped_fields = $3, unmapped_confirmed = $4
           WHERE id = $1 RETURNING *`,
          [
            request.params.sourceId,
            mapping,
            JSON.stringify(
              request.body.unmappedFields.map(canonicalSourcePath).sort(),
            ),
            request.body.unmappedConfirmed,
          ],
        );
        const updatedDraft = await client.query(
          `UPDATE working_draft
           SET revision = revision + 1, mapping_revision_id = NULL,
               formal_schema_id = NULL, updated_by = $2, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [current.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_source_mapping_saved', 'draft_source', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.sourceId,
            { revision: Number(updatedDraft.rows[0].revision) },
          ],
        );
        await client.query("COMMIT");
        const sources = await draftSources(current.id);
        return {
          source: {
            id: saved.rows[0].id,
            assetId: saved.rows[0].asset_id,
            parsedViewId: saved.rows[0].parsed_view_id,
            position: Number(saved.rows[0].position),
            mapping: saved.rows[0].mapping,
            unmappedFields: saved.rows[0].unmapped_fields,
            unmappedConfirmed: Boolean(saved.rows[0].unmapped_confirmed),
          },
          draft: draftResponse({ ...updatedDraft.rows[0], sources }, actor.id),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: {
      leaseToken?: string;
      expectedRevision?: number;
      caseId?: string;
      input?: unknown;
      expectedOutput?: unknown;
      metadata?: unknown;
      reason?: string;
    };
  }>(
    "/api/projects/:projectId/drafts/:draftId/cases",
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
      if (
        typeof request.body?.reason !== "string" ||
        !request.body.reason.trim()
      )
        return reply
          .code(422)
          .send({ error: { code: "manual_reason_required" } });
      const item = {
        input: request.body.input,
        expected_output: request.body.expectedOutput ?? null,
        metadata: request.body.metadata ?? {},
      };
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draft = await client.query(
          `SELECT wd.*, fs.mode, fs.input_schema, fs.expected_output_schema,
                  pm.user_id AS authorized_actor_id
           FROM working_draft wd
           JOIN test_set ts ON ts.id = wd.test_set_id
           LEFT JOIN project_member pm
             ON pm.project_id = ts.project_id AND pm.user_id = $3
            AND pm.role IN ('owner', 'editor')
           LEFT JOIN test_set_version base_version ON base_version.id = wd.base_version_id
           LEFT JOIN formal_schema_revision fs ON fs.id = wd.formal_schema_id
             OR fs.id = base_version.schema_revision_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId, actor.id],
        );
        if (!draft.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        if (!draft.rows[0].authorized_actor_id) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "project_not_found" } });
        }
        const current = draft.rows[0];
        const writeError = draftWriteError(
          current,
          actor.id,
          request.body.leaseToken,
          request.body.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }
        if (!isValidCaseMetadata(item.metadata)) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "manual_case_metadata_invalid" } });
        }
        if (
          !current.input_schema ||
          !validateFormalItems(
            current.input_schema,
            current.expected_output_schema,
            [item],
            current.mode,
          ).valid
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "manual_case_schema_invalid" } });
        }
        const requestedId = request.body.caseId?.trim();
        if (requestedId) {
          const conflict = await client.query(
            "SELECT test_set_id FROM test_case WHERE id = $1",
            [requestedId],
          );
          if (conflict.rowCount) {
            await client.query("COMMIT");
            return reply.code(409).send({
              error: { code: "case_id_conflict", caseId: requestedId },
            });
          }
          const bound = await client.query(
            `SELECT 1 FROM draft_case_binding WHERE case_id = $1
             UNION ALL SELECT 1 FROM candidate_item WHERE case_id = $1 LIMIT 1`,
            [requestedId],
          );
          if (bound.rowCount) {
            await client.query("COMMIT");
            return reply.code(409).send({
              error: { code: "case_id_conflict", caseId: requestedId },
            });
          }
        }
        const caseId = requestedId ?? opaqueId("case");
        await client.query(
          "INSERT INTO test_case (id, test_set_id) VALUES ($1, $2)",
          [caseId, current.test_set_id],
        );
        const operationId = opaqueId("caseop");
        await client.query(
          `INSERT INTO draft_case_operation
           (id, draft_id, operation, case_id, input, expected_output, metadata, reason, created_by)
           VALUES ($1, $2, 'create', $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)`,
          [
            operationId,
            current.id,
            caseId,
            JSON.stringify(item.input),
            JSON.stringify(item.expected_output),
            JSON.stringify(item.metadata),
            request.body.reason.trim(),
            actor.id,
          ],
        );
        const updated = await client.query(
          `UPDATE working_draft SET revision = revision + 1, updated_by = $2,
              updated_at = $3 WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [current.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'manual_case_created', 'test_case', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            caseId,
            { reason: request.body.reason.trim(), draftId: current.id },
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          case: { id: caseId, operation: "create" },
          draft: draftResponse(updated.rows[0], actor.id),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.put<{
    Params: { projectId: string; draftId: string; caseId: string };
    Body: {
      leaseToken?: string;
      expectedRevision?: number;
      input?: unknown;
      expectedOutput?: unknown;
      metadata?: unknown;
      reason?: string;
    };
  }>(
    "/api/projects/:projectId/drafts/:draftId/cases/:caseId",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draft = await client.query(
          `SELECT wd.*, fs.mode, fs.input_schema, fs.expected_output_schema
           FROM working_draft wd
           JOIN test_set ts ON ts.id = wd.test_set_id
           LEFT JOIN test_set_version base_version ON base_version.id = wd.base_version_id
           LEFT JOIN formal_schema_revision fs ON fs.id = wd.formal_schema_id
             OR fs.id = base_version.schema_revision_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = draft.rows[0];
        const writeError = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }
        const existing = await client.query(
          `SELECT op.operation, op.input, op.expected_output, op.metadata, op.reason,
                  op.diff
           FROM draft_case_operation op
           WHERE op.draft_id = $1 AND op.case_id = $2`,
          [current.id, request.params.caseId],
        );
        if (existing.rows[0]?.operation === "delete") {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "case_deleted_in_draft" },
          });
        }
        const base = existing.rowCount
          ? undefined
          : await client.query(
              `SELECT cr.input, cr.expected_output, cr.metadata
               FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id = vm.case_revision_id
               WHERE vm.version_id = $1 AND cr.case_id = $2`,
              [current.base_version_id, request.params.caseId],
            );
        const source = existing.rows[0] ?? base?.rows[0];
        if (!source) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "case_not_found" } });
        }
        const hasExpectedOutput = Object.prototype.hasOwnProperty.call(
          request.body ?? {},
          "expectedOutput",
        );
        const next = {
          input: request.body?.input ?? source.input,
          expected_output: hasExpectedOutput
            ? request.body?.expectedOutput
            : source.expected_output,
          metadata: request.body?.metadata ?? source.metadata,
        };
        if (!isValidCaseMetadata(next.metadata)) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "manual_case_metadata_invalid" } });
        }
        const semanticChanged =
          canonicalJson(next.input) !== canonicalJson(source.input) ||
          canonicalJson(next.expected_output) !==
            canonicalJson(source.expected_output);
        if (semanticChanged && !request.body?.reason?.trim()) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: {
              code: "manual_reason_required",
              currentRevision: Number(current.revision),
            },
          });
        }
        if (
          !current.input_schema ||
          !validateFormalItems(
            current.input_schema,
            current.expected_output_schema,
            [next],
            current.mode,
          ).valid
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "manual_case_schema_invalid" } });
        }
        const changedFields = ["input", "expected_output", "metadata"].filter(
          (field) =>
            canonicalJson((next as any)[field]) !==
            canonicalJson((source as any)[field]),
        );
        const previousContent = {
          input: source.input,
          expected_output: source.expected_output,
          metadata: source.metadata,
        };
        const contentDiff = Object.fromEntries(
          changedFields.map((field) => [
            field,
            {
              before: (previousContent as any)[field],
              after: (next as any)[field],
            },
          ]),
        );
        if (
          !Object.prototype.hasOwnProperty.call(
            contentDiff,
            "expected_output",
          ) &&
          Object.prototype.hasOwnProperty.call(
            existing.rows[0]?.diff ?? {},
            "expected_output",
          )
        ) {
          contentDiff.expected_output = existing.rows[0].diff.expected_output;
        }
        const operationId = opaqueId("caseop");
        const operation =
          existing.rows[0]?.operation === "create" ? "create" : "update";
        const operationReason =
          operation === "create"
            ? (existing.rows[0]?.reason ?? request.body?.reason?.trim() ?? null)
            : (request.body?.reason?.trim() ?? null);
        await client.query(
          `INSERT INTO draft_case_operation
           (id, draft_id, operation, case_id, input, expected_output, metadata,
            reason, previous_content, diff, created_by)
           VALUES ($1, $2, $11, $3, $4::jsonb, $5::jsonb, $6::jsonb,
                   $7, $8::jsonb, $9::jsonb, $10)
           ON CONFLICT (draft_id, case_id) DO UPDATE SET
             id = EXCLUDED.id, operation = EXCLUDED.operation,
             input = EXCLUDED.input, expected_output = EXCLUDED.expected_output,
             metadata = EXCLUDED.metadata, reason = EXCLUDED.reason,
             previous_content = EXCLUDED.previous_content,
             diff = EXCLUDED.diff,
             created_by = EXCLUDED.created_by, created_at = now()`,
          [
            operationId,
            current.id,
            request.params.caseId,
            JSON.stringify(next.input),
            JSON.stringify(next.expected_output),
            JSON.stringify(next.metadata),
            operationReason,
            JSON.stringify(previousContent),
            JSON.stringify(contentDiff),
            actor.id,
            operation,
          ],
        );
        const updated = await client.query(
          `UPDATE working_draft SET revision = revision + 1, updated_by = $2,
              updated_at = $3 WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [current.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'manual_case_revised', 'test_case', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.caseId,
            {
              changedFields,
              diff: contentDiff,
              reason: request.body?.reason?.trim() ?? null,
              draftId: current.id,
            },
          ],
        );
        await client.query("COMMIT");
        return {
          case: { id: request.params.caseId, operation },
          draft: draftResponse(updated.rows[0], actor.id),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{
    Params: { projectId: string; draftId: string; caseId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/cases/:caseId",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draft = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = draft.rows[0];
        const writeError = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (writeError) {
          await client.query("COMMIT");
          return reply.code(409).send({ error: writeError });
        }
        const existing = await client.query(
          `SELECT 1 FROM draft_case_operation
           WHERE draft_id = $1 AND case_id = $2 AND operation IN ('create', 'update')`,
          [current.id, request.params.caseId],
        );
        const base = existing.rowCount
          ? undefined
          : await client.query(
              `SELECT 1 FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id = vm.case_revision_id
               WHERE vm.version_id = $1 AND cr.case_id = $2`,
              [current.base_version_id, request.params.caseId],
            );
        if (!existing.rowCount && !base?.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "case_not_found" } });
        }
        await client.query(
          `INSERT INTO draft_case_operation
           (id, draft_id, operation, case_id, created_by)
           VALUES ($1, $2, 'delete', $3, $4)
           ON CONFLICT (draft_id, case_id) DO UPDATE SET
             id = EXCLUDED.id, operation = EXCLUDED.operation,
             input = NULL, expected_output = NULL, metadata = NULL,
             reason = NULL, previous_content = NULL, diff = NULL,
             created_by = EXCLUDED.created_by, created_at = now()`,
          [opaqueId("caseop"), current.id, request.params.caseId, actor.id],
        );
        const updated = await client.query(
          `UPDATE working_draft SET revision = revision + 1, updated_by = $2,
              updated_at = $3 WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [current.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'manual_case_deleted', 'test_case', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.caseId,
            { draftId: current.id },
          ],
        );
        await client.query("COMMIT");
        return {
          case: { id: request.params.caseId, operation: "delete" },
          draft: draftResponse(updated.rows[0], actor.id),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    "/api/projects/:projectId/drafts/:draftId/audit",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT ae.action, ae.actor_id, ae.details, ae.created_at
         FROM audit_event ae
         JOIN test_set ts ON ts.project_id = ae.project_id
         JOIN working_draft wd ON wd.id = $1 AND wd.test_set_id = ts.id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         LEFT JOIN candidate_snapshot cs ON cs.id = ae.object_id AND ae.object_type = 'candidate_snapshot'
         WHERE ae.project_id = $2
           AND ((ae.object_type = 'working_draft' AND ae.object_id = $1)
             OR (cs.draft_id = $1)
             OR (ae.object_type = 'test_case' AND ae.details ->> 'draftId' = $1))
         ORDER BY ae.id`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      return {
        events: result.rows.map((row) => ({
          action: row.action,
          actorId: row.actor_id,
          details: row.details,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: {
      leaseToken?: string;
      expectedRevision?: number;
      steps?: RecipeStep[];
      versionDescription?: string;
      mapping?: unknown;
      unmappedFields?: string[];
      unmappedConfirmed?: boolean;
      duplicateDecisions?: Record<string, "include" | "exclude">;
    };
  }>(
    "/api/projects/:projectId/drafts/:draftId/recipe",
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
      if (
        !Array.isArray(request.body?.steps) ||
        (request.body.mapping !== undefined &&
          !normalizeDraftMapping(request.body.mapping)) ||
        (request.body.unmappedFields !== undefined &&
          (!Array.isArray(request.body.unmappedFields) ||
            request.body.unmappedFields.some(
              (field) => typeof field !== "string",
            ))) ||
        (request.body.unmappedConfirmed !== undefined &&
          typeof request.body.unmappedConfirmed !== "boolean")
      )
        return reply.code(422).send({ error: { code: "recipe_invalid" } });
      if (
        request.body.duplicateDecisions !== undefined &&
        (!request.body.duplicateDecisions ||
          typeof request.body.duplicateDecisions !== "object" ||
          Array.isArray(request.body.duplicateDecisions) ||
          Object.entries(request.body.duplicateDecisions).some(
            ([caseId, decision]) =>
              !caseId || !["include", "exclude"].includes(decision),
          ))
      )
        return reply.code(422).send({ error: { code: "recipe_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const result = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing' FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = result.rows[0];
        const error = draftWriteError(
          current,
          actor.id,
          request.body.leaseToken,
          request.body.expectedRevision,
        );
        if (error) {
          await client.query("COMMIT");
          return reply.code(409).send({ error });
        }
        try {
          validateRecipe(request.body.steps);
        } catch {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "recipe_invalid" } });
        }
        const steps = request.body.steps.map((step) =>
          step.kind === "manual"
            ? {
                ...step,
                include: step.include?.map(({ id, reason }) => ({
                  id,
                  ...(reason === undefined ? {} : { reason }),
                  actorId: actor.id,
                })),
                exclude: step.exclude?.map(({ id, reason }) => ({
                  id,
                  ...(reason === undefined ? {} : { reason }),
                  actorId: actor.id,
                })),
              }
            : step,
        );
        const mappingChanged =
          request.body.mapping !== undefined &&
          canonicalJson(normalizeDraftMapping(request.body.mapping)) !==
            canonicalJson((current.recipe as any)?.mapping ?? null);
        if (request.body.mapping !== undefined) {
          const sources = await client.query(
            "SELECT id FROM draft_source WHERE draft_id = $1 AND removed_at IS NULL",
            [current.id],
          );
          if (sources.rowCount === 1)
            await client.query(
              `UPDATE draft_source
               SET mapping = $2,
                   unmapped_fields = COALESCE($3, unmapped_fields),
                   unmapped_confirmed = COALESCE($4, CASE WHEN $5 THEN false ELSE unmapped_confirmed END)
               WHERE id = $1`,
              [
                sources.rows[0].id,
                normalizeDraftMapping(request.body.mapping),
                request.body.unmappedFields === undefined
                  ? null
                  : JSON.stringify(
                      request.body.unmappedFields
                        .map(canonicalSourcePath)
                        .sort(),
                    ),
                request.body.unmappedConfirmed ?? null,
                mappingChanged,
              ],
            );
        }
        const stepsChanged =
          canonicalJson(steps) !==
          canonicalJson(
            (current.recipe as any)?.steps ?? recipeSteps(current.recipe),
          );
        const unmappedFieldsChanged =
          request.body.unmappedFields !== undefined &&
          canonicalJson(
            request.body.unmappedFields.map(canonicalSourcePath).sort(),
          ) !==
            canonicalJson(
              Array.isArray((current.recipe as any)?.unmappedFields)
                ? (current.recipe as any).unmappedFields
                    .map(canonicalSourcePath)
                    .sort()
                : [],
            );
        const unmappedConfirmationChanged =
          request.body.unmappedConfirmed !== undefined &&
          request.body.unmappedConfirmed !==
            Boolean((current.recipe as any)?.unmappedConfirmed);
        const duplicateDecisionsChanged =
          request.body.duplicateDecisions !== undefined &&
          canonicalJson(request.body.duplicateDecisions) !==
            canonicalJson((current.recipe as any)?.duplicateDecisions ?? {});
        const configurationStateChanged =
          mappingChanged ||
          stepsChanged ||
          unmappedFieldsChanged ||
          unmappedConfirmationChanged;
        const recipeStateChanged =
          configurationStateChanged || duplicateDecisionsChanged;
        let confirmedDuplicateContentHashes: Record<string, string> =
          (current.recipe as any)?.duplicateContentHashes ?? {};
        if (request.body.duplicateDecisions !== undefined) {
          const duplicateReport = await client.query(
            `SELECT validation_report FROM candidate_snapshot
             WHERE draft_id = $1 AND status = 'failed'
               AND validation_report ->> 'errorCode' = 'duplicate_content_requires_decision'
             ORDER BY created_at DESC LIMIT 1`,
            [current.id],
          );
          const report = duplicateReport.rows[0]?.validation_report ?? {};
          const allowedIds = new Set<string>(report.duplicateCaseIds ?? []);
          const contentHashes: Record<string, string> =
            report.duplicateContentHashes ?? {};
          if (
            !allowedIds.size ||
            Object.keys(request.body.duplicateDecisions).some(
              (caseId) => !allowedIds.has(caseId),
            )
          ) {
            await client.query("COMMIT");
            return reply
              .code(422)
              .send({ error: { code: "duplicate_decision_invalid" } });
          }
          confirmedDuplicateContentHashes = Object.fromEntries(
            Object.keys(request.body.duplicateDecisions).map((caseId) => [
              caseId,
              contentHashes[caseId],
            ]),
          );
        }
        const recipe = {
          ...(typeof current.recipe === "object" && current.recipe
            ? current.recipe
            : {}),
          steps,
          ...(request.body.mapping === undefined
            ? {}
            : { mapping: normalizeDraftMapping(request.body.mapping) }),
          ...(request.body.unmappedFields === undefined
            ? {}
            : {
                unmappedFields: request.body.unmappedFields
                  .map(canonicalSourcePath)
                  .sort(),
              }),
          ...(mappingChanged || stepsChanged || unmappedFieldsChanged
            ? { unmappedConfirmed: false }
            : request.body.unmappedConfirmed === undefined
              ? {}
              : { unmappedConfirmed: request.body.unmappedConfirmed }),
          ...(request.body.duplicateDecisions === undefined
            ? {}
            : { duplicateDecisions: request.body.duplicateDecisions }),
          ...(configurationStateChanged
            ? {
                duplicateDecisions: {},
                duplicateContentHashes: {},
              }
            : request.body.duplicateDecisions === undefined
              ? {}
              : {
                  duplicateContentHashes: confirmedDuplicateContentHashes,
                }),
        };
        const nextDescription =
          request.body.versionDescription ?? current.version_description;
        if (
          canonicalJson(recipe) === canonicalJson(current.recipe ?? {}) &&
          nextDescription === current.version_description
        ) {
          await client.query("COMMIT");
          return {
            draft: draftResponse(
              { ...current, sources: await draftSources(current.id) },
              actor.id,
            ),
          };
        }
        const saved = await client.query(
          `UPDATE working_draft
           SET recipe = $2, version_description = $3, revision = revision + 1,
               mapping_revision_id = CASE WHEN $6 THEN NULL ELSE mapping_revision_id END,
               formal_schema_id = CASE WHEN $6 THEN NULL ELSE formal_schema_id END,
               updated_by = $4, updated_at = $5
           WHERE id = $1 RETURNING *`,
          [
            current.id,
            recipe,
            nextDescription,
            actor.id,
            now(),
            configurationStateChanged,
          ],
        );
        if (recipeStateChanged)
          await client.query(
            `UPDATE candidate_snapshot SET status = 'superseded'
             WHERE draft_id = $1 AND status = 'ready_to_publish'`,
            [current.id],
          );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_recipe_saved', 'working_draft', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            current.id,
            { revision: saved.rows[0].revision },
          ],
        );
        await client.query("COMMIT");
        return {
          draft: draftResponse(
            { ...saved.rows[0], sources: await draftSources(current.id) },
            actor.id,
          ),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
  }>(
    "/api/projects/:projectId/drafts/:draftId/evaluate",
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
      const draft = await db.query(
        `SELECT wd.recipe FROM working_draft wd
         JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         WHERE wd.id = $1 AND ts.project_id = $2`,
        [request.params.draftId, request.params.projectId, actor.id],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const steps = draft.rows[0].recipe?.steps ?? [];
      if (!Array.isArray(steps))
        return reply.code(422).send({ error: { code: "recipe_invalid" } });
      try {
        const sources = await db.query(
          `SELECT ds.id, ds.parsed_view_id
           FROM draft_source ds
           WHERE ds.draft_id = $1 AND ds.removed_at IS NULL
           ORDER BY ds.position`,
          [request.params.draftId],
        );
        const evaluations: ReturnType<typeof evaluateRecipe>[] = [];
        for (const source of sources.rows) {
          const records = await db.query(
            `SELECT ordinal, value, record_hash FROM source_record
             WHERE parsed_view_id = $1 AND parse_status = 'valid' ORDER BY ordinal`,
            [source.parsed_view_id],
          );
          evaluations.push(
            evaluateRecipe(
              records.rows.map((record: any) => ({
                id: `${source.parsed_view_id}:${record.ordinal}`,
                sampleKey: record.record_hash,
                ordinal: Number(record.ordinal),
                fields: record.value,
              })),
              steps,
            ),
          );
        }
        const mergedSteps = steps.map((_step: unknown, index: number) =>
          evaluations.reduce(
            (result, evaluation) => {
              const step = evaluation.steps[index];
              if (!step) return result;
              return {
                kind: step.kind,
                inputCount: result.inputCount + step.inputCount,
                outputCount: result.outputCount + step.outputCount,
                excludedCount: result.excludedCount + step.excludedCount,
                errorCount: result.errorCount + step.errorCount,
              };
            },
            {
              kind: steps[index]?.kind,
              inputCount: 0,
              outputCount: 0,
              excludedCount: 0,
              errorCount: 0,
            },
          ),
        );
        const evaluation = {
          records: evaluations.flatMap((item) => item.records),
          steps: mergedSteps,
          exits: Object.assign({}, ...evaluations.map((item) => item.exits)),
        };
        return { evaluation };
      } catch {
        return reply.code(422).send({ error: { code: "recipe_invalid" } });
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/lease/renew",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const result = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing' FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = result.rows[0];
        const error = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (error || current.lease_holder_id !== actor.id) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: error ?? {
              code: "draft_lease_invalid",
              currentRevision: Number(current.revision),
            },
          });
        }
        const renewed = await client.query(
          `UPDATE working_draft SET lease_expires_at = $2, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [current.id, newLease().expiresAt, now()],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id)
           VALUES ($1, $2, 'draft_lease_acquired', 'working_draft', $3)`,
          [request.params.projectId, actor.id, current.id],
        );
        await client.query("COMMIT");
        return { draft: draftResponse(renewed.rows[0], actor.id) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { confirm?: boolean; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/lease/takeover",
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
      if (
        !request.body?.confirm ||
        !Number.isInteger(request.body.expectedRevision)
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_takeover_confirmation_required" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const result = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing' FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = result.rows[0];
        if (Number(current.revision) !== request.body.expectedRevision) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: {
              code: "draft_revision_conflict",
              currentRevision: Number(current.revision),
            },
          });
        }
        const lease = newLease();
        const takenOver = await client.query(
          `UPDATE working_draft
           SET lease_holder_id = $2, lease_token = $3, lease_expires_at = $4,
               updated_by = $2, updated_at = $5
           WHERE id = $1 RETURNING *`,
          [current.id, actor.id, lease.token, lease.expiresAt, now()],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_lease_taken_over', 'working_draft', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            current.id,
            { takeover: "confirmed" },
          ],
        );
        await client.query("COMMIT");
        return { draft: draftResponse(takenOver.rows[0], actor.id) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/freeze",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const result = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing' FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = result.rows[0];
        const error = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (error) {
          await client.query("COMMIT");
          return reply.code(409).send({ error });
        }
        const sourceRows = await client.query(
          `SELECT ds.id AS draft_source_id, ds.asset_id, ds.parsed_view_id,
                  ds.position, ds.mapping, ds.unmapped_fields,
                  ds.unmapped_confirmed, pv.parser_name, pv.parser_version,
                  pv.record_count, sar.id AS attribution_id, sar.source_type,
                  sar.source_name, sar.responsible_actor, sar.responsible_person,
                  sar.purpose, sar.license_status, sar.sensitivity,
                  sar.source_address, sar.acquired_at,
                  sar.deidentification_confirmed
           FROM draft_source ds
           JOIN parsed_view pv ON pv.id = ds.parsed_view_id
           LEFT JOIN LATERAL (
             SELECT * FROM source_attribution_revision
             WHERE asset_id = ds.asset_id
             ORDER BY created_at DESC, id DESC LIMIT 1
           ) sar ON true
           WHERE ds.draft_id = $1 AND ds.removed_at IS NULL
           ORDER BY ds.position`,
          [current.id],
        );
        const sources = sourceRows.rows.map(sourceSnapshotFromRow);
        const operationRows = await client.query(
          `SELECT id, draft_id, operation, case_id, input, expected_output,
                  metadata, reason, previous_content, diff, created_by,
                  created_at::text AS created_at
           FROM draft_case_operation
           WHERE draft_id = $1 ORDER BY created_at, id`,
          [current.id],
        );
        const operations = operationRows.rows;
        const revisionPayload = {
          revision: Number(current.revision),
          recipe: current.recipe,
          versionDescription: current.version_description,
          baseVersionId: current.base_version_id ?? null,
          schemaRevisionId: current.formal_schema_id ?? null,
          sources,
          operations,
        };
        const revisionHash = sha256(canonicalJson(revisionPayload));
        const frozen = await client.query(
          `INSERT INTO draft_revision
           (id, draft_id, revision, recipe, sources, operations, schema_revision_id,
            base_version_id, version_description, created_by, revision_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (draft_id, revision) DO NOTHING
           RETURNING *`,
          [
            opaqueId("draftrev"),
            current.id,
            current.revision,
            current.recipe,
            JSON.stringify(sources),
            JSON.stringify(operations),
            current.formal_schema_id ?? null,
            current.base_version_id ?? null,
            current.version_description,
            actor.id,
            revisionHash,
          ],
        );
        const frozenRevision = frozen.rowCount
          ? frozen.rows[0]
          : (
              await client.query(
                `SELECT * FROM draft_revision
                 WHERE draft_id = $1 AND revision = $2`,
                [current.id, current.revision],
              )
            ).rows[0];
        await client.query("COMMIT");
        return {
          revision: {
            id: frozenRevision.id,
            number: Number(frozenRevision.revision),
            hash: frozenRevision.revision_hash,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/abandon",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const result = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing' FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!result.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = result.rows[0];
        const error = draftWriteError(
          current,
          actor.id,
          request.body?.leaseToken,
          request.body?.expectedRevision,
        );
        if (error) {
          await client.query("COMMIT");
          return reply.code(409).send({ error });
        }
        const abandoned = await client.query(
          `UPDATE working_draft
           SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
               revision = revision + 1, updated_by = $2, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [current.id, actor.id, now()],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id)
           VALUES ($1, $2, 'draft_lease_released', 'working_draft', $3)`,
          [request.params.projectId, actor.id, current.id],
        );
        await client.query("COMMIT");
        return { draft: draftResponse(abandoned.rows[0], actor.id) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.put<{
    Params: { projectId: string; draftId: string };
    Body: DraftConfiguration;
  }>(
    "/api/projects/:projectId/drafts/:draftId",
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
      if (!body || typeof body !== "object" || Array.isArray(body))
        return reply
          .code(422)
          .send({ error: { code: "draft_configuration_invalid" } });
      if (typeof body.proposalId !== "string" || !body.proposalId)
        return reply.code(422).send({
          error: { code: "schema_proposal_required" },
        });
      if (
        typeof body.leaseToken !== "string" ||
        !Number.isInteger(body.expectedRevision) ||
        body.filter?.operator !== "eq" ||
        !Array.isArray(body.unmappedFields) ||
        body.unmappedFields.some((field) => typeof field !== "string") ||
        !body.unmappedConfirmed ||
        !body.formalSchema ||
        typeof body.formalSchema !== "object" ||
        Array.isArray(body.formalSchema) ||
        !body.formalSchema.input ||
        typeof body.formalSchema.input !== "object" ||
        !body.formalSchema.expectedOutput ||
        typeof body.formalSchema.expectedOutput !== "object" ||
        !["gold_required", "input_only"].includes(body.formalSchema?.mode) ||
        (body.mapping !== undefined && !normalizeDraftMapping(body.mapping))
      ) {
        return reply
          .code(422)
          .send({ error: { code: "draft_configuration_invalid" } });
      }
      try {
        assertFormalSchema(body.formalSchema.input);
        assertFormalSchema(body.formalSchema.expectedOutput);
      } catch {
        return reply
          .code(422)
          .send({ error: { code: "formal_schema_unsupported" } });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const draft = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2 AND wd.status = 'editing'
           FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const current = draft.rows[0];
        if (
          current.lease_holder_id !== actor.id ||
          current.lease_token !== body.leaseToken ||
          !current.lease_expires_at ||
          new Date(current.lease_expires_at).getTime() <= now().getTime()
        ) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: {
              code: "draft_lease_invalid",
              currentRevision: Number(current.revision),
            },
          });
        }
        if (Number(current.revision) !== body.expectedRevision) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: {
              code: "draft_revision_conflict",
              currentRevision: Number(current.revision),
            },
          });
        }
        const sources = await client.query(
          `SELECT ds.id, ds.parsed_view_id, ds.mapping, ds.unmapped_fields,
                  ds.unmapped_confirmed
           FROM draft_source ds
           WHERE ds.draft_id = $1 AND ds.removed_at IS NULL ORDER BY ds.position`,
          [current.id],
        );
        const contexts: any[] = [];
        const allUnmappedFields: string[] = [];
        for (const source of sources.rows) {
          const useRequestMapping =
            sources.rowCount === 1 && body.mapping !== undefined;
          const mapping = normalizeDraftMapping(
            useRequestMapping
              ? body.mapping
              : (source.mapping ?? current.recipe?.mapping),
          );
          if (
            !mapping ||
            (useRequestMapping
              ? !body.unmappedConfirmed
              : !source.unmapped_confirmed)
          ) {
            await client.query("COMMIT");
            return reply.code(422).send({ error: { code: "mapping_invalid" } });
          }
          const sourceValues = await client.query(
            `SELECT ordinal, locator, value, record_hash FROM source_record
             WHERE parsed_view_id = $1 AND parse_status = 'valid' ORDER BY ordinal`,
            [source.parsed_view_id],
          );
          const selected = selectedSourceRows(
            sourceValues.rows,
            source.parsed_view_id,
            current.recipe,
          );
          const mappedFields = new Set(mappedSourceFields(mapping));
          const sourceUnmappedFields = [
            ...new Set(
              sourceValues.rows.flatMap((row) =>
                sourceLeafPaths(row.value).filter(
                  (field) => !sourcePathIsMapped(field, mappedFields),
                ),
              ),
            ),
          ].sort();
          if (
            !useRequestMapping &&
            JSON.stringify(
              (source.unmapped_fields ?? []).map(canonicalSourcePath).sort(),
            ) !== JSON.stringify(sourceUnmappedFields)
          ) {
            await client.query("COMMIT");
            return reply.code(422).send({
              error: {
                code: "unmapped_fields_invalid",
                sourceId: source.id,
                unmappedFields: sourceUnmappedFields,
              },
            });
          }
          allUnmappedFields.push(...sourceUnmappedFields);
          contexts.push({ source, mapping, selected });
        }
        const unmappedFields = [...new Set(allUnmappedFields)].sort();
        if (
          JSON.stringify(
            [...body.unmappedFields].map(canonicalSourcePath).sort(),
          ) !== JSON.stringify([...new Set(unmappedFields)])
        ) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "unmapped_fields_invalid", unmappedFields },
          });
        }
        const mapped = contexts.flatMap(({ mapping, selected }) =>
          selected.map((record: any) => ({
            record,
            replay: replayMapping(record.value, mapping),
          })),
        );
        const mappingErrors = mapped.flatMap(({ record, replay }) =>
          replay.errors.map((error: any) => ({
            ordinal: Number(record.ordinal),
            locator: record.locator,
            ...error,
          })),
        );
        if (mappingErrors.length) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "mapping_records_invalid", errors: mappingErrors },
          });
        }
        const identity = {
          mappingHash: sha256(
            canonicalJson(
              contexts.map(({ source, mapping }) => ({
                sourceId: source.id,
                mapping,
              })),
            ),
          ),
          selectedRecordsHash: sha256(
            canonicalJson(
              contexts.flatMap(({ source, selected }) =>
                selected.map((record: any) => ({
                  sourceId: source.id,
                  parsedViewId: source.parsed_view_id,
                  ordinal: Number(record.ordinal),
                  recordHash: record.record_hash,
                })),
              ),
            ),
          ),
        };
        const proposal = await client.query(
          `SELECT id FROM formal_schema_proposal
           WHERE id = $1 AND draft_id = $2 AND mapping_hash = $3
             AND selected_records_hash = $4 AND scanned_record_count = $5`,
          [
            body.proposalId,
            current.id,
            identity.mappingHash,
            identity.selectedRecordsHash,
            mapped.length,
          ],
        );
        if (!proposal.rowCount) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "schema_proposal_stale" },
          });
        }
        const priorSchema = await client.query(
          `SELECT fs.mode, fs.input_schema, fs.expected_output_schema
           FROM test_set_version v JOIN formal_schema_revision fs ON fs.id = v.schema_revision_id
           WHERE v.test_set_id = $1 ORDER BY v.sequence DESC LIMIT 1`,
          [current.test_set_id],
        );
        if (
          priorSchema.rowCount &&
          compareFormalSchemaBundles(
            {
              mode: priorSchema.rows[0].mode,
              input: priorSchema.rows[0].input_schema,
              expectedOutput: priorSchema.rows[0].expected_output_schema,
            },
            {
              mode: body.formalSchema.mode,
              input: body.formalSchema.input,
              expectedOutput: body.formalSchema.expectedOutput,
            },
          ) === "requires_new_test_set"
        ) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "requires_new_test_set" },
          });
        }
        const primaryMapping = contexts[0]?.mapping;
        if (!primaryMapping) {
          await client.query("COMMIT");
          return reply.code(422).send({ error: { code: "mapping_invalid" } });
        }
        if (contexts.length === 1 && body.mapping !== undefined)
          await client.query(
            `UPDATE draft_source
             SET mapping = $2, unmapped_fields = $3, unmapped_confirmed = $4
             WHERE id = $1`,
            [
              contexts[0].source.id,
              primaryMapping,
              JSON.stringify(
                body.unmappedFields.map(canonicalSourcePath).sort(),
              ),
              body.unmappedConfirmed,
            ],
          );
        const mappingId = opaqueId("mapping");
        await client.query(
          `INSERT INTO mapping_revision
           (id, draft_id, mapping, unmapped_fields, unmapped_confirmed, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            mappingId,
            current.id,
            primaryMapping,
            JSON.stringify(body.unmappedFields.map(canonicalSourcePath).sort()),
            body.unmappedConfirmed,
            actor.id,
          ],
        );
        const schemaId = opaqueId("schema");
        await client.query(
          `INSERT INTO formal_schema_revision
           (id, test_set_id, mode, input_schema, expected_output_schema, proposal_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            schemaId,
            current.test_set_id,
            body.formalSchema.mode,
            body.formalSchema.input,
            body.formalSchema.expectedOutput,
            body.proposalId,
          ],
        );
        const existingRecipe =
          typeof current.recipe === "object" && current.recipe
            ? current.recipe
            : {};
        const existingSteps = Array.isArray(existingRecipe.steps)
          ? existingRecipe.steps
          : undefined;
        const primaryFilter =
          existingSteps?.find((step: any) => step.kind === "filter")?.filter ??
          body.filter;
        await client.query(
          `UPDATE working_draft
           SET recipe = $2, formal_schema_id = $3, mapping_revision_id = $4, updated_by = $5, updated_at = $6,
               revision = revision + 1
           WHERE id = $1 RETURNING revision, updated_at`,
          [
            request.params.draftId,
            {
              ...existingRecipe,
              filter: primaryFilter,
              steps: existingSteps ?? [{ kind: "filter", filter: body.filter }],
              mapping: primaryMapping,
              sourceMappings: contexts.map(({ source, mapping }) => ({
                sourceId: source.id,
                mapping,
              })),
              unmappedFields: body.unmappedFields
                .map(canonicalSourcePath)
                .sort(),
              unmappedConfirmed: body.unmappedConfirmed,
            },
            schemaId,
            mappingId,
            actor.id,
            now(),
          ],
        );
        await client.query(
          `UPDATE candidate_snapshot SET status = 'superseded'
           WHERE draft_id = $1 AND status = 'ready_to_publish'`,
          [request.params.draftId],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'draft_recipe_saved', 'working_draft', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.draftId,
            { revision: Number(current.revision) + 1 },
          ],
        );
        await client.query("COMMIT");
        return {
          draft: {
            id: request.params.draftId,
            status: "editing",
            schemaRevisionId: schemaId,
            revision: Number(current.revision) + 1,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; draftId: string };
    Body: { leaseToken?: string; expectedRevision?: number };
  }>(
    "/api/projects/:projectId/drafts/:draftId/candidates",
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
      if (
        typeof request.body?.leaseToken !== "string" ||
        !Number.isInteger(request.body.expectedRevision)
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_write_precondition_required" } });
      const draft = await db.query(
        `SELECT wd.id, wd.base_version_id
         FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN LATERAL (
           SELECT ds.asset_id FROM draft_source ds
           WHERE ds.draft_id = wd.id AND ds.removed_at IS NULL
           ORDER BY ds.position LIMIT 1
         ) first_source ON true
         WHERE wd.id = $1 AND ts.project_id = $2 AND wd.recipe IS NOT NULL AND wd.formal_schema_id IS NOT NULL
           AND (
             wd.base_version_id IS NOT NULL OR EXISTS (
               SELECT 1 FROM draft_source ds
               WHERE ds.draft_id = wd.id AND ds.removed_at IS NULL
                 AND ds.mapping IS NOT NULL AND ds.unmapped_confirmed
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM draft_source ds
             WHERE ds.draft_id = wd.id AND ds.removed_at IS NULL
               AND ds.mapping IS NOT NULL AND NOT ds.unmapped_confirmed
           )`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount) {
        const draftExists = await db.query(
          `SELECT 1 FROM working_draft wd
           JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draftExists.rowCount)
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        return reply.code(422).send({ error: { code: "draft_not_ready" } });
      }
      const candidateId = opaqueId("candidate");
      const jobId = opaqueId("job");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await lockDraftDeletionReferences(
          client,
          request.params.projectId,
          request.params.draftId,
        );
        const current = await client.query(
          `SELECT wd.* FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = $1 AND ts.project_id = $2
             AND wd.status IN ('editing', 'materializing') FOR UPDATE OF wd`,
          [request.params.draftId, request.params.projectId],
        );
        if (!current.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (
          await draftDeletionBlocked(
            client,
            request.params.projectId,
            request.params.draftId,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const error = draftWriteError(
          current.rows[0],
          actor.id,
          request.body.leaseToken,
          request.body.expectedRevision,
        );
        if (error) {
          await client.query("COMMIT");
          return reply.code(409).send({ error });
        }
        if (current.rows[0].status === "materializing") {
          const existing = await client.query(
            `SELECT id, status FROM candidate_snapshot
             WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [current.rows[0].id],
          );
          if (!existing.rowCount) {
            await client.query("COMMIT");
            return reply.code(409).send({
              error: { code: "candidate_materialization_in_progress" },
            });
          }
          const existingJob = await client.query(
            `SELECT id, status FROM job
             WHERE kind = 'materialize_candidate'
               AND payload ->> 'candidateId' = $1
               AND status IN ('queued', 'running', 'retry_wait')
             ORDER BY created_at DESC LIMIT 1`,
            [existing.rows[0].id],
          );
          await client.query("COMMIT");
          return reply.code(202).send({
            candidate: {
              id: existing.rows[0].id,
              status: existing.rows[0].status,
            },
            ...(existingJob.rowCount
              ? {
                  job: {
                    id: existingJob.rows[0].id,
                    status: existingJob.rows[0].status,
                  },
                }
              : {}),
            replayed: true,
          });
        }
        const existingRevision = await client.query(
          `SELECT * FROM draft_revision
           WHERE draft_id = $1 AND revision = $2 FOR UPDATE`,
          [current.rows[0].id, current.rows[0].revision],
        );
        let sourceSnapshots: any[];
        let frozenRevision: any;
        if (
          existingRevision.rowCount &&
          Array.isArray(existingRevision.rows[0].sources)
        ) {
          frozenRevision = existingRevision.rows[0];
          sourceSnapshots = frozenRevision.sources;
        } else {
          const snapshotSources = await client.query(
            `SELECT ds.id AS draft_source_id, ds.asset_id, ds.parsed_view_id,
                    ds.position, ds.mapping, ds.unmapped_fields,
                    ds.unmapped_confirmed, pv.parser_name, pv.parser_version,
                    pv.record_count, sar.id AS attribution_id, sar.source_type,
                    sar.source_name, sar.responsible_actor, sar.responsible_person,
                    sar.purpose, sar.license_status, sar.sensitivity,
                    sar.source_address, sar.acquired_at,
                    sar.deidentification_confirmed
             FROM draft_source ds
             JOIN parsed_view pv ON pv.id = ds.parsed_view_id
             JOIN LATERAL (
               SELECT * FROM source_attribution_revision
               WHERE asset_id = ds.asset_id
               ORDER BY created_at DESC, id DESC LIMIT 1
             ) sar ON true
             WHERE ds.draft_id = $1 AND ds.removed_at IS NULL
             ORDER BY ds.position`,
            [current.rows[0].id],
          );
          sourceSnapshots = snapshotSources.rows.map(sourceSnapshotFromRow);
          if (
            !sourceSnapshots.length ||
            sourceSnapshots.some((source) => !isAllowedSourceSnapshot(source))
          ) {
            await client.query("COMMIT");
            return reply
              .code(422)
              .send({ error: { code: "data_classification_not_allowed" } });
          }
          const operationRows = await client.query(
            `SELECT id, draft_id, operation, case_id, input, expected_output,
                    metadata, reason, previous_content, diff, created_by,
                    created_at::text AS created_at
             FROM draft_case_operation
             WHERE draft_id = $1 ORDER BY created_at, id`,
            [current.rows[0].id],
          );
          const operations = operationRows.rows;
          const revisionPayload = {
            revision: Number(current.rows[0].revision),
            recipe: current.rows[0].recipe ?? {},
            versionDescription: current.rows[0].version_description ?? "",
            baseVersionId: current.rows[0].base_version_id ?? null,
            schemaRevisionId: current.rows[0].formal_schema_id,
            sources: sourceSnapshots,
            operations,
          };
          const revisionHash = sha256(canonicalJson(revisionPayload));
          const insertedRevision = await client.query(
            `INSERT INTO draft_revision
             (id, draft_id, revision, recipe, sources, operations, schema_revision_id,
              base_version_id, version_description, created_by, revision_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (draft_id, revision) DO NOTHING
             RETURNING *`,
            [
              opaqueId("draftrev"),
              current.rows[0].id,
              current.rows[0].revision,
              JSON.stringify(revisionPayload.recipe),
              JSON.stringify(sourceSnapshots),
              JSON.stringify(operations),
              current.rows[0].formal_schema_id,
              current.rows[0].base_version_id,
              revisionPayload.versionDescription,
              actor.id,
              revisionHash,
            ],
          );
          frozenRevision = insertedRevision.rowCount
            ? insertedRevision.rows[0]
            : (
                await client.query(
                  `SELECT * FROM draft_revision
                   WHERE draft_id = $1 AND revision = $2 FOR UPDATE`,
                  [current.rows[0].id, current.rows[0].revision],
                )
              ).rows[0];
          if (Array.isArray(frozenRevision.sources))
            sourceSnapshots = frozenRevision.sources;
        }
        if (
          !sourceSnapshots.length ||
          sourceSnapshots.some((source) => !isAllowedSourceSnapshot(source))
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "data_classification_not_allowed" } });
        }
        const frozenRecipe =
          frozenRevision.recipe ?? current.rows[0].recipe ?? {};
        const frozenSchemaRevisionId =
          frozenRevision.schema_revision_id ?? current.rows[0].formal_schema_id;
        const frozenBaseVersionId =
          frozenRevision.base_version_id ?? current.rows[0].base_version_id;
        const candidateInsert = await client.query(
          `INSERT INTO candidate_snapshot
           (id, draft_id, draft_revision_id, materializer_version, status,
            attribution_revision_id, base_version_id, schema_revision_id,
            recipe, sources, change_note)
           VALUES ($1, $2, $3, $4, 'materializing', $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            candidateId,
            request.params.draftId,
            frozenRevision.id,
            MATERIALIZER_VERSION,
            sourceSnapshots[0].attribution.id,
            frozenBaseVersionId,
            frozenSchemaRevisionId,
            JSON.stringify(frozenRecipe),
            JSON.stringify(sourceSnapshots),
            frozenRevision.version_description ?? "",
          ],
        );
        if (!candidateInsert.rowCount) {
          const existing = await client.query(
            `SELECT id, status FROM candidate_snapshot
             WHERE draft_revision_id = $1 AND schema_revision_id = $2
               AND materializer_version = $3`,
            [frozenRevision.id, frozenSchemaRevisionId, MATERIALIZER_VERSION],
          );
          const existingJob = existing.rowCount
            ? await client.query(
                `SELECT id, status FROM job
                 WHERE kind = 'materialize_candidate'
                   AND payload ->> 'candidateId' = $1
                   AND status IN ('queued', 'running', 'retry_wait', 'failed')
                 ORDER BY created_at DESC LIMIT 1`,
                [existing.rows[0].id],
              )
            : { rowCount: 0, rows: [] };
          if (!existing.rowCount) {
            await client.query("COMMIT");
            return reply.code(409).send({
              error: { code: "candidate_materialization_conflict" },
            });
          }
          if (
            existing.rows[0].status === "failed" &&
            existingJob.rowCount &&
            existingJob.rows[0].status === "failed"
          ) {
            await client.query(
              `UPDATE candidate_snapshot
               SET status = 'materializing'
               WHERE id = $1 AND status = 'failed'`,
              [existing.rows[0].id],
            );
            await client.query(
              `UPDATE working_draft SET status = 'materializing'
               WHERE id = (SELECT draft_id FROM candidate_snapshot WHERE id = $1)
                 AND status = 'editing'`,
              [existing.rows[0].id],
            );
            await client.query(
              `UPDATE job SET status = 'queued', stage = 'queued',
                  progress = 0, attempt = 0, error_code = NULL,
                  retryable = NULL, result = NULL, counts = '{}'::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL,
                  next_run_at = now() + ($2::bigint * interval '1 millisecond'),
                  updated_at = now()
               WHERE id = $1`,
              [existingJob.rows[0].id, config.jobClaimDelayMs],
            );
            await client.query(
              `INSERT INTO audit_event
               (project_id, actor_id, action, object_type, object_id, details)
               VALUES ($1, $2, 'materialization_retry_requested', 'job', $3, $4)`,
              [
                request.params.projectId,
                actor.id,
                existingJob.rows[0].id,
                {
                  correlationId: existingJob.rows[0].id,
                  candidateId: existing.rows[0].id,
                },
              ],
            );
            await client.query("COMMIT");
            return reply.code(202).send({
              candidate: { id: existing.rows[0].id, status: "materializing" },
              job: { id: existingJob.rows[0].id, status: "queued" },
              replayed: true,
            });
          }
          await client.query("COMMIT");
          return reply.code(202).send({
            candidate: {
              id: existing.rows[0].id,
              status: existing.rows[0].status,
            },
            ...(existingJob.rowCount
              ? {
                  job: {
                    id: existingJob.rows[0].id,
                    status: existingJob.rows[0].status,
                  },
                }
              : {}),
            replayed: true,
          });
        }
        await client.query(
          "UPDATE working_draft SET status = 'materializing' WHERE id = $1",
          [request.params.draftId],
        );
        await client.query(
          `INSERT INTO job
             (id, project_id, actor_id, kind, payload, status, correlation_id,
              idempotency_key, max_attempts, next_run_at)
           VALUES ($1, $2, $3, 'materialize_candidate', $4, 'queued', $1, $5, $6,
                   now() + ($7::bigint * interval '1 millisecond'))`,
          [
            jobId,
            request.params.projectId,
            actor.id,
            { candidateId },
            `candidate:${frozenRevision.id}:${frozenSchemaRevisionId}:${MATERIALIZER_VERSION}`,
            config.jobMaxAttempts,
            config.jobClaimDelayMs,
          ],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'candidate_materialization_requested',
                   'candidate_snapshot', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            candidateId,
            { candidateId, correlationId: jobId },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          candidate: { id: candidateId, status: "materializing" },
          job: { id: jobId, status: "queued" },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; candidateId: string } }>(
    "/api/projects/:projectId/candidates/:candidateId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT cs.* FROM candidate_snapshot cs JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         WHERE cs.id = $1 AND ts.project_id = $2
           AND cs.status NOT IN ('deletion_pending', 'tombstoned')
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = ts.project_id
               AND dl.object_type = 'candidate_snapshot' AND dl.object_id = cs.id
           )`,
        [request.params.candidateId, request.params.projectId, actor.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "candidate_not_found" } });
      const row = result.rows[0];
      return {
        candidate: {
          id: row.id,
          status: row.status,
          itemCount: row.item_count,
          payloadHash: row.payload_hash,
          evidenceHash: row.evidence_hash,
          validationReport: row.validation_report,
          recipe: row.recipe,
          draftRevisionId: row.draft_revision_id,
          materializerVersion: row.materializer_version,
          schemaRevisionId: row.schema_revision_id,
          sources: row.sources,
        },
      };
    },
  );

  app.post<{ Params: { projectId: string; candidateId: string } }>(
    "/api/projects/:projectId/candidates/:candidateId/publish",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const candidate = await client.query(
          `SELECT cs.status, cs.change_note, v.id AS version_id, sar.source_type, sar.source_name,
                  sar.responsible_person, sar.purpose, sar.license_status, sar.sensitivity,
                  sar.source_address, sar.acquired_at, sar.deidentification_confirmed
           FROM candidate_snapshot cs
           JOIN working_draft wd ON wd.id = cs.draft_id
           JOIN test_set ts ON ts.id = wd.test_set_id
           JOIN source_attribution_revision sar ON sar.id = cs.attribution_revision_id
           LEFT JOIN test_set_version v ON v.candidate_id = cs.id
           WHERE cs.id = $1 AND ts.project_id = $2
             AND cs.status IN (
               'ready_to_publish',
               'publish_failed',
               'publishing',
               'published_as_version'
             )
             FOR UPDATE OF cs`,
          [request.params.candidateId, request.params.projectId],
        );
        if (!candidate.rowCount) {
          await client.query("COMMIT");
          const candidateExists = await db.query(
            `SELECT 1 FROM candidate_snapshot cs
             JOIN working_draft wd ON wd.id = cs.draft_id
             JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE cs.id = $1 AND ts.project_id = $2`,
            [request.params.candidateId, request.params.projectId],
          );
          if (!candidateExists.rowCount)
            return reply
              .code(404)
              .send({ error: { code: "candidate_not_found" } });
          return reply
            .code(422)
            .send({ error: { code: "candidate_not_ready" } });
        }
        const integrityObjects = await candidateIntegrityObjects(
          client,
          request.params.projectId,
          request.params.candidateId,
        );
        if (
          await integrityBlocked(
            reply,
            request.params.projectId,
            integrityObjects,
          )
        ) {
          await client.query("ROLLBACK");
          return reply;
        }
        if (
          await hasCandidateDeletionLock(
            request.params.projectId,
            request.params.candidateId,
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const attribution = attributionFromRow(candidate.rows[0]);
        if (!attribution || !isAllowedSourceAttribution(attribution)) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "data_classification_not_allowed" } });
        }
        if (candidate.rows[0].status === "published_as_version") {
          await client.query("COMMIT");
          return {
            version: {
              id: candidate.rows[0].version_id,
              status: "published",
            },
            replayed: true,
          };
        }
        if (candidate.rows[0].status === "publishing") {
          const existing = await client.query(
            `SELECT id, status FROM job
             WHERE project_id = $1 AND kind = 'publish_version'
               AND payload ->> 'candidateId' = $2
               AND status IN ('queued', 'running', 'retry_wait')
             ORDER BY created_at DESC, id DESC LIMIT 1`,
            [request.params.projectId, request.params.candidateId],
          );
          if (!existing.rowCount) {
            await client.query("COMMIT");
            return reply
              .code(409)
              .send({ error: { code: "publication_job_not_active" } });
          }
          await client.query("COMMIT");
          return reply.code(202).send({
            job: { id: existing.rows[0].id, status: existing.rows[0].status },
            replayed: true,
          });
        }
        if (
          !["ready_to_publish", "publish_failed"].includes(
            candidate.rows[0].status,
          )
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "candidate_not_ready" } });
        }
        if (!candidate.rows[0].change_note?.trim()) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "version_description_required" } });
        }
        if (candidate.rows[0].status === "publish_failed") {
          const priorFailedJob = await client.query(
            `SELECT id FROM job
             WHERE project_id = $1 AND kind = 'publish_version'
               AND payload ->> 'candidateId' = $2 AND status = 'failed'
             ORDER BY created_at DESC, id DESC LIMIT 1`,
            [request.params.projectId, request.params.candidateId],
          );
          if (priorFailedJob.rowCount) {
            const priorJobId = priorFailedJob.rows[0].id;
            await client.query(
              "UPDATE candidate_snapshot SET status = 'publishing' WHERE id = $1",
              [request.params.candidateId],
            );
            await client.query(
              `UPDATE job SET status = 'queued', stage = 'queued',
                  progress = 0, attempt = 0, error_code = NULL, retryable = NULL,
                  result = NULL, counts = '{}'::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL,
                  next_run_at = now() + ($2::bigint * interval '1 millisecond'),
                  updated_at = now()
               WHERE id = $1`,
              [priorJobId, config.jobClaimDelayMs],
            );
            await client.query(
              `INSERT INTO audit_event
               (project_id, actor_id, action, object_type, object_id, details)
               VALUES ($1, $2, 'publication_retry_requested', 'job', $3, $4)`,
              [
                request.params.projectId,
                actor.id,
                priorJobId,
                {
                  correlationId: priorJobId,
                  candidateId: request.params.candidateId,
                },
              ],
            );
            await client.query("COMMIT");
            return reply.code(202).send({
              job: { id: priorJobId, status: "queued" },
              replayed: true,
            });
          }
        }
        const jobId = opaqueId("job");
        await client.query(
          "UPDATE candidate_snapshot SET status = 'publishing' WHERE id = $1",
          [request.params.candidateId],
        );
        await client.query(
          `INSERT INTO job
             (id, project_id, actor_id, kind, payload, status, correlation_id,
              idempotency_key, max_attempts, next_run_at)
           VALUES ($1, $2, $3, 'publish_version', $4, 'queued', $1, $5, $6,
                   now() + ($7::bigint * interval '1 millisecond'))`,
          [
            jobId,
            request.params.projectId,
            actor.id,
            { candidateId: request.params.candidateId },
            `publication:${request.params.candidateId}`,
            config.jobMaxAttempts,
            config.jobClaimDelayMs,
          ],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'publication_requested', 'candidate_snapshot', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.candidateId,
            {
              candidateId: request.params.candidateId,
              correlationId: jobId,
            },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({ job: { id: jobId, status: "queued" } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; jobId: string } }>(
    "/api/projects/:projectId/jobs/:jobId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT j.id, j.kind, j.status, j.stage, j.progress, j.attempt,
                j.max_attempts, j.counts, j.next_run_at, j.retryable,
                j.correlation_id, j.error_code, j.result
         FROM job j
         JOIN project_member pm ON pm.project_id = j.project_id AND pm.user_id = $3
         WHERE j.id = $1 AND j.project_id = $2`,
        [request.params.jobId, request.params.projectId, actor.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "job_not_found" } });
      return {
        job: {
          id: result.rows[0].id,
          kind: result.rows[0].kind,
          status: result.rows[0].status,
          stage: result.rows[0].stage,
          progress: Number(result.rows[0].progress),
          attempt: Number(result.rows[0].attempt),
          maxAttempts: Number(result.rows[0].max_attempts),
          counts: result.rows[0].counts,
          retryAt: result.rows[0].next_run_at,
          retryable: result.rows[0].retryable,
          correlationId: result.rows[0].correlation_id,
          errorCode: result.rows[0].error_code,
          result: result.rows[0].result,
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { subjectType?: string; subjectId?: string };
  }>(
    "/api/projects/:projectId/lineage/trace",
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
      const subjectType = request.query.subjectType;
      const subjectId = request.query.subjectId;
      if (
        !["case_revision", "test_set_version"].includes(subjectType ?? "") ||
        !subjectId
      )
        return reply
          .code(422)
          .send({ error: { code: "lineage_subject_invalid" } });
      if (
        await hasDeletionLock(request.params.projectId, [
          { type: subjectType as string, id: subjectId },
        ])
      )
        return deletionLocked(reply);

      const nodes = new Map<string, Record<string, unknown>>();
      const edges: Array<Record<string, unknown>> = [];
      type LineageNode = {
        type: string;
        id: string;
        [key: string]: unknown;
      };
      const addNode = (node: LineageNode) => {
        const key = `${node.type}:${node.id}`;
        if (!nodes.has(key)) nodes.set(key, node);
      };
      const addEdge = (
        from: LineageNode,
        to: LineageNode,
        relation: string,
      ) => {
        addNode(from);
        addNode(to);
        edges.push({
          from: `${from.type}:${from.id}`,
          to: `${to.type}:${to.id}`,
          relation,
        });
      };

      const addVersionSources = async (versionId: string) => {
        const sources = await db.query(
          `SELECT DISTINCT sr.parsed_view_id, sr.ordinal, sr.locator, sr.record_hash,
                  da.id AS asset_id
           FROM test_set_version v
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
           JOIN candidate_item ci
             ON ci.candidate_id = v.candidate_id AND ci.ordinal = vm.ordinal
           JOIN parsed_view pv ON pv.id = ci.parsed_view_id
           JOIN data_asset da ON da.id = pv.asset_id
           JOIN source_record sr
             ON sr.parsed_view_id = pv.id
            AND sr.ordinal = ci.source_record_ordinal
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = $1 AND ts.project_id = $2`,
          [versionId, request.params.projectId],
        );
        for (const source of sources.rows) {
          addEdge(
            { type: "test_set_version", id: versionId },
            {
              type: "source_record",
              id: `${source.parsed_view_id}:${Number(source.ordinal)}`,
              parsedViewId: source.parsed_view_id,
              ordinal: Number(source.ordinal),
              assetId: source.asset_id,
              locator: source.locator,
              recordHash: source.record_hash,
            },
            "contains_source_record",
          );
        }
      };

      const addCaseOrigin = async (
        revision: Record<string, any>,
        depth = 0,
      ) => {
        const caseNode = {
          type: "case_revision",
          id: revision.id,
          caseId: revision.case_id,
          lineageLevel: revision.lineage_level ?? "record_level",
        };
        addNode(caseNode);
        const origin = revision.origin_ref ?? {};
        const transformationRun = origin.transformation_run;
        if (transformationRun?.id) {
          addEdge(
            caseNode,
            {
              type: "transformation_run",
              id: transformationRun.id,
              operationType: transformationRun.operationType,
              lineageLevel: transformationRun.lineageLevel,
              manifestHash: transformationRun.manifestHash,
            },
            "produced_by",
          );
          for (const input of origin.input_scope ?? []) {
            if (input.objectType === "test_set_version") {
              addEdge(
                { type: "transformation_run", id: transformationRun.id },
                {
                  type: "test_set_version",
                  id: input.id,
                  scope: input.scope,
                },
                "input_scope",
              );
              await addVersionSources(input.id);
            } else if (input.objectType === "data_asset") {
              addEdge(
                { type: "transformation_run", id: transformationRun.id },
                { type: "data_asset", id: input.id, scope: input.scope },
                "input_scope",
              );
            }
          }
        }
        if (origin.source_record?.parsedViewId) {
          addEdge(
            caseNode,
            {
              type: "source_record",
              id: `${origin.source_record.parsedViewId}:${origin.source_record.ordinal}`,
              ...origin.source_record,
            },
            "source_record",
          );
        }
        const expandParent = async (parentRevisionId: string) => {
          const parentNode = {
            type: "case_revision",
            id: parentRevisionId,
          };
          addEdge(caseNode, parentNode, "parent_revision");
          if (depth >= 2) return;
          const parentRevision = await db.query(
            `SELECT cr.* FROM case_revision cr
             JOIN test_case tc ON tc.id = cr.case_id
             JOIN test_set ts ON ts.id = tc.test_set_id
             WHERE cr.id = $1 AND ts.project_id = $2`,
            [parentRevisionId, request.params.projectId],
          );
          if (parentRevision.rowCount)
            await addCaseOrigin(parentRevision.rows[0], depth + 1);
        };
        if (revision.parent_case_revision_id)
          await expandParent(revision.parent_case_revision_id);
        for (const parent of Array.isArray(origin.parent_inputs)
          ? origin.parent_inputs
          : []) {
          if (!isPlainObject(parent)) continue;
          if (parent.objectType === "case_revision")
            await expandParent(String(parent.id));
          if (parent.objectType === "source_record")
            addEdge(
              caseNode,
              {
                type: "source_record",
                id: `${parent.parsedViewId}:${Number(parent.ordinal)}`,
                ...parent,
              },
              "parent_source_record",
            );
        }
        if (origin.manual_creation)
          addEdge(
            caseNode,
            {
              type: "manual_event",
              id: `${revision.id}:manual`,
              ...origin.manual_creation,
            },
            "manual_creation",
          );
      };

      if (subjectType === "test_set_version") {
        const version = await db.query(
          `SELECT v.id FROM test_set_version v
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = $1 AND ts.project_id = $2`,
          [subjectId, request.params.projectId],
        );
        if (!version.rowCount)
          return reply.code(404).send({
            error: { code: "lineage_subject_not_found" },
          });
        addNode({ type: "test_set_version", id: subjectId });
        const members = await db.query(
          `SELECT cr.*, ci.ordinal
           FROM test_set_version v
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
           JOIN candidate_item ci
             ON ci.candidate_id = v.candidate_id AND ci.ordinal = vm.ordinal
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = $1 AND ts.project_id = $2
           ORDER BY ci.ordinal`,
          [subjectId, request.params.projectId],
        );
        for (const member of members.rows) {
          addEdge(
            { type: "test_set_version", id: subjectId },
            { type: "case_revision", id: member.id },
            "contains_case",
          );
          await addCaseOrigin(member);
        }
      } else {
        const revision = await db.query(
          `SELECT cr.* FROM case_revision cr
           JOIN test_case tc ON tc.id = cr.case_id
           JOIN test_set ts ON ts.id = tc.test_set_id
           WHERE cr.id = $1 AND ts.project_id = $2`,
          [subjectId, request.params.projectId],
        );
        if (!revision.rowCount)
          return reply.code(404).send({
            error: { code: "lineage_subject_not_found" },
          });
        await addCaseOrigin(revision.rows[0]);
      }

      return traceLineageGraph(
        { type: subjectType as string, id: subjectId },
        Array.from(nodes.values()) as any,
        edges as any,
      );
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/transformation-runs",
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

      if (!isPlainObject(request.body))
        return reply
          .code(422)
          .send({ error: validateTransformationManifest(request.body) });
      const manifest = request.body;
      const registered = registerRun(manifest, (content) => sha256(content));
      const report = registered.report;
      if (
        !report.valid &&
        report.errors.some((error) =>
          ["/schemaVersion", "/operationType", "/lineageLevel"].includes(
            error.path,
          ),
        )
      )
        return reply.code(422).send({ error: report });
      if (
        !report.valid &&
        manifest.lineageLevel === "record_level" &&
        (!Array.isArray(manifest.recordEdges) ||
          manifest.recordEdges.length === 0)
      )
        return reply.code(422).send({ error: report });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [
          request.params.projectId,
        ]);
        const declaredInputs = Array.isArray(manifest.inputs)
          ? manifest.inputs
          : [];
        const outputReferenceForLock =
          Array.isArray(manifest.outputs) &&
          manifest.outputs[0] &&
          typeof manifest.outputs[0] === "object"
            ? (manifest.outputs[0] as Record<string, unknown>)
            : undefined;
        const inputAssetIds = declaredInputs
          .filter(
            (input): input is Record<string, unknown> =>
              !!input &&
              typeof input === "object" &&
              (input as Record<string, unknown>).objectType === "data_asset" &&
              typeof (input as Record<string, unknown>).id === "string",
          )
          .map((input) => String(input.id));
        const inputVersionIds = declaredInputs
          .filter(
            (input): input is Record<string, unknown> =>
              !!input &&
              typeof input === "object" &&
              (input as Record<string, unknown>).objectType ===
                "test_set_version" &&
              typeof (input as Record<string, unknown>).id === "string",
          )
          .map((input) => String(input.id));
        const edgeViewIds = (
          Array.isArray(manifest.recordEdges) ? manifest.recordEdges : []
        ).flatMap((edge) =>
          edge && typeof edge === "object" && Array.isArray(edge.inputs)
            ? edge.inputs
                .filter(
                  (input: unknown): input is Record<string, unknown> =>
                    !!input &&
                    typeof input === "object" &&
                    (input as Record<string, unknown>).objectType ===
                      "source_record" &&
                    typeof (input as Record<string, unknown>).parsedViewId ===
                      "string",
                )
                .map((input: Record<string, unknown>) =>
                  String(input.parsedViewId),
                )
            : [],
        );
        const edgeRevisionIds = (
          Array.isArray(manifest.recordEdges) ? manifest.recordEdges : []
        ).flatMap((edge) =>
          edge && typeof edge === "object" && Array.isArray(edge.inputs)
            ? edge.inputs
                .filter(
                  (input: unknown): input is Record<string, unknown> =>
                    !!input &&
                    typeof input === "object" &&
                    (input as Record<string, unknown>).objectType ===
                      "case_revision" &&
                    typeof (input as Record<string, unknown>).id === "string",
                )
                .map((input: Record<string, unknown>) => String(input.id))
            : [],
        );
        const outputAssetId =
          typeof outputReferenceForLock?.assetId === "string"
            ? outputReferenceForLock.assetId
            : undefined;
        const lockedAssets = new Map<string, Record<string, any>>();
        for (const assetId of [
          ...new Set([
            ...inputAssetIds,
            ...(outputAssetId ? [outputAssetId] : []),
          ]),
        ].sort()) {
          const row = await lockAssetRow(
            client,
            request.params.projectId,
            assetId,
          );
          if (row) lockedAssets.set(assetId, row);
        }
        const outputAsset = outputReferenceForLock
          ? await client.query(
              `SELECT da.blob_sha256, da.status AS asset_status,
                      pv.status, pv.record_count, pv.id AS parsed_view_id
               FROM data_asset da
               LEFT JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
               WHERE da.id = $1 AND da.project_id = $2`,
              [outputReferenceForLock.assetId, request.params.projectId],
            )
          : { rowCount: 0, rows: [] };
        const parsedViewIds = [
          ...new Set([
            ...edgeViewIds,
            ...(outputAsset.rows[0]?.parsed_view_id
              ? [String(outputAsset.rows[0].parsed_view_id)]
              : []),
          ]),
        ].sort();
        const lockedParsedViews = new Map<string, Record<string, any>>();
        for (const viewId of parsedViewIds) {
          const row = await lockParsedViewRow(
            client,
            request.params.projectId,
            viewId,
          );
          if (row) lockedParsedViews.set(viewId, row);
        }
        for (const revisionId of [...new Set(edgeRevisionIds)].sort()) {
          await lockCaseRevisionRow(
            client,
            request.params.projectId,
            revisionId,
          );
        }
        const lockedVersions = new Map<string, Record<string, any>>();
        for (const versionId of [...new Set(inputVersionIds)].sort()) {
          const row = await lockVersionRow(
            client,
            request.params.projectId,
            versionId,
          );
          if (row) lockedVersions.set(versionId, row);
        }
        const blockedInput = await (async () => {
          for (const input of declaredInputs) {
            if (!input || typeof input !== "object") continue;
            const reference = input as Record<string, unknown>;
            if (typeof reference.id !== "string") continue;
            if (reference.objectType === "data_asset") {
              if (
                deletionStateBlocked(lockedAssets.get(reference.id)) ||
                (await hasAssetDeletionLock(
                  request.params.projectId,
                  reference.id,
                  client,
                ))
              )
                return true;
            } else if (reference.objectType === "test_set_version") {
              if (
                deletionStateBlocked(lockedVersions.get(reference.id)) ||
                (await hasVersionDeletionLock(
                  request.params.projectId,
                  reference.id,
                  client,
                ))
              )
                return true;
            }
          }
          return false;
        })();
        const outputLocked =
          typeof outputAssetId === "string" &&
          (deletionStateBlocked(lockedAssets.get(outputAssetId)) ||
            (await hasAssetDeletionLock(
              request.params.projectId,
              outputAssetId,
              client,
            )));
        const parsedViewLockResults = await Promise.all(
          [...lockedParsedViews.entries()].map(
            async ([viewId, row]) =>
              deletionStateBlocked(row) ||
              (await hasParsedViewDeletionLock(
                request.params.projectId,
                viewId,
                client,
              )),
          ),
        );
        const revisionLocked = await hasDeletionLock(
          request.params.projectId,
          [...new Set(edgeRevisionIds)].map((id) => ({
            type: "case_revision",
            id,
          })),
          client,
        );
        if (
          blockedInput ||
          outputLocked ||
          parsedViewLockResults.some(Boolean) ||
          revisionLocked
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        for (const input of Array.isArray(manifest.inputs)
          ? manifest.inputs
          : []) {
          if (!input || typeof input !== "object") continue;
          const reference = input as Record<string, unknown>;
          if (reference.objectType === "data_asset") {
            const found = await client.query(
              `SELECT blob_sha256 FROM data_asset
               WHERE id = $1 AND project_id = $2`,
              [reference.id, request.params.projectId],
            );
            if (
              !found.rowCount ||
              found.rows[0].blob_sha256 !== reference.sha256
            ) {
              await client.query("COMMIT");
              return reply.code(422).send({
                error: { code: "transformation_input_invalid" },
              });
            }
          } else if (reference.objectType === "test_set_version") {
            const found = await client.query(
              `SELECT v.manifest_hash FROM test_set_version v
               JOIN test_set ts ON ts.id = v.test_set_id
               WHERE v.id = $1 AND ts.project_id = $2`,
              [reference.id, request.params.projectId],
            );
            if (
              !found.rowCount ||
              found.rows[0].manifest_hash !== reference.sha256
            ) {
              await client.query("COMMIT");
              return reply.code(422).send({
                error: { code: "transformation_input_invalid" },
              });
            }
          }
        }

        const output = Array.isArray(manifest.outputs)
          ? manifest.outputs[0]
          : undefined;
        const outputReference =
          output && typeof output === "object"
            ? (output as Record<string, unknown>)
            : undefined;
        if (
          !outputReference ||
          !outputAsset.rowCount ||
          outputAsset.rows[0].blob_sha256 !== outputReference.sha256 ||
          outputAsset.rows[0].status !== "ready" ||
          Number(outputAsset.rows[0].record_count) !==
            Number(outputReference.recordCount)
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "transformation_output_invalid" } });
        }
        const existingOutput = await client.query(
          `SELECT tro.run_id
           FROM transformation_run_output tro
           JOIN transformation_run tr ON tr.id = tro.run_id
           WHERE tro.asset_id = $1 AND tr.project_id = $2`,
          [outputReference.assetId, request.params.projectId],
        );
        if (existingOutput.rowCount) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "transformation_output_already_registered" },
          });
        }

        for (const edge of Array.isArray(manifest.recordEdges)
          ? manifest.recordEdges
          : []) {
          if (!edge || typeof edge !== "object") continue;
          const declaredVersionIds = ((manifest.inputs ?? []) as any[])
            .filter((input: any) => input?.objectType === "test_set_version")
            .map((input: any) => input.id);
          const declaredAssetIds = ((manifest.inputs ?? []) as any[])
            .filter((input: any) => input?.objectType === "data_asset")
            .map((input: any) => input.id);
          for (const input of Array.isArray(edge.inputs) ? edge.inputs : []) {
            if (!input || typeof input !== "object") continue;
            const reference = input as Record<string, unknown>;
            let inputValid = false;
            if (reference.objectType === "source_record") {
              const found = await client.query(
                `SELECT sr.record_hash
                 FROM source_record sr
                 JOIN parsed_view pv ON pv.id = sr.parsed_view_id
                 JOIN data_asset da ON da.id = pv.asset_id
                 WHERE da.project_id = $1
                   AND pv.id = $2 AND sr.ordinal = $3
                   AND sr.parse_status = 'valid'
                   AND (
                     pv.asset_id = ANY($4::text[])
                     OR EXISTS (
                       SELECT 1
                       FROM test_set_version v
                       JOIN candidate_snapshot cs ON cs.id = v.candidate_id
                       CROSS JOIN LATERAL jsonb_array_elements(cs.sources) source(value)
                       WHERE v.id = ANY($5::text[])
                         AND source.value ->> 'assetId' = pv.asset_id::text
                     )
                   )`,
                [
                  request.params.projectId,
                  reference.parsedViewId,
                  Number(reference.ordinal),
                  declaredAssetIds,
                  declaredVersionIds,
                ],
              );
              inputValid =
                !!found.rowCount &&
                found.rows[0].record_hash === reference.recordHash;
            } else if (reference.objectType === "case_revision") {
              const found = await client.query(
                `SELECT cr.content_hash
                 FROM case_revision cr
                 JOIN test_case tc ON tc.id = cr.case_id
                 JOIN test_set ts ON ts.id = tc.test_set_id
                 WHERE ts.project_id = $1 AND cr.id = $2
                   AND EXISTS (
                     SELECT 1 FROM resolved_version_member vm
                     JOIN test_set_version v ON v.id = vm.version_id
                     WHERE vm.case_revision_id = cr.id
                       AND v.id = ANY($3::text[])
                   )`,
                [request.params.projectId, reference.id, declaredVersionIds],
              );
              inputValid =
                !!found.rowCount &&
                found.rows[0].content_hash === reference.contentHash;
            }
            if (!inputValid) {
              await client.query("COMMIT");
              return reply.code(422).send({
                error: { code: "transformation_input_invalid" },
              });
            }
          }
        }

        const existingDependencies = await client.query(
          `SELECT tro.asset_id AS output_asset, tri.object_id AS dependency_asset
           FROM transformation_run_output tro
           JOIN transformation_run_input tri ON tri.run_id = tro.run_id
           WHERE tro.project_id = $1 AND tri.object_type = 'data_asset'
           UNION ALL
           SELECT tro.asset_id, source.value ->> 'assetId'
           FROM transformation_run_output tro
           JOIN transformation_run_input tri ON tri.run_id = tro.run_id
           JOIN test_set_version v ON v.id = tri.object_id
           JOIN candidate_snapshot cs ON cs.id = v.candidate_id
           CROSS JOIN LATERAL jsonb_array_elements(cs.sources) source(value)
           WHERE tro.project_id = $1 AND tri.object_type = 'test_set_version'
           UNION ALL
           SELECT tro.asset_id, pv.asset_id::text
           FROM transformation_run_output tro
           JOIN transformation_record_edge edge ON edge.run_id = tro.run_id
          JOIN parsed_view pv ON pv.id = edge.input_ref ->> 'parsedViewId'
           WHERE tro.project_id = $1 AND edge.input_type = 'source_record'
           UNION ALL
           SELECT tro.asset_id, source.value ->> 'assetId'
           FROM transformation_run_output tro
           JOIN transformation_record_edge edge ON edge.run_id = tro.run_id
           JOIN resolved_version_member vm ON vm.case_revision_id = edge.input_ref ->> 'id'
           JOIN test_set_version v ON v.id = vm.version_id
           JOIN candidate_snapshot cs ON cs.id = v.candidate_id
           CROSS JOIN LATERAL jsonb_array_elements(cs.sources) source(value)
           WHERE tro.project_id = $1 AND edge.input_type = 'case_revision'`,
          [request.params.projectId],
        );
        const adjacency = new Map<string, string[]>();
        for (const edge of existingDependencies.rows) {
          adjacency.set(edge.output_asset, [
            ...(adjacency.get(edge.output_asset) ?? []),
            edge.dependency_asset,
          ]);
        }
        const proposedDependencies = new Set<string>();
        for (const input of Array.isArray(manifest.inputs)
          ? manifest.inputs
          : []) {
          if (!input || typeof input !== "object") continue;
          const reference = input as Record<string, unknown>;
          if (
            reference.objectType === "data_asset" &&
            typeof reference.id === "string"
          )
            proposedDependencies.add(reference.id);
          if (reference.objectType === "test_set_version") {
            const versionSources = await client.query(
              `SELECT source.value ->> 'assetId' AS asset_id
               FROM test_set_version v
               JOIN candidate_snapshot cs ON cs.id = v.candidate_id
               CROSS JOIN LATERAL jsonb_array_elements(cs.sources) source(value)
               WHERE v.id = $1`,
              [reference.id],
            );
            for (const source of versionSources.rows)
              proposedDependencies.add(source.asset_id);
          }
        }
        for (const edge of Array.isArray(manifest.recordEdges)
          ? manifest.recordEdges
          : []) {
          if (!edge || typeof edge !== "object") continue;
          for (const input of Array.isArray(edge.inputs) ? edge.inputs : []) {
            if (!input || typeof input !== "object") continue;
            const reference = input as Record<string, unknown>;
            if (reference.objectType === "source_record") {
              const sourceAsset = await client.query(
                `SELECT pv.asset_id::text AS asset_id
                 FROM parsed_view pv WHERE pv.id = $1`,
                [reference.parsedViewId],
              );
              if (sourceAsset.rowCount)
                proposedDependencies.add(sourceAsset.rows[0].asset_id);
            } else if (reference.objectType === "case_revision") {
              const revisionAssets = await client.query(
                `SELECT source.value ->> 'assetId' AS asset_id
                 FROM resolved_version_member vm
                 JOIN test_set_version v ON v.id = vm.version_id
                 JOIN candidate_snapshot cs ON cs.id = v.candidate_id
                 CROSS JOIN LATERAL jsonb_array_elements(cs.sources) source(value)
                 WHERE vm.case_revision_id = $1`,
                [reference.id],
              );
              for (const source of revisionAssets.rows)
                proposedDependencies.add(source.asset_id);
            }
          }
        }
        adjacency.set(outputReference.assetId as string, [
          ...(adjacency.get(outputReference.assetId as string) ?? []),
          ...proposedDependencies,
        ]);
        const visiting = new Set<string>();
        const hasCycle = (assetId: string): boolean => {
          if (visiting.has(assetId)) return false;
          visiting.add(assetId);
          return (adjacency.get(assetId) ?? []).some(
            (dependency) =>
              dependency === outputReference.assetId || hasCycle(dependency),
          );
        };
        if (hasCycle(outputReference.assetId as string)) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "lineage_cycle" },
          });
        }

        const prompt = isPlainObject(manifest.prompt)
          ? manifest.prompt
          : undefined;
        const promptReference =
          prompt && isPlainObject(prompt.immutableRef)
            ? prompt.immutableRef
            : undefined;
        if (promptReference) {
          if (
            !(await verifiedPromptReference(
              client,
              request.params.projectId,
              promptReference,
            ))
          ) {
            await client.query("COMMIT");
            return reply
              .code(422)
              .send({ error: { code: "transformation_prompt_invalid" } });
          }
        }

        const runId = opaqueId("run");
        const inserted = await client.query(
          `INSERT INTO transformation_run
           (id, project_id, status, operation_type, lineage_level, manifest,
            manifest_hash, validation_report, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
           RETURNING *`,
          [
            runId,
            request.params.projectId,
            report.valid ? "complete" : "incomplete",
            manifest.operationType ?? "",
            manifest.lineageLevel ?? "",
            JSON.stringify(manifest),
            transformationManifestHash(manifest),
            JSON.stringify(report),
            actor.id,
          ],
        );
        for (const input of Array.isArray(manifest.inputs)
          ? manifest.inputs
          : []) {
          if (!input || typeof input !== "object") continue;
          const reference = input as Record<string, unknown>;
          if (
            !["data_asset", "test_set_version"].includes(
              reference.objectType as string,
            ) ||
            typeof reference.id !== "string"
          )
            continue;
          await client.query(
            `INSERT INTO transformation_run_input
             (run_id, object_type, object_id, sha256, scope)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              runId,
              reference.objectType,
              reference.id,
              reference.sha256,
              JSON.stringify(reference.scope ?? {}),
            ],
          );
        }
        await client.query(
          `INSERT INTO transformation_run_output
           (run_id, project_id, asset_id, sha256, record_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            runId,
            request.params.projectId,
            outputReference.assetId,
            outputReference.sha256,
            Number(outputReference.recordCount),
          ],
        );
        for (const edge of Array.isArray(manifest.recordEdges)
          ? manifest.recordEdges
          : []) {
          if (!edge || typeof edge !== "object") continue;
          const edgeRecord = edge as Record<string, unknown>;
          for (const input of Array.isArray(edgeRecord.inputs)
            ? edgeRecord.inputs
            : []) {
            if (!input || typeof input !== "object") continue;
            await client.query(
              `INSERT INTO transformation_record_edge
               (id, run_id, output_parsed_view_id, output_ordinal,
                input_type, input_ref)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
              [
                opaqueId("lineage"),
                runId,
                outputAsset.rows[0].parsed_view_id,
                Number(edgeRecord.outputOrdinal),
                (input as Record<string, unknown>).objectType,
                JSON.stringify(input),
              ],
            );
          }
        }
        await client.query(
          "UPDATE data_asset SET asset_kind = 'derived' WHERE id = $1",
          [outputReference.assetId],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'transformation_run_registered', 'transformation_run', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            runId,
            {
              operationType: manifest.operationType ?? null,
              lineageLevel: manifest.lineageLevel ?? null,
              manifestHash: transformationManifestHash(manifest),
              outputAssetId: outputReference.assetId,
            },
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(201)
          .send({ run: transformationRunResponse(inserted.rows[0]) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; runId: string } }>(
    "/api/projects/:projectId/transformation-runs/:runId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT tr.*,
                COALESCE(
                  (
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', annotation.id, 'note', annotation.note,
                      'createdBy', annotation.created_by,
                      'createdAt', annotation.created_at
                    ) ORDER BY annotation.created_at, annotation.id)
                    FROM transformation_run_annotation annotation
                    WHERE annotation.run_id = tr.id
                  ),
                  '[]'::jsonb
                ) AS annotations
         FROM transformation_run tr
         JOIN project_member pm
           ON pm.project_id = tr.project_id AND pm.user_id = $3
         WHERE tr.id = $1 AND tr.project_id = $2`,
        [request.params.runId, request.params.projectId, actor.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({
          error: { code: "transformation_run_not_found" },
        });
      return { run: transformationRunResponse(result.rows[0]) };
    },
  );

  app.post<{ Params: { projectId: string; runId: string }; Body: unknown }>(
    "/api/projects/:projectId/transformation-runs/:runId/complete",
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
      if (!isPlainObject(request.body))
        return reply
          .code(422)
          .send({ error: validateTransformationManifest(request.body) });
      const manifest = request.body;
      const prompt = isPlainObject(manifest.prompt)
        ? manifest.prompt
        : undefined;
      if (
        prompt &&
        typeof prompt.content === "string" &&
        prompt.content.trim() &&
        !prompt.sha256
      )
        prompt.sha256 = sha256(prompt.content);
      const report = validateTransformationManifest(manifest);
      if (!report.valid) return reply.code(422).send({ error: report });
      const promptReference =
        prompt && isPlainObject(prompt.immutableRef)
          ? prompt.immutableRef
          : undefined;
      if (
        promptReference &&
        !(await verifiedPromptReference(
          db,
          request.params.projectId,
          promptReference,
        ))
      )
        return reply.code(422).send({
          error: { code: "transformation_prompt_invalid" },
        });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const run = await client.query(
          `SELECT tr.*, tro.asset_id
           FROM transformation_run tr
           JOIN transformation_run_output tro ON tro.run_id = tr.id
           WHERE tr.id = $1 AND tr.project_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM candidate_transformation_run ctr
               WHERE ctr.run_id = tr.id
             )
           FOR UPDATE OF tr`,
          [request.params.runId, request.params.projectId],
        );
        const output = Array.isArray(manifest.outputs)
          ? (manifest.outputs[0] as Record<string, unknown>)
          : undefined;
        if (
          !run.rowCount ||
          run.rows[0].status !== "incomplete" ||
          manifest.schemaVersion !== run.rows[0].manifest.schemaVersion ||
          manifest.operationType !== run.rows[0].operation_type ||
          manifest.lineageLevel !== run.rows[0].lineage_level ||
          output?.assetId !== run.rows[0].asset_id ||
          canonicalJson(manifest.inputs ?? []) !==
            canonicalJson(run.rows[0].manifest.inputs ?? []) ||
          canonicalJson(manifest.outputs ?? []) !==
            canonicalJson(run.rows[0].manifest.outputs ?? []) ||
          canonicalJson(manifest.recordEdges ?? []) !==
            canonicalJson(run.rows[0].manifest.recordEdges ?? [])
        ) {
          await client.query("COMMIT");
          return reply
            .code(409)
            .send({ error: { code: "transformation_run_not_completable" } });
        }
        if (
          await hasRunDeletionLock(
            request.params.projectId,
            request.params.runId,
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        await client.query(
          `UPDATE transformation_run
           SET status='complete', manifest=$2::jsonb, manifest_hash=$3,
               validation_report=$4::jsonb
           WHERE id=$1`,
          [
            request.params.runId,
            JSON.stringify(manifest),
            transformationManifestHash(manifest),
            JSON.stringify(report),
          ],
        );
        await client.query(
          "DELETE FROM transformation_run_input WHERE run_id=$1",
          [request.params.runId],
        );
        for (const input of manifest.inputs as any[]) {
          await client.query(
            `INSERT INTO transformation_run_input
             (run_id, object_type, object_id, sha256, scope)
             VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [
              request.params.runId,
              input.objectType,
              input.id,
              input.sha256,
              JSON.stringify(input.scope ?? {}),
            ],
          );
        }
        const outputView = await client.query(
          `SELECT pv.id
           FROM transformation_run_output tro
           JOIN parsed_view pv ON pv.asset_id=tro.asset_id AND pv.is_current
           WHERE tro.run_id=$1`,
          [request.params.runId],
        );
        await client.query(
          "DELETE FROM transformation_record_edge WHERE run_id=$1",
          [request.params.runId],
        );
        for (const edge of (manifest.recordEdges as any[]) ?? []) {
          for (const input of edge.inputs ?? []) {
            await client.query(
              `INSERT INTO transformation_record_edge
               (id,run_id,output_parsed_view_id,output_ordinal,input_type,input_ref)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
              [
                opaqueId("lineage"),
                request.params.runId,
                outputView.rows[0].id,
                Number(edge.outputOrdinal),
                input.objectType,
                JSON.stringify(input),
              ],
            );
          }
        }
        await client.query("COMMIT");
        return { run: { id: request.params.runId, status: "complete" } };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; runId: string };
    Body: { note?: string };
  }>(
    "/api/projects/:projectId/transformation-runs/:runId/annotations",
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
      const note = request.body?.note?.trim();
      if (!note)
        return reply
          .code(422)
          .send({ error: { code: "transformation_annotation_required" } });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const run = await client.query(
          `SELECT id FROM transformation_run
           WHERE id = $1 AND project_id = $2 FOR UPDATE`,
          [request.params.runId, request.params.projectId],
        );
        if (!run.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({
            error: { code: "transformation_run_not_found" },
          });
        }
        const annotationId = opaqueId("note");
        await client.query(
          `INSERT INTO transformation_run_annotation
           (id, run_id, note, created_by)
           VALUES ($1, $2, $3, $4)`,
          [annotationId, request.params.runId, note, actor.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'transformation_run_annotated', 'transformation_run', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.runId,
            { annotationId, correlationId: request.params.runId },
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          annotation: { id: annotationId, note, createdBy: actor.id },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:versionId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const summary = await testSetSummary(
        request.params.projectId,
        request.params.testSetId,
        actor.id,
      );
      if (!summary)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const allowed = new Set(["limit", "offset"]);
      const limit = request.query.limit ? Number(request.query.limit) : 100;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const degraded = await db.query(
        `SELECT ts.id AS test_set_id, ts.name, ts.status AS test_set_status,
                ts.default_version_id, v.id, v.sequence, v.status,
                v.archived_at, v.archive_reason
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm
           ON pm.project_id = ts.project_id AND pm.user_id = $4
         WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
           AND v.status = 'degraded_by_deletion'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          actor.id,
        ],
      );
      if (degraded.rowCount) {
        const row = degraded.rows[0];
        const tombstones = await db.query(
          `SELECT dt.event_id, dt.object_type, dt.opaque_object_id,
                  dt.prior_hash, dt.affected_version_ids, dt.actor_id,
                  dt.reason_code, dt.reason_note, dt.initiated_at,
                  dt.confirmed_at, dt.completed_at, dt.result_status
           FROM deletion_tombstone dt
           JOIN deletion_event de ON de.id = dt.event_id
           WHERE de.project_id = $1
             AND dt.object_type = 'test_set_version'
             AND dt.opaque_object_id = $2
           ORDER BY dt.completed_at DESC NULLS LAST, dt.event_id DESC`,
          [request.params.projectId, request.params.versionId],
        );
        return {
          tombstoneOnly: true,
          governance: "nonproduction_governance_simulation",
          testSet: testSetSummaryResponse(summary),
          version: {
            id: row.id,
            number: row.sequence,
            status: row.status,
            archivedAt: row.archived_at
              ? new Date(row.archived_at).toISOString()
              : null,
            archiveReason: null,
            itemCount: null,
            payloadHash: null,
            evidenceHash: null,
            manifestHash: null,
            tombstones: tombstones.rows.map((item) => ({
              deletionEventId: item.event_id,
              objectType: item.object_type,
              opaqueObjectId: item.opaque_object_id,
              priorHash: item.prior_hash,
              affectedVersionIds: item.affected_version_ids,
              actorId: item.actor_id,
              reasonCode: item.reason_code,
              reasonNote: item.reason_note,
              initiatedAt: item.initiated_at,
              confirmedAt: item.confirmed_at,
              completedAt: item.completed_at,
              resultStatus: item.result_status,
            })),
            lineagePagination: { total: 0, limit, offset },
          },
        };
      }
      const versionQuery = `
        SELECT ts.id AS test_set_id, ts.name, ts.default_version_id, v.*,
                cs.asset_id, cs.parsed_view_id, cs.recipe, cs.validation_report, cs.sources,
                fs.dialect AS schema_dialect, fs.mode AS schema_mode, fs.input_schema, fs.expected_output_schema,
                sar.id AS attribution_id, sar.source_type, sar.source_name, sar.purpose,
                sar.responsible_actor, sar.license_status, sar.sensitivity,
               ci.origin_kind, ci.parent_case_revision_id, ci.manual_reason, ci.origin_ref,
                ci.lineage_level, ci.transformation_run_id,
                cr.case_id, cr.source_record_ordinal, sr.locator, sr.record_hash
         FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $4
         JOIN LATERAL resolve_version_members(v.id) vm ON true
         JOIN case_revision cr ON cr.id = vm.case_revision_id
         JOIN candidate_snapshot cs ON cs.id = v.candidate_id
         LEFT JOIN candidate_item ci ON ci.candidate_id = cs.id AND ci.ordinal = vm.ordinal
         JOIN formal_schema_revision fs ON fs.id = v.schema_revision_id
         JOIN source_attribution_revision sar ON sar.id = cs.attribution_revision_id
         LEFT JOIN source_record sr
           ON ci.origin_kind = 'source_record'
          AND sr.parsed_view_id = ci.parsed_view_id
          AND sr.ordinal = ci.source_record_ordinal
         WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
           AND v.status <> 'degraded_by_deletion'
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = ts.project_id
               AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
           )
         ORDER BY vm.ordinal
         LIMIT $5 OFFSET $6`;
      const queryValues = [
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
        actor.id,
        String(limit),
        String(offset),
      ];
      const result = await db.query(versionQuery, queryValues);
      let lineageRows = result.rows;
      let detailRows = result.rows;
      if (!result.rowCount) {
        const firstPage = await db.query(versionQuery, [
          ...queryValues.slice(0, 4),
          "1",
          "0",
        ]);
        if (!firstPage.rowCount)
          return reply.code(404).send({ error: { code: "version_not_found" } });
        detailRows = firstPage.rows;
        lineageRows = [];
      }
      const lineageTotals = await db.query(
        `SELECT count(*)::text AS total,
                count(*) FILTER (
                  WHERE COALESCE(ci.lineage_level, 'record_level') = 'record_level'
                )::text AS record_level,
                count(*) FILTER (WHERE ci.lineage_level = 'asset_level')::text AS asset_level
         FROM resolve_version_members($1) vm
         LEFT JOIN candidate_item ci
           ON ci.candidate_id = (SELECT candidate_id FROM test_set_version WHERE id = $1)
          AND ci.ordinal = vm.ordinal
         WHERE vm.version_id = $1`,
        [request.params.versionId],
      );
      const resultRows = detailRows;
      const row = resultRows[0];
      const frozenSources: any[] = Array.isArray(row.sources)
        ? row.sources
        : [];
      return {
        testSet: testSetSummaryResponse(summary),
        version: {
          id: row.id,
          number: row.sequence,
          parentVersionId: row.parent_version_id ?? null,
          changeNote: row.change_note ?? "",
          status: row.status ?? "published",
          archivedAt: row.archived_at
            ? new Date(row.archived_at).toISOString()
            : null,
          archiveReason: row.archive_reason ?? null,
          itemCount: row.item_count,
          manifestHash: row.manifest_hash,
          payloadHash: row.payload_hash,
          evidenceHash: row.evidence_hash,
          publishedBy: "owner",
          publishedAt: row.published_at,
          evidence: {
            attribution: {
              id: row.attribution_id,
              sourceType: row.source_type,
              sourceName: row.source_name,
              purpose: row.purpose,
              responsibleActor: row.responsible_actor,
              licenseStatus: row.license_status,
              sensitivity: row.sensitivity,
            },
            attributions: frozenSources.map((source) => ({
              ...source.attribution,
              assetId: source.assetId,
            })),
            sources: frozenSources,
            recipe: row.recipe,
            schema: {
              revisionId: row.schema_revision_id,
              dialect: row.schema_dialect,
              mode: row.schema_mode,
              input: row.input_schema,
              expectedOutput: row.expected_output_schema,
            },
            validationReport: row.validation_report,
          },
          lineage: lineageRows.map((item) => {
            const origin = item.origin_ref ?? {};
            const source = origin.source_record;
            const transformationRun = origin.transformation_run;
            return {
              caseId: item.case_id,
              level: item.lineage_level ?? "record_level",
              originKind: item.origin_kind ?? "source_record",
              transformationRunId: item.transformation_run_id ?? null,
              ...(transformationRun ? { transformationRun } : {}),
              parentCaseRevisionId: item.parent_case_revision_id ?? null,
              manualReason: item.manual_reason ?? null,
              origin,
              ...(source
                ? {
                    assetId: source.assetId,
                    parsedViewId: source.parsedViewId,
                    sourceRecordOrdinal: source.ordinal,
                    locator: source.locator,
                    recordHash: source.recordHash,
                    rawAssetDownloadUrl: `/api/projects/${request.params.projectId}/assets/${source.assetId}/download`,
                  }
                : {}),
            };
          }),
          lineageLevels: {
            recordLevel: Number(lineageTotals.rows[0]?.record_level ?? 0),
            assetLevel: Number(lineageTotals.rows[0]?.asset_level ?? 0),
          },
          lineagePagination: {
            total: Number(lineageTotals.rows[0]?.total ?? 0),
            limit,
            offset,
          },
        },
      };
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: {
      reason?: string;
      expectedDefaultVersionId?: string | null;
      correlationId?: string;
    };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:versionId/default",
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
      if (
        typeof request.body?.reason !== "string" ||
        !request.body.reason.trim()
      )
        return reply
          .code(422)
          .send({ error: { code: "default_reason_required" } });
      if (
        typeof request.body.correlationId !== "string" ||
        !request.body.correlationId.trim()
      )
        return reply
          .code(422)
          .send({ error: { code: "correlation_id_required" } });
      if (
        !Object.prototype.hasOwnProperty.call(
          request.body,
          "expectedDefaultVersionId",
        )
      )
        return reply
          .code(422)
          .send({ error: { code: "default_precondition_required" } });
      const commandFingerprint = sha256(
        canonicalJson({
          versionId: request.params.versionId,
          reason: request.body.reason.trim(),
          expectedDefaultVersionId:
            request.body.expectedDefaultVersionId ?? null,
        }),
      );
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT ts.id, ts.default_version_id
           FROM test_set ts
           JOIN project_member pm
             ON pm.project_id = ts.project_id AND pm.user_id = $3
            AND pm.role IN ('owner', 'editor')
           WHERE ts.id = $1 AND ts.project_id = $2
           FOR UPDATE OF ts`,
          [request.params.testSetId, request.params.projectId, actor.id],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const priorCorrelation = await client.query(
          `SELECT object_id, details FROM audit_event
           WHERE project_id = $1 AND actor_id = $2
             AND action = 'test_set_default_selected'
             AND details ->> 'correlationId' = $3
             AND EXISTS (
               SELECT 1 FROM test_set_version prior_version
               WHERE prior_version.id = audit_event.object_id
                 AND prior_version.test_set_id = $4
             )
           ORDER BY id DESC LIMIT 1`,
          [
            request.params.projectId,
            actor.id,
            request.body.correlationId,
            request.params.testSetId,
          ],
        );
        if (
          priorCorrelation.rowCount &&
          (priorCorrelation.rows[0].object_id !== request.params.versionId ||
            priorCorrelation.rows[0].details.commandFingerprint !==
              commandFingerprint)
        ) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "lifecycle_command_conflict" },
          });
        }
        if (priorCorrelation.rowCount) {
          await client.query("COMMIT");
          return {
            testSet: {
              id: request.params.testSetId,
              defaultVersionId: request.params.versionId,
            },
            version: {
              id: request.params.versionId,
              number: priorCorrelation.rows[0].details.versionNumber,
              status: "published",
            },
            replayed: true,
          };
        }
        const expectedDefaultVersionId =
          request.body.expectedDefaultVersionId ?? null;
        if (testSet.rows[0].default_version_id !== expectedDefaultVersionId) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: {
              code: "default_version_conflict",
              currentDefaultVersionId:
                testSet.rows[0].default_version_id ?? null,
            },
          });
        }
        const version = await client.query(
          `SELECT id, sequence, status FROM test_set_version
           WHERE id = $1 AND test_set_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = $3
                 AND dl.object_type = 'test_set_version' AND dl.object_id = id
             )`,
          [
            request.params.versionId,
            request.params.testSetId,
            request.params.projectId,
          ],
        );
        if (!version.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "version_not_found" } });
        }
        if (version.rows[0].status !== "published") {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "version_not_eligible_for_default" } });
        }
        if (testSet.rows[0].default_version_id === request.params.versionId) {
          await client.query("COMMIT");
          return {
            testSet: {
              id: request.params.testSetId,
              defaultVersionId: request.params.versionId,
            },
            version: {
              id: request.params.versionId,
              number: Number(version.rows[0].sequence),
              status: version.rows[0].status,
            },
            replayed: true,
          };
        }
        await client.query(
          "UPDATE test_set SET default_version_id = $2 WHERE id = $1",
          [request.params.testSetId, request.params.versionId],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'test_set_default_selected', 'test_set_version', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.versionId,
            {
              correlationId: request.body.correlationId,
              commandFingerprint,
              versionNumber: Number(version.rows[0].sequence),
              reason: request.body.reason.trim(),
              versionId: request.params.versionId,
            },
          ],
        );
        await client.query("COMMIT");
        return {
          testSet: {
            id: request.params.testSetId,
            defaultVersionId: request.params.versionId,
          },
          replayed: false,
          version: {
            id: request.params.versionId,
            number: Number(version.rows[0].sequence),
            status: version.rows[0].status,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: {
      reason?: string;
      expectedDefaultVersionId?: string | null;
      correlationId?: string;
    };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:versionId/archive",
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
      if (
        request.body?.reason !== undefined &&
        typeof request.body.reason !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "archive_reason_invalid" } });
      const archiveReason = request.body?.reason?.trim() || null;
      if (
        !Object.prototype.hasOwnProperty.call(
          request.body,
          "expectedDefaultVersionId",
        )
      )
        return reply
          .code(422)
          .send({ error: { code: "default_precondition_required" } });
      if (
        typeof request.body.correlationId !== "string" ||
        !request.body.correlationId.trim()
      )
        return reply
          .code(422)
          .send({ error: { code: "correlation_id_required" } });
      const commandFingerprint = sha256(
        canonicalJson({
          versionId: request.params.versionId,
          reason: archiveReason,
          expectedDefaultVersionId:
            request.body.expectedDefaultVersionId ?? null,
        }),
      );

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT ts.id, ts.default_version_id
           FROM test_set ts
           JOIN project_member pm
             ON pm.project_id = ts.project_id AND pm.user_id = $3
            AND pm.role IN ('owner', 'editor')
           WHERE ts.id = $1 AND ts.project_id = $2
           FOR UPDATE OF ts`,
          [request.params.testSetId, request.params.projectId, actor.id],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const priorCorrelation = await client.query(
          `SELECT object_id, details FROM audit_event
           WHERE project_id = $1 AND actor_id = $2
             AND action = 'test_set_version_archived'
             AND details ->> 'correlationId' = $3
             AND EXISTS (
               SELECT 1 FROM test_set_version prior_version
               WHERE prior_version.id = audit_event.object_id
                 AND prior_version.test_set_id = $4
             )
           ORDER BY id DESC LIMIT 1`,
          [
            request.params.projectId,
            actor.id,
            request.body.correlationId,
            request.params.testSetId,
          ],
        );
        if (
          priorCorrelation.rowCount &&
          (priorCorrelation.rows[0].object_id !== request.params.versionId ||
            priorCorrelation.rows[0].details.commandFingerprint !==
              commandFingerprint)
        ) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "lifecycle_command_conflict" },
          });
        }
        if (priorCorrelation.rowCount) {
          await client.query("COMMIT");
          return {
            version: {
              id: request.params.versionId,
              number: priorCorrelation.rows[0].details.versionNumber,
              status: "archived",
              archivedAt: priorCorrelation.rows[0].details.archivedAt,
            },
            replayed: true,
          };
        }
        const expectedDefaultVersionId =
          request.body.expectedDefaultVersionId ?? null;
        if (testSet.rows[0].default_version_id !== expectedDefaultVersionId) {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: {
              code: "default_version_conflict",
              currentDefaultVersionId:
                testSet.rows[0].default_version_id ?? null,
            },
          });
        }
        if (testSet.rows[0].default_version_id === request.params.versionId) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "default_version_cannot_archive" } });
        }
        const existing = await client.query(
          `SELECT id, sequence, status FROM test_set_version
           WHERE id = $1 AND test_set_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = $3
                 AND dl.object_type = 'test_set_version' AND dl.object_id = id
             ) FOR UPDATE`,
          [
            request.params.versionId,
            request.params.testSetId,
            request.params.projectId,
          ],
        );
        if (!existing.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "version_not_found" } });
        }
        if (existing.rows[0].status === "archived") {
          await client.query("COMMIT");
          return {
            version: {
              id: request.params.versionId,
              number: Number(existing.rows[0].sequence),
              status: "archived",
            },
            replayed: true,
          };
        }
        const archivedAt = now();
        await client.query(
          `UPDATE test_set_version
           SET status = 'archived', archived_at = $2, archived_by = $3,
               archive_reason = $4
           WHERE id = $1`,
          [request.params.versionId, archivedAt, actor.id, archiveReason],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'test_set_version_archived', 'test_set_version', $3, $4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.versionId,
            {
              correlationId: request.body.correlationId,
              commandFingerprint,
              versionNumber: Number(existing.rows[0].sequence),
              reason: archiveReason,
              actorId: actor.id,
              archivedAt: archivedAt.toISOString(),
            },
          ],
        );
        await client.query("COMMIT");
        return {
          version: {
            id: request.params.versionId,
            number: Number(existing.rows[0].sequence),
            status: "archived",
            archivedAt: archivedAt.toISOString(),
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: {
      projectId: string;
      testSetId: string;
      baseVersionId: string;
      targetVersionId: string;
    };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/test-sets/:testSetId/versions/:baseVersionId/compare/:targetVersionId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const allowed = new Set(["limit", "offset"]);
      const limit = request.query.limit ? Number(request.query.limit) : 100;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        (await hasVersionDeletionLock(
          request.params.projectId,
          request.params.baseVersionId,
        )) ||
        (await hasVersionDeletionLock(
          request.params.projectId,
          request.params.targetVersionId,
        ))
      )
        return deletionLocked(reply);
      const versions = await db.query(
        `SELECT v.*, cs.recipe, cs.sources,
                fs.mode, fs.input_schema, fs.expected_output_schema
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
         JOIN candidate_snapshot cs ON cs.id = v.candidate_id
         JOIN formal_schema_revision fs ON fs.id = v.schema_revision_id
         WHERE ts.project_id = $1 AND ts.id = $2
           AND v.id IN ($4, $5)`,
        [
          request.params.projectId,
          request.params.testSetId,
          actor.id,
          request.params.baseVersionId,
          request.params.targetVersionId,
        ],
      );
      const base = versions.rows.find(
        (row) => row.id === request.params.baseVersionId,
      );
      const target = versions.rows.find(
        (row) => row.id === request.params.targetVersionId,
      );
      if (!base || !target || versions.rowCount !== 2)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const members = await db.query(
        `SELECT vm.version_id, cr.id AS revision_id, cr.case_id,
                cr.input, cr.expected_output, cr.metadata, cr.reason
         FROM resolved_version_member vm
         JOIN case_revision cr ON cr.id = vm.case_revision_id
         WHERE vm.version_id IN ($1, $2)
         ORDER BY vm.ordinal`,
        [base.id, target.id],
      );
      const snapshot = (row: any) => ({
        revisionId: row.revision_id,
        input: row.input,
        expected_output: row.expected_output,
        metadata: row.metadata,
      });
      const baseByCase = new Map(
        members.rows
          .filter((row) => row.version_id === base.id)
          .map((row) => [row.case_id, { row, snapshot: snapshot(row) }]),
      );
      const targetByCase = new Map(
        members.rows
          .filter((row) => row.version_id === target.id)
          .map((row) => [row.case_id, { row, snapshot: snapshot(row) }]),
      );
      const items: any[] = [];
      for (const [caseId, targetItem] of targetByCase) {
        const baseItem = baseByCase.get(caseId);
        if (!baseItem) {
          items.push({
            status: "added",
            caseId,
            after: targetItem.snapshot,
          });
        } else if (
          baseItem.row.revision_id !== targetItem.row.revision_id ||
          canonicalJson(baseItem.snapshot) !==
            canonicalJson(targetItem.snapshot)
        ) {
          items.push({
            status: "modified",
            caseId,
            before: baseItem.snapshot,
            after: targetItem.snapshot,
            reason: targetItem.row.reason ?? null,
          });
        } else {
          items.push({
            status: "unchanged",
            caseId,
            before: baseItem.snapshot,
            after: targetItem.snapshot,
          });
        }
      }
      for (const [caseId, baseItem] of baseByCase)
        if (!targetByCase.has(caseId))
          items.push({
            status: "removed",
            caseId,
            before: baseItem.snapshot,
          });
      const statusOrder = ["added", "removed", "modified", "unchanged"];
      items.sort(
        (left, right) =>
          statusOrder.indexOf(left.status) -
            statusOrder.indexOf(right.status) ||
          String(left.caseId).localeCompare(String(right.caseId)),
      );
      const schemaChanged =
        base.mode !== target.mode ||
        canonicalJson(base.input_schema) !==
          canonicalJson(target.input_schema) ||
        canonicalJson(base.expected_output_schema) !==
          canonicalJson(target.expected_output_schema);
      return {
        comparison: {
          baseVersion: { id: base.id, number: Number(base.sequence) },
          targetVersion: { id: target.id, number: Number(target.sequence) },
          counts: {
            added: items.filter((item) => item.status === "added").length,
            removed: items.filter((item) => item.status === "removed").length,
            modified: items.filter((item) => item.status === "modified").length,
            unchanged: items.filter((item) => item.status === "unchanged")
              .length,
          },
          changes: {
            sources:
              canonicalJson(base.sources) !== canonicalJson(target.sources),
            recipe: canonicalJson(base.recipe) !== canonicalJson(target.recipe),
            formalSchema: schemaChanged,
          },
          recipe: {
            before: base.recipe,
            after: target.recipe,
          },
          sources: {
            before: base.sources,
            after: target.sources,
          },
          formalSchema: {
            before: {
              mode: base.mode,
              input: base.input_schema,
              expectedOutput: base.expected_output_schema,
            },
            after: {
              mode: target.mode,
              input: target.input_schema,
              expectedOutput: target.expected_output_schema,
            },
          },
          items: items.slice(offset, offset + limit),
          pagination: { total: items.length, limit, offset },
        },
      };
    },
  );

  app.get<{ Params: { projectId: string; versionId: string } }>(
    "/api/projects/:projectId/versions/:versionId/package",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      let delivery: {
        rows: Array<Record<string, any>>;
        rowCount?: number | null;
      };
      let packageStream: Readable;
      try {
        await client.query("BEGIN");
        const versionLock = await client.query(
          `SELECT v.id
           FROM test_set_version v
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = $1 AND ts.project_id = $2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
             )
           FOR SHARE OF v`,
          [request.params.versionId, request.params.projectId],
        );
        if (!versionLock.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        delivery = await client.query(
          `SELECT dr.id, dr.object_ref, dr.package_type, dr.status FROM delivery_record dr
           JOIN test_set_version v ON v.id = dr.version_id JOIN test_set ts ON ts.id = v.test_set_id
           JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
           WHERE dr.version_id = $1 AND ts.project_id = $2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'delivery_record' AND dl.object_id = dr.id
             )
             AND dr.package_type = 'standard'
           FOR SHARE OF dr`,
          [request.params.versionId, request.params.projectId, actor.id],
        );
        if (!delivery.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        if (
          await integrityBlocked(reply, request.params.projectId, [
            { type: "test_set_version", id: request.params.versionId },
            { type: "delivery_record", id: delivery.rows[0].id },
          ])
        ) {
          await client.query("COMMIT");
          return reply;
        }
        packageStream = await artifacts.read(delivery.rows[0].object_ref);
        const downloaded = await client.query(
          `WITH downloaded AS (
             UPDATE delivery_record dr
             SET status='downloaded', downloaded_at=now(), external_copy_recorded=true
             FROM test_set_version v
             JOIN test_set ts ON ts.id = v.test_set_id
             WHERE dr.id=$1 AND dr.version_id=v.id AND ts.project_id=$2
               AND dr.status NOT IN ('user_confirmed_imported', 'deletion_pending', 'tombstoned')
               AND NOT EXISTS (
                 SELECT 1 FROM deletion_lock dl
                 WHERE dl.project_id=ts.project_id
                   AND ((dl.object_type='delivery_record' AND dl.object_id=dr.id)
                     OR (dl.object_type='test_set_version' AND dl.object_id=v.id)
                     OR (dl.object_type='test_set' AND dl.object_id=ts.id))
               )
             RETURNING dr.id
           )
           INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           SELECT $2, $3, 'delivery_downloaded', 'delivery_record', id,
                  jsonb_build_object('packageType', $4::text)
           FROM downloaded`,
          [
            delivery.rows[0].id,
            request.params.projectId,
            actor.id,
            delivery.rows[0].package_type,
          ],
        );
        if (!downloaded.rowCount) {
          const stillAllowed = await client.query(
            `SELECT dr.id
             FROM delivery_record dr
             JOIN test_set_version v ON v.id=dr.version_id
             JOIN test_set ts ON ts.id=v.test_set_id
             WHERE dr.id=$1 AND ts.project_id=$2
               AND dr.status='user_confirmed_imported'
               AND NOT EXISTS (
                 SELECT 1 FROM deletion_lock dl
                 WHERE dl.project_id=ts.project_id
                   AND ((dl.object_type='delivery_record' AND dl.object_id=dr.id)
                     OR (dl.object_type='test_set_version' AND dl.object_id=v.id)
                     OR (dl.object_type='test_set' AND dl.object_id=ts.id))
               )`,
            [delivery.rows[0].id, request.params.projectId],
          );
          if (!stillAllowed.rowCount) {
            packageStream.destroy();
            await client.query("ROLLBACK");
            return reply
              .code(404)
              .send({ error: { code: "delivery_not_found" } });
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="agentbench-${request.params.versionId}.zip"`,
      );
      return reply.send(packageStream);
    },
  );

  app.get<{ Params: { projectId: string; versionId: string } }>(
    "/api/projects/:projectId/versions/:versionId/deliveries",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const version = await db.query(
        `SELECT 1
         FROM test_set_version v
         JOIN test_set ts ON ts.id=v.test_set_id
         JOIN project_member pm
           ON pm.project_id=ts.project_id AND pm.user_id=$3
         WHERE v.id=$1 AND ts.project_id=$2
           AND v.status <> 'degraded_by_deletion'
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = ts.project_id
               AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
           )`,
        [request.params.versionId, request.params.projectId, actor.id],
      );
      if (!version.rowCount)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const deliveries = await db.query(
        `SELECT dr.id, dr.package_type, dr.package_format_version,
                dr.status, dr.downloaded_at, dr.confirmed_at,
                dr.external_copy_recorded, dr.created_at,
                evidence.local_validation, evidence.verification_level,
                evidence.recorded_at AS validation_recorded_at
         FROM delivery_record dr
         JOIN test_set_version v ON v.id = dr.version_id
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm
           ON pm.project_id = ts.project_id AND pm.user_id = $3
         LEFT JOIN LATERAL (
           SELECT ae.details -> 'localValidation' AS local_validation,
                  ae.details ->> 'verificationLevel' AS verification_level,
                  ae.created_at AS recorded_at
           FROM audit_event ae
           WHERE ae.project_id = ts.project_id
             AND ae.object_type = 'delivery_record'
             AND ae.object_id = dr.id
             AND ae.action IN ('langfuse_csv_generated', 'package_generated')
           ORDER BY ae.created_at DESC, ae.id DESC
           LIMIT 1
         ) evidence ON true
         WHERE dr.version_id = $1 AND ts.project_id = $2
           AND v.status <> 'degraded_by_deletion'
           AND NOT EXISTS (
             SELECT 1 FROM deletion_lock dl
             WHERE dl.project_id = ts.project_id
               AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
           )
         ORDER BY dr.created_at, dr.id`,
        [request.params.versionId, request.params.projectId, actor.id],
      );
      return {
        deliveries: deliveries.rows.map((row) => ({
          id: row.id,
          packageType: row.package_type,
          verificationLevel:
            row.package_type === "standard"
              ? "standard"
              : row.package_type === "full_provenance"
                ? "full"
                : "local_csv",
          formatVersion: row.package_format_version,
          status: row.status,
          downloadedAt: row.downloaded_at,
          confirmedAt: row.confirmed_at,
          externalCopyRecorded: row.external_copy_recorded,
          remoteVerified: false,
          createdAt: row.created_at,
          localValidation: row.local_validation ?? null,
          offlineValidation:
            row.package_type === "full_provenance" &&
            row.verification_level === "full"
              ? {
                  valid: true,
                  verificationLevel: "full",
                  source: "worker_generation",
                  recordedAt: row.validation_recorded_at
                    ? new Date(row.validation_recorded_at).toISOString()
                    : null,
                }
              : row.package_type === "standard"
                ? {
                    status: "recipient_required",
                    verificationLevel: "standard",
                    note: "下载后请使用离线校验器验证包内容。",
                  }
                : null,
        })),
      };
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      packageType?: string;
    };
  }>(
    "/api/projects/:projectId/deliveries",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const allowed = new Set(["limit", "offset", "status", "packageType"]);
      const limit = request.query.limit ? Number(request.query.limit) : 20;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      const statuses = new Set([
        "generated",
        "downloaded",
        "user_confirmed_imported",
        "deletion_pending",
        "tombstoned",
      ]);
      const packageTypes = new Set([
        "standard",
        "full_provenance",
        "langfuse_csv",
      ]);
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.status !== undefined &&
          !statuses.has(request.query.status)) ||
        (request.query.packageType !== undefined &&
          !packageTypes.has(request.query.packageType))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });

      const values: string[] = [request.params.projectId, actor.id];
      const conditions = [
        "ts.project_id = $1",
        "pm.user_id = $2",
        "ts.status <> 'unavailable_by_deletion'",
        "v.status <> 'degraded_by_deletion'",
        "dr.status NOT IN ('deletion_pending', 'tombstoned')",
        `NOT EXISTS (
          SELECT 1 FROM deletion_lock dl
          WHERE dl.project_id = ts.project_id
            AND ((dl.object_type = 'test_set' AND dl.object_id = ts.id)
              OR (dl.object_type = 'test_set_version' AND dl.object_id = v.id)
              OR (dl.object_type = 'delivery_record' AND dl.object_id = dr.id))
        )`,
      ];
      if (request.query.status !== undefined) {
        values.push(request.query.status);
        conditions.push(`dr.status = $${values.length}`);
      }
      if (request.query.packageType !== undefined) {
        values.push(request.query.packageType);
        conditions.push(`dr.package_type = $${values.length}`);
      }
      values.push(String(limit), String(offset));
      const result = await db.query(
        `SELECT dr.id, dr.version_id, dr.package_type, dr.package_format_version,
                dr.target_type, dr.status,
                dr.created_at, dr.downloaded_at, dr.confirmed_at,
                dr.external_copy_recorded, ts.id AS test_set_id, ts.name AS test_set_name,
                v.sequence AS version_number, v.status AS version_status,
                evidence.local_validation, evidence.verification_level,
                evidence.recorded_at AS validation_recorded_at
         FROM delivery_record dr
         JOIN test_set_version v ON v.id = dr.version_id
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $2
         LEFT JOIN LATERAL (
           SELECT ae.details -> 'localValidation' AS local_validation,
                  ae.details ->> 'verificationLevel' AS verification_level,
                  ae.created_at AS recorded_at
           FROM audit_event ae
           WHERE ae.project_id = ts.project_id
             AND ae.object_type = 'delivery_record'
             AND ae.object_id = dr.id
             AND ae.action IN ('langfuse_csv_generated', 'package_generated')
           ORDER BY ae.created_at DESC, ae.id DESC
           LIMIT 1
         ) evidence ON true
         WHERE ${conditions.join(" AND ")}
         ORDER BY dr.created_at DESC, dr.id DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const total = await db.query(
        `SELECT count(*)::text AS total
         FROM delivery_record dr
         JOIN test_set_version v ON v.id = dr.version_id
         JOIN test_set ts ON ts.id = v.test_set_id
         JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $2
         WHERE ${conditions.join(" AND ")}`,
        values.slice(0, -2),
      );
      return {
        deliveries: result.rows.map((row) => ({
          id: row.id,
          versionId: row.version_id,
          testSetId: row.test_set_id,
          testSetName: row.test_set_name,
          versionNumber: Number(row.version_number),
          versionStatus: row.version_status,
          packageType: row.package_type,
          verificationLevel:
            row.package_type === "standard"
              ? "standard"
              : row.package_type === "full_provenance"
                ? "full"
                : "local_csv",
          formatVersion: row.package_format_version,
          targetType: row.target_type,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          downloadedAt: row.downloaded_at
            ? new Date(row.downloaded_at).toISOString()
            : null,
          confirmedAt: row.confirmed_at
            ? new Date(row.confirmed_at).toISOString()
            : null,
          externalCopyRecorded: row.external_copy_recorded,
          remoteVerified: false,
          localValidation: row.local_validation ?? null,
          offlineValidation:
            row.package_type === "full_provenance" &&
            row.verification_level === "full"
              ? {
                  valid: true,
                  verificationLevel: "full",
                  source: "worker_generation",
                  recordedAt: row.validation_recorded_at
                    ? new Date(row.validation_recorded_at).toISOString()
                    : null,
                }
              : row.package_type === "standard"
                ? {
                    status: "recipient_required",
                    verificationLevel: "standard",
                    note: "下载后请使用离线校验器验证包内容。",
                  }
                : null,
        })),
        pagination: {
          total: Number(total.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
    },
  );

  app.post<{
    Params: { projectId: string; versionId: string };
    Body: { packageType?: string; formatVersion?: string };
  }>(
    "/api/projects/:projectId/versions/:versionId/packages",
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
          "export",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const packageType = request.body?.packageType;
      const formatVersion = request.body?.formatVersion ?? "1.0";
      if (
        !["standard", "full_provenance"].includes(packageType ?? "") ||
        formatVersion !== "1.0"
      )
        return reply.code(422).send({
          error: { code: "package_configuration_invalid" },
        });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const version = await client.query(
          `SELECT v.id
           FROM test_set_version v
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = $1 AND ts.project_id = $2
             AND v.status IN ('published', 'archived')
           FOR UPDATE OF v`,
          [request.params.versionId, request.params.projectId],
        );
        if (!version.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "version_not_found" } });
        }
        if (
          await hasVersionDeletionLock(
            request.params.projectId,
            request.params.versionId,
            client,
          )
        ) {
          await client.query("ROLLBACK");
          return deletionLocked(reply);
        }
        const jobId = opaqueId("job");
        const idempotencyKey = `package:${request.params.versionId}:${packageType}:${formatVersion}`;
        await client.query(
          `INSERT INTO job
           (id, project_id, actor_id, kind, payload, status, correlation_id,
            idempotency_key, max_attempts, next_run_at)
           VALUES ($1,$2,$3,'generate_package',$4,'queued',$1,$5,$6,
                   now() + ($7::bigint * interval '1 millisecond'))
           ON CONFLICT (project_id, kind, idempotency_key) DO NOTHING`,
          [
            jobId,
            request.params.projectId,
            actor.id,
            {
              versionId: request.params.versionId,
              packageType,
              formatVersion,
            },
            idempotencyKey,
            config.jobMaxAttempts,
            config.jobClaimDelayMs,
          ],
        );
        await resetCancelledGenerationJob(client, {
          projectId: request.params.projectId,
          versionId: request.params.versionId,
          packageType: packageType as string,
          formatVersion,
          kind: "generate_package",
          idempotencyKey,
        });
        const job = await client.query(
          `SELECT id, status FROM job
           WHERE project_id=$1 AND kind='generate_package'
             AND idempotency_key=$2
           FOR UPDATE`,
          [request.params.projectId, idempotencyKey],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1,$2,'package_generation_requested','job',$3,$4)`,
          [
            request.params.projectId,
            actor.id,
            job.rows[0].id,
            {
              correlationId: job.rows[0].id,
              versionId: request.params.versionId,
              packageType,
              formatVersion,
            },
          ],
        );
        await client.query("COMMIT");
        return reply.code(202).send({
          job: { id: job.rows[0].id, status: job.rows[0].status },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string; deliveryId: string } }>(
    "/api/projects/:projectId/deliveries/:deliveryId/preview",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "export",
        ))
      )
        return reply.code(404).send({ error: { code: "delivery_not_found" } });
      const client = await db.connect();
      let delivery: {
        rows: Array<Record<string, any>>;
        rowCount?: number | null;
      };
      let preview: Buffer;
      try {
        await client.query("BEGIN");
        const versionLock = await client.query(
          `SELECT v.id
           FROM delivery_record dr
           JOIN test_set_version v ON v.id = dr.version_id
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE dr.id = $1 AND ts.project_id = $2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
             )
           FOR SHARE OF v`,
          [request.params.deliveryId, request.params.projectId],
        );
        if (!versionLock.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        delivery = await client.query(
          `SELECT dr.object_ref, dr.package_type
           FROM delivery_record dr
           JOIN test_set_version v ON v.id = dr.version_id
           JOIN test_set ts ON ts.id = v.test_set_id
           JOIN project_member pm
             ON pm.project_id = ts.project_id AND pm.user_id = $3
           WHERE dr.id = $1 AND ts.project_id = $2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'delivery_record' AND dl.object_id = dr.id
             )
             AND dr.package_type = 'langfuse_csv'
           FOR SHARE OF dr`,
          [request.params.deliveryId, request.params.projectId, actor.id],
        );
        if (!delivery.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        if (
          delivery.rows[0].package_type === "langfuse_csv" &&
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "write",
          ))
        ) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        if (
          await integrityBlocked(reply, request.params.projectId, [
            { type: "delivery_record", id: request.params.deliveryId },
            {
              type: "test_set_version",
              id: String(versionLock.rows[0].id),
            },
          ])
        ) {
          await client.query("COMMIT");
          return reply;
        }
        preview = await artifacts.readPrefix(
          delivery.rows[0].object_ref,
          1_000_000,
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", "inline");
      return reply.send(preview);
    },
  );

  app.get<{ Params: { projectId: string; deliveryId: string } }>(
    "/api/projects/:projectId/deliveries/:deliveryId/download",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      let delivery: {
        rows: Array<Record<string, any>>;
        rowCount?: number | null;
      };
      let packageStream: Readable;
      try {
        await client.query("BEGIN");
        const versionLock = await client.query(
          `SELECT v.id
           FROM delivery_record dr
           JOIN test_set_version v ON v.id = dr.version_id
           JOIN test_set ts ON ts.id = v.test_set_id
           WHERE dr.id = $1 AND ts.project_id = $2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'test_set_version' AND dl.object_id = v.id
             )
           FOR SHARE OF v`,
          [request.params.deliveryId, request.params.projectId],
        );
        if (!versionLock.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        delivery = await client.query(
          `SELECT dr.id, dr.object_ref, dr.package_type, dr.status
           FROM delivery_record dr
           JOIN test_set_version v ON v.id = dr.version_id
           JOIN test_set ts ON ts.id = v.test_set_id
           JOIN project_member pm ON pm.project_id=ts.project_id AND pm.user_id=$3
           WHERE dr.id=$1 AND ts.project_id=$2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'delivery_record' AND dl.object_id = dr.id
             )
           FOR SHARE OF dr`,
          [request.params.deliveryId, request.params.projectId, actor.id],
        );
        if (!delivery.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        if (
          delivery.rows[0].package_type === "langfuse_csv" &&
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "write",
          ))
        ) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "delivery_not_found" } });
        }
        if (
          await integrityBlocked(reply, request.params.projectId, [
            { type: "delivery_record", id: request.params.deliveryId },
            {
              type: "test_set_version",
              id: String(versionLock.rows[0].id),
            },
          ])
        ) {
          await client.query("COMMIT");
          return reply;
        }
        packageStream = await artifacts.read(delivery.rows[0].object_ref);
        const downloaded = await client.query(
          `WITH downloaded AS (
             UPDATE delivery_record dr
             SET status='downloaded', downloaded_at=now(), external_copy_recorded=true
             FROM test_set_version v
             JOIN test_set ts ON ts.id = v.test_set_id
             WHERE dr.id=$1 AND dr.version_id=v.id AND ts.project_id=$2
               AND dr.status NOT IN ('user_confirmed_imported', 'deletion_pending', 'tombstoned')
               AND NOT EXISTS (
                 SELECT 1 FROM deletion_lock dl
                 WHERE dl.project_id=ts.project_id
                   AND ((dl.object_type='delivery_record' AND dl.object_id=dr.id)
                     OR (dl.object_type='test_set_version' AND dl.object_id=v.id)
                     OR (dl.object_type='test_set' AND dl.object_id=ts.id))
               )
             RETURNING dr.id
           )
           INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           SELECT $2, $3, 'delivery_downloaded', 'delivery_record', id,
                  jsonb_build_object('packageType', $4::text)
           FROM downloaded`,
          [
            delivery.rows[0].id,
            request.params.projectId,
            actor.id,
            delivery.rows[0].package_type,
          ],
        );
        if (!downloaded.rowCount) {
          const stillAllowed = await client.query(
            `SELECT dr.id
             FROM delivery_record dr
             JOIN test_set_version v ON v.id=dr.version_id
             JOIN test_set ts ON ts.id=v.test_set_id
             WHERE dr.id=$1 AND ts.project_id=$2
               AND dr.status='user_confirmed_imported'
               AND NOT EXISTS (
                 SELECT 1 FROM deletion_lock dl
                 WHERE dl.project_id=ts.project_id
                   AND ((dl.object_type='delivery_record' AND dl.object_id=dr.id)
                     OR (dl.object_type='test_set_version' AND dl.object_id=v.id)
                     OR (dl.object_type='test_set' AND dl.object_id=ts.id))
               )`,
            [delivery.rows[0].id, request.params.projectId],
          );
          if (!stillAllowed.rowCount) {
            packageStream.destroy();
            await client.query("ROLLBACK");
            return reply
              .code(404)
              .send({ error: { code: "delivery_not_found" } });
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const isCsv = delivery.rows[0].package_type === "langfuse_csv";
      reply.header(
        "content-type",
        isCsv ? "text/csv; charset=utf-8" : "application/zip",
      );
      reply.header(
        "content-disposition",
        `attachment; filename="agentbench-${delivery.rows[0].package_type}-${request.params.deliveryId}.${isCsv ? "csv" : "zip"}"`,
      );
      return reply.send(packageStream);
    },
  );

  app.post<{ Params: { projectId: string; deliveryId: string } }>(
    "/api/projects/:projectId/deliveries/:deliveryId/imported",
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const delivery = await client.query(
          `SELECT dr.id, dr.package_type, dr.status
           FROM delivery_record dr
           JOIN test_set_version v ON v.id=dr.version_id
           JOIN test_set ts ON ts.id=v.test_set_id
           JOIN project_member pm ON pm.project_id=ts.project_id AND pm.user_id=$3
           WHERE dr.id=$1 AND ts.project_id=$2
             AND v.status <> 'degraded_by_deletion'
             AND NOT EXISTS (
               SELECT 1 FROM deletion_lock dl
               WHERE dl.project_id = ts.project_id
                 AND dl.object_type = 'delivery_record' AND dl.object_id = dr.id
             )
             AND dr.package_type='langfuse_csv'
           FOR UPDATE OF dr`,
          [request.params.deliveryId, request.params.projectId, actor.id],
        );
        if (!delivery.rowCount) {
          await client.query("COMMIT");
          return reply.code(404).send({
            error: { code: "delivery_not_found" },
          });
        }
        if (delivery.rows[0].status !== "downloaded") {
          await client.query("COMMIT");
          return reply.code(409).send({
            error: { code: "delivery_not_downloaded" },
          });
        }
        const updated = await client.query(
          `UPDATE delivery_record
           SET status='user_confirmed_imported', confirmed_at=now(), confirmed_by=$2
           WHERE id=$1 RETURNING id,status,package_type`,
          [request.params.deliveryId, actor.id],
        );
        await client.query(
          `INSERT INTO audit_event
           (project_id,actor_id,action,object_type,object_id,details)
           VALUES ($1,$2,'delivery_import_attested','delivery_record',$3,$4)`,
          [
            request.params.projectId,
            actor.id,
            request.params.deliveryId,
            { remoteVerified: false },
          ],
        );
        await client.query("COMMIT");
        return {
          delivery: {
            id: updated.rows[0].id,
            status: updated.rows[0].status,
            packageType: updated.rows[0].package_type,
            remoteVerified: false,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  type DeletionRequestBody = {
    targetType?: DeletionTargetType;
    targetId?: string;
    previewId?: string;
    deletionEventId?: string;
    previewHash?: string;
    reasonCode?: string;
    reasonNote?: string;
  };

  async function deletionOwner(
    projectId: string,
    actorId: string,
  ): Promise<boolean> {
    const owner = await db.query(`SELECT owner_id FROM project WHERE id = $1`, [
      projectId,
    ]);
    return Boolean(
      owner.rowCount &&
      owner.rows[0].owner_id === actorId &&
      (await hasProjectCapability(db, projectId, actorId, "manage")),
    );
  }

  function deletionTargetFromRequest(
    body: DeletionRequestBody | undefined,
    assetId?: string,
  ): DeletionTarget | undefined {
    const targetType = assetId ? "data_asset" : body?.targetType;
    const targetId = assetId ?? body?.targetId;
    if (
      !["data_asset", "test_set_version", "test_set"].includes(
        targetType ?? "",
      ) ||
      typeof targetId !== "string" ||
      !targetId.trim()
    )
      return undefined;
    return { targetType: targetType as DeletionTargetType, targetId };
  }

  function deletionObjectList(
    closure: Awaited<ReturnType<typeof collectDeletionClosure>>,
  ) {
    return [
      ...(closure.target.type === "test_set"
        ? closure.testSets.map((item) => ({ type: "test_set", id: item.id }))
        : []),
      ...closure.assets.map((item) => ({ type: "data_asset", id: item.id })),
      ...closure.parsedViews.map((item) => ({
        type: "parsed_view",
        id: item.id,
      })),
      ...closure.sourceRecords.map((item) => ({
        type: "source_record",
        id: item.id,
      })),
      ...closure.draftSources.map((item) => ({
        type: "draft_source",
        id: item.id,
      })),
      ...closure.draftRevisions.map((item) => ({
        type: "draft_revision",
        id: item.id,
      })),
      ...closure.drafts.map((item) => ({ type: "working_draft", id: item.id })),
      ...closure.candidates.map((item) => ({
        type: "candidate_snapshot",
        id: item.id,
      })),
      ...closure.caseRevisions.map((item) => ({
        type: "case_revision",
        id: item.id,
      })),
      ...closure.versions.map((item) => ({
        type: "test_set_version",
        id: item.id,
      })),
      ...closure.transformationRuns.map((item) => ({
        type: "transformation_run",
        id: item.id,
      })),
      ...closure.deliveries.map((item) => ({
        type: "delivery_record",
        id: item.id,
      })),
      ...closure.sharedBlobs
        .filter((item) => item.deleteObject)
        .map((item) => ({
          type: "data_blob",
          // Uploads coordinate on the global content digest. Keep the
          // user-facing tombstone ID opaque, but use the digest for locking.
          id: item.sha256,
        })),
    ].filter(
      (item): item is { type: string; id: string } =>
        typeof item.id === "string",
    );
  }

  async function lockDeletionClosureRows(
    queryable: { query: (text: string, values?: unknown[]) => Promise<any> },
    projectId: string,
    closure: Awaited<ReturnType<typeof collectDeletionClosure>>,
  ) {
    const lock = async (sql: string, ids: string[]) => {
      if (ids.length) await queryable.query(sql, [ids, projectId]);
    };
    await lock(
      `SELECT da.id FROM data_asset da
       WHERE da.project_id = $2 AND da.id = ANY($1::text[])
       ORDER BY da.id FOR UPDATE`,
      closure.assets.map((item) => String(item.id)),
    );
    await lock(
      `SELECT pv.id FROM parsed_view pv
       JOIN data_asset da ON da.id = pv.asset_id
       WHERE da.project_id = $2 AND pv.id = ANY($1::text[])
       ORDER BY pv.id FOR UPDATE OF pv`,
      closure.parsedViews.map((item) => String(item.id)),
    );
    await lock(
      `SELECT ts.id FROM test_set ts
       WHERE ts.project_id = $2 AND ts.id = ANY($1::text[])
       ORDER BY ts.id FOR UPDATE`,
      closure.testSets.map((item) => String(item.id)),
    );
    await lock(
      `SELECT cs.id FROM candidate_snapshot cs
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND cs.id = ANY($1::text[])
       ORDER BY cs.id FOR UPDATE OF cs`,
      closure.candidates.map((item) => String(item.id)),
    );
    await lock(
      `SELECT wd.id FROM working_draft wd
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND wd.id = ANY($1::text[])
       ORDER BY wd.id FOR UPDATE`,
      closure.drafts.map((item) => String(item.id)),
    );
    await lock(
      `SELECT cr.id FROM case_revision cr
       JOIN test_case tc ON tc.id = cr.case_id
       JOIN test_set ts ON ts.id = tc.test_set_id
       WHERE ts.project_id = $2 AND cr.id = ANY($1::text[])
       ORDER BY cr.id FOR UPDATE OF cr`,
      closure.caseRevisions.map((item) => String(item.id)),
    );
    await lock(
      `SELECT v.id FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND v.id = ANY($1::text[])
       ORDER BY v.id FOR UPDATE OF v`,
      closure.versions.map((item) => String(item.id)),
    );
    await lock(
      `SELECT tr.id FROM transformation_run tr
       WHERE tr.project_id = $2 AND tr.id = ANY($1::text[])
       ORDER BY tr.id FOR UPDATE`,
      closure.transformationRuns.map((item) => String(item.id)),
    );
    await lock(
      `SELECT dr.id FROM delivery_record dr
       JOIN test_set_version v ON v.id = dr.version_id
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND dr.id = ANY($1::text[])
       ORDER BY dr.id FOR UPDATE OF dr`,
      closure.deliveries.map((item) => String(item.id)),
    );
    const draftIds = closure.drafts.map((item) => String(item.id));
    await lock(
      `SELECT ds.id FROM draft_source ds
       JOIN working_draft wd ON wd.id = ds.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND ds.draft_id = ANY($1::text[])
       ORDER BY ds.id FOR UPDATE OF ds`,
      draftIds,
    );
    const mappingIds = closure.drafts
      .map((item) => item.mappingRevisionId)
      .filter((id): id is string => typeof id === "string");
    await lock(
      `SELECT mr.id FROM mapping_revision mr
       JOIN working_draft wd ON wd.id = mr.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND mr.id = ANY($1::text[])
       ORDER BY mr.id FOR UPDATE OF mr`,
      mappingIds,
    );
    const schemaIds = [
      ...closure.drafts
        .map((item) => item.formalSchemaId)
        .filter((id): id is string => typeof id === "string"),
      ...closure.candidates
        .map((item) => item.schemaRevisionId)
        .filter((id): id is string => typeof id === "string"),
      ...closure.versions
        .map((item) => item.schemaRevisionId)
        .filter((id): id is string => typeof id === "string"),
    ];
    await lock(
      `SELECT fs.id FROM formal_schema_revision fs
       JOIN test_set ts ON ts.id = fs.test_set_id
       WHERE ts.project_id = $2 AND fs.id = ANY($1::text[])
       ORDER BY fs.id FOR UPDATE OF fs`,
      [...new Set(schemaIds)],
    );
    const allDraftRevisionIds = closure.draftRevisions
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string");
    await lock(
      `SELECT dr.id FROM draft_revision dr
       JOIN working_draft wd ON wd.id = dr.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND dr.id = ANY($1::text[])
       ORDER BY dr.id FOR UPDATE OF dr`,
      [...new Set(allDraftRevisionIds)],
    );
  }

  async function createDeletionPreview(
    request: FastifyRequest<{
      Params: { projectId: string; assetId?: string };
      Body: DeletionRequestBody;
    }>,
    reply: FastifyReply,
  ) {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    if (!(await deletionOwner(request.params.projectId, actor.id)))
      return reply
        .code(403)
        .send({ error: { code: "controlled_deletion_owner_required" } });
    const target = deletionTargetFromRequest(
      request.body,
      request.params.assetId,
    );
    if (!target)
      return reply
        .code(422)
        .send({ error: { code: "deletion_target_invalid" } });
    const eventId = opaqueId("deletion");
    const client = await db.connect();
    let closure: Awaited<ReturnType<typeof collectDeletionClosure>>;
    let hash: string;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      closure = await collectDeletionClosure(
        client,
        request.params.projectId,
        target,
      );
      hash = deletionPreviewHash(closure);
      const locked = await client.query(
        `SELECT 1 FROM deletion_lock
           WHERE project_id = $1 AND object_type = $2 AND object_id = $3
           LIMIT 1 FOR SHARE`,
        [request.params.projectId, target.targetType, target.targetId],
      );
      if (locked.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: { code: "deletion_already_confirmed" },
        });
      }
      await client.query(
        `INSERT INTO deletion_event
           (id, project_id, target_type, target_id, status, stage,
            preview_hash, closure, initiated_by)
           VALUES ($1,$2,$3,$4,'preview_ready','preview',$5,$6,$7)`,
        [
          eventId,
          request.params.projectId,
          target.targetType,
          target.targetId,
          hash,
          closure,
          actor.id,
        ],
      );
      await client.query(
        `INSERT INTO audit_event
           (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1,$2,'deletion_preview_created','deletion_event',$3,$4)`,
        [
          request.params.projectId,
          actor.id,
          eventId,
          {
            previewHash: hash,
            targetType: target.targetType,
            targetId: target.targetId,
            outcome: "preview_ready",
          },
        ],
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        deletion: {
          id: eventId,
          previewId: eventId,
          status: "preview_ready",
          target: closure.target,
          previewHash: hash,
          closure,
          reasonCodes: [...DELETION_REASON_CODES],
          governance: "nonproduction_governance_simulation",
          cancellable: true,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "deletion_target_not_found")
        return reply
          .code(404)
          .send({ error: { code: "deletion_target_not_found" } });
      throw error;
    } finally {
      client.release();
    }
  }

  app.post<{
    Params: { projectId: string };
    Body: DeletionRequestBody;
  }>(
    "/api/projects/:projectId/deletions/preview",
    { preHandler: authenticate },
    createDeletionPreview,
  );

  async function confirmDeletion(
    request: FastifyRequest<{
      Params: { projectId: string; eventId: string };
      Body: DeletionRequestBody;
    }>,
    reply: FastifyReply,
  ) {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    if (!(await deletionOwner(request.params.projectId, actor.id)))
      return reply
        .code(403)
        .send({ error: { code: "controlled_deletion_owner_required" } });
    const previewHash = request.body?.previewHash;
    const reasonCode = request.body?.reasonCode;
    const reasonNote = request.body?.reasonNote ?? "";
    if (
      typeof previewHash !== "string" ||
      !deletionReasonValid(reasonCode, reasonNote)
    )
      return reply
        .code(422)
        .send({ error: { code: "deletion_reason_invalid" } });

    const client = await db.connect();
    try {
      // READ COMMITTED lets the post-lock closure refresh observe a revision
      // that raced the initial preview read before confirmation.
      await client.query("BEGIN");
      // ponytail: serialize confirmations per project; deletion writes remain
      // row-locked and this keeps overlapping events fail-closed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agentbench:controlled-deletion-project:${request.params.projectId}`,
      ]);
      const event = await client.query(
        `SELECT de.* FROM deletion_event de
         JOIN project p ON p.id = de.project_id
         WHERE de.id = $1 AND de.project_id = $2
         FOR UPDATE`,
        [request.params.eventId, request.params.projectId],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(404)
          .send({ error: { code: "deletion_event_not_found" } });
      }
      if (event.rows[0].initiated_by !== actor.id) {
        await client.query("ROLLBACK");
        return reply
          .code(403)
          .send({ error: { code: "controlled_deletion_owner_required" } });
      }
      if (event.rows[0].status === "completed") {
        await client.query("COMMIT");
        return {
          deletion: {
            id: request.params.eventId,
            status: "completed",
            replayed: true,
          },
        };
      }
      if (event.rows[0].status !== "preview_ready") {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "deletion_not_confirmable" } });
      }
      let closure = await collectDeletionClosure(
        client,
        request.params.projectId,
        {
          targetType: event.rows[0].target_type,
          targetId: event.rows[0].target_id,
        },
      );
      let stableClosure = false;
      for (let pass = 0; pass < 4; pass += 1) {
        await lockDeletionClosureRows(
          client,
          request.params.projectId,
          closure,
        );
        for (const blob of closure.sharedBlobs) {
          if (typeof blob.sha256 === "string")
            await lockDeletionBlob(client, blob.sha256);
        }
        // Rebuild after locks so newly discovered references are locked on the
        // next pass before the preview hash is accepted.
        const refreshed = await collectDeletionClosure(
          client,
          request.params.projectId,
          {
            targetType: event.rows[0].target_type,
            targetId: event.rows[0].target_id,
          },
        );
        if (deletionPreviewHash(refreshed) === deletionPreviewHash(closure)) {
          closure = refreshed;
          stableClosure = true;
          break;
        }
        closure = refreshed;
      }
      if (!stableClosure) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: {
            code: "deletion_preview_stale",
            retry: "Create a new impact preview before confirming deletion.",
          },
        });
      }
      const currentHash = deletionPreviewHash(closure);
      if (
        currentHash !== event.rows[0].preview_hash ||
        currentHash !== previewHash
      ) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: {
            code: "deletion_preview_stale",
            retry: "Create a new impact preview before confirming deletion.",
          },
        });
      }
      const objectList = deletionObjectList(closure).sort((left, right) =>
        `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
      );
      for (const object of objectList) {
        await client.query(
          `INSERT INTO deletion_lock (event_id, project_id, object_type, object_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [
            request.params.eventId,
            request.params.projectId,
            object.type,
            object.id,
          ],
        );
      }
      const conflictValues = objectList
        .map((_, index) => `($${index * 2 + 3}, $${index * 2 + 4})`)
        .join(", ");
      const conflictParams = objectList.flatMap((object) => [
        object.type,
        object.id,
      ]);
      const conflicting = conflictValues
        ? await client.query(
            `SELECT event_id, object_type, object_id FROM deletion_lock
             WHERE project_id = $1 AND event_id <> $2
               AND (object_type, object_id) IN (VALUES ${conflictValues})
             LIMIT 1`,
            [
              request.params.projectId,
              request.params.eventId,
              ...conflictParams,
            ],
          )
        : { rowCount: 0 };
      if (conflicting.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "deletion_already_confirmed" } });
      }
      const assetIds = closure.assets.map((item) => item.id as string);
      const viewIds = closure.parsedViews.map((item) => item.id as string);
      const candidateIds = closure.candidates.map((item) => item.id as string);
      const deliveryIds = closure.deliveries.map((item) => item.id as string);
      const versionIds = closure.versions.map((item) => item.id as string);
      if (assetIds.length)
        await client.query(
          `UPDATE data_asset SET status = 'deletion_pending'
           WHERE project_id = $1 AND id = ANY($2::text[])`,
          [request.params.projectId, assetIds],
        );
      if (assetIds.length)
        await client.query(
          `DELETE FROM version_export_cache c USING test_set_version v,test_set ts
            WHERE c.version_id=v.id AND v.test_set_id=ts.id AND ts.project_id=$1`,
          [request.params.projectId],
        );
      if (viewIds.length)
        await client.query(
          `UPDATE parsed_view pv
           SET status = 'deletion_pending', draft_eligible = false
           WHERE pv.id = ANY($1::text[])
             AND EXISTS (
               SELECT 1 FROM data_asset da
               WHERE da.id = pv.asset_id AND da.project_id = $2
             )`,
          [viewIds, request.params.projectId],
        );
      if (candidateIds.length)
        await client.query(
          `UPDATE candidate_snapshot cs
           SET status = 'deletion_pending'
           WHERE cs.id = ANY($1::text[])
             AND EXISTS (
               SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
               WHERE wd.id = cs.draft_id AND ts.project_id = $2
             )`,
          [candidateIds, request.params.projectId],
        );
      if (deliveryIds.length)
        await client.query(
          `UPDATE delivery_record dr
           SET status = 'deletion_pending', deletion_event_id = $2
           WHERE dr.id = ANY($1::text[])
             AND EXISTS (
               SELECT 1 FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
               WHERE v.id = dr.version_id AND ts.project_id = $3
             )`,
          [deliveryIds, request.params.eventId, request.params.projectId],
        );
      if (versionIds.length)
        await client.query(
          `UPDATE test_set ts SET default_version_id = NULL
           WHERE ts.project_id = $1 AND ts.default_version_id = ANY($2::text[])`,
          [request.params.projectId, versionIds],
        );
      const jobId = opaqueId("job");
      const idempotencyKey = `deletion:${request.params.eventId}:${event.rows[0].preview_hash}`;
      await client.query(
        `INSERT INTO job
         (id, project_id, actor_id, kind, payload, status, correlation_id,
          idempotency_key, max_attempts, next_run_at)
         VALUES ($1,$2,$3,'controlled_deletion',$4,'queued',$1,$5,$6,
                 now() + ($7::bigint * interval '1 millisecond'))
         ON CONFLICT (project_id, kind, idempotency_key) DO NOTHING`,
        [
          jobId,
          request.params.projectId,
          actor.id,
          {
            eventId: request.params.eventId,
            previewHash: event.rows[0].preview_hash,
          },
          idempotencyKey,
          config.jobMaxAttempts,
          config.jobClaimDelayMs,
        ],
      );
      const job = await client.query(
        `SELECT id, status FROM job
         WHERE project_id = $1 AND kind = 'controlled_deletion' AND idempotency_key = $2
         FOR UPDATE`,
        [request.params.projectId, idempotencyKey],
      );
      await client.query(
        `UPDATE deletion_event SET status = 'confirmed', stage = 'fail_closed_lock',
          preview_hash = $2, closure = $3, reason_code = $4, reason_note = $5,
         external_copy_dispositions = $6::jsonb,
          confirmed_by = $7, confirmed_at = now(), failure_code = NULL,
          failure_message = NULL
         WHERE id = $1 AND project_id = $8`,
        [
          request.params.eventId,
          currentHash,
          closure,
          reasonCode,
          reasonNote,
          JSON.stringify(closure.externalCopies ?? []),
          actor.id,
          request.params.projectId,
        ],
      );
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1,$2,'deletion_confirmed','deletion_event',$3,$4)`,
        [
          request.params.projectId,
          actor.id,
          request.params.eventId,
          {
            previewHash: currentHash,
            reasonCode,
            reasonNote,
            outcome: "confirmed",
            sameOwner: true,
            cancellable: false,
          },
        ],
      );
      await client.query("COMMIT");
      return reply.code(202).send({
        deletion: {
          id: request.params.eventId,
          status: "confirmed",
          previewHash: currentHash,
          cancellable: false,
          governance: "nonproduction_governance_simulation",
        },
        job: { id: job.rows[0].id, status: job.rows[0].status },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  app.post<{
    Params: { projectId: string; eventId: string };
    Body: DeletionRequestBody;
  }>(
    "/api/projects/:projectId/deletions/:eventId/confirm",
    { preHandler: authenticate },
    confirmDeletion,
  );

  async function deletionOutcome(
    request: FastifyRequest<{ Params: { projectId: string; eventId: string } }>,
    reply: FastifyReply,
  ) {
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
        .send({ error: { code: "deletion_event_not_found" } });
    const event = await db.query(
      `SELECT id, project_id, target_type, target_id, status, stage,
              preview_hash, closure, reason_code, reason_note,
              initiated_by, confirmed_by, initiated_at, confirmed_at,
              completed_at, failed_at, failure_code,
              external_copy_dispositions
       FROM deletion_event WHERE id = $1 AND project_id = $2`,
      [request.params.eventId, request.params.projectId],
    );
    if (!event.rowCount)
      return reply
        .code(404)
        .send({ error: { code: "deletion_event_not_found" } });
    const tombstones = await db.query(
      `SELECT dt.event_id, dt.object_type, dt.opaque_object_id, dt.prior_hash,
              dt.affected_version_ids, dt.actor_id, dt.reason_code, dt.reason_note,
              dt.initiated_at, dt.confirmed_at, dt.completed_at, dt.result_status
       FROM deletion_tombstone dt
       JOIN deletion_event de ON de.id = dt.event_id AND de.project_id = $2
       WHERE dt.event_id = $1
       ORDER BY dt.object_type, dt.opaque_object_id`,
      [request.params.eventId, request.params.projectId],
    );
    const job = await db.query(
      `SELECT id, status, stage, progress, attempt, error_code, result
       FROM job WHERE project_id = $1 AND kind = 'controlled_deletion'
         AND payload ->> 'eventId' = $2 ORDER BY created_at DESC LIMIT 1`,
      [request.params.projectId, request.params.eventId],
    );
    const row = event.rows[0];
    const testSetIds = Array.isArray(row.closure?.testSets)
      ? row.closure.testSets
          .map((item: { id?: unknown }) => item.id)
          .filter((id: unknown): id is string => typeof id === "string")
      : [];
    const currentTestSets = testSetIds.length
      ? await db.query(
          `SELECT id, status, default_version_id
           FROM test_set WHERE project_id = $1 AND id = ANY($2::text[])`,
          [request.params.projectId, testSetIds],
        )
      : { rows: [] };
    return {
      deletion: {
        id: row.id,
        status: row.status,
        stage: row.stage,
        target: { type: row.target_type, id: row.target_id },
        previewHash: row.preview_hash,
        closure: row.closure,
        reasonCode: row.reason_code,
        reasonNote: row.reason_note,
        initiatedBy: row.initiated_by,
        confirmedBy: row.confirmed_by,
        initiatedAt: row.initiated_at,
        confirmedAt: row.confirmed_at,
        completedAt: row.completed_at,
        failedAt: row.failed_at,
        failureCode: row.failure_code,
        cancellable: row.status === "preview_ready",
        governance: "nonproduction_governance_simulation",
        externalCopies:
          row.external_copy_dispositions ?? row.closure?.externalCopies ?? [],
        testSets: currentTestSets.rows.map((testSet) => ({
          id: testSet.id,
          availability: testSet.status,
          defaultVersionId: testSet.default_version_id,
        })),
        tombstones: tombstones.rows.map((item) => ({
          deletionEventId: item.event_id,
          objectType: item.object_type,
          opaqueObjectId: item.opaque_object_id,
          priorHash: item.prior_hash,
          affectedVersionIds: item.affected_version_ids,
          actorId: item.actor_id,
          reasonCode: item.reason_code,
          reasonNote: item.reason_note,
          initiatedAt: item.initiated_at,
          confirmedAt: item.confirmed_at,
          completedAt: item.completed_at,
          resultStatus: item.result_status,
        })),
      },
      job: job.rowCount
        ? {
            id: job.rows[0].id,
            status: job.rows[0].status,
            stage: job.rows[0].stage,
            progress: Number(job.rows[0].progress),
            attempt: Number(job.rows[0].attempt),
            errorCode: job.rows[0].error_code,
            result: job.rows[0].result,
          }
        : null,
    };
  }

  app.get<{ Params: { projectId: string; eventId: string } }>(
    "/api/projects/:projectId/deletions/:eventId/outcome",
    { preHandler: authenticate },
    deletionOutcome,
  );

  async function retryDeletion(
    request: FastifyRequest<{ Params: { projectId: string; eventId: string } }>,
    reply: FastifyReply,
  ) {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    if (!(await deletionOwner(request.params.projectId, actor.id)))
      return reply
        .code(403)
        .send({ error: { code: "controlled_deletion_owner_required" } });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query(
        `SELECT id, status, initiated_by FROM deletion_event
         WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [request.params.eventId, request.params.projectId],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(404)
          .send({ error: { code: "deletion_event_not_found" } });
      }
      if (event.rows[0].initiated_by !== actor.id) {
        await client.query("ROLLBACK");
        return reply
          .code(403)
          .send({ error: { code: "controlled_deletion_owner_required" } });
      }
      if (event.rows[0].status !== "failed") {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "deletion_not_retryable" } });
      }
      const job = await client.query(
        `SELECT id FROM job WHERE project_id = $1 AND kind = 'controlled_deletion'
         AND payload ->> 'eventId' = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [request.params.projectId, request.params.eventId],
      );
      if (!job.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "deletion_job_missing" } });
      }
      await client.query(
        `UPDATE job SET status = 'queued', stage = 'queued', progress = 0,
          attempt = 0, error_code = NULL, retryable = NULL, result = NULL,
          lease_owner = NULL, lease_expires_at = NULL, next_run_at = now(), updated_at = now()
         WHERE id = $1`,
        [job.rows[0].id],
      );
      await client.query(
        `UPDATE deletion_event SET status = 'confirmed', stage = 'retry_queued',
          failure_code = NULL, failure_message = NULL
         WHERE id = $1 AND project_id = $2`,
        [request.params.eventId, request.params.projectId],
      );
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1,$2,'deletion_retry_requested','deletion_event',$3,$4)`,
        [
          request.params.projectId,
          actor.id,
          request.params.eventId,
          { outcome: "requested" },
        ],
      );
      await client.query("COMMIT");
      return reply.code(202).send({
        deletion: {
          id: request.params.eventId,
          status: "confirmed",
          cancellable: false,
        },
        job: { id: job.rows[0].id, status: "queued" },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  app.post<{ Params: { projectId: string; eventId: string } }>(
    "/api/projects/:projectId/deletions/:eventId/retry",
    { preHandler: authenticate },
    retryDeletion,
  );

  return app;
}
