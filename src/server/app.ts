import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { PoolClient } from "pg";

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
import { createPool, type Database } from "../db/pool.js";
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
import { parseSourceRecords } from "../parser/index.js";
import {
  evaluateRecipe,
  recipeSteps,
  type RecipeStep,
  validateRecipe,
} from "../recipe/index.js";
import { hashPassword, verifyPassword } from "../security/password.js";
import {
  capabilitiesForRole,
  hasProjectCapability,
  isTestIdentityRole,
  type ProjectCapabilities,
} from "../security/project-access.js";
import {
  assertFormalSchema,
  compareFormalSchemaBundles,
  isValidCaseMetadata,
  validateFormalItems,
} from "../schema/formal.js";
import { ArtifactRepository } from "../storage/artifacts.js";
import { createCheckpoint } from "../version/checkpoint.js";
import {
  encodeDeltaManifest,
  publishSparseVersion,
  type SparseOperation,
} from "../version/publish-sparse.js";
import {
  snapshotPayloadHash,
  storedRecord,
} from "../version/snapshot-record.js";
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

export type AgentBenchApp = FastifyInstance;

export interface AppDependencies {
  now?: () => Date;
  artifacts?: ArtifactRepository;
  disableLegacyTestBootstrap?: boolean;
}

interface AuthenticatedRequest extends FastifyRequest {
  actor: SessionActor;
}

interface SessionActor {
  id: string;
  username: string;
  role: string;
  projectRole: string | null;
  capabilities: ProjectCapabilities;
  testIdentity: boolean;
  csrfToken: string;
}

function sessionActor(
  user: {
    id: string;
    username: string;
    role: string;
    project_role?: string | null;
  },
  csrfToken: string,
): SessionActor {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    projectRole: user.project_role ?? null,
    capabilities: capabilitiesForRole(
      user.role === "admin" ? "owner" : user.project_role,
    ),
    testIdentity: isTestIdentityRole(user.role),
    csrfToken,
  };
}

function publicSessionActor(actor: SessionActor) {
  return {
    id: actor.id,
    username: actor.username,
    role: actor.role,
    projectRole: actor.projectRole,
    capabilities: actor.capabilities,
    testIdentity: actor.testIdentity,
  };
}

function requestIdentifiers(request: FastifyRequest) {
  const params = (request.params ?? {}) as Record<string, unknown>;
  return {
    job_id: typeof params.jobId === "string" ? params.jobId : null,
    project_id: typeof params.projectId === "string" ? params.projectId : null,
    object_id:
      Object.entries(params).find(
        ([key, value]) =>
          key !== "projectId" && key !== "jobId" && typeof value === "string",
      )?.[1] ?? null,
  };
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

async function resetCancelledGenerationJob(
  client: PoolClient,
  input: {
    projectId: string;
    versionId: string;
    packageType: string;
    formatVersion: string;
    kind: string;
    idempotencyKey: string;
  },
): Promise<void> {
  const job = await client.query(
    `SELECT id, status FROM job
     WHERE project_id = $1 AND kind = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [input.projectId, input.kind, input.idempotencyKey],
  );
  if (!job.rowCount || job.rows[0].status !== "cancelled") return;
  const delivery = await client.query(
    `SELECT 1 FROM delivery_record
     WHERE project_id = $1 AND version_id = $2
       AND package_type = $3 AND package_format_version = $4`,
    [input.projectId, input.versionId, input.packageType, input.formatVersion],
  );
  if (delivery.rowCount) return;
  await client.query(
    `UPDATE job
     SET status = 'queued', stage = 'queued', progress = 0, attempt = 0,
         error_code = NULL, retryable = NULL, result = NULL,
         counts = '{}'::jsonb, lease_owner = NULL, lease_expires_at = NULL,
         next_run_at = now(), updated_at = now()
     WHERE id = $1`,
    [job.rows[0].id],
  );
}

function selectedSourceRows(
  rows: Array<{
    ordinal: number;
    locator: unknown;
    value: unknown;
    record_hash?: string;
  }>,
  parsedViewId: string,
  recipe: unknown,
) {
  const steps = recipeSteps(recipe);
  const selected = new Set(
    evaluateRecipe(
      rows.map((row) => ({
        id: `${parsedViewId}:${row.ordinal}`,
        ordinal: Number(row.ordinal),
        fields: row.value,
        sampleKey: row.record_hash,
      })),
      steps,
    ).records.map((record) => record.ordinal),
  );
  return rows.filter((row) => selected.has(Number(row.ordinal)));
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function bootstrapOwner(db: Database, config: Config): Promise<void> {
  const passwordHash = await hashPassword(config.ownerPassword);
  await db.query(
    `INSERT INTO app_user (id, username, password_hash, role)
     VALUES ('user_owner', 'owner', $1, 'owner')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [passwordHash],
  );
  await db.query(
    `INSERT INTO project (id, name, owner_id) VALUES ('project_demo', 'Ticket 01 Demo', 'user_owner')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO project_member (project_id, user_id, role)
     VALUES ('project_demo', 'user_owner', 'owner') ON CONFLICT DO NOTHING`,
  );
  await ensureUnfiledCollection(db, "project_demo");
  if (!config.allowTestIdentity) return;
  const editorHash = await hashPassword(config.editorPassword);
  const viewerHash = await hashPassword(config.viewerPassword);
  await db.query(
    `INSERT INTO app_user (id, username, password_hash, role)
     VALUES ('user_editor', 'editor', $1, 'editor'),
            ('user_viewer', 'viewer', $2, 'viewer')
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [editorHash, viewerHash],
  );
  await db.query(
    `INSERT INTO project_member (project_id, user_id, role)
     SELECT 'project_demo', seed.user_id, seed.role
     FROM (VALUES ('user_editor', 'editor'), ('user_viewer', 'viewer')) AS seed(user_id, role)
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_event
       WHERE project_id = 'project_demo'
         AND action = 'project_membership_changed'
         AND object_id = seed.user_id
         AND details->>'action' = 'removed'
     )
     ON CONFLICT (project_id, user_id) DO NOTHING`,
  );
}

async function ensureUnfiledCollection(
  db: Database,
  projectId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO raw_material_collection
       (id, project_id, name, description, is_unfiled)
     VALUES ($1, $2, '未整理', '暂时不归入资料集合的文件。', true)
     ON CONFLICT (project_id, name) DO NOTHING`,
    [opaqueId("collection"), projectId],
  );
}

function assetResponse(row: Record<string, unknown>, username: string) {
  return {
    id: row.id,
    fileName: row.file_name,
    size: Number(row.size_bytes),
    mimeType: row.mime_type,
    format: row.format,
    sha256: row.blob_sha256,
    uploadedBy: username,
    uploadedAt: new Date(row.uploaded_at as string).toISOString(),
    status: row.status,
  };
}

function collectionResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isUnfiled: Boolean(row.is_unfiled),
    fileCount: Number(row.file_count ?? 0),
    unifiedRecordCount: Number(row.unified_record_count ?? 0),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function projectResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    datasetCount: Number(row.dataset_count ?? 0),
    testSetCount: Number(row.test_set_count ?? 0),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function transformationRunResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    status: row.status,
    operationType: row.operation_type,
    lineageLevel: row.lineage_level,
    manifest: row.manifest,
    manifestHash: row.manifest_hash,
    validationReport: row.validation_report,
    annotations: row.annotations ?? [],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function attributionResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    responsiblePerson: row.responsible_person,
    purpose: row.purpose,
    licenseStatus: row.license_status,
    sensitivity: row.sensitivity,
    sourceAddress: row.source_address,
    acquiredAt: row.acquired_at
      ? new Date(row.acquired_at as string).toISOString()
      : null,
    deidentificationConfirmed: row.deidentification_confirmed,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function attributionInput(value: unknown): SourceAttributionInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  return {
    sourceType:
      typeof input.sourceType === "string" ? input.sourceType.trim() : "",
    sourceName:
      typeof input.sourceName === "string" ? input.sourceName.trim() : "",
    responsiblePerson:
      typeof input.responsiblePerson === "string"
        ? input.responsiblePerson.trim()
        : "",
    purpose: typeof input.purpose === "string" ? input.purpose.trim() : "",
    licenseStatus:
      typeof input.licenseStatus === "string" ? input.licenseStatus.trim() : "",
    sensitivity:
      typeof input.sensitivity === "string" ? input.sensitivity.trim() : "",
    sourceAddress:
      typeof input.sourceAddress === "string" && input.sourceAddress.trim()
        ? input.sourceAddress.trim()
        : null,
    acquiredAt:
      typeof input.acquiredAt === "string" && input.acquiredAt.trim()
        ? input.acquiredAt.trim()
        : null,
    deidentificationConfirmed: input.deidentificationConfirmed === true,
  };
}

function parsedViewNotDraftEligibleError(
  parsedViewId: string,
  parsedView: Record<string, any>,
) {
  const blockingError = parsedView.error_summary?.errors?.find(
    (error: { code?: string }) => error.code === "source_record_limit_exceeded",
  );
  return {
    code: "parsed_view_not_draft_eligible",
    object: { type: "parsed_view", id: parsedViewId },
    reason:
      blockingError?.reason ??
      parsedView.error_summary?.errors?.[0]?.reason ??
      "Located parse failures must be explicitly excluded.",
    actualRecords: blockingError?.actualRecords ?? parsedView.record_count,
    limitRecords:
      blockingError?.limitRecords ?? CAPACITY_LIMITS.parsedViewRecords,
    retry:
      blockingError?.retry ??
      "Correct parser configuration or exclude every located failure.",
    blockingPhase: "parsed_view",
  };
}

function attributionFromRow(row: Record<string, any>) {
  return attributionInput({
    sourceType: row.source_type,
    sourceName: row.source_name,
    responsiblePerson: row.responsible_person,
    purpose: row.purpose,
    licenseStatus: row.license_status,
    sensitivity: row.sensitivity,
    sourceAddress: row.source_address,
    acquiredAt: row.acquired_at
      ? new Date(row.acquired_at).toISOString()
      : null,
    deidentificationConfirmed: row.deidentification_confirmed,
  });
}

async function verifiedPromptReference(
  queryable: { query: (...args: any[]) => Promise<any> },
  projectId: string,
  reference: Record<string, unknown>,
): Promise<boolean> {
  const promptAsset = await queryable.query(
    `SELECT da.blob_sha256,
                sar.source_type, sar.source_name, sar.responsible_actor,
                sar.responsible_person, sar.purpose, sar.license_status,
                sar.sensitivity, sar.source_address, sar.acquired_at,
                sar.deidentification_confirmed
         FROM data_asset da
         JOIN LATERAL (
           SELECT * FROM source_attribution_revision
           WHERE asset_id = da.id ORDER BY created_at DESC, id DESC LIMIT 1
         ) sar ON true
         WHERE da.id = $1 AND da.project_id = $2`,
    [reference.assetId, projectId],
  );
  return (
    !!promptAsset.rowCount &&
    promptAsset.rows[0].blob_sha256 === reference.sha256 &&
    isAllowedSourceAttribution(attributionFromRow(promptAsset.rows[0])!)
  );
}

function sourceSnapshotFromRow(row: Record<string, any>) {
  return {
    draftSourceId: row.draft_source_id,
    assetId: row.asset_id,
    parsedViewId: row.parsed_view_id,
    position: Number(row.position),
    mapping: row.mapping,
    unmappedFields: row.unmapped_fields ?? [],
    unmappedConfirmed: Boolean(row.unmapped_confirmed),
    parserName: row.parser_name,
    parserVersion: row.parser_version,
    recordCount: Number(row.record_count ?? 0),
    attribution: {
      id: row.attribution_id,
      sourceType: row.source_type,
      sourceName: row.source_name,
      responsibleActor: row.responsible_actor,
      responsiblePerson: row.responsible_person,
      purpose: row.purpose,
      licenseStatus: row.license_status,
      sensitivity: row.sensitivity,
      sourceAddress: row.source_address ?? null,
      acquiredAt: row.acquired_at
        ? new Date(row.acquired_at).toISOString()
        : null,
      deidentificationConfirmed: Boolean(row.deidentification_confirmed),
    },
  };
}

function isAllowedSourceSnapshot(source: Record<string, any>): boolean {
  const attribution = source.attribution ?? source;
  return isAllowedSourceAttribution({
    sourceType: attribution.sourceType ?? attribution.source_type,
    sourceName: attribution.sourceName ?? attribution.source_name,
    responsiblePerson:
      attribution.responsiblePerson ?? attribution.responsible_person,
    purpose: attribution.purpose,
    licenseStatus: attribution.licenseStatus ?? attribution.license_status,
    sensitivity: attribution.sensitivity,
    sourceAddress:
      attribution.sourceAddress ?? attribution.source_address ?? null,
    acquiredAt: attribution.acquiredAt ?? attribution.acquired_at ?? null,
    deidentificationConfirmed:
      attribution.deidentificationConfirmed ??
      attribution.deidentification_confirmed ??
      false,
  });
}

type AssetFormat = "csv" | "json" | "jsonl";
type DisplayMapping = {
  question?: string;
  expectedOutput?: string;
  metadata: string[];
};
const CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE = {
  sourceType: "owner_confirmed_nonproduction",
  sourceName: "Owner-confirmed permitted non-production environment",
  purpose: "confirmed upload",
  licenseStatus: "environment_confirmed",
  sensitivity: "non_sensitive",
} as const;
const PARSER_VERSION = "parser-contract-v1";
const MATERIALIZER_VERSION = "candidate-v1";

function assetFormat(fileName: unknown): AssetFormat | undefined {
  const extension = String(fileName ?? "")
    .toLowerCase()
    .match(/\.([^.]+)$/u)?.[1];
  return extension === "csv" || extension === "json" || extension === "jsonl"
    ? extension
    : undefined;
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function defaultParserConfig(format: AssetFormat): Record<string, unknown> {
  if (format === "csv") {
    return { encoding: "auto", delimiter: ",", headerRow: 1, quote: '"' };
  }
  if (format === "json") return { recordPath: "" };
  return {};
}

function normalizeDisplayMapping(
  value: unknown,
  requireDistinctMetadataKeys = false,
): DisplayMapping | undefined {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some(
      (key) => !["question", "expectedOutput", "metadata"].includes(key),
    )
  )
    return undefined;
  const question = value.question;
  const expectedOutput = value.expectedOutput;
  const metadata = value.metadata ?? [];
  if (
    (question !== undefined && typeof question !== "string") ||
    (expectedOutput !== undefined && typeof expectedOutput !== "string") ||
    !Array.isArray(metadata) ||
    metadata.some((path) => typeof path !== "string") ||
    new Set([question, expectedOutput].filter(Boolean)).size !==
      [question, expectedOutput].filter(Boolean).length
  )
    return undefined;
  const normalizedMetadata = [
    ...new Set(metadata.filter(Boolean).map(canonicalSourcePath)),
  ];
  if (
    requireDistinctMetadataKeys &&
    new Set(
      normalizedMetadata.map((path) => displayFieldName(path).toLowerCase()),
    ).size !== normalizedMetadata.length
  )
    return undefined;
  return {
    ...(question ? { question: canonicalSourcePath(question) } : {}),
    ...(expectedOutput
      ? { expectedOutput: canonicalSourcePath(expectedOutput) }
      : {}),
    metadata: normalizedMetadata,
  };
}

function displayText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

type MetadataEntry = { key: string; value: string };

function normalizeMetadataEntries(value: unknown): MetadataEntry[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !isPlainObject(entry) ||
        Object.keys(entry).some((key) => key !== "key" && key !== "value") ||
        typeof entry.key !== "string" ||
        typeof entry.value !== "string" ||
        !entry.key.trim(),
    )
  )
    return undefined;
  const entries = value.map((entry) => {
    const object = entry as Record<string, string>;
    return { key: object.key.trim(), value: object.value };
  });
  return new Set(entries.map((entry) => entry.key.toLocaleLowerCase())).size ===
    entries.length
    ? entries
    : undefined;
}

function readMetadataEntries(value: unknown): MetadataEntry[] {
  if (isPlainObject(value) && Array.isArray(value.entries))
    return normalizeMetadataEntries(value.entries) ?? [];
  if (isPlainObject(value) && typeof value.text === "string")
    return [{ key: "Metadata", value: value.text }];
  if (typeof value === "string") return [{ key: "Metadata", value }];
  return value === null || value === undefined
    ? []
    : [{ key: "Metadata", value: displayText(value) }];
}

function metadataText(entries: MetadataEntry[]): string {
  return entries.map((entry) => `${entry.key}：${entry.value}`).join("\n");
}

function displayFieldName(path: string): string {
  const segment = path.split("/").at(-1) ?? path;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function mappedDisplayValue(fields: unknown, path: string | undefined): string {
  if (!path) return "";
  const result = sourceValueAt(fields, path);
  return result.found ? displayText(result.value) : "";
}

function mapMaterialRecord(fields: unknown, mapping: DisplayMapping) {
  return {
    question: mappedDisplayValue(fields, mapping.question),
    expectedOutput: mappedDisplayValue(fields, mapping.expectedOutput),
    metadata: mapping.metadata.map(
      (path): MetadataEntry => ({
        key: displayFieldName(path),
        value: mappedDisplayValue(fields, path),
      }),
    ),
  };
}

function utf8Prefix(bytes: Buffer, maximumBytes: number): string {
  let end = Math.min(bytes.byteLength, maximumBytes);
  let continuationBytes = 0;
  while (
    continuationBytes < 3 &&
    end - continuationBytes - 1 >= 0 &&
    (bytes[end - continuationBytes - 1] & 0b1100_0000) === 0b1000_0000
  ) {
    continuationBytes += 1;
  }
  const leadingByte = bytes[end - continuationBytes - 1];
  const sequenceLength =
    leadingByte === undefined || leadingByte < 0b1000_0000
      ? 1
      : (leadingByte & 0b1110_0000) === 0b1100_0000
        ? 2
        : (leadingByte & 0b1111_0000) === 0b1110_0000
          ? 3
          : (leadingByte & 0b1111_1000) === 0b1111_0000
            ? 4
            : 1;
  if (sequenceLength > continuationBytes + 1) end -= continuationBytes + 1;
  return bytes.subarray(0, end).toString("utf8");
}

function normalizeParserConfig(
  format: AssetFormat,
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const config = value as Record<string, unknown>;
  if (format === "csv") {
    const allowed = ["delimiter", "encoding", "headerRow", "quote"];
    if (Object.keys(config).some((key) => !allowed.includes(key)))
      return undefined;
    if (
      !["auto", "utf8", "gb18030", "gbk"].includes(String(config.encoding)) ||
      typeof config.delimiter !== "string" ||
      config.delimiter.length !== 1 ||
      typeof config.quote !== "string" ||
      config.quote.length !== 1 ||
      config.quote === config.delimiter ||
      !Number.isInteger(config.headerRow) ||
      Number(config.headerRow) < 1
    ) {
      return undefined;
    }
    return {
      encoding: config.encoding,
      delimiter: config.delimiter,
      headerRow: config.headerRow,
      quote: config.quote,
    };
  }
  if (format === "json") {
    if (
      Object.keys(config).some((key) => key !== "recordPath") ||
      typeof config.recordPath !== "string" ||
      (config.recordPath !== "" &&
        (!config.recordPath.startsWith("/") ||
          /(?:~[^01]|\*)/u.test(config.recordPath)))
    ) {
      return undefined;
    }
    return { recordPath: config.recordPath };
  }
  return Object.keys(config).length === 0 ? {} : undefined;
}

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
  const db = createPool(config.databaseUrl);
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
  app.addHook("onClose", async () => db.end());
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
      .send(renderMetrics(await metricSnapshot(db, health)));
  });

  app.get("/api/installation", async () => {
    const state = await db.query(
      `SELECT EXISTS(SELECT 1 FROM installation_state) AS initialized,
              EXISTS(SELECT 1 FROM app_user) AS has_users`,
    );
    const row = state.rows[0];
    return {
      needsAdministrator: !row.initialized && !row.has_users,
      ...(row.has_users && !row.initialized ? { needsMigration: true } : {}),
    };
  });

  app.post<{ Body: unknown }>(
    "/api/installation/administrator",
    async (request, reply) => {
      if (request.headers.origin !== config.appOrigin)
        return reply.code(403).send({ error: { code: "origin_rejected" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (key) =>
            !["email", "displayName", "password", "confirmPassword"].includes(
              key,
            ),
        ) ||
        typeof body.email !== "string" ||
        typeof body.displayName !== "string" ||
        typeof body.password !== "string" ||
        typeof body.confirmPassword !== "string" ||
        body.password !== body.confirmPassword ||
        body.password.length < 8 ||
        body.displayName.trim().length < 1 ||
        body.displayName.trim().length > 30
      )
        return reply
          .code(422)
          .send({ error: { code: "account_payload_invalid" } });
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
        return reply
          .code(422)
          .send({ error: { code: "account_payload_invalid" } });
      const passwordHash = await hashPassword(body.password);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(91827463)");
        const prior = await client.query(
          `SELECT EXISTS(SELECT 1 FROM installation_state) AS initialized,
                  EXISTS(SELECT 1 FROM app_user) AS has_users`,
        );
        if (prior.rows[0].initialized || prior.rows[0].has_users) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "installation_already_initialized" } });
        }
        const id = opaqueId("user");
        await client.query(
          `INSERT INTO app_user (id, username, email, display_name, password_hash, role)
           VALUES ($1, $2, $2, $3, $4, 'admin')`,
          [id, email, body.displayName.trim(), passwordHash],
        );
        await client.query("INSERT INTO installation_state (id) VALUES (true)");
        await client.query("COMMIT");
        return reply.code(201).send({ administrator: { id, email } });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Body: unknown }>("/api/accounts", async (request, reply) => {
    if (request.headers.origin !== config.appOrigin)
      return reply.code(403).send({ error: { code: "origin_rejected" } });
    const body = request.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some(
        (key) => !["email", "password", "confirmPassword"].includes(key),
      ) ||
      typeof body.email !== "string" ||
      typeof body.password !== "string" ||
      typeof body.confirmPassword !== "string" ||
      body.password.length < 8 ||
      body.password !== body.confirmPassword
    )
      return reply
        .code(422)
        .send({ error: { code: "account_payload_invalid" } });
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
      return reply
        .code(422)
        .send({ error: { code: "account_payload_invalid" } });
    const passwordHash = await hashPassword(body.password);
    const id = opaqueId("user");
    const name = email.split("@", 1)[0].slice(0, 30);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(91827463)");
      const installed = await client.query(
        "SELECT 1 FROM installation_state LIMIT 1",
      );
      if (!installed.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "administrator_setup_required" } });
      }
      await client.query(
        `INSERT INTO app_user (id, username, email, display_name, password_hash, role)
         VALUES ($1, $2, $2, $3, $4, 'user')`,
        [id, email, name, passwordHash],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505")
        return reply
          .code(409)
          .send({ error: { code: "email_already_registered" } });
      throw error;
    } finally {
      client.release();
    }
    return reply.code(201).send({ account: { id, email, displayName: name } });
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/session",
    async (request, reply) => {
      if (
        request.headers.origin !== config.appOrigin &&
        !(
          config.allowTestIdentity &&
          request.headers.origin === "http://web:3000"
        )
      ) {
        return reply.code(403).send({ error: { code: "origin_rejected" } });
      }
      const body = request.body as unknown;
      const soloBootstrap =
        legacyTestBootstrap &&
        config.soloOwnerMode &&
        (body === undefined ||
          (isPlainObject(body) && Object.keys(body).length === 0));
      if (legacyTestBootstrap && config.soloOwnerMode && !soloBootstrap)
        return reply.code(404).send({ error: { code: "route_not_found" } });
      const username =
        isPlainObject(body) && typeof body.email === "string"
          ? body.email.trim().toLowerCase()
          : legacyTestBootstrap &&
              isPlainObject(body) &&
              typeof body.username === "string"
            ? body.username
            : undefined;
      const password =
        isPlainObject(body) && typeof body.password === "string"
          ? body.password
          : undefined;
      const result = await db.query(
        `SELECT u.id, u.username, u.email, u.display_name, u.avatar_color, u.role, u.password_hash,
                pm.role AS project_role
         FROM app_user u
         LEFT JOIN project_member pm
           ON pm.project_id='project_demo' AND pm.user_id=u.id
         WHERE ${soloBootstrap ? "u.id = 'user_owner'" : legacyTestBootstrap ? "u.email = $1 OR u.username = $1" : "u.email = $1"}`,
        soloBootstrap ? [] : [username],
      );
      const user = result.rows[0];
      if (
        !user ||
        (!soloBootstrap &&
          !(await verifyPassword(password ?? "", user.password_hash)))
      ) {
        return reply.code(401).send({ error: { code: "invalid_credentials" } });
      }
      if (
        !soloBootstrap &&
        ((!legacyTestBootstrap && !user.email) ||
          (!config.allowTestIdentity && isTestIdentityRole(user.role)))
      )
        return reply.code(401).send({ error: { code: "invalid_credentials" } });
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");
      await db.query(
        `INSERT INTO app_session (token_hash, user_id, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
        [sessionHash(token), user.id, csrfToken],
      );
      reply.setCookie("agentbench_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.appOrigin.startsWith("https://"),
        path: "/",
        maxAge: 8 * 60 * 60,
      });
      const actor = sessionActor(user, csrfToken);
      return { csrfToken, actor: publicSessionActor(actor) };
    },
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.agentbench_session;
    if (!token)
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    const result = await db.query(
      `SELECT u.id, u.username, u.email, u.display_name, u.avatar_color, u.role, s.csrf_token,
              pm.role AS project_role
       FROM app_session s JOIN app_user u ON u.id = s.user_id
       LEFT JOIN project_member pm
         ON pm.project_id = 'project_demo' AND pm.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sessionHash(token)],
    );
    if (!result.rowCount)
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    if (
      (!legacyTestBootstrap && !result.rows[0].email) ||
      (!config.allowTestIdentity && isTestIdentityRole(result.rows[0].role))
    ) {
      await db.query("DELETE FROM app_session WHERE token_hash = $1", [
        sessionHash(token),
      ]);
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    }
    (request as AuthenticatedRequest).actor = sessionActor(
      result.rows[0],
      result.rows[0].csrf_token,
    );
    if (await enforceDeletionLock(request, reply)) return;
  }

  app.delete(
    "/api/session",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const token = request.cookies.agentbench_session;
      await db.query("DELETE FROM app_session WHERE token_hash = $1", [
        sessionHash(token!),
      ]);
      reply.clearCookie("agentbench_session", { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get("/api/session", { preHandler: authenticate }, async (request) => {
    const actor = (request as AuthenticatedRequest).actor;
    return { csrfToken: actor.csrfToken, actor: publicSessionActor(actor) };
  });

  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    const actor = (request as AuthenticatedRequest).actor;
    const result = await db.query(
      "SELECT id, email, display_name, avatar_color, role FROM app_user WHERE id = $1",
      [actor.id],
    );
    const user = result.rows[0];
    return {
      account: {
        id: user.id,
        email: user.email,
        displayName: user.display_name ?? user.username,
        avatarColor: user.avatar_color,
        role: user.role,
      },
    };
  });

  app.patch<{ Body: unknown }>(
    "/api/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(
          (key) => !["displayName", "avatarColor"].includes(key),
        ) ||
        (body.displayName !== undefined &&
          (typeof body.displayName !== "string" ||
            body.displayName.trim().length < 1 ||
            body.displayName.trim().length > 30)) ||
        (body.avatarColor !== undefined &&
          (typeof body.avatarColor !== "string" ||
            !/^#[0-9a-fA-F]{6}$/u.test(body.avatarColor)))
      )
        return reply
          .code(422)
          .send({ error: { code: "profile_payload_invalid" } });
      const result = await db.query(
        `UPDATE app_user
       SET display_name = coalesce($2, display_name),
           avatar_color = coalesce($3, avatar_color)
       WHERE id = $1
       RETURNING id, email, display_name, avatar_color, role`,
        [
          actor.id,
          typeof body.displayName === "string" ? body.displayName.trim() : null,
          typeof body.avatarColor === "string"
            ? body.avatarColor.toLowerCase()
            : null,
        ],
      );
      const user = result.rows[0];
      return {
        account: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          avatarColor: user.avatar_color,
          role: user.role,
        },
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
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
      const result = await db.query(
        `SELECT u.id, u.email, u.display_name, u.avatar_color, pm.role
         FROM project_member pm JOIN app_user u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND pm.role IN ('editor', 'viewer')
         ORDER BY u.display_name, u.id`,
        [request.params.projectId],
      );
      return {
        members: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          avatarColor: row.avatar_color,
          role: row.role,
        })),
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `SELECT id, email, role, status, expires_at, created_at
         FROM project_invitation WHERE project_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 100`,
        [request.params.projectId],
      );
      return {
        invitations: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          status:
            row.status === "pending" && new Date(row.expires_at) <= now()
              ? "expired"
              : row.status,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/invitations",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some((key) => !["email", "role"].includes(key)) ||
        typeof body.email !== "string" ||
        !["editor", "viewer"].includes(String(body.role))
      )
        return reply
          .code(422)
          .send({ error: { code: "invitation_payload_invalid" } });
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
        return reply
          .code(422)
          .send({ error: { code: "invitation_payload_invalid" } });
      const target = await db.query(
        "SELECT id FROM app_user WHERE lower(email) = $1 AND role = 'user'",
        [email],
      );
      if (!target.rowCount)
        return reply
          .code(422)
          .send({ error: { code: "account_not_registered" } });
      const targetId = String(target.rows[0].id);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE project_invitation SET status = 'expired'
           WHERE project_id = $1 AND target_user_id = $2 AND status = 'pending'
             AND expires_at <= now()`,
          [request.params.projectId, targetId],
        );
        const member = await client.query(
          "SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2",
          [request.params.projectId, targetId],
        );
        if (member.rowCount) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "already_project_member" } });
        }
        const id = opaqueId("invitation");
        const result = await client.query(
          `INSERT INTO project_invitation
             (id, project_id, target_user_id, email, role, invited_by, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')
           RETURNING id, email, role, expires_at`,
          [id, request.params.projectId, targetId, email, body.role, actor.id],
        );
        await client.query("COMMIT");
        const row = result.rows[0];
        return reply.code(201).send({
          invitation: {
            id: row.id,
            email: row.email,
            role: row.role,
            expiresAt: row.expires_at,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if ((error as { code?: string }).code === "23505")
          return reply
            .code(409)
            .send({ error: { code: "invitation_pending" } });
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { projectId: string; invitationId: string } }>(
    "/api/projects/:projectId/invitations/:invitationId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `UPDATE project_invitation SET status = 'revoked'
         WHERE id = $1 AND project_id = $2 AND status = 'pending' RETURNING id`,
        [request.params.invitationId, request.params.projectId],
      );
      if (!result.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "invitation_not_found" } });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/me/invitations",
    { preHandler: authenticate },
    async (request) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT i.id, i.project_id, p.name AS project_name, i.role, i.expires_at
       FROM project_invitation i JOIN project p ON p.id = i.project_id
       WHERE i.target_user_id = $1 AND i.status = 'pending' AND i.expires_at > now()
       ORDER BY i.created_at DESC`,
        [actor.id],
      );
      return {
        invitations: result.rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          projectName: row.project_name,
          role: row.role,
          expiresAt: row.expires_at,
        })),
      };
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/api/me/invitations/:invitationId/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT id, project_id, target_user_id, role, status, expires_at
           FROM project_invitation WHERE id = $1 FOR UPDATE`,
          [request.params.invitationId],
        );
        const invitation = result.rows[0];
        if (!invitation || invitation.target_user_id !== actor.id) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "invitation_not_found" } });
        }
        if (invitation.status === "accepted") {
          await client.query("COMMIT");
          return { projectId: invitation.project_id, role: invitation.role };
        }
        if (
          invitation.status !== "pending" ||
          new Date(invitation.expires_at) <= now()
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "invitation_inactive" } });
        }
        await client.query(
          `INSERT INTO project_member (project_id, user_id, role)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [invitation.project_id, actor.id, invitation.role],
        );
        await client.query(
          "UPDATE project_invitation SET status = 'accepted', accepted_at = now() WHERE id = $1",
          [invitation.id],
        );
        const membership = await client.query(
          "SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2",
          [invitation.project_id, actor.id],
        );
        await client.query("COMMIT");
        return {
          projectId: invitation.project_id,
          role: membership.rows[0].role,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { projectId: string; userId: string }; Body: unknown }>(
    "/api/projects/:projectId/members/:userId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).length !== 1 ||
        !["editor", "viewer"].includes(String(body.role))
      )
        return reply
          .code(422)
          .send({ error: { code: "member_payload_invalid" } });
      const result = await db.query(
        `UPDATE project_member SET role = $3
         WHERE project_id = $1 AND user_id = $2 AND role IN ('editor', 'viewer')
         RETURNING role`,
        [request.params.projectId, request.params.userId, body.role],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "member_not_found" } });
      return { userId: request.params.userId, role: result.rows[0].role };
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `DELETE FROM project_member WHERE project_id = $1 AND user_id = $2
         AND role IN ('editor', 'viewer') RETURNING user_id`,
        [request.params.projectId, request.params.userId],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "member_not_found" } });
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { projectId: string };
  }>(
    "/api/projects/:projectId/solo-test-set-sources",
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
      const result = await db.query(
        `SELECT c.id AS collection_id, c.name AS collection_name,
                da.id AS asset_id, da.file_name, sr.ordinal, sr.value,
                pv.display_mapping
           FROM raw_material_collection c
           JOIN data_asset da
             ON da.collection_id = c.id AND da.project_id = c.project_id
           JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
           JOIN source_record sr ON sr.parsed_view_id = pv.id
          WHERE c.project_id = $1
            AND da.status NOT IN ('deletion_pending', 'tombstoned')
            AND pv.status = 'ready'
            AND sr.parse_status = 'valid'
          ORDER BY c.name, da.file_name, sr.ordinal`,
        [request.params.projectId],
      );
      const collections = new Map<
        string,
        {
          id: string;
          name: string;
          files: Array<{
            id: string;
            fileName: string;
            records: Array<{
              assetId: string;
              ordinal: number;
              question: string;
              expectedOutput: string;
              metadata: MetadataEntry[];
            }>;
          }>;
        }
      >();
      for (const row of result.rows) {
        let collection = collections.get(row.collection_id);
        if (!collection) {
          collection = {
            id: row.collection_id,
            name: row.collection_name,
            files: [],
          };
          collections.set(row.collection_id, collection);
        }
        let file = collection.files.at(-1);
        if (!file || file.id !== row.asset_id) {
          file = { id: row.asset_id, fileName: row.file_name, records: [] };
          collection.files.push(file);
        }
        file.records.push({
          assetId: row.asset_id,
          ordinal: Number(row.ordinal),
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        });
      }
      return { datasets: [...collections.values()] };
    },
  );

  // V2 shared draft identities are separate from legacy lease-based working_draft.
  const draftPath = "/api/projects/:projectId/collaborative-drafts";
  const draftByIdPath = `${draftPath}/:draftId`;
  const draftSummary = (row: Record<string, unknown>) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    testSetId: row.test_set_id ? String(row.test_set_id) : null,
    parentVersionId: row.parent_version_id
      ? String(row.parent_version_id)
      : null,
    name: String(row.name),
    purpose: String(row.purpose),
    status: String(row.status),
    suspended:
      row.status === "editing" &&
      ((row.test_set_status !== null && row.test_set_status !== "available") ||
        (row.parent_status !== null && row.parent_status !== "published")),
    revision: Number(row.revision),
    nameRevision: Number(row.name_revision),
    purposeRevision: Number(row.purpose_revision),
    updatedBy: String(row.updated_by),
    updatedByName: String(
      row.updated_by_name ?? row.updated_by_username ?? row.updated_by,
    ),
    updatedAt: row.updated_at,
    publishedVersionId: row.published_version_id
      ? String(row.published_version_id)
      : null,
  });
  const draftSelect = `SELECT d.*, ts.status AS test_set_status,
    v.status AS parent_status, u.display_name AS updated_by_name,
    u.username AS updated_by_username FROM collaborative_draft d
    LEFT JOIN test_set ts ON ts.id=d.test_set_id
    LEFT JOIN test_set_version v ON v.id=d.parent_version_id
    LEFT JOIN app_user u ON u.id=d.updated_by`;
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
  const draftRow = (row: Record<string, unknown>) => ({
    id: String(row.id),
    position: Number(row.position),
    caseId: row.case_id ? String(row.case_id) : null,
    beforeRevisionId: row.before_revision_id
      ? String(row.before_revision_id)
      : null,
    question: String(row.question),
    expectedOutput: String(row.expected_output),
    metadata: row.metadata,
    source: row.source,
    sourceFileName: row.source_file_name ?? null,
    rowRevision: Number(row.row_revision),
    questionRevision: Number(row.question_revision),
    expectedOutputRevision: Number(row.expected_output_revision),
    metadataRevision: Number(row.metadata_revision),
    sourceRevision: Number(row.source_revision),
    fieldAttribution: row.field_attribution,
    updatedBy: String(row.updated_by),
    updatedAt: row.updated_at,
  });
  const draftLive = (row: Record<string, unknown>) =>
    row.status === "editing" &&
    (row.test_set_status === null || row.test_set_status === "available") &&
    (row.parent_status === null || row.parent_status === "published");
  const draftFieldValue = (field: string, value: unknown) => {
    if (field === "question" || field === "expectedOutput")
      return typeof value === "string" && value.length <= 100_000
        ? value
        : undefined;
    if (field === "metadata") return normalizeMetadataEntries(value);
    if (field === "source") {
      if (value === null) return null;
      if (
        isPlainObject(value) &&
        typeof value.assetId === "string" &&
        Number.isInteger(value.ordinal) &&
        Number(value.ordinal) >= 0
      )
        return { assetId: value.assetId, ordinal: Number(value.ordinal) };
    }
    return undefined;
  };

  app.get<{
    Params: { projectId: string };
    Querystring: { testSetId?: string };
  }>(draftPath, { preHandler: authenticate }, async (request, reply) => {
    if (!(await draftRead(request, reply, request.params.projectId))) return;
    const rows = await db.query(
      `${draftSelect} WHERE d.project_id=$1
        AND d.status='editing' AND ($2::text IS NULL OR d.test_set_id=$2)
        ORDER BY d.updated_at DESC,d.id DESC`,
      [request.params.projectId, request.query.testSetId ?? null],
    );
    return { drafts: rows.rows.map(draftSummary) };
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    draftPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (k) => !["testSetId", "parentVersionId"].includes(k),
        ) ||
        (body.testSetId === undefined) !==
          (body.parentVersionId === undefined) ||
        (body.testSetId !== undefined &&
          (typeof body.testSetId !== "string" ||
            typeof body.parentVersionId !== "string"))
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_request_invalid" } });
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        let name = "",
          purpose = "";
        if (body.testSetId) {
          const parent = await client.query(
            `SELECT ts.name,ts.purpose,ts.status AS test_set_status,
            v.status AS parent_status FROM test_set ts JOIN test_set_version v
              ON v.test_set_id=ts.id AND v.id=$3
            WHERE ts.id=$2 AND ts.project_id=$1 FOR SHARE OF ts,v`,
            [request.params.projectId, body.testSetId, body.parentVersionId],
          );
          if (
            !parent.rowCount ||
            parent.rows[0].test_set_status !== "available" ||
            parent.rows[0].parent_status !== "published"
          ) {
            await client.query("ROLLBACK");
            return reply
              .code(404)
              .send({ error: { code: "parent_version_not_found" } });
          }
          name = String(parent.rows[0].name);
          purpose = String(parent.rows[0].purpose);
        }
        const draftId = opaqueId("collabdraft");
        const inserted = await client.query(
          `INSERT INTO collaborative_draft
          (id,project_id,test_set_id,parent_version_id,name,purpose,updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
          [
            draftId,
            request.params.projectId,
            body.testSetId ?? null,
            body.parentVersionId ?? null,
            name,
            purpose,
            actor.id,
          ],
        );
        const actualId = inserted.rowCount
          ? draftId
          : String(
              (
                await client.query(
                  `SELECT id FROM collaborative_draft
          WHERE project_id=$1 AND test_set_id=$2 AND parent_version_id=$3 AND status='editing'`,
                  [
                    request.params.projectId,
                    body.testSetId,
                    body.parentVersionId,
                  ],
                )
              ).rows[0]?.id ?? "",
            );
        if (!actualId) throw new Error("draft_create_conflict");
        if (inserted.rowCount && body.parentVersionId) {
          const records = await client.query(
            `SELECT vm.position,vm.case_id,vm.case_revision_id,
            cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref,
            coalesce(attr.field_attribution,'{}'::jsonb) AS inherited_attribution
            FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id=vm.case_revision_id
            LEFT JOIN collaborative_draft_attribution attr
              ON attr.version_id=$1 AND attr.case_id=vm.case_id
            ORDER BY vm.ordinal`,
            [body.parentVersionId],
          );
          for (const row of records.rows) {
            const source =
              isPlainObject(row.origin_ref) &&
              row.origin_kind === "source_record" &&
              typeof row.origin_ref.assetId === "string"
                ? {
                    assetId: row.origin_ref.assetId,
                    ordinal: Number(row.origin_ref.ordinal),
                  }
                : null;
            await client.query(
              `INSERT INTO collaborative_draft_record
              (draft_id,id,position,case_id,before_revision_id,question,expected_output,metadata,source,updated_by,field_attribution)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                draftId,
                opaqueId("draftrow"),
                row.position,
                row.case_id,
                row.case_revision_id,
                isPlainObject(row.input)
                  ? String(row.input.question ?? "")
                  : displayText(row.input),
                isPlainObject(row.expected_output)
                  ? String(row.expected_output.text ?? "")
                  : displayText(row.expected_output),
                JSON.stringify(readMetadataEntries(row.metadata)),
                source ? JSON.stringify(source) : null,
                actor.id,
                JSON.stringify(row.inherited_attribution),
              ],
            );
          }
        }
        const draft = await client.query(`${draftSelect} WHERE d.id=$1`, [
          actualId,
        ]);
        await client.query("COMMIT");
        return reply.code(inserted.rowCount ? 201 : 200).send({
          draft: draftSummary(draft.rows[0]),
          replayed: !inserted.rowCount,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: { projectId: string; draftId: string };
    Querystring: { limit?: string; offset?: string; search?: string };
  }>(draftByIdPath, { preHandler: authenticate }, async (request, reply) => {
    if (!(await draftRead(request, reply, request.params.projectId))) return;
    const draft = await db.query(
      `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
      [request.params.draftId, request.params.projectId],
    );
    if (
      !draft.rowCount ||
      draft.rows[0].status === "discarded" ||
      draft.rows[0].status === "terminated"
    )
      return reply.code(404).send({ error: { code: "draft_not_found" } });
    const summary = draftSummary(draft.rows[0]);
    if (summary.suspended) return { draft: summary, records: [], total: 0 };
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const search = String(request.query.search ?? "").slice(0, 200);
    const rows = await db.query(
      `SELECT dr.*, da.file_name AS source_file_name, count(*) OVER() AS total
        FROM collaborative_draft_record dr
        LEFT JOIN data_asset da ON da.id=dr.source->>'assetId'
        WHERE dr.draft_id=$1 AND dr.deleted=false AND
          ($2='' OR question ILIKE '%'||$2||'%' OR expected_output ILIKE '%'||$2||'%')
        ORDER BY position LIMIT $3 OFFSET $4`,
      [request.params.draftId, search, limit, offset],
    );
    return {
      draft: summary,
      records: rows.rows.map(draftRow),
      total: Number(rows.rows[0]?.total ?? 0),
    };
  });

  app.patch<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !["name", "purpose"].includes(String(body.field)) ||
        typeof body.value !== "string" ||
        !Number.isInteger(body.expectedFieldRevision) ||
        body.value.length > (body.field === "name" ? 200 : 2000)
      )
        return reply.code(422).send({ error: { code: "draft_field_invalid" } });
      const field = String(body.field),
        revField = field === "name" ? "name_revision" : "purpose_revision";
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(current.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        if (Number(current.rows[0][revField]) !== body.expectedFieldRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_field_conflict" },
            draft: draftSummary(current.rows[0]),
          });
        }
        await client.query(
          `UPDATE collaborative_draft SET ${field}=$2,${revField}=${revField}+1,
          revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`,
          [request.params.draftId, body.value, actor.id],
        );
        const updated = await client.query(`${draftSelect} WHERE d.id=$1`, [
          request.params.draftId,
        ]);
        await client.query("COMMIT");
        return { draft: draftSummary(updated.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/records`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (k) =>
            !["source", "question", "expectedOutput", "metadata"].includes(k),
        ) ||
        (body.source !== undefined &&
          (body.question !== undefined ||
            body.expectedOutput !== undefined ||
            body.metadata !== undefined ||
            draftFieldValue("source", body.source) === undefined)) ||
        (body.question !== undefined &&
          draftFieldValue("question", body.question) === undefined) ||
        (body.expectedOutput !== undefined &&
          draftFieldValue("expectedOutput", body.expectedOutput) ===
            undefined) ||
        (body.metadata !== undefined &&
          draftFieldValue("metadata", body.metadata) === undefined)
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_record_invalid" } });
      const source =
        body.source === undefined
          ? null
          : (draftFieldValue("source", body.source) as {
              assetId: string;
              ordinal: number;
            } | null);
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(current.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const count = await client.query(
          `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
          FROM collaborative_draft_record WHERE draft_id=$1`,
          [request.params.draftId],
        );
        if (Number(count.rows[0].count) >= 10000) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        if (source) {
          const existing = await client.query(
            `SELECT * FROM collaborative_draft_record WHERE draft_id=$1
            AND source->>'assetId'=$2 AND (source->>'ordinal')::integer=$3
            AND deleted=false LIMIT 1`,
            [request.params.draftId, source.assetId, source.ordinal],
          );
          if (existing.rowCount) {
            await client.query("COMMIT");
            return reply
              .code(200)
              .send({ record: draftRow(existing.rows[0]), replayed: true });
          }
        }
        if (source) {
          const used = await client.query(
            `SELECT DISTINCT source->>'assetId' AS asset_id
            FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
            [request.params.draftId],
          );
          const assetIds = [
            ...new Set([
              ...used.rows.map((row) => String(row.asset_id)),
              source.assetId,
            ]),
          ];
          const size = await client.query(
            `SELECT coalesce(sum(size_bytes),0)::bigint AS total
            FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[])`,
            [request.params.projectId, assetIds],
          );
          if (assetIds.length > 5 || Number(size.rows[0].total) > 100000000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
        }
        let question = String(body.question ?? ""),
          expectedOutput = String(body.expectedOutput ?? ""),
          metadata: MetadataEntry[] =
            (body.metadata as MetadataEntry[] | undefined) ?? [];
        if (source) {
          const material = await client.query(
            `SELECT sr.value,pv.display_mapping FROM data_asset da
            JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
            JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=$3 AND sr.parse_status='valid'
            WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')`,
            [request.params.projectId, source.assetId, source.ordinal],
          );
          if (!material.rowCount) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "source_selection_invalid" } });
          }
          const mapped = mapMaterialRecord(
            material.rows[0].value,
            normalizeDisplayMapping(material.rows[0].display_mapping) ?? {
              metadata: [],
            },
          );
          question = mapped.question;
          expectedOutput = mapped.expectedOutput;
          metadata = mapped.metadata;
        }
        const rowId = opaqueId("draftrow");
        await client.query(
          `INSERT INTO collaborative_draft_record
          (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
            jsonb_build_object(
              'question',jsonb_build_object('userId',$8::text,'at',now()),
              'expectedOutput',jsonb_build_object('userId',$8::text,'at',now()),
              'metadata',jsonb_build_object('userId',$8::text,'at',now())
            ))`,
          [
            request.params.draftId,
            rowId,
            Number(count.rows[0].high_water) + 1,
            question,
            expectedOutput,
            JSON.stringify(metadata),
            source ? JSON.stringify(source) : null,
            actor.id,
          ],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
        );
        const inserted = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, rowId],
        );
        await client.query("COMMIT");
        return reply.code(201).send({ record: draftRow(inserted.rows[0]) });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
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
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !["question", "expectedOutput", "metadata"].includes(
          String(body.field),
        ) ||
        !Number.isInteger(body.expectedFieldRevision) ||
        draftFieldValue(String(body.field), body.value) === undefined
      )
        return reply.code(422).send({ error: { code: "draft_field_invalid" } });
      const field = String(body.field);
      const column = field === "expectedOutput" ? "expected_output" : field;
      const revColumn = `${column}_revision`;
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const current = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
          [request.params.draftId, request.params.recordId],
        );
        if (!current.rowCount || current.rows[0].deleted) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_record_removed" } });
        }
        if (Number(current.rows[0][revColumn]) !== body.expectedFieldRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_field_conflict" },
            record: draftRow(current.rows[0]),
          });
        }
        const value = draftFieldValue(field, body.value);
        await client.query(
          `UPDATE collaborative_draft_record SET ${column}=$3,
          ${revColumn}=${revColumn}+1,row_revision=row_revision+1,
          field_attribution=jsonb_set(field_attribution,$4::text[],jsonb_build_object('userId',$5::text,'at',now()),true),
          updated_by=$5,updated_at=now() WHERE draft_id=$1 AND id=$2`,
          [
            request.params.draftId,
            request.params.recordId,
            field === "metadata" ? JSON.stringify(value) : value,
            [field],
            actor.id,
          ],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
        );
        const updated = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, request.params.recordId],
        );
        await client.query("COMMIT");
        return { record: draftRow(updated.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
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
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (!isPlainObject(body) || !Number.isInteger(body.expectedRowRevision))
        return reply
          .code(422)
          .send({ error: { code: "draft_row_revision_required" } });
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const current = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
          [request.params.draftId, request.params.recordId],
        );
        if (!current.rowCount || current.rows[0].deleted) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_record_removed" } });
        }
        if (Number(current.rows[0].row_revision) !== body.expectedRowRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_row_conflict" },
            record: draftRow(current.rows[0]),
          });
        }
        await client.query(
          `UPDATE collaborative_draft_record SET deleted=true,row_revision=row_revision+1,
          updated_by=$3,updated_at=now() WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, request.params.recordId, actor.id],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
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

  app.delete<{ Params: { projectId: string; draftId: string } }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        await client.query(
          `DELETE FROM collaborative_draft_record WHERE draft_id=$1`,
          [request.params.draftId],
        );
        await client.query(
          `UPDATE collaborative_draft SET status='discarded',name='',purpose='',revision=revision+1,
          updated_at=now() WHERE id=$1`,
          [request.params.draftId],
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

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/publish`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Number.isInteger(body.revision) ||
        Object.keys(body).some((key) => key !== "revision")
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_revision_required" } });
      const actor = (request as AuthenticatedRequest).actor;
      const draft = await db.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const saved = draft.rows[0];
      if (saved.status === "published" && saved.published_version_id) {
        const result = await db.query(
          `SELECT v.id,v.version_label,v.item_count,v.test_set_id,
          ts.name,ts.purpose FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
          WHERE v.id=$1`,
          [saved.published_version_id],
        );
        if (!result.rowCount)
          return reply
            .code(409)
            .send({ error: { code: "idempotency_result_missing" } });
        return {
          testSet: {
            id: result.rows[0].test_set_id,
            name: result.rows[0].name,
            purpose: result.rows[0].purpose,
          },
          version: {
            id: result.rows[0].id,
            label: result.rows[0].version_label,
            recordCount: Number(result.rows[0].item_count),
          },
          replayed: true,
        };
      }
      if (!draftLive(saved))
        return reply.code(409).send({ error: { code: "draft_not_editable" } });
      if (Number(saved.revision) !== body.revision)
        return reply.code(409).send({
          error: { code: "draft_revision_conflict" },
          draft: draftSummary(saved),
        });
      if (!String(saved.name).trim())
        return reply
          .code(422)
          .send({ error: { code: "test_set_name_required" } });
      const records = await db.query(
        `SELECT * FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false ORDER BY position`,
        [request.params.draftId],
      );
      if (!records.rowCount)
        return reply
          .code(422)
          .send({ error: { code: "test_set_records_required" } });
      if (!saved.parent_version_id) {
        const normalized = records.rows.map((row) => ({
          question: String(row.question),
          expectedOutput: String(row.expected_output),
          metadata: row.metadata as MetadataEntry[],
          ...(row.source
            ? { source: row.source as { assetId: string; ordinal: number } }
            : {}),
        }));
        const selections = [
          ...new Map(
            normalized.flatMap((record) =>
              record.source
                ? [
                    [
                      `${record.source.assetId}:${record.source.ordinal}`,
                      record.source,
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ];
        const internal = await app.inject({
          method: "POST",
          url: `/api/projects/${request.params.projectId}/solo-test-sets`,
          headers: {
            cookie: String(request.headers.cookie ?? ""),
            origin: String(request.headers.origin ?? ""),
            "x-csrf-token": String(request.headers["x-csrf-token"] ?? ""),
            "idempotency-key": `draft:${request.params.draftId}:${body.revision}`,
          },
          payload: {
            name: saved.name,
            purpose: saved.purpose,
            selections,
            operations: normalized.map((after) => ({
              operation: "add",
              after,
            })),
            collaborativeDraftId: request.params.draftId,
            draftRevision: body.revision,
          },
        });
        return reply.code(internal.statusCode).send(internal.json());
      }
      try {
        const published = await publishSparseVersion(db, artifacts, {
          projectId: request.params.projectId,
          testSetId: String(saved.test_set_id),
          parentVersionId: String(saved.parent_version_id),
          actorId: actor.id,
          idempotencyKey: `draft:${request.params.draftId}:${body.revision}`,
          operations: [],
          draftId: request.params.draftId,
          draftRevision: Number(body.revision),
        });
        const count = await db.query(
          `SELECT item_count FROM test_set_version WHERE id=$1`,
          [published.id],
        );
        return reply.code(published.replayed ? 200 : 201).send({
          testSet: {
            id: saved.test_set_id,
            name: saved.name,
            purpose: saved.purpose,
          },
          version: {
            id: published.id,
            label: published.label,
            recordCount: Number(count.rows[0]?.item_count ?? 0),
            parentVersionId: saved.parent_version_id,
          },
          replayed: published.replayed,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          code &&
          [
            "draft_not_found",
            "version_not_found",
            "test_set_not_found",
          ].includes(code)
        )
          return reply.code(404).send({ error: { code } });
        if (
          code &&
          ["draft_revision_conflict", "idempotency_conflict"].includes(code)
        )
          return reply.code(409).send({ error: { code } });
        if (
          code &&
          [
            "test_set_records_required",
            "test_record_invalid",
            "source_selection_invalid",
            "test_set_capacity_exceeded",
            "parent_record_invalid",
            "draft_parent_incomplete",
          ].includes(code)
        )
          return reply.code(422).send({ error: { code } });
        if (code === "checkpoint_hard_limit_failed")
          return reply.code(503).send({ error: { code } });
        throw error;
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { search?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/collaborative-draft-source-files",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const limit = Math.min(
        100,
        Math.max(1, Number(request.query.limit) || 10),
      );
      const offset = Math.max(0, Number(request.query.offset) || 0);
      const search = String(request.query.search ?? "").slice(0, 200);
      const rows = await db.query(
        `SELECT da.id,da.file_name,c.name AS collection_name,
        count(sr.ordinal)::integer AS record_count,count(*) OVER() AS total
        FROM data_asset da JOIN raw_material_collection c ON c.id=da.collection_id
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($2='' OR da.file_name ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%')
        GROUP BY da.id,da.file_name,c.name ORDER BY c.name,da.file_name,da.id
        LIMIT $3 OFFSET $4`,
        [request.params.projectId, search, limit, offset],
      );
      return {
        files: rows.rows.map((row) => ({
          id: row.id,
          fileName: row.file_name,
          collectionName: row.collection_name,
          recordCount: Number(row.record_count),
        })),
        total: Number(rows.rows[0]?.total ?? 0),
      };
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
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      if (!request.query.assetId)
        return reply
          .code(422)
          .send({ error: { code: "source_asset_required" } });
      const limit = Math.min(
        100,
        Math.max(1, Number(request.query.limit) || 20),
      );
      const offset = Math.max(0, Number(request.query.offset) || 0);
      const search = String(request.query.search ?? "").slice(0, 200);
      const rows = await db.query(
        `SELECT sr.ordinal,sr.value,pv.display_mapping,
        count(*) OVER() AS total FROM data_asset da
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
        ORDER BY sr.ordinal LIMIT $4 OFFSET $5`,
        [
          request.params.projectId,
          request.query.assetId,
          search,
          limit,
          offset,
        ],
      );
      return {
        records: rows.rows.map((row) => ({
          assetId: request.query.assetId,
          ordinal: Number(row.ordinal),
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        })),
        total: Number(rows.rows[0]?.total ?? 0),
      };
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    `${draftByIdPath}/selected-sources`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const draft = await db.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2
        AND d.status IN ('editing','published')`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      if (draftSummary(draft.rows[0]).suspended)
        return reply.code(409).send({ error: { code: "draft_not_editable" } });
      const rows = await db.query(
        `SELECT source->>'assetId' AS asset_id,
        (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
        [request.params.draftId],
      );
      return {
        sources: rows.rows.map((row) => ({
          assetId: row.asset_id,
          ordinal: row.ordinal,
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/source-selection`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Array.isArray(body.assetIds) ||
        body.assetIds.length < 1 ||
        body.assetIds.length > 5 ||
        body.assetIds.some((id) => typeof id !== "string") ||
        new Set(body.assetIds).size !== body.assetIds.length ||
        !["add", "remove"].includes(String(body.mode)) ||
        (body.search !== undefined &&
          (typeof body.search !== "string" || body.search.length > 200)) ||
        (body.exclude !== undefined &&
          (!Array.isArray(body.exclude) ||
            body.exclude.length > 10000 ||
            body.exclude.some(
              (item) =>
                !isPlainObject(item) ||
                typeof item.assetId !== "string" ||
                !Number.isInteger(item.ordinal) ||
                Number(item.ordinal) < 0,
            ))) ||
        (body.ordinals !== undefined &&
          (!Array.isArray(body.ordinals) ||
            body.ordinals.length > 10000 ||
            body.ordinals.some(
              (value) => !Number.isInteger(value) || Number(value) < 0,
            )))
      )
        return reply
          .code(422)
          .send({ error: { code: "source_selection_invalid" } });
      const assetIds = body.assetIds as string[];
      const excluded = new Set(
        (
          (body.exclude ?? []) as Array<{ assetId: string; ordinal: number }>
        ).map((item) => `${item.assetId}:${item.ordinal}`),
      );
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const assets = await client.query(
          `SELECT da.id,da.size_bytes FROM data_asset da
          JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
          WHERE da.project_id=$1 AND da.id=ANY($2::text[]) AND da.status NOT IN ('deletion_pending','tombstoned')`,
          [request.params.projectId, assetIds],
        );
        if (
          assets.rows.length !== assetIds.length ||
          assets.rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) >
            100000000
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        const sources = await client.query(
          `SELECT da.id AS asset_id,sr.ordinal,sr.value,pv.display_mapping
          FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
          JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
          WHERE da.project_id=$1 AND da.id=ANY($2::text[])
            AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
            AND ($4::integer[] IS NULL OR sr.ordinal=ANY($4::integer[]))
          ORDER BY da.id,sr.ordinal LIMIT 10001`,
          [
            request.params.projectId,
            assetIds,
            String(body.search ?? ""),
            body.ordinals ?? null,
          ],
        );
        if (sources.rows.length > 10000) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        const selected = sources.rows.filter(
          (row) => !excluded.has(`${row.asset_id}:${row.ordinal}`),
        );
        let changed = 0;
        if (body.mode === "add") {
          const active = await client.query(
            `SELECT source->>'assetId' AS asset_id,
            (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
            [request.params.draftId],
          );
          const activeKeys = new Set(
            active.rows.map((row) => `${row.asset_id}:${row.ordinal}`),
          );
          const additions = selected.filter(
            (row) => !activeKeys.has(`${row.asset_id}:${row.ordinal}`),
          );
          const allAssets = [
            ...new Set([
              ...active.rows.map((row) => String(row.asset_id)),
              ...additions.map((row) => String(row.asset_id)),
            ]),
          ];
          if (allAssets.length > 5) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          const totalSize = await client.query(
            `SELECT coalesce(sum(size_bytes),0)::bigint AS size
            FROM data_asset WHERE id=ANY($1::text[])`,
            [allAssets],
          );
          if (Number(totalSize.rows[0].size) > 100000000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          const state = await client.query(
            `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
            FROM collaborative_draft_record WHERE draft_id=$1`,
            [request.params.draftId],
          );
          if (Number(state.rows[0].count) + additions.length > 10000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          let position = Number(state.rows[0].high_water);
          for (const row of additions) {
            const source = {
              assetId: String(row.asset_id),
              ordinal: Number(row.ordinal),
            };
            const mapped = mapMaterialRecord(
              row.value,
              normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
            );
            const inserted = await client.query(
              `INSERT INTO collaborative_draft_record
              (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                jsonb_build_object(
                  'question',jsonb_build_object('userId',$8::text,'at',now()),
                  'expectedOutput',jsonb_build_object('userId',$8::text,'at',now()),
                  'metadata',jsonb_build_object('userId',$8::text,'at',now())
                )) ON CONFLICT DO NOTHING RETURNING id`,
              [
                request.params.draftId,
                opaqueId("draftrow"),
                ++position,
                mapped.question,
                mapped.expectedOutput,
                JSON.stringify(mapped.metadata),
                JSON.stringify(source),
                actor.id,
              ],
            );
            changed += inserted.rowCount ?? 0;
          }
        } else {
          for (const row of selected) {
            const removed = await client.query(
              `UPDATE collaborative_draft_record SET deleted=true,
              row_revision=row_revision+1,updated_by=$4,updated_at=now()
              WHERE draft_id=$1 AND deleted=false
                AND source->>'assetId'=$2 AND (source->>'ordinal')::integer=$3`,
              [request.params.draftId, row.asset_id, row.ordinal, actor.id],
            );
            changed += removed.rowCount ?? 0;
          }
        }
        if (changed)
          await client.query(
            `UPDATE collaborative_draft SET revision=revision+1,
          updated_by=$2,updated_at=now() WHERE id=$1`,
            [request.params.draftId, actor.id],
          );
        await client.query("COMMIT");
        return { matched: selected.length, changed };
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
    "/api/projects/:projectId/solo-test-sets",
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
        !isPlainObject(request.body) ||
        Object.keys(request.body).some(
          (key) =>
            ![
              "name",
              "purpose",
              "selections",
              "operations",
              "collaborativeDraftId",
              "draftRevision",
            ].includes(key),
        ) ||
        typeof request.body.name !== "string" ||
        request.body.name.trim().length < 1 ||
        request.body.name.trim().length > 200 ||
        (request.body.purpose !== undefined &&
          (typeof request.body.purpose !== "string" ||
            request.body.purpose.length > 2_000)) ||
        !Array.isArray(request.body.selections) ||
        !Array.isArray(request.body.operations)
      )
        return reply
          .code(422)
          .send({ error: { code: "test_set_payload_invalid" } });
      const selections = request.body.selections;
      const operations = request.body.operations;
      if (
        operations.some(
          (operation) =>
            !isPlainObject(operation) ||
            Object.keys(operation).length !== 2 ||
            operation.operation !== "add" ||
            !Object.keys(operation).includes("after"),
        )
      )
        return reply
          .code(422)
          .send({ error: { code: "test_set_payload_invalid" } });
      const records = operations.map((operation) => operation.after);
      if (!records.length)
        return reply
          .code(422)
          .send({ error: { code: "test_set_records_required" } });
      if (selections.length > 10_000 || records.length > 10_000)
        return reply
          .code(422)
          .send({ error: { code: "test_set_capacity_exceeded" } });
      const selected = selections.map((selection) => {
        if (!isPlainObject(selection)) return undefined;
        const assetId = selection.assetId;
        const ordinal = selection.ordinal;
        return Object.keys(selection).every((key) =>
          ["assetId", "ordinal"].includes(key),
        ) &&
          typeof assetId === "string" &&
          typeof ordinal === "number" &&
          Number.isInteger(ordinal) &&
          ordinal >= 0
          ? { assetId, ordinal }
          : undefined;
      });
      if (selected.some((selection) => !selection))
        return reply
          .code(422)
          .send({ error: { code: "source_selection_invalid" } });
      const selectedSources = selected as Array<{
        assetId: string;
        ordinal: number;
      }>;
      const selectedKeys = new Set(
        selectedSources.map(({ assetId, ordinal }) => `${assetId}:${ordinal}`),
      );
      if (selectedKeys.size !== selectedSources.length)
        return reply
          .code(422)
          .send({ error: { code: "source_selection_invalid" } });
      const edited = records.map((record) => {
        const metadata = isPlainObject(record)
          ? normalizeMetadataEntries(record.metadata)
          : undefined;
        if (
          !isPlainObject(record) ||
          Object.keys(record).some(
            (key) =>
              !["question", "expectedOutput", "metadata", "source"].includes(
                key,
              ),
          ) ||
          typeof record.question !== "string" ||
          typeof record.expectedOutput !== "string" ||
          !metadata ||
          record.question.length > 100_000 ||
          record.expectedOutput.length > 100_000 ||
          Buffer.byteLength(canonicalJson(metadata)) > 100_000
        )
          return undefined;
        if (record.source === undefined)
          return {
            question: record.question,
            expectedOutput: record.expectedOutput,
            metadata,
          };
        if (!isPlainObject(record.source)) return undefined;
        const sourceAssetId = record.source.assetId;
        const sourceOrdinal = record.source.ordinal;
        if (
          Object.keys(record.source).some(
            (key) => !["assetId", "ordinal"].includes(key),
          ) ||
          typeof sourceAssetId !== "string" ||
          typeof sourceOrdinal !== "number" ||
          !Number.isInteger(sourceOrdinal) ||
          sourceOrdinal < 0 ||
          !selectedKeys.has(`${sourceAssetId}:${sourceOrdinal}`)
        )
          return undefined;
        return {
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata,
          source: {
            assetId: sourceAssetId,
            ordinal: sourceOrdinal,
          },
        };
      });
      if (edited.some((record) => !record))
        return reply.code(422).send({ error: { code: "test_record_invalid" } });
      const testRecords = edited as Array<{
        question: string;
        expectedOutput: string;
        metadata: MetadataEntry[];
        source?: { assetId: string; ordinal: number };
      }>;
      const normalizedBytes = Buffer.byteLength(canonicalJson(testRecords));
      if (normalizedBytes > 100_000_000)
        return reply
          .code(422)
          .send({ error: { code: "test_set_capacity_exceeded" } });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 200)
        return reply
          .code(422)
          .send({ error: { code: "idempotency_key_required" } });
      const requestFingerprint = sha256(
        canonicalJson({
          name: request.body.name.trim(),
          purpose: request.body.purpose?.trim() ?? "",
          selections: selectedSources,
          records: testRecords,
        }),
      );
      const client = await db.connect();
      let storedManifest: { objectRef: string } | undefined;
      let commitAttempted = false;
      try {
        await client.query("BEGIN");
        const collaborativeDraftId =
          typeof request.body.collaborativeDraftId === "string"
            ? request.body.collaborativeDraftId
            : null;
        if (
          request.body.collaborativeDraftId !== undefined &&
          (!collaborativeDraftId ||
            !Number.isInteger(request.body.draftRevision))
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "draft_request_invalid" } });
        }
        if (collaborativeDraftId) {
          const locked = await client.query(
            `SELECT * FROM collaborative_draft
            WHERE id=$1 AND project_id=$2 AND parent_version_id IS NULL
            FOR UPDATE`,
            [collaborativeDraftId, request.params.projectId],
          );
          if (!locked.rowCount) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: { code: "draft_not_found" } });
          }
          const draft = locked.rows[0];
          if (draft.status === "published" && draft.published_version_id) {
            const published = await client.query(
              `SELECT ts.id AS test_set_id,ts.name,ts.purpose,
              v.id AS version_id,v.item_count FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
              WHERE v.id=$1`,
              [draft.published_version_id],
            );
            await client.query("COMMIT");
            if (!published.rowCount)
              return reply
                .code(409)
                .send({ error: { code: "idempotency_result_missing" } });
            return {
              testSet: {
                id: published.rows[0].test_set_id,
                name: published.rows[0].name,
                purpose: published.rows[0].purpose,
              },
              version: {
                id: published.rows[0].version_id,
                label: "v1",
                recordCount: Number(published.rows[0].item_count),
              },
              replayed: true,
            };
          }
          if (
            draft.status !== "editing" ||
            Number(draft.revision) !== request.body.draftRevision
          ) {
            await client.query("ROLLBACK");
            return reply
              .code(409)
              .send({ error: { code: "draft_revision_conflict" } });
          }
          const rows = await client.query(
            `SELECT * FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false ORDER BY position`,
            [collaborativeDraftId],
          );
          const savedRecords = rows.rows.map((row) => ({
            question: String(row.question),
            expectedOutput: String(row.expected_output),
            metadata: row.metadata as MetadataEntry[],
            ...(row.source
              ? { source: row.source as { assetId: string; ordinal: number } }
              : {}),
          }));
          const savedSelections = [
            ...new Map(
              savedRecords.flatMap((record) =>
                record.source
                  ? [
                      [
                        `${record.source.assetId}:${record.source.ordinal}`,
                        record.source,
                      ] as const,
                    ]
                  : [],
              ),
            ).values(),
          ];
          if (
            draft.name !== request.body.name ||
            draft.purpose !== (request.body.purpose ?? "") ||
            canonicalJson(savedRecords) !== canonicalJson(testRecords) ||
            canonicalJson(savedSelections) !== canonicalJson(selectedSources)
          ) {
            await client.query("ROLLBACK");
            return reply
              .code(409)
              .send({ error: { code: "draft_revision_conflict" } });
          }
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:solo-test-set:${request.params.projectId}:${actor.id}:${key}`,
        ]);
        const replay = await client.query(
          `SELECT asset_id, request_fingerprint
             FROM upload_idempotency
            WHERE project_id = $1 AND actor_id = $2
              AND operation = 'solo_test_set_publish' AND idempotency_key = $3
              AND status = 'committed'`,
          [request.params.projectId, actor.id, key],
        );
        if (replay.rowCount) {
          if (replay.rows[0].request_fingerprint !== requestFingerprint) {
            await client.query("COMMIT");
            return reply
              .code(409)
              .send({ error: { code: "idempotency_conflict" } });
          }
          const reopened = await client.query(
            `SELECT ts.id, ts.name, ts.purpose, v.id AS version_id, v.item_count
               FROM test_set ts
               JOIN test_set_version v ON v.test_set_id = ts.id AND v.sequence = 1
              WHERE ts.project_id = $1 AND ts.id = $2`,
            [request.params.projectId, replay.rows[0].asset_id],
          );
          await client.query("COMMIT");
          if (!reopened.rowCount)
            return reply
              .code(409)
              .send({ error: { code: "idempotency_result_missing" } });
          return {
            testSet: {
              id: reopened.rows[0].id,
              name: reopened.rows[0].name,
              purpose: reopened.rows[0].purpose,
            },
            version: {
              id: reopened.rows[0].version_id,
              label: "v1",
              recordCount: Number(reopened.rows[0].item_count),
            },
            dataCheck: dataCheck(testRecords),
            replayed: true,
          };
        }
        const sourceRows = selectedSources.length
          ? await client.query(
              `WITH selected(asset_id, ordinal) AS (
                 SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(asset_id text, ordinal integer)
               )
               SELECT selected.asset_id, selected.ordinal, da.size_bytes, pv.id AS parsed_view_id,
                      sr.locator, sr.record_hash
                 FROM selected
                 JOIN data_asset da ON da.id = selected.asset_id AND da.project_id = $1
                 JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current AND pv.status = 'ready'
                 JOIN source_record sr
                   ON sr.parsed_view_id = pv.id AND sr.ordinal = selected.ordinal
                WHERE da.status NOT IN ('deletion_pending', 'tombstoned')
                  AND sr.parse_status = 'valid'`,
              [
                request.params.projectId,
                JSON.stringify(
                  selectedSources.map(({ assetId, ordinal }) => ({
                    asset_id: assetId,
                    ordinal,
                  })),
                ),
              ],
            )
          : { rows: [] as Array<Record<string, unknown>> };
        if (sourceRows.rows.length !== selectedSources.length) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "source_selection_invalid" } });
        }
        const sourceAssetBytes = new Map<string, number>();
        for (const row of sourceRows.rows)
          sourceAssetBytes.set(row.asset_id as string, Number(row.size_bytes));
        if (
          sourceAssetBytes.size > 5 ||
          [...sourceAssetBytes.values()].reduce(
            (sum, value) => sum + value,
            0,
          ) > 100_000_000
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        const sourceByKey = new Map(
          sourceRows.rows.map((row) => [`${row.asset_id}:${row.ordinal}`, row]),
        );
        const testSetId = opaqueId("testset");
        const draftId = opaqueId("draft");
        const schemaId = opaqueId("schema");
        const candidateId = opaqueId("candidate");
        const versionId = opaqueId("version");
        const payload = Buffer.from(
          `${testRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
        );
        const payloadHash = sha256(payload);
        const evidenceHash = sha256(
          canonicalJson({ sources: selectedSources, payloadHash }),
        );
        const planned = testRecords.map((record, index) => {
          const source = record.source
            ? sourceByKey.get(
                `${record.source.assetId}:${record.source.ordinal}`,
              )
            : undefined;
          const contentHash = sha256(canonicalJson(record));
          return {
            record,
            position: String(index + 1),
            caseId: opaqueId("case"),
            revisionId: opaqueId("revision"),
            contentHash,
            source,
            originRef: source
              ? {
                  assetId: record.source!.assetId,
                  parsedViewId: source.parsed_view_id,
                  ordinal: record.source!.ordinal,
                  locator: source.locator,
                  recordHash: source.record_hash,
                }
              : { kind: "manual" },
            lineageFingerprint: sha256(
              canonicalJson({
                source: record.source ?? { kind: "manual" },
                contentHash,
              }),
            ),
          };
        });
        const publishedAt = new Date().toISOString();
        const { bytes: manifest, manifestHash } = encodeDeltaManifest({
          format: "evalbase.test-set-delta-manifest",
          format_version: 1,
          version_id: versionId,
          test_set_id: testSetId,
          parent_version_id: null,
          publication_order: 1,
          generation: 1,
          branch_number: null,
          version_label: "v1",
          published_at: publishedAt,
          schema_revision_id: schemaId,
          item_count: testRecords.length,
          payload_hash: payloadHash,
          evidence_hash: evidenceHash,
          changes: planned.map((item) => ({
            case_id: item.caseId,
            operation: "add",
            position: item.position,
            before_revision_id: null,
            before_content_hash: null,
            after_revision_id: item.revisionId,
            after_content_hash: item.contentHash,
          })),
          new_revisions: [...planned]
            .sort((a, b) => a.revisionId.localeCompare(b.revisionId))
            .map((item) => ({
              revision_id: item.revisionId,
              case_id: item.caseId,
              parent_revision_id: null,
              input: { question: item.record.question },
              expected_output: { text: item.record.expectedOutput },
              metadata: item.record.metadata,
              source_record_ordinal: item.record.source?.ordinal ?? 0,
              content_hash: item.contentHash,
              origin_kind: item.record.source ? "source_record" : "manual",
              origin_ref: item.originRef,
              lineage_fingerprint: item.lineageFingerprint,
              lineage_level: "record_level",
            })),
        });
        storedManifest = await artifacts.storeImmutable(
          manifest,
          `solo-test-set-${testSetId}`,
        );
        await client.query(
          `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            testSetId,
            request.params.projectId,
            request.body.name.trim(),
            request.body.purpose?.trim() ?? "",
            actor.id,
          ],
        );
        await client.query(
          `INSERT INTO working_draft (id, test_set_id, status, updated_by, revision, version_description)
           VALUES ($1, $2, 'published', $3, 1, '')`,
          [draftId, testSetId, actor.id],
        );
        await client.query(
          `INSERT INTO formal_schema_revision
             (id, test_set_id, mode, input_schema, expected_output_schema)
           VALUES ($1, $2, 'gold_required', $3, $4)`,
          [
            schemaId,
            testSetId,
            { type: "object", properties: { question: { type: "string" } } },
            { type: "string" },
          ],
        );
        await client.query(
          `INSERT INTO candidate_snapshot
             (id, draft_id, status, item_count, payload_hash, evidence_hash, object_ref)
           VALUES ($1, $2, 'published_as_version', $3, $4, $5, $6)`,
          [
            candidateId,
            draftId,
            testRecords.length,
            payloadHash,
            evidenceHash,
            storedManifest.objectRef,
          ],
        );
        await client.query(
          `INSERT INTO test_set_version
             (id, test_set_id, sequence, candidate_id, schema_revision_id, payload_hash,
              evidence_hash, manifest_hash, manifest_object_ref, item_count, published_by,
              published_at, publication_order, generation, branch_number, version_label,
              storage_format)
           VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, NULL, 'v1',
                   'delta_v1')`,
          [
            versionId,
            testSetId,
            candidateId,
            schemaId,
            payloadHash,
            evidenceHash,
            manifestHash,
            storedManifest.objectRef,
            testRecords.length,
            actor.id,
            publishedAt,
          ],
        );
        for (const item of planned) {
          const {
            record,
            caseId,
            revisionId,
            source,
            contentHash,
            lineageFingerprint,
            originRef,
            position,
          } = item;
          await client.query(
            `INSERT INTO test_case (id, test_set_id) VALUES ($1, $2)`,
            [caseId, testSetId],
          );
          await client.query(
            `INSERT INTO case_revision
               (id, case_id, input, expected_output, metadata, source_record_ordinal,
                 content_hash, origin_kind, origin_ref, lineage_fingerprint)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              revisionId,
              caseId,
              { question: record.question },
              { text: record.expectedOutput },
              { entries: record.metadata },
              record.source?.ordinal ?? 0,
              contentHash,
              record.source ? "source_record" : "manual",
              originRef,
              lineageFingerprint,
            ],
          );
          await client.query(
            `INSERT INTO candidate_item
               (candidate_id, ordinal, case_id, source_record_ordinal, content_hash,
                parsed_view_id, origin_kind, origin_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              candidateId,
              Number(position),
              caseId,
              record.source?.ordinal ?? 0,
              contentHash,
              source?.parsed_view_id ?? null,
              record.source ? "source_record" : "manual",
              record.source
                ? {
                    assetId: record.source.assetId,
                    ordinal: record.source.ordinal,
                  }
                : { kind: "manual" },
            ],
          );
          await client.query(
            `INSERT INTO version_change
               (version_id,case_id,operation,position,before_revision_id,before_content_hash,
                after_revision_id,after_content_hash)
             VALUES ($1,$2,'add',$3,NULL,NULL,$4,$5)`,
            [versionId, caseId, position, revisionId, contentHash],
          );
        }
        const membersHash = sha256(
          canonicalJson(
            planned.map(({ position, caseId, revisionId }) => [
              Number(position),
              caseId,
              revisionId,
            ]),
          ),
        );
        await client.query(
          `INSERT INTO version_checkpoint
             (version_id,reason,retention_class,item_count,members_hash)
           VALUES ($1,'initial','rebuildable',$2,$3)`,
          [versionId, planned.length, membersHash],
        );
        if (planned.length)
          await client.query(
            `INSERT INTO version_checkpoint_member
               (version_id,position,case_id,case_revision_id)
             SELECT $1,x.position::bigint,x.case_id,x.case_revision_id
               FROM jsonb_to_recordset($2::jsonb)
                 AS x(position text,case_id text,case_revision_id text)`,
            [
              versionId,
              JSON.stringify(
                planned.map(({ position, caseId, revisionId }) => ({
                  position,
                  case_id: caseId,
                  case_revision_id: revisionId,
                })),
              ),
            ],
          );
        const verified = await client.query(
          `SELECT checkpoint_members_hash($1) AS hash,
                  (SELECT count(*)::int FROM version_checkpoint_member
                    WHERE version_id=$1) AS count`,
          [versionId],
        );
        if (
          verified.rows[0].hash !== membersHash ||
          verified.rows[0].count !== planned.length
        )
          throw new Error("initial_checkpoint_failed");
        const resolved = await client.query(
          `SELECT cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref
             FROM resolve_version_members($1) vm
             JOIN case_revision cr ON cr.id=vm.case_revision_id
            ORDER BY vm.ordinal`,
          [versionId],
        );
        if (
          resolved.rowCount !== planned.length ||
          snapshotPayloadHash(resolved.rows.map(storedRecord)) !== payloadHash
        )
          throw new Error("initial_checkpoint_failed");
        await client.query(
          "UPDATE test_set SET default_version_id = $2 WHERE id = $1",
          [testSetId, versionId],
        );
        await client.query(
          `INSERT INTO upload_idempotency
             (project_id, actor_id, operation, idempotency_key, status,
              request_fingerprint, asset_id, operation_id)
           VALUES ($1, $2, 'solo_test_set_publish', $3, 'committed', $4, $5, $6)`,
          [
            request.params.projectId,
            actor.id,
            key,
            requestFingerprint,
            testSetId,
            `solo-test-set-${testSetId}`,
          ],
        );
        await client.query(
          `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'solo_test_set_v1_published', 'test_set_version', $3, $4)`,
          [request.params.projectId, actor.id, versionId, { testSetId }],
        );
        if (collaborativeDraftId) {
          const savedRows = await client.query(
            `SELECT id,field_attribution,updated_by,updated_at
            FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false ORDER BY position`,
            [collaborativeDraftId],
          );
          if (savedRows.rows.length !== planned.length)
            throw new Error("draft_revision_conflict");
          for (let index = 0; index < planned.length; index++) {
            const row = savedRows.rows[index],
              item = planned[index];
            await client.query(
              `INSERT INTO collaborative_draft_attribution
              (version_id,draft_row_id,case_id,field_attribution,saved_by,saved_at)
              VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                versionId,
                row.id,
                item.caseId,
                row.field_attribution,
                row.updated_by,
                row.updated_at,
              ],
            );
          }
          await client.query(
            `UPDATE collaborative_draft SET status='published',
            test_set_id=$2,published_version_id=$3,updated_by=$4,updated_at=now()
            WHERE id=$1 AND status='editing'`,
            [collaborativeDraftId, testSetId, versionId, actor.id],
          );
        }
        commitAttempted = true;
        await client.query("COMMIT");
        return reply.code(201).send({
          testSet: {
            id: testSetId,
            name: request.body.name.trim(),
            purpose: request.body.purpose?.trim() ?? "",
          },
          version: {
            id: versionId,
            label: "v1",
            recordCount: testRecords.length,
          },
          dataCheck: dataCheck(testRecords),
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (storedManifest && !commitAttempted)
          await artifacts
            .remove(storedManifest.objectRef)
            .catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  function dataCheck(
    records: Array<{
      question: string;
      expectedOutput: string;
      metadata: MetadataEntry[];
      source?: unknown;
    }>,
  ) {
    const fingerprints = records.map(({ question, expectedOutput, metadata }) =>
      canonicalJson({ question, expectedOutput, metadata }),
    );
    return {
      missingQuestionCount: records.filter((record) => !record.question.trim())
        .length,
      exactDuplicateCount: fingerprints.length - new Set(fingerprints).size,
      traceableRecordCount: records.filter((record) => record.source).length,
    };
  }

  type SoloVersionRecord = {
    id: string;
    ordinal: number;
    parentRevisionId: string;
    question: string;
    expectedOutput: string;
    metadata: MetadataEntry[];
    source: {
      assetId: string;
      ordinal: number;
      fileName?: string;
      collectionId?: string;
    } | null;
  };

  type SoloVersionChange = {
    id: string;
    changeType: "unchanged" | "modified" | "added" | "removed";
    current: Omit<
      SoloVersionRecord,
      "id" | "ordinal" | "parentRevisionId"
    > | null;
    previous: Omit<
      SoloVersionRecord,
      "id" | "ordinal" | "parentRevisionId"
    > | null;
    source: SoloVersionRecord["source"];
    changedFields: string[];
  };

  function soloVersionRecord(row: Record<string, unknown>): SoloVersionRecord {
    const origin = isPlainObject(row.origin_ref) ? row.origin_ref : undefined;
    return {
      id: String(row.case_id),
      ordinal: Number(row.ordinal),
      parentRevisionId: String(row.case_revision_id),
      question:
        isPlainObject(row.input) && typeof row.input.question === "string"
          ? row.input.question
          : displayText(row.input),
      expectedOutput:
        isPlainObject(row.expected_output) &&
        typeof row.expected_output.text === "string"
          ? row.expected_output.text
          : displayText(row.expected_output),
      metadata: readMetadataEntries(row.metadata),
      source:
        row.origin_kind === "source_record" && origin
          ? { assetId: String(origin.assetId), ordinal: Number(origin.ordinal) }
          : null,
    };
  }

  async function soloVersionChanges(
    projectId: string,
    testSetId: string,
    versionId: string,
    queryClient: Pick<PoolClient, "query"> = db,
  ) {
    const version = await queryClient.query(
      `SELECT ts.id AS test_set_id, ts.name, v.id, v.version_label, v.item_count,
              v.parent_version_id, v.published_at, v.evidence_hash
         FROM test_set ts
         JOIN test_set_version v ON v.test_set_id = ts.id
        WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
          AND ts.status = 'available' AND v.status = 'published'`,
      [projectId, testSetId, versionId],
    );
    if (!version.rowCount) return undefined;

    const members = async (id: string, pending = false) => {
      const result = await queryClient.query(
        `SELECT vm.ordinal, cr.case_id, cr.input, cr.expected_output, cr.metadata,
                cr.origin_kind, cr.origin_ref
           FROM ${pending ? "resolve_version_members_internal($1,true,true)" : "resolve_version_members($1)"} vm
           JOIN case_revision cr ON cr.id = vm.case_revision_id
          WHERE vm.version_id = $1
          ORDER BY vm.ordinal`,
        [id],
      );
      return result.rows.map(soloVersionRecord);
    };
    const current = await members(versionId);
    const parentVersionId = version.rows[0].parent_version_id as string | null;
    const parentState = parentVersionId
      ? await queryClient.query(
          "SELECT status,cleanup_pending,manifest_object_ref FROM test_set_version WHERE id = $1",
          [parentVersionId],
        )
      : { rows: [] as Array<{ status: string }> };
    const parentUnavailable =
      parentState.rows[0] &&
      ["tombstoned", "permanently_deleted", "degraded_by_deletion"].includes(
        parentState.rows[0].status,
      );
    const cutState = parentUnavailable
      ? await queryClient.query(
          "SELECT 1 FROM version_provenance_cut_state WHERE version_id=$1 AND parent_version_id=$2",
          [versionId, parentVersionId],
        )
      : { rowCount: 0 };
    const parentPendingContent =
      parentUnavailable &&
      !cutState.rowCount &&
      parentState.rows[0].cleanup_pending &&
      !String(parentState.rows[0].manifest_object_ref).startsWith(
        "tombstone:",
      ) &&
      !String(parentState.rows[0].manifest_object_ref).startsWith("deleted:");
    const previous =
      parentVersionId && (!parentUnavailable || parentPendingContent)
        ? await members(parentVersionId, Boolean(parentPendingContent))
        : [];
    const cutFacts = parentUnavailable
      ? await queryClient.query(
          `SELECT case_id, change_type, changed_fields
             FROM version_provenance_cut_fact WHERE version_id = $1`,
          [versionId],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const factById = new Map(
      cutFacts.rows.map((row) => [String(row.case_id), row]),
    );
    const currentById = new Map(current.map((record) => [record.id, record]));
    const previousById = new Map(previous.map((record) => [record.id, record]));
    const changes: SoloVersionChange[] = [];
    for (const id of new Set([
      ...previousById.keys(),
      ...currentById.keys(),
      ...factById.keys(),
    ])) {
      const currentRecord = currentById.get(id);
      const previousRecord = previousById.get(id);
      const cutFact = factById.get(id);
      const currentValue = currentRecord
        ? (({
            id: _id,
            ordinal: _ordinal,
            parentRevisionId: _parentRevisionId,
            ...value
          }) => value)(currentRecord)
        : null;
      const previousValue =
        previousRecord && !parentUnavailable
          ? (({
              id: _id,
              ordinal: _ordinal,
              parentRevisionId: _parentRevisionId,
              ...value
            }) => value)(previousRecord)
          : null;
      const changedFields: string[] =
        currentRecord && previousRecord
          ? (["question", "expectedOutput", "metadata"] as const).filter(
              (field) =>
                field === "metadata"
                  ? canonicalJson(currentRecord.metadata) !==
                    canonicalJson(previousRecord.metadata)
                  : currentRecord[field] !== previousRecord[field],
            )
          : [];
      if (
        currentRecord &&
        previousRecord &&
        (currentRecord.source?.assetId !== previousRecord.source?.assetId ||
          currentRecord.source?.ordinal !== previousRecord.source?.ordinal)
      )
        changedFields.push("source");
      changes.push({
        id,
        changeType: cutFact
          ? (String(cutFact.change_type) as SoloVersionChange["changeType"])
          : !previousRecord
            ? "added"
            : !currentRecord
              ? "removed"
              : changedFields.length ||
                  currentRecord.source?.assetId !==
                    previousRecord.source?.assetId ||
                  currentRecord.source?.ordinal !==
                    previousRecord.source?.ordinal
                ? "modified"
                : "unchanged",
        current: currentValue,
        previous: previousValue,
        source:
          currentRecord?.source ??
          (!parentUnavailable ? previousRecord?.source : null) ??
          null,
        changedFields:
          cutFact && Array.isArray(cutFact.changed_fields)
            ? (cutFact.changed_fields as string[])
            : changedFields,
      });
    }

    const sourceAssetIds = [
      ...new Set(
        changes.flatMap((change) =>
          [
            change.current?.source,
            change.previous?.source,
            change.source,
          ].flatMap((source) => (source ? [source.assetId] : [])),
        ),
      ),
    ];
    const assets = sourceAssetIds.length
      ? await queryClient.query(
          `SELECT da.id, da.file_name, da.collection_id, da.status, pv.display_mapping
             FROM data_asset da
             LEFT JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
            WHERE da.project_id = $1 AND da.id = ANY($2::text[])
            ORDER BY da.id`,
          [projectId, sourceAssetIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const assetById = new Map(
      assets.rows.map((asset) => [String(asset.id), asset]),
    );
    const enrichSource = (source: SoloVersionRecord["source"]) => {
      if (source) {
        const asset = assetById.get(source.assetId);
        source.fileName = String(asset?.file_name ?? "未记录资料");
        source.collectionId = String(asset?.collection_id ?? "");
      }
    };
    for (const change of changes) {
      enrichSource(change.current?.source ?? null);
      enrichSource(change.previous?.source ?? null);
      enrichSource(change.source);
    }
    const addedFileCounts = new Map<string, number>();
    for (const change of changes) {
      const assetId = change.current?.source?.assetId;
      if (
        assetId &&
        (change.changeType === "added" ||
          (change.changeType === "modified" &&
            change.changedFields.includes("source")))
      )
        addedFileCounts.set(assetId, (addedFileCounts.get(assetId) ?? 0) + 1);
    }
    const addedFiles = [...addedFileCounts].map(([assetId, recordCount]) => {
      const asset = assetById.get(assetId);
      const mapping = normalizeDisplayMapping(asset?.display_mapping) ?? {
        metadata: [],
      };
      return {
        assetId,
        fileName: String(asset?.file_name ?? "未记录资料"),
        recordCount,
        mapping: {
          question: mapping.question ?? null,
          expectedOutput: mapping.expectedOutput ?? null,
          metadata: mapping.metadata,
        },
      };
    });
    const parent = parentVersionId
      ? await queryClient.query(
          `SELECT version_label FROM test_set_version WHERE id = $1`,
          [parentVersionId],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    return {
      version: version.rows[0],
      parentLabel: parent.rows[0]?.version_label ?? null,
      changes,
      current,
      addedFiles,
      manualAddedCount: changes.filter(
        (change) => change.changeType === "added" && !change.source,
      ).length,
      sourceFingerprint: sha256(canonicalJson(assets.rows)),
      parentStatus: parentState.rows[0]?.status ?? null,
    };
  }

  function csvField(value: string) {
    const protectedValue = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(protectedValue)
      ? `"${protectedValue.replaceAll('"', '""')}"`
      : protectedValue;
  }

  function csvDocument(rows: string[][]) {
    return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
  }

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
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const allowed = new Set([
        "search",
        "limit",
        "offset",
        "sourceAssetId",
        "question",
        "origin",
        "metadataField",
        "metadata",
      ]);
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      const question = request.query.question ?? "all";
      const origin = request.query.origin ?? "all";
      const sourceAssetIds = (
        Array.isArray(request.query.sourceAssetId)
          ? request.query.sourceAssetId
          : [request.query.sourceAssetId]
      ).filter((value): value is string => typeof value === "string");
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !["all", "present", "missing"].includes(question) ||
        !["all", "source", "manual"].includes(origin) ||
        sourceAssetIds.some((id) => !id || id.length > 200) ||
        (request.query.search !== undefined &&
          request.query.search.length > 200) ||
        (request.query.metadataField !== undefined &&
          request.query.metadataField.length > 200) ||
        (request.query.metadata !== undefined &&
          request.query.metadata.length > 200)
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const version = await db.query(
        `SELECT 1
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
            AND ts.status = 'available' AND v.status = 'published'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
        ],
      );
      if (!version.rowCount)
        return reply.code(404).send({ error: { code: "version_not_found" } });

      const values: unknown[] = [
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      ];
      const conditions = [
        "ts.project_id = $1",
        "ts.id = $2",
        "v.id = $3",
        "ts.status = 'available'",
        "v.status = 'published'",
      ];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const search = request.query.search?.trim();
      if (search) {
        const parameter = add(search);
        conditions.push(
          `LOWER(CONCAT_WS(' ', cr.input ->> 'question', cr.expected_output ->> 'text',
             da.file_name, cr.metadata::text)) LIKE '%' || LOWER(${parameter}) || '%'`,
        );
      }
      if (sourceAssetIds.length)
        conditions.push(
          `(cr.origin_ref ->> 'assetId') = ANY(${add(sourceAssetIds)}::text[])`,
        );
      if (question === "present")
        conditions.push("COALESCE(cr.input ->> 'question', '') <> ''");
      if (question === "missing")
        conditions.push("COALESCE(cr.input ->> 'question', '') = ''");
      if (origin === "source")
        conditions.push("cr.origin_kind = 'source_record'");
      if (origin === "manual")
        conditions.push("cr.origin_kind <> 'source_record'");
      const metadataField = request.query.metadataField?.trim();
      const metadata = request.query.metadata?.trim();
      if (metadata) {
        const fieldParameter = add(metadataField || null);
        const valueParameter = add(metadata);
        conditions.push(`(
          (jsonb_typeof(cr.metadata -> 'entries') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(cr.metadata -> 'entries') AS entry
             WHERE (${fieldParameter}::text IS NULL OR LOWER(entry ->> 'key') = LOWER(${fieldParameter}))
               AND LOWER(entry ->> 'value') LIKE '%' || LOWER(${valueParameter}) || '%'
          ))
          OR
          (jsonb_typeof(cr.metadata -> 'entries') IS DISTINCT FROM 'array'
            AND (${fieldParameter}::text IS NULL OR LOWER(${fieldParameter}) = 'metadata')
            AND LOWER(COALESCE(
              cr.metadata ->> 'text',
              CASE WHEN jsonb_typeof(cr.metadata) = 'string' THEN cr.metadata #>> '{}' ELSE '' END
            )) LIKE '%' || LOWER(${valueParameter}) || '%')
        )`);
      }
      const where = conditions.join(" AND ");
      const countValues = [...values];
      const result = await db.query(
        `SELECT vm.ordinal, cr.input, cr.expected_output, cr.metadata, cr.origin_kind,
                cr.origin_ref, da.file_name, COUNT(*) OVER () AS total
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
           LEFT JOIN data_asset da
             ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
          WHERE ${where}
          ORDER BY vm.ordinal
          LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        values,
      );
      const total =
        result.rows[0]?.total ??
        (
          await db.query(
            `SELECT count(*)::integer AS total
             FROM test_set ts
             JOIN test_set_version v ON v.test_set_id = ts.id
             JOIN LATERAL resolve_version_members(v.id) vm ON true
             JOIN case_revision cr ON cr.id = vm.case_revision_id
             LEFT JOIN data_asset da
               ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
            WHERE ${where}`,
            countValues,
          )
        ).rows[0].total;
      const records = result.rows.map((row) => {
        const record = soloVersionRecord(row);
        return {
          ordinal: record.ordinal,
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata: record.metadata,
          source: record.source
            ? {
                ordinal: record.source.ordinal,
                fileName: String(row.file_name ?? "未记录资料"),
              }
            : null,
        };
      });
      const [sourceFiles, metadataFields] = await Promise.all([
        db.query(
          `SELECT DISTINCT cr.origin_ref ->> 'assetId' AS id, da.file_name AS name
             FROM test_set ts
             JOIN test_set_version v ON v.test_set_id = ts.id
             JOIN LATERAL resolve_version_members(v.id) vm ON true
             JOIN case_revision cr ON cr.id = vm.case_revision_id
             JOIN data_asset da ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
            WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
              AND cr.origin_kind = 'source_record'
            ORDER BY name`,
          [
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
          ],
        ),
        db.query(
          `SELECT DISTINCT field AS key FROM (
             SELECT entry ->> 'key' AS field
               FROM test_set ts
               JOIN test_set_version v ON v.test_set_id = ts.id
               JOIN LATERAL resolve_version_members(v.id) vm ON true
               JOIN case_revision cr ON cr.id = vm.case_revision_id
               CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(cr.metadata -> 'entries') = 'array'
                   THEN cr.metadata -> 'entries' ELSE '[]'::jsonb END
               ) AS entry
              WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
             UNION
             SELECT 'Metadata'
               FROM test_set ts
               JOIN test_set_version v ON v.test_set_id = ts.id
               JOIN LATERAL resolve_version_members(v.id) vm ON true
               JOIN case_revision cr ON cr.id = vm.case_revision_id
              WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
                AND jsonb_typeof(cr.metadata -> 'entries') IS DISTINCT FROM 'array'
           ) fields WHERE field IS NOT NULL AND field <> '' ORDER BY key`,
          [
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
          ],
        ),
      ]);
      return {
        records,
        pagination: {
          total: Number(total),
          limit,
          offset,
        },
        filterOptions: {
          sourceFiles: sourceFiles.rows.map((row) => ({
            id: String(row.id),
            name: String(row.name),
          })),
          metadataFields: metadataFields.rows.map((row) => String(row.key)),
        },
      };
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
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const limit = Number(request.query.limit ?? 100);
      const offset = Number(request.query.offset ?? 0);
      const sourceAssetId = request.query.sourceAssetId;
      const sourceOrdinal =
        request.query.sourceOrdinal === undefined
          ? undefined
          : Number(request.query.sourceOrdinal);
      if (
        Object.keys(request.query).some(
          (key) =>
            !["limit", "offset", "sourceAssetId", "sourceOrdinal"].includes(
              key,
            ),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (sourceAssetId === undefined) !== (sourceOrdinal === undefined) ||
        (sourceAssetId !== undefined &&
          (typeof sourceAssetId !== "string" ||
            !sourceAssetId ||
            sourceAssetId.length > 200)) ||
        (request.query.sourceOrdinal !== undefined &&
          (typeof request.query.sourceOrdinal !== "string" ||
            !/^(0|[1-9]\d*)$/.test(request.query.sourceOrdinal) ||
            sourceOrdinal === undefined ||
            !Number.isSafeInteger(sourceOrdinal) ||
            sourceOrdinal > 2_147_483_647))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const result = await db.query(
        `SELECT vm.ordinal, vm.case_revision_id, cr.case_id, cr.input, cr.expected_output,
                cr.metadata, cr.origin_kind, cr.origin_ref, COUNT(*) OVER () AS total
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
            AND ts.status = 'available' AND v.status = 'published'
            AND ($6::text IS NULL OR (cr.origin_kind = 'source_record'
              AND cr.origin_ref ->> 'assetId' = $6
              AND cr.source_record_ordinal = $7))
          ORDER BY vm.ordinal LIMIT $4 OFFSET $5`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          limit,
          offset,
          sourceAssetId ?? null,
          sourceOrdinal ?? null,
        ],
      );
      if (!result.rowCount && offset === 0) {
        const version = await db.query(
          `SELECT 1 FROM test_set ts JOIN test_set_version v ON v.test_set_id = ts.id
            WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
              AND ts.status = 'available' AND v.status = 'published'`,
          [
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
          ],
        );
        if (!version.rowCount)
          return reply.code(404).send({ error: { code: "version_not_found" } });
      }
      return {
        records: result.rows.map((row) => {
          const record = soloVersionRecord(row);
          return {
            ordinal: record.ordinal,
            parentOrdinal: record.ordinal,
            caseId: String(row.case_id),
            revisionId: String(row.case_revision_id),
            question: record.question,
            expectedOutput: record.expectedOutput,
            metadata: record.metadata,
            source: record.source
              ? {
                  assetId: record.source.assetId,
                  ordinal: record.source.ordinal,
                }
              : null,
          };
        }),
        pagination: {
          total: Number(result.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
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
      const ordinal = Number(request.params.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 1)
        return reply
          .code(422)
          .send({ error: { code: "record_ordinal_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const result = await db.query(
        `SELECT vm.ordinal, cr.input, cr.expected_output, cr.metadata, cr.origin_kind,
                cr.origin_ref, da.file_name
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
           LEFT JOIN data_asset da
             ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3 AND vm.ordinal = $4
            AND ts.status = 'available' AND v.status = 'published'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          ordinal,
        ],
      );
      if (!result.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "version_record_not_found" } });
      const record = soloVersionRecord(result.rows[0]);
      return {
        record: {
          ordinal: record.ordinal,
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata: record.metadata,
          source: record.source
            ? {
                ordinal: record.source.ordinal,
                fileName: String(result.rows[0].file_name ?? "未记录资料"),
              }
            : null,
        },
      };
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
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const name = request.query.name?.trim();
      const result = await db.query(
        `SELECT ts.id, ts.name, v.id AS version_id, v.version_label, v.item_count, v.published_at,
                coalesce(
                  array_to_string(
                    array_agg(DISTINCT coalesce(da.file_name, '已删除资料')
                      ORDER BY coalesce(da.file_name, '已删除资料'))
                      FILTER (WHERE cr.origin_kind = 'source_record'),
                    '、'
                  ),
                  '手工新增'
                ) AS source
           FROM test_set ts
           JOIN LATERAL (
             SELECT * FROM test_set_version
              WHERE test_set_id = ts.id AND status = 'published'
              ORDER BY publication_order DESC, id DESC
              LIMIT 1
           ) v ON true
           LEFT JOIN LATERAL resolve_version_members(v.id) vm ON true
           LEFT JOIN case_revision cr ON cr.id = vm.case_revision_id
           LEFT JOIN data_asset da
             ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
          WHERE ts.project_id = $1
            AND ts.status = 'available'
            AND ($2::text IS NULL OR ts.name ILIKE '%' || $2 || '%')
          GROUP BY ts.id, ts.name, v.id, v.version_label, v.item_count, v.published_at
          ORDER BY v.published_at DESC, ts.id DESC
          LIMIT $3 OFFSET $4`,
        [request.params.projectId, name ?? null, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::integer AS total
           FROM test_set
          WHERE project_id = $1 AND status = 'available'
            AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')`,
        [request.params.projectId, name ?? null],
      );
      return {
        testSets: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          currentVersionId: row.version_id,
          currentVersion: row.version_label,
          recordCount: Number(row.item_count),
          source: row.source,
          status: "已发布",
          updatedAt: new Date(row.published_at).toISOString(),
        })),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId",
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
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const version = await db.query(
        `SELECT ts.id AS test_set_id, ts.name, ts.purpose, v.id AS version_id,
                v.version_label, v.item_count, v.parent_version_id, v.published_at,
                v.publication_order, v.generation, v.branch_number
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
            AND ts.status = 'available' AND v.status = 'published'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
        ],
      );
      if (!version.rowCount)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const provenance = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!provenance)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const changes = { modified: 0, added: 0, removed: 0 };
      for (const change of provenance.changes) {
        if (change.changeType === "modified") changes.modified += 1;
        else if (change.changeType === "added") changes.added += 1;
        else if (change.changeType === "removed") changes.removed += 1;
      }
      const graph = await db.query(
        `SELECT id, parent_version_id, version_label, item_count, published_at,
                tombstoned_at, publication_order, generation, branch_number, status
           FROM test_set_version
          WHERE test_set_id = $1 AND status IN ('published', 'tombstoned')
          ORDER BY publication_order, id`,
        [request.params.testSetId],
      );
      const current = version.rows[0];
      return {
        testSet: {
          id: current.test_set_id,
          name: current.name,
          purpose: current.purpose,
        },
        version: {
          id: current.version_id,
          label: current.version_label,
          recordCount: Number(current.item_count),
          parentVersionId: current.parent_version_id,
          createdAt: new Date(current.published_at).toISOString(),
        },
        versionSummary: {
          sourceFiles: [
            ...new Set(
              provenance.current.flatMap((record) =>
                record.source?.fileName ? [record.source.fileName] : [],
              ),
            ),
          ],
          manualRecordCount: provenance.current.filter(
            (record) => !record.source,
          ).length,
          changes,
        },
        dataCheck: dataCheck(provenance.current),
        graph: {
          nodes: graph.rows.map((row) => ({
            id: row.id,
            label: row.version_label,
            parentVersionId: row.parent_version_id,
            recordCount: Number(row.item_count),
            publicationOrder: Number(row.publication_order),
            generation: Number(row.generation),
            branchNumber:
              row.branch_number === null ? null : Number(row.branch_number),
            createdAt: new Date(row.published_at).toISOString(),
            tombstoned: row.status === "tombstoned",
            tombstonedAt:
              row.tombstoned_at === null
                ? undefined
                : new Date(row.tombstoned_at).toISOString(),
          })),
        },
      };
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
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const allowed = new Set(["status", "search", "limit", "offset"]);
      const status = request.query.status ?? "changed";
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        ![
          "changed",
          "all",
          "unchanged",
          "modified",
          "added",
          "removed",
        ].includes(status) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.search !== undefined &&
          request.query.search.length > 200)
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const result = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!result)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const search = request.query.search?.trim().toLowerCase();
      const matching = result.changes.filter((change) => {
        if (status === "changed" && change.changeType === "unchanged")
          return false;
        if (
          status !== "all" &&
          status !== "changed" &&
          change.changeType !== status
        )
          return false;
        if (!search) return true;
        return [
          change.changeType,
          change.current?.question,
          change.current?.expectedOutput,
          change.current ? metadataText(change.current.metadata) : undefined,
          change.previous?.question,
          change.previous?.expectedOutput,
          change.previous ? metadataText(change.previous.metadata) : undefined,
          change.source?.fileName,
          String(change.source?.ordinal ?? ""),
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase()
          .includes(search);
      });
      const counts = Object.fromEntries(
        ["unchanged", "modified", "added", "removed"].map((changeType) => [
          changeType,
          result.changes.filter((change) => change.changeType === changeType)
            .length,
        ]),
      );
      return {
        summary: {
          parentVersion: result.version.parent_version_id
            ? {
                id: result.version.parent_version_id,
                label: result.parentLabel,
              }
            : null,
          currentVersion: {
            id: result.version.id,
            label: result.version.version_label,
            recordCount: Number(result.version.item_count),
            createdAt: new Date(result.version.published_at).toISOString(),
          },
          counts,
          addedFiles: result.addedFiles,
          manualAddedCount: result.manualAddedCount,
        },
        changes: matching.slice(offset, offset + limit),
        pagination: { total: matching.length, limit, offset },
      };
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
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const result = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!result)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const change = result.changes.find(
        (item) => item.id === request.params.changeId,
      );
      if (!change)
        return reply.code(404).send({ error: { code: "change_not_found" } });
      return { change };
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
          const evidenceFingerprint = sha256(
            canonicalJson({
              evidenceHash: result.version.evidence_hash,
              parentStatus: result.parentStatus,
              sourceFingerprint: result.sourceFingerprint,
              current: result.current,
              changes: result.changes,
              addedFiles: result.addedFiles,
            }),
          );
          await lock.query(
            `DELETE FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND (serializer_version<>1 OR evidence_fingerprint<>$3)`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          const cached = await lock.query(
            `SELECT document FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND serializer_version=1 AND evidence_fingerprint=$3`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          const document =
            cached.rows[0]?.document ?? csvDocument(rows(result));
          if (!cached.rowCount)
            await lock.query(
              `INSERT INTO version_export_cache
             (version_id,export_type,serializer_version,evidence_fingerprint,document)
             SELECT v.id,$2,1,$3,$4 FROM test_set_version v
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
          await lock.query("COMMIT");
          return reply
            .type("text/csv; charset=utf-8")
            .header(
              "content-disposition",
              `attachment; filename="agentbench-${result.version.version_label}-${name}"`,
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

  const storedStringArray = (value: unknown) =>
    Array.isArray(value) && value.every((id) => typeof id === "string")
      ? value
      : [];

  async function versionBranch(
    client: PoolClient,
    testSetId: string,
    rootVersionId: string,
  ) {
    const result = await client.query(
      `WITH RECURSIVE branch AS (
         SELECT id, parent_version_id, status
           FROM test_set_version
          WHERE id = $2 AND test_set_id = $1
         UNION ALL
         SELECT child.id, child.parent_version_id, child.status
           FROM test_set_version child
           JOIN branch parent ON child.parent_version_id = parent.id
          WHERE child.test_set_id = $1
       )
       SELECT id, parent_version_id, status FROM branch`,
      [testSetId, rootVersionId],
    );
    return result.rows;
  }

  async function protectDeletionBoundaries(
    client: PoolClient,
    testSetId: string,
    deletedIds: string[],
    projectId: string,
  ) {
    const boundaries = await client.query(
      `WITH RECURSIVE path AS (
         SELECT id,parent_version_id,status FROM test_set_version
          WHERE test_set_id=$1 AND parent_version_id=ANY($2::text[])
            AND id<>ALL($2::text[])
         UNION ALL
         SELECT child.id,child.parent_version_id,child.status
           FROM test_set_version child JOIN path parent
             ON child.parent_version_id=parent.id
          WHERE child.test_set_id=$1
            AND parent.status IN ('tombstoned','permanently_deleted','degraded_by_deletion')
       )
       SELECT path.id,path.parent_version_id
         FROM path
        WHERE path.status IN ('published','trashed','archived') ORDER BY path.id`,
      [testSetId, deletedIds],
    );
    for (const row of boundaries.rows) {
      const versionId = String(row.id);
      const parentId = String(row.parent_version_id);
      const checkpoint = await createCheckpoint(
        client,
        versionId,
        "deletion_cut",
        projectId,
      );
      if (checkpoint === "skipped")
        throw new Error("deletion_cut_checkpoint_skipped");
      const recordedCut = await client.query(
        "SELECT 1 FROM version_provenance_cut_state WHERE version_id=$1 AND parent_version_id=$2",
        [versionId, parentId],
      );
      if (!recordedCut.rowCount) {
        const before = await client.query(
          `SELECT vm.case_id,cr.input,cr.expected_output,cr.metadata,cr.origin_ref
           FROM resolve_version_members_internal($1,true,true) vm
           JOIN case_revision cr ON cr.id=vm.case_revision_id`,
          [parentId],
        );
        const after = await client.query(
          `SELECT vm.case_id,cr.input,cr.expected_output,cr.metadata,cr.origin_ref
           FROM resolve_version_members_internal($1,true,true) vm
           JOIN case_revision cr ON cr.id=vm.case_revision_id`,
          [versionId],
        );
        const beforeById = new Map(
          before.rows.map((member) => [String(member.case_id), member]),
        );
        const afterById = new Map(
          after.rows.map((member) => [String(member.case_id), member]),
        );
        const facts = [
          ...new Set([...beforeById.keys(), ...afterById.keys()]),
        ].map((caseId) => {
          const previous = beforeById.get(caseId);
          const current = afterById.get(caseId);
          const changedFields =
            previous && current
              ? (
                  [
                    ["question", previous.input, current.input],
                    [
                      "expectedOutput",
                      previous.expected_output,
                      current.expected_output,
                    ],
                    ["metadata", previous.metadata, current.metadata],
                    ["source", previous.origin_ref, current.origin_ref],
                  ] as const
                )
                  .filter(
                    ([, oldValue, newValue]) =>
                      canonicalJson(oldValue) !== canonicalJson(newValue),
                  )
                  .map(([field]) => field)
              : [];
          return {
            caseId,
            changeType: !previous
              ? "added"
              : !current
                ? "removed"
                : changedFields.length
                  ? "modified"
                  : "unchanged",
            changedFields,
          };
        });
        await client.query(
          "DELETE FROM version_provenance_cut_fact WHERE version_id=$1",
          [versionId],
        );
        if (facts.length)
          await client.query(
            `INSERT INTO version_provenance_cut_fact
           (version_id,case_id,change_type,changed_fields)
           SELECT $1,x.case_id,x.change_type,x.changed_fields
             FROM jsonb_to_recordset($2::jsonb)
               AS x(case_id text,change_type text,changed_fields jsonb)`,
            [
              versionId,
              JSON.stringify(
                facts.map((fact) => ({
                  case_id: fact.caseId,
                  change_type: fact.changeType,
                  changed_fields: fact.changedFields,
                })),
              ),
            ],
          );
        await client.query(
          `INSERT INTO version_provenance_cut_state(version_id,parent_version_id)
           VALUES ($1,$2) ON CONFLICT (version_id) DO UPDATE
             SET parent_version_id=EXCLUDED.parent_version_id,completed_at=now()`,
          [versionId, parentId],
        );
      }
    }
    return boundaries.rows.map((row) => String(row.id));
  }

  async function clearVersionContent(
    client: PoolClient,
    versionIds: string[],
    status: "tombstoned" | "permanently_deleted",
    marker: string,
  ) {
    const objects = await client.query(
      `SELECT v.manifest_object_ref, v.cleanup_object_refs,
              cs.object_ref, cs.evidence_object_ref,
              cs.id AS candidate_id, cs.draft_revision_id, cs.draft_id
         FROM test_set_version v
         LEFT JOIN candidate_snapshot cs ON cs.id = v.candidate_id
        WHERE v.id = ANY($1::text[])`,
      [versionIds],
    );
    const objectRefs: string[] = [
      ...new Set(
        objects.rows.flatMap((row) =>
          [
            row.manifest_object_ref,
            row.object_ref,
            row.evidence_object_ref,
            ...storedStringArray(row.cleanup_object_refs),
          ].filter(
            (value): value is string =>
              typeof value === "string" && value.startsWith("blobs/"),
          ),
        ),
      ),
    ];
    const revisionRows = await client.query(
      `SELECT DISTINCT revision_id FROM (
         SELECT vm.case_revision_id AS revision_id FROM version_member vm
          WHERE vm.version_id = ANY($1::text[])
         UNION ALL
         SELECT ch.after_revision_id FROM version_change ch
          WHERE ch.version_id = ANY($1::text[]) AND ch.after_revision_id IS NOT NULL
         UNION ALL
         SELECT cm.case_revision_id FROM version_checkpoint_member cm
          WHERE cm.version_id = ANY($1::text[])
       ) refs`,
      [versionIds],
    );
    const revisionIds = revisionRows.rows.map((row) => String(row.revision_id));
    const candidateIds = objects.rows.map((row) => String(row.candidate_id));
    await client.query(
      "DELETE FROM version_export_cache WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_provenance_cut_fact WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_provenance_cut_state WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM candidate_item WHERE candidate_id = ANY($1::text[])",
      [candidateIds],
    );
    await client.query(
      "DELETE FROM candidate_transformation_run WHERE candidate_id = ANY($1::text[])",
      [candidateIds],
    );
    await client.query(
      "DELETE FROM version_checkpoint WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_change WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_member WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      `UPDATE candidate_snapshot cs
          SET status = 'tombstoned', object_ref = NULL,
              evidence_object_ref = NULL, item_count = 0,
              payload_hash = NULL, evidence_hash = NULL,
              recipe = NULL, sources = NULL, validation_report = NULL,
              attribution_revision_id = NULL, asset_id = NULL,
              parsed_view_id = NULL, schema_revision_id = NULL,
              draft_revision_id = NULL, base_version_id = NULL
         FROM test_set_version v
        WHERE v.id = ANY($1::text[]) AND cs.id = v.candidate_id`,
      [versionIds],
    );
    const draftRevisionIds = objects.rows
      .map((row) => row.draft_revision_id)
      .filter((id): id is string => typeof id === "string");
    if (draftRevisionIds.length)
      await client.query(
        `UPDATE draft_revision dr
            SET recipe = NULL, sources = NULL, operations = '[]'::jsonb,
                version_description = ''
          WHERE dr.id = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM candidate_snapshot cs
               WHERE cs.draft_revision_id = dr.id AND cs.status <> 'tombstoned'
            )`,
        [draftRevisionIds],
      );
    const draftIds = objects.rows.map((row) => String(row.draft_id));
    if (draftIds.length) {
      await client.query(
        `UPDATE draft_case_operation
            SET previous_content=NULL,diff=NULL
          WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
      await client.query(
        `UPDATE draft_revision dr SET operations=COALESCE(
           (SELECT jsonb_agg(op.value - 'previous_content' - 'diff'
                             ORDER BY op.ordinality)
              FROM jsonb_array_elements(dr.operations)
                   WITH ORDINALITY AS op(value,ordinality)),
           '[]'::jsonb)
          WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
    }
    const exclusiveDrafts = await client.query(
      `SELECT wd.id FROM working_draft wd
        WHERE wd.id=ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM candidate_snapshot cs
             WHERE cs.draft_id=wd.id AND cs.status<>'tombstoned'
          )`,
      [draftIds],
    );
    const exclusiveDraftIds = exclusiveDrafts.rows.map((row) => String(row.id));
    if (exclusiveDraftIds.length) {
      await client.query(
        `UPDATE working_draft
            SET status='abandoned',recipe=NULL,base_version_id=NULL,version_description=''
          WHERE id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
      await client.query(
        `UPDATE draft_case_operation
            SET input=NULL,expected_output=NULL,metadata=NULL,reason=NULL,
                previous_content=NULL,diff=NULL
          WHERE draft_id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
      await client.query(
        `UPDATE draft_revision
            SET recipe=NULL,sources=NULL,operations='[]'::jsonb,
                base_version_id=NULL,version_description=''
          WHERE draft_id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
    }
    if (draftIds.length) {
      const redacted = await client.query(
        `SELECT id,revision,recipe,sources,operations,schema_revision_id,
                base_version_id,version_description
           FROM draft_revision WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
      for (const row of redacted.rows) {
        const revisionHash = sha256(
          canonicalJson({
            revision: Number(row.revision),
            recipe: row.recipe,
            versionDescription: row.version_description,
            baseVersionId: row.base_version_id ?? null,
            schemaRevisionId: row.schema_revision_id ?? null,
            sources: row.sources,
            operations: row.operations,
          }),
        );
        await client.query(
          "UPDATE draft_revision SET revision_hash=$2 WHERE id=$1",
          [row.id, revisionHash],
        );
      }
    }
    if (revisionIds.length) {
      const protectedRows = await client.query(
        `SELECT DISTINCT revision_id FROM (
           SELECT vm.case_revision_id AS revision_id FROM version_member vm
           UNION ALL SELECT cm.case_revision_id FROM version_checkpoint_member cm
           UNION ALL SELECT ch.after_revision_id FROM version_change ch
             WHERE ch.after_revision_id IS NOT NULL
         ) refs WHERE revision_id = ANY($1::text[])`,
        [revisionIds],
      );
      const protectedIds = new Set(
        protectedRows.rows.map((row) => String(row.revision_id)),
      );
      const exclusiveIds = revisionIds.filter((id) => !protectedIds.has(id));
      if (exclusiveIds.length) {
        await client.query(
          "UPDATE version_change SET before_revision_id = NULL WHERE before_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "UPDATE candidate_item SET parent_case_revision_id = NULL WHERE parent_case_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "UPDATE case_revision SET parent_revision_id = NULL WHERE parent_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "DELETE FROM case_revision WHERE id = ANY($1::text[])",
          [exclusiveIds],
        );
      }
    }
    await client.query(
      `UPDATE test_set_version
          SET status = $2,
              item_count = 0,
              manifest_object_ref = $3,
              tombstoned_at = CASE WHEN $2 = 'tombstoned' THEN now() ELSE tombstoned_at END,
              cleanup_object_refs = $4::jsonb,
              cleanup_pending = true
        WHERE id = ANY($1::text[])`,
      [versionIds, status, marker, JSON.stringify(objectRefs)],
    );
    return objectRefs;
  }

  async function removeUnreferencedObjects(objectRefs: string[]) {
    for (const objectRef of objectRefs) {
      const references = await db.query(
        `SELECT 1 FROM (
           SELECT object_ref FROM data_asset
            WHERE object_ref = $1 AND status NOT IN ('deletion_pending', 'tombstoned')
           UNION ALL
           SELECT object_ref FROM pending_upload
            WHERE object_ref = $1 AND status IN ('previewable', 'confirmed')
           UNION ALL
           SELECT object_ref FROM candidate_snapshot
            WHERE object_ref = $1 AND status <> 'tombstoned'
           UNION ALL
           SELECT evidence_object_ref FROM candidate_snapshot
            WHERE evidence_object_ref = $1 AND status <> 'tombstoned'
           UNION ALL
           SELECT manifest_object_ref FROM test_set_version
            WHERE manifest_object_ref = $1 AND status IN ('published', 'trashed')
         ) refs LIMIT 1`,
        [objectRef],
      );
      if (!references.rowCount) await artifacts.remove(objectRef);
    }
  }

  async function finishTombstoneCleanup(
    versionId: string,
    objectRefs: string[],
  ) {
    await removeUnreferencedObjects(objectRefs);
    await db.query(
      `UPDATE test_set_version
          SET cleanup_object_refs = '[]'::jsonb, cleanup_pending = false
        WHERE id = $1 AND status = 'tombstoned'`,
      [versionId],
    );
  }

  function trashEntryResponse(row: Record<string, unknown>) {
    return {
      id: String(row.id),
      type: row.type,
      testSetId: row.test_set_id,
      testSetName: row.test_set_name,
      rootVersionId: row.root_version_id,
      rootVersionLabel: row.root_version_label,
      versionCount: Number(row.version_count),
      trashedAt: new Date(row.trashed_at as string).toISOString(),
      pendingCleanup: row.status === "purging",
    };
  }

  async function canManageProject(projectId: string, actorId: string) {
    return await hasProjectCapability(db, projectId, actorId, "manage");
  }

  app.post<{
    Params: { projectId: string; testSetId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (!isPlainObject(request.body) || Object.keys(request.body).length)
        return reply
          .code(422)
          .send({ error: { code: "trash_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const versions = await client.query(
          `SELECT id FROM test_set_version
            WHERE test_set_id = $1 AND status IN ('published', 'tombstoned', 'trashed')`,
          [request.params.testSetId],
        );
        const entryId = opaqueId("trash");
        await client.query(
          "UPDATE test_set SET status = 'trashed' WHERE id = $1",
          [request.params.testSetId],
        );
        await client.query(
          `UPDATE test_set_trash_entry
              SET status = 'restored', updated_at = now()
            WHERE test_set_id = $1 AND type = 'version_branch' AND status = 'trashed'`,
          [request.params.testSetId],
        );
        await client.query(
          `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, version_ids, status)
           VALUES ($1, $2, $3, 'test_set', $4::jsonb, 'trashed')`,
          [
            entryId,
            request.params.projectId,
            request.params.testSetId,
            JSON.stringify(versions.rows.map((row) => row.id)),
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(201)
          .send({ entry: { id: entryId, type: "test_set" } });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).some((key) => key !== "includeDescendants") ||
        (request.body.includeDescendants !== undefined &&
          typeof request.body.includeDescendants !== "boolean")
      )
        return reply
          .code(422)
          .send({ error: { code: "trash_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const branch = await versionBranch(
          client,
          request.params.testSetId,
          request.params.versionId,
        );
        if (!branch.length || branch[0].status !== "published") {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "version_not_found" } });
        }
        if (branch.some((row) => row.status !== "published")) {
          await client.query("COMMIT");
          return reply
            .code(409)
            .send({ error: { code: "version_branch_unavailable" } });
        }
        if (branch.length > 1 && request.body.includeDescendants !== true) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "version_branch_required" } });
        }
        const entryId = opaqueId("trash");
        const versionIds = branch.map((row) => String(row.id));
        await client.query(
          "UPDATE test_set_version SET status = 'trashed' WHERE id = ANY($1::text[])",
          [versionIds],
        );
        await client.query(
          `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, root_version_id, version_ids, status)
           VALUES ($1, $2, $3, 'version_branch', $4, $5::jsonb, 'trashed')`,
          [
            entryId,
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
            JSON.stringify(versionIds),
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          entry: {
            id: entryId,
            type: "version_branch",
            rootVersionId: request.params.versionId,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
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
    "/api/projects/:projectId/solo-test-set-trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some(
          (key) => !["limit", "offset"].includes(key),
        ) ||
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
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const entries = await db.query(
        `SELECT e.id, e.type, e.test_set_id, e.root_version_id, e.status, e.trashed_at,
                ts.name AS test_set_name, root.version_label AS root_version_label,
                jsonb_array_length(e.version_ids) AS version_count
           FROM test_set_trash_entry e
           JOIN test_set ts ON ts.id = e.test_set_id
           LEFT JOIN test_set_version root ON root.id = e.root_version_id
          WHERE e.project_id = $1 AND e.status IN ('trashed', 'purging')
          ORDER BY e.trashed_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
        [request.params.projectId, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::integer AS total FROM test_set_trash_entry
          WHERE project_id = $1 AND status IN ('trashed', 'purging')`,
        [request.params.projectId],
      );
      return {
        entries: entries.rows.map(trashEntryResponse),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.post<{
    Params: { projectId: string; entryId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-set-trash/:entryId/restore",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (!isPlainObject(request.body) || Object.keys(request.body).length)
        return reply
          .code(422)
          .send({ error: { code: "restore_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const entryIdentity = await client.query(
          `SELECT test_set_id FROM test_set_trash_entry
            WHERE id=$1 AND project_id=$2 AND status='trashed'`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entryIdentity.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        await client.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
          entryIdentity.rows[0].test_set_id,
        ]);
        const entry = await client.query(
          `SELECT * FROM test_set_trash_entry
            WHERE id = $1 AND project_id = $2 AND status = 'trashed' FOR UPDATE`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entry.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        const row = entry.rows[0];
        const versionIds = storedStringArray(row.version_ids);
        if (row.type === "test_set") {
          await client.query(
            "UPDATE test_set SET status = 'available' WHERE id = $1 AND status = 'trashed'",
            [row.test_set_id],
          );
        }
        await client.query(
          "UPDATE test_set_version SET status = 'published' WHERE id = ANY($1::text[]) AND status = 'trashed'",
          [versionIds],
        );
        await client.query(
          "UPDATE test_set_trash_entry SET status = 'restored', updated_at = now() WHERE id = $1",
          [row.id],
        );
        await client.query("COMMIT");
        return { restored: true };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/tombstone",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).length !== 1 ||
        typeof request.body.confirmation !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "tombstone_confirmation_required" } });
      const client = await db.connect();
      let objectRefs: string[] = [];
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set WHERE id=$1 AND project_id=$2 AND status='available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        const version = testSet.rowCount
          ? await client.query(
              `SELECT id,status,version_label,cleanup_object_refs,manifest_object_ref
             FROM test_set_version
            WHERE test_set_id=$1 AND id=$2 AND status IN ('published','tombstoned') FOR UPDATE`,
              [request.params.testSetId, request.params.versionId],
            )
          : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
        if (
          !version.rowCount ||
          request.body.confirmation !== String(version.rows[0].version_label)
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "tombstone_confirmation_required" } });
        }
        const descendants = version.rowCount
          ? await client.query(
              `SELECT 1 FROM test_set_version
                WHERE test_set_id = $1 AND parent_version_id = $2
                  AND status IN ('published', 'tombstoned', 'trashed') LIMIT 1`,
              [request.params.testSetId, request.params.versionId],
            )
          : { rowCount: 0 };
        if (!descendants.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "middle_version_required" } });
        }
        if (version.rows[0].status === "published") {
          await client.query(
            `UPDATE test_set_version
                SET status='tombstoned',tombstoned_at=now(),cleanup_pending=true
              WHERE id=$1`,
            [request.params.versionId],
          );
          await client.query(
            `DELETE FROM version_export_cache WHERE version_id IN (
               WITH RECURSIVE affected AS (
                 SELECT id FROM test_set_version WHERE id=$1
                 UNION ALL
                 SELECT child.id FROM test_set_version child
                   JOIN affected parent ON child.parent_version_id=parent.id
               ) SELECT id FROM affected
             )`,
            [request.params.versionId],
          );
          await client.query(
            `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id, details)
             VALUES ($1, $2, 'solo_test_set_version_tombstoned', 'test_set_version', $3, '{}')`,
            [request.params.projectId, actor.id, request.params.versionId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const cleanupClient = await db.connect();
      try {
        await cleanupClient.query("BEGIN");
        await cleanupClient.query(
          "SELECT id FROM test_set WHERE id=$1 FOR UPDATE",
          [request.params.testSetId],
        );
        const target = await cleanupClient.query(
          `SELECT manifest_object_ref,cleanup_object_refs
             FROM test_set_version WHERE id=$1 AND status='tombstoned' FOR UPDATE`,
          [request.params.versionId],
        );
        if (!target.rowCount) throw new Error("tombstone_target_missing");
        if (
          target.rows[0].manifest_object_ref !==
          `tombstone:${request.params.versionId}`
        ) {
          await protectDeletionBoundaries(
            cleanupClient,
            request.params.testSetId,
            [request.params.versionId],
            request.params.projectId,
          );
          objectRefs = await clearVersionContent(
            cleanupClient,
            [request.params.versionId],
            "tombstoned",
            `tombstone:${request.params.versionId}`,
          );
        } else {
          objectRefs = storedStringArray(target.rows[0].cleanup_object_refs);
        }
        await cleanupClient.query("COMMIT");
      } catch {
        await cleanupClient.query("ROLLBACK").catch(() => undefined);
        return reply
          .code(503)
          .send({ error: { code: "tombstone_cleanup_pending" } });
      } finally {
        cleanupClient.release();
      }
      try {
        await finishTombstoneCleanup(request.params.versionId, objectRefs);
        return { tombstoned: true };
      } catch {
        return reply
          .code(503)
          .send({ error: { code: "tombstone_cleanup_pending" } });
      }
    },
  );

  app.post<{
    Params: { projectId: string; entryId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-set-trash/:entryId/permanent-delete",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).length !== 1 ||
        typeof request.body.confirmation !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "permanent_delete_confirmation_required" } });
      const client = await db.connect();
      let objectRefs: string[] = [];
      try {
        await client.query("BEGIN");
        const entryIdentity = await client.query(
          `SELECT test_set_id FROM test_set_trash_entry
            WHERE id=$1 AND project_id=$2 AND status IN ('trashed','purging')`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entryIdentity.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        await client.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
          entryIdentity.rows[0].test_set_id,
        ]);
        const entry = await client.query(
          `SELECT * FROM test_set_trash_entry
            WHERE id = $1 AND project_id = $2 AND status IN ('trashed', 'purging') FOR UPDATE`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entry.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        const row = entry.rows[0];
        const testSet = await client.query(
          "SELECT name FROM test_set WHERE id = $1 FOR UPDATE",
          [row.test_set_id],
        );
        const expected =
          row.type === "test_set"
            ? String(testSet.rows[0]?.name ?? "")
            : String(
                (
                  await client.query(
                    "SELECT version_label FROM test_set_version WHERE id = $1 FOR UPDATE",
                    [row.root_version_id],
                  )
                ).rows[0]?.version_label ?? "",
              );
        if (!expected || request.body.confirmation !== expected) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "permanent_delete_confirmation_required" },
          });
        }
        objectRefs = storedStringArray(row.object_refs);
        if (row.status === "trashed") {
          const versionIds =
            row.type === "test_set"
              ? (
                  await client.query(
                    `SELECT id FROM test_set_version
                      WHERE test_set_id = $1
                        AND status IN ('published', 'tombstoned', 'trashed')`,
                    [row.test_set_id],
                  )
                ).rows.map((version) => String(version.id))
              : storedStringArray(row.version_ids);
          objectRefs = await clearVersionContent(
            client,
            versionIds,
            "permanently_deleted",
            `deleted:${row.id}`,
          );
          if (row.type === "test_set")
            await client.query(
              "UPDATE test_set SET status = 'permanently_deleted' WHERE id = $1",
              [row.test_set_id],
            );
          if (row.type === "test_set")
            await client.query(
              `UPDATE test_set_trash_entry
                  SET status = 'permanently_deleted', updated_at = now()
                WHERE test_set_id = $1 AND id <> $2
                  AND status IN ('trashed', 'purging')`,
              [row.test_set_id, row.id],
            );
          await client.query(
            "UPDATE test_set_trash_entry SET status = 'purging', object_refs = $2::jsonb, updated_at = now() WHERE id = $1",
            [row.id, JSON.stringify(objectRefs)],
          );
        }
        await client.query("COMMIT");
        const entryId = String(row.id);
        try {
          await removeUnreferencedObjects(objectRefs);
          await db.query(
            "UPDATE test_set_trash_entry SET status = 'permanently_deleted', updated_at = now() WHERE id = $1",
            [entryId],
          );
          return { permanentlyDeleted: true };
        } catch {
          return reply
            .code(503)
            .send({ error: { code: "delete_cleanup_pending" } });
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Querystring: { name?: string; limit?: string; offset?: string };
  }>("/api/projects", { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    const offset = request.query.offset ? Number(request.query.offset) : 0;
    if (
      Object.keys(request.query).some(
        (key) => !["name", "limit", "offset"].includes(key),
      ) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      (request.query.name !== undefined &&
        (request.query.name.trim().length === 0 ||
          request.query.name.length > 200))
    )
      return reply
        .code(422)
        .send({ error: { code: "query_parameter_invalid" } });
    const values: string[] = [actor.id];
    const filters = [
      actor.role === "admin" ? "TRUE" : "pm.user_id IS NOT NULL",
    ];
    if (request.query.name) {
      values.push(request.query.name.trim());
      filters.push(`p.name ILIKE '%' || $${values.length} || '%'`);
    }
    const projects = await db.query(
      `SELECT p.id, p.name, p.description, p.updated_at,
              count(DISTINCT c.id)::int AS dataset_count,
              count(DISTINCT ts.id)::int AS test_set_count
       FROM project p
       LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = $1
       LEFT JOIN raw_material_collection c ON c.project_id = p.id
       LEFT JOIN test_set ts ON ts.project_id = p.id
       WHERE ${filters.join(" AND ")}
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, String(limit), String(offset)],
    );
    const total = await db.query(
      `SELECT count(*)::text AS total
       FROM project p
       LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE ${filters.join(" AND ")}`,
      values,
    );
    return {
      projects: projects.rows.map(projectResponse),
      pagination: {
        total: Number(total.rows[0]?.total ?? 0),
        limit,
        offset,
      },
    };
  });

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

  async function parsePendingUpload(row: Record<string, unknown>) {
    const format = row.format as AssetFormat;
    return parseSourceRecords({
      assetId: String(row.id),
      parsedViewId: `pending-view:${row.id}`,
      parserVersion: PARSER_VERSION,
      bytes: await artifacts.read(String(row.object_ref)),
      format,
      config: defaultParserConfig(format) as never,
    });
  }

  function pendingResponse(
    row: Record<string, unknown>,
    parsed: Awaited<ReturnType<typeof parsePendingUpload>>,
  ) {
    return {
      id: row.id,
      fileName: row.file_name,
      format: row.format,
      size: Number(row.size_bytes),
      recordCount: parsed.summary.totalCount,
      fields: (parsed.summary.fieldProfiles ?? []).map((field) => ({
        path: field.path,
        sample: field.examples[0] ?? null,
      })),
      issues: [
        ...(parsed.summary.blockingErrors ?? []),
        ...parsed.records
          .filter((record) => record.parseStatus === "invalid")
          .slice(0, 10)
          .map((record) => record.error),
      ].filter(Boolean),
    };
  }

  app.post<{ Params: { projectId: string }; Body: Readable }>(
    "/api/projects/:projectId/pending-uploads",
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
        Object.keys(request.headers).some((header) =>
          /^(?:x-source-|x-responsible-|x-license-|x-sensitivity-|x-acquired-at$|x-deidentification-confirmed$)/u.test(
            header,
          ),
        )
      )
        return reply
          .code(422)
          .send({ error: { code: "upload_payload_invalid" } });
      const encoded =
        firstHeaderValue(request.headers["x-agentbench-upload-encoding"]) ===
        UPLOAD_HEADER_ENCODING;
      let fileName: string;
      try {
        fileName = decodeUploadHeader(
          firstHeaderValue(request.headers["x-file-name"]) ?? "",
          encoded,
        ).trim();
      } catch {
        return reply
          .code(400)
          .send({ error: { code: "upload_payload_invalid" } });
      }
      const format = assetFormat(fileName);
      if (!fileName || !format)
        return reply
          .code(415)
          .send({ error: { code: "unsupported_asset_format" } });
      let stored;
      try {
        stored = await artifacts.storeOriginal(
          opaqueId("pending"),
          request.body,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "asset_too_large")
          return reply.code(413).send({
            error: {
              code: "asset_too_large",
              actualBytes: (error as { observedBytes?: number }).observedBytes,
              limitBytes: CAPACITY_LIMITS.dataAssetBytes,
            },
          });
        throw error;
      }
      const row = {
        id: opaqueId("pending"),
        project_id: request.params.projectId,
        actor_id: actor.id,
        file_name: fileName,
        mime_type: String(
          request.headers["content-type"] ?? "application/octet-stream",
        ),
        format,
        blob_sha256: stored.sha256,
        object_ref: stored.objectRef,
        size_bytes: stored.size,
      };
      const parsed = await parsePendingUpload(row);
      const response = pendingResponse(row, parsed);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:upload-content:${row.project_id}:${row.blob_sha256}`,
        ]);
        const existingAsset = await client.query(
          `SELECT da.file_name, collection.name AS collection_name
             FROM data_asset da
             JOIN raw_material_collection collection ON collection.id = da.collection_id
            WHERE da.project_id = $1 AND da.blob_sha256 = $2
              AND da.status NOT IN ('deletion_pending', 'tombstoned')
            ORDER BY da.uploaded_at, da.id
            LIMIT 1`,
          [row.project_id, row.blob_sha256],
        );
        if (existingAsset.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "duplicate_upload",
              existingFileName: existingAsset.rows[0].file_name,
              existingCollectionName: existingAsset.rows[0].collection_name,
            },
          });
        }
        const existingPending = await client.query(
          `SELECT file_name FROM pending_upload
            WHERE project_id = $1 AND blob_sha256 = $2
              AND status = 'previewable' AND expires_at > now()
            ORDER BY created_at, id
            LIMIT 1`,
          [row.project_id, row.blob_sha256],
        );
        if (existingPending.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "duplicate_upload",
              existingFileName: existingPending.rows[0].file_name,
              existingCollectionName: null,
            },
          });
        }
        await client.query(
          `INSERT INTO pending_upload
           (id, project_id, actor_id, file_name, mime_type, format, blob_sha256,
            object_ref, size_bytes, status, parse_summary, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'previewable', $10,
                 now() + interval '24 hours')`,
          [
            row.id,
            row.project_id,
            row.actor_id,
            row.file_name,
            row.mime_type,
            row.format,
            row.blob_sha256,
            row.object_ref,
            row.size_bytes,
            response,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({ pendingUpload: response });
    },
  );

  app.put<{
    Params: { projectId: string; pendingUploadId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/pending-uploads/:pendingUploadId/preview",
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
      const mapping = isPlainObject(request.body)
        ? normalizeDisplayMapping(request.body.mapping, true)
        : undefined;
      if (!mapping)
        return reply
          .code(422)
          .send({ error: { code: "display_mapping_invalid" } });
      const pending = await db.query(
        `SELECT * FROM pending_upload
         WHERE id = $1 AND project_id = $2 AND actor_id = $3
           AND status = 'previewable' AND expires_at > now()`,
        [request.params.pendingUploadId, request.params.projectId, actor.id],
      );
      if (!pending.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "pending_upload_not_found" } });
      const row = pending.rows[0];
      const parsed = await parsePendingUpload(row);
      const response = pendingResponse(row, parsed);
      const preview = parsed.records
        .filter((record) => record.parseStatus === "valid")
        .slice(0, 5)
        .map((record) => mapMaterialRecord(record.fields, mapping));
      await db.query(
        `UPDATE pending_upload
         SET display_mapping = $4, parse_summary = $5, updated_at = now()
         WHERE id = $1 AND project_id = $2 AND actor_id = $3`,
        [row.id, request.params.projectId, actor.id, mapping, response],
      );
      return { ...response, preview };
    },
  );

  app.delete<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/pending-upload-batches",
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
      const ids =
        isPlainObject(request.body) &&
        Object.keys(request.body).length === 1 &&
        Array.isArray(request.body.pendingUploadIds) &&
        request.body.pendingUploadIds.every((id) => typeof id === "string")
          ? request.body.pendingUploadIds
          : undefined;
      if (!ids?.length || new Set(ids).size !== ids.length)
        return reply
          .code(422)
          .send({ error: { code: "pending_upload_batch_invalid" } });
      const cancelled = await db.query(
        `UPDATE pending_upload SET status = 'cancelled', updated_at = now()
         WHERE id = ANY($1::text[]) AND project_id = $2 AND actor_id = $3
           AND status = 'previewable'`,
        [ids, request.params.projectId, actor.id],
      );
      if (cancelled.rowCount !== ids.length)
        return reply
          .code(404)
          .send({ error: { code: "pending_upload_not_found" } });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/pending-upload-batches/confirm",
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
      const ids =
        isPlainObject(body) &&
        Object.keys(body).every((key) =>
          ["collectionId", "pendingUploadIds"].includes(key),
        ) &&
        typeof body.collectionId === "string" &&
        Array.isArray(body.pendingUploadIds) &&
        body.pendingUploadIds.every((id) => typeof id === "string")
          ? body.pendingUploadIds
          : undefined;
      const collectionId = isPlainObject(body) ? body.collectionId : undefined;
      const idempotencyKey = firstHeaderValue(
        request.headers["idempotency-key"],
      );
      if (!ids?.length || new Set(ids).size !== ids.length || !idempotencyKey)
        return reply
          .code(422)
          .send({ error: { code: "pending_upload_batch_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:confirmed-upload:${request.params.projectId}:${actor.id}:${idempotencyKey}`,
        ]);
        const replay = await client.query(
          `SELECT receipt FROM confirmed_upload_batch
           WHERE project_id = $1 AND actor_id = $2 AND idempotency_key = $3 FOR UPDATE`,
          [request.params.projectId, actor.id, idempotencyKey],
        );
        if (replay.rowCount) {
          await client.query("COMMIT");
          return { assets: replay.rows[0].receipt, replayed: true };
        }
        const collection = await client.query(
          `SELECT id FROM raw_material_collection
           WHERE id = $1 AND project_id = $2`,
          [collectionId, request.params.projectId],
        );
        if (!collection.rowCount) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "collection_not_found" } });
        }
        const pending = await client.query(
          `SELECT * FROM pending_upload
           WHERE id = ANY($1::text[]) AND project_id = $2 AND actor_id = $3
             AND status = 'previewable' AND expires_at > now() FOR UPDATE`,
          [ids, request.params.projectId, actor.id],
        );
        if (pending.rowCount !== ids.length) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "pending_upload_not_found" } });
        }
        const rows = pending.rows.sort(
          (left, right) => ids.indexOf(left.id) - ids.indexOf(right.id),
        );
        const hashes = [
          ...new Set(rows.map((row) => String(row.blob_sha256))),
        ].sort();
        for (const hash of hashes)
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `agentbench:upload-content:${request.params.projectId}:${hash}`,
          ]);
        if (hashes.length !== rows.length) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: "duplicate_upload" } });
        }
        const existingAssets = await client.query(
          `SELECT 1 FROM data_asset
            WHERE project_id = $1 AND blob_sha256 = ANY($2::text[])
              AND status NOT IN ('deletion_pending', 'tombstoned')
            LIMIT 1`,
          [request.params.projectId, hashes],
        );
        if (existingAssets.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: "duplicate_upload" } });
        }
        const parsed = await Promise.all(
          rows.map((row) => parsePendingUpload(row)),
        );
        if (
          rows.some(
            (row, index) =>
              !row.display_mapping ||
              parsed[index].summary.blockingErrors?.length,
          )
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "pending_upload_not_previewable" } });
        }
        const assets: Array<{
          id: string;
          fileName: string;
          format: string;
          size: number;
        }> = [];
        for (const [index, row] of rows.entries()) {
          const assetId = opaqueId("asset");
          const parsedViewId = opaqueId("view");
          const parserConfig = defaultParserConfig(row.format as AssetFormat);
          await client.query(
            `INSERT INTO data_asset
               (id, project_id, collection_id, blob_sha256, object_ref, size_bytes,
                mime_type, file_name, format, status, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stored', $10)`,
            [
              assetId,
              request.params.projectId,
              collectionId,
              row.blob_sha256,
              row.object_ref,
              row.size_bytes,
              row.mime_type,
              row.file_name,
              row.format,
              actor.id,
            ],
          );
          await client.query(
            `INSERT INTO source_attribution_revision
               (id, asset_id, source_type, source_name, purpose, responsible_actor,
                responsible_person, license_status, sensitivity, source_address,
                acquired_at, deidentification_confirmed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, false)`,
            [
              opaqueId("attr"),
              assetId,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sourceType,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sourceName,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.purpose,
              actor.id,
              actor.username,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.licenseStatus,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sensitivity,
            ],
          );
          await client.query(
            `INSERT INTO parsed_view
               (id, asset_id, format, parser_name, parser_version, parser_config,
                parser_config_hash, display_mapping, status, record_count,
                success_count, failure_count, boundary_trusted, draft_eligible,
                is_current, field_summary, error_summary)
             VALUES ($1, $2, $3, 'format-adapter', $4, $5, $6, $7, 'ready',
                     $8, $9, $10, $11, $12, true, $13, $14)`,
            [
              parsedViewId,
              assetId,
              row.format,
              PARSER_VERSION,
              parserConfig,
              sha256(canonicalJson(parserConfig)),
              JSON.stringify(row.display_mapping as DisplayMapping),
              parsed[index].summary.totalCount,
              parsed[index].summary.successCount,
              parsed[index].summary.failureCount,
              parsed[index].summary.boundaryTrusted,
              parsed[index].summary.draftEligible,
              JSON.stringify(parsed[index].summary.fieldProfiles ?? []),
              JSON.stringify(parsed[index].summary.blockingErrors ?? []),
            ],
          );
          for (const record of parsed[index].records)
            await client.query(
              `INSERT INTO source_record
                 (parsed_view_id, ordinal, value, locator, record_hash, parse_status, parse_error)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                parsedViewId,
                record.ordinal,
                JSON.stringify(record.fields),
                JSON.stringify(record.locator),
                record.recordHash,
                record.parseStatus,
                record.error ? JSON.stringify(record.error) : null,
              ],
            );
          assets.push({
            id: assetId,
            fileName: row.file_name,
            format: row.format,
            size: Number(row.size_bytes),
          });
        }
        await client.query(
          `UPDATE pending_upload SET status = 'confirmed', updated_at = now()
           WHERE id = ANY($1::text[])`,
          [ids],
        );
        await client.query(
          `INSERT INTO confirmed_upload_batch
             (project_id, actor_id, idempotency_key, collection_id, receipt)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            request.params.projectId,
            actor.id,
            idempotencyKey,
            collectionId,
            JSON.stringify(assets),
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({ assets });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

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
