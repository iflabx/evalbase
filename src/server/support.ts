import { createHash, randomUUID } from "node:crypto";
import { type FastifyInstance, type FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import {
  isAllowedSourceAttribution,
  type SourceAttributionInput,
} from "../attribution.js";
import { CAPACITY_LIMITS } from "../capacity.js";
import { type Config } from "../config.js";
import { type Database } from "../db/pool.js";
import { canonicalSourcePath, sourceValueAt } from "../mapping/index.js";
import { evaluateRecipe, recipeSteps } from "../recipe/index.js";
import { hashPassword } from "../security/password.js";
import {
  capabilitiesForRole,
  isTestIdentityRole,
  type ProjectCapabilities,
} from "../security/project-access.js";
import { ArtifactRepository } from "../storage/artifacts.js";

export type AgentBenchApp = FastifyInstance;

export interface AppDependencies {
  now?: () => Date;
  artifacts?: ArtifactRepository;
  disableLegacyTestBootstrap?: boolean;
}

export interface AuthenticatedRequest extends FastifyRequest {
  actor: SessionActor;
}

export interface SessionActor {
  id: string;
  username: string;
  role: string;
  projectRole: string | null;
  capabilities: ProjectCapabilities;
  testIdentity: boolean;
  csrfToken: string;
}

export function sessionActor(
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

export function publicSessionActor(actor: SessionActor) {
  return {
    id: actor.id,
    username: actor.username,
    role: actor.role,
    projectRole: actor.projectRole,
    capabilities: actor.capabilities,
    testIdentity: actor.testIdentity,
  };
}

export function requestIdentifiers(request: FastifyRequest) {
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

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

export async function resetCancelledGenerationJob(
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

export function selectedSourceRows(
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

export function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function bootstrapOwner(
  db: Database,
  config: Config,
): Promise<void> {
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

export async function ensureUnfiledCollection(
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

export function assetResponse(row: Record<string, unknown>, username: string) {
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

export function collectionResponse(row: Record<string, unknown>) {
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

export function projectResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    datasetCount: Number(row.dataset_count ?? 0),
    testSetCount: Number(row.test_set_count ?? 0),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export function transformationRunResponse(row: Record<string, unknown>) {
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

export function attributionResponse(row: Record<string, unknown>) {
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

export function attributionInput(
  value: unknown,
): SourceAttributionInput | undefined {
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

export function parsedViewNotDraftEligibleError(
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

export function attributionFromRow(row: Record<string, any>) {
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

export async function verifiedPromptReference(
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

export function sourceSnapshotFromRow(row: Record<string, any>) {
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

export function isAllowedSourceSnapshot(source: Record<string, any>): boolean {
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

export type AssetFormat = "csv" | "json" | "jsonl";

export type DisplayMapping = {
  question?: string;
  expectedOutput?: string;
  metadata: string[];
};

export const CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE = {
  sourceType: "owner_confirmed_nonproduction",
  sourceName: "Owner-confirmed permitted non-production environment",
  purpose: "confirmed upload",
  licenseStatus: "environment_confirmed",
  sensitivity: "non_sensitive",
} as const;

export const PARSER_VERSION = "parser-contract-v1";

export const MATERIALIZER_VERSION = "candidate-v1";

export function assetFormat(fileName: unknown): AssetFormat | undefined {
  const extension = String(fileName ?? "")
    .toLowerCase()
    .match(/\.([^.]+)$/u)?.[1];
  return extension === "csv" || extension === "json" || extension === "jsonl"
    ? extension
    : undefined;
}

export function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function defaultParserConfig(
  format: AssetFormat,
): Record<string, unknown> {
  if (format === "csv") {
    return { encoding: "auto", delimiter: ",", headerRow: 1, quote: '"' };
  }
  if (format === "json") return { recordPath: "" };
  return {};
}

export function normalizeDisplayMapping(
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

export function displayText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

export type MetadataEntry = { key: string; value: string };

export function normalizeMetadataEntries(
  value: unknown,
): MetadataEntry[] | undefined {
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

export function readMetadataEntries(value: unknown): MetadataEntry[] {
  if (isPlainObject(value) && Array.isArray(value.entries))
    return normalizeMetadataEntries(value.entries) ?? [];
  if (isPlainObject(value) && typeof value.text === "string")
    return [{ key: "Metadata", value: value.text }];
  if (typeof value === "string") return [{ key: "Metadata", value }];
  return value === null || value === undefined
    ? []
    : [{ key: "Metadata", value: displayText(value) }];
}

export function metadataText(entries: MetadataEntry[]): string {
  return entries.map((entry) => `${entry.key}：${entry.value}`).join("\n");
}

export function displayFieldName(path: string): string {
  const segment = path.split("/").at(-1) ?? path;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function mappedDisplayValue(
  fields: unknown,
  path: string | undefined,
): string {
  if (!path) return "";
  const result = sourceValueAt(fields, path);
  return result.found ? displayText(result.value) : "";
}

export function mapMaterialRecord(fields: unknown, mapping: DisplayMapping) {
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

export function utf8Prefix(bytes: Buffer, maximumBytes: number): string {
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

export function normalizeParserConfig(
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
