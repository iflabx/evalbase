import { processingRecovery } from "./recovery.js";
import {
  guardAssistantCommit,
  linkAssistantProcessing,
  type AssistantGuard,
} from "../assistant/fence.js";
import type { PoolClient } from "pg";
import {
  freezeBackground,
  type BackgroundSnapshot,
} from "../assistant/background.js";
import { cleanupProcessingObjects } from "./cleanup.js";
import { deduplicate } from "./deduplication.js";
import { attachProcessingRound, guardProcessingTask } from "./task-state.js";
import type { TaskRound, TaskSave } from "./task-state.js";
import {
  filterProcessingRecords,
  processingSourceSummary,
} from "./presentation.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  isPlainObject,
  opaqueId,
  mapMaterialRecord,
  normalizeDisplayMapping,
  displayFieldName,
  displayText,
  readMetadataEntries,
} from "../server/support.js";
import {
  processingOptions,
  generatesRecords,
  PROCESSING_EXECUTION,
  type ProcessingInput,
  type ProcessingOptions,
  type ProcessingResult,
} from "./protocol.js";
import {
  createGenerationPlan,
  GENERATION_RECIPE,
  type GenerationPlan,
} from "./generation.js";

export class ProcessingError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export type ProcessingScope = {
  projectId: string;
  actorId: string;
  assistantGuard?: AssistantGuard;
  expectedInputHash?: string;
  /** Frozen by the assistant confirmation; never accepted from a public processing body. */
  acceptanceGroups?: { runId: string; resultIds: string[] }[];
  /** Internal completion context, derived from immutable results, never a public body. */
  completionBaseline?: ProcessingResult["records"];
  /** Resolved and fenced by the task service, never trusted from a run request. */
  taskRound?: TaskRound;
  taskSave?: TaskSave;
  /** Frozen by the assistant's task review; never read from a public processing body. */
  assistantResultsGuard?: {
    states: { id: string; revision: number }[];
    excludedGroups?: { runId: string; resultIds: string[] }[];
  };
};
export type ProcessingSource =
  | { kind: "assets"; assetIds: string[]; recordIds: string[] }
  | {
      kind: "draft" | "version" | "background";
      id: string;
      recordIds: string[];
    };
export type CandidateOrigin = { runId: string; resultId: string };
export type InputSnapshot = {
  generation?: GenerationPlan;
  deduplicationBaseline?: Pick<
    ProcessingInput,
    "question" | "expectedOutput" | "metadata"
  >[];
  background?: BackgroundSnapshot;
  records: (ProcessingInput & {
    candidateOrigin?: CandidateOrigin;
    taskRecordKey?: string;
    adoptionOperation?: ProcessingOptions["operation"];
    adoptionFields?: ProcessingOptions["allowedFields"];
    baseline?: ProcessingInput & {
      source?: unknown;
      revisions?: Record<string, number>;
    };
    source?: unknown;
    revisions?: Record<string, number>;
  })[];
  source: ProcessingSource;
  revision?: number;
  continuation?: {
    parentRunId: string;
    kind: "continue" | "rerun";
    inputParentRunId?: string;
    inputRootOperation: ProcessingOptions["operation"];
    rootOperation: ProcessingOptions["operation"];
    adoptionFields: ProcessingOptions["allowedFields"];
  };
  refinement?: {
    parentRunId: string;
    selectedIds: string[];
    rootOperation: ProcessingOptions["operation"];
    adoptionFields: ProcessingOptions["allowedFields"];
  };
};
export type ProcessingRun = {
  continuation_kind?: "continue" | "rerun";
  id: string;
  project_id: string;
  actor_id: string;
  job_id: string;
  parent_run_id?: string | null;
  background_document_ids: string[];
  has_execution_issues?: boolean;
  request_hash: string;
  source: ProcessingSource;
  options: ProcessingOptions;
  input_ref: string | null;
  input_hash: string;
  model_revision: number | null;
  input_count: number;
  execution_config: Omit<typeof PROCESSING_EXECUTION, "recipeVersion"> & {
    recipeVersion: string;
  };
  output_count?: number;
  issue_count?: number;
  target_draft_id: string | null;
  created_at: Date;
  status: string;
  progress: number;
  error_code: string | null;
  result: unknown;
};

export async function processingAccess(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  lock = false,
  capability: "read" | "write" = "write",
) {
  if (lock) {
    await db.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
      scope.actorId,
    ]);
    await db.query(
      "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
      [scope.projectId, scope.actorId],
    );
  }
  if (
    !(await hasProjectCapability(
      db,
      scope.projectId,
      scope.actorId,
      capability,
    ))
  )
    throw new ProcessingError(404, "processing_not_found");
}

function strings(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 250,
    ) &&
    new Set(value).size === value.length
  );
}
function parseSource(value: unknown, generation = false): ProcessingSource {
  if (
    generation &&
    isPlainObject(value) &&
    value.kind === "background" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 250 &&
    Array.isArray(value.recordIds) &&
    !value.recordIds.length &&
    Object.keys(value).every((key) => ["kind", "id", "recordIds"].includes(key))
  )
    return { kind: "background", id: value.id, recordIds: [] };
  if (!isPlainObject(value) || !strings(value.recordIds, 10000))
    throw new ProcessingError(422, "processing_scope_invalid");
  if (
    value.kind === "assets" &&
    strings(value.assetIds, 5) &&
    Object.keys(value).every((k) =>
      ["kind", "assetIds", "recordIds"].includes(k),
    )
  )
    return {
      kind: "assets",
      assetIds: [...value.assetIds].sort(),
      recordIds: [...value.recordIds].sort(),
    };
  if (
    (value.kind === "draft" || value.kind === "version") &&
    typeof value.id === "string" &&
    value.id.length <= 250 &&
    Object.keys(value).every((k) => ["kind", "id", "recordIds"].includes(k))
  )
    return {
      kind: value.kind,
      id: value.id,
      recordIds: [...value.recordIds].sort(),
    };
  throw new ProcessingError(422, "processing_scope_invalid");
}

/** Batch metadata only; these are the same source guards used for body access. */
export async function processingSourceRows(
  db: Pick<Database, "query">,
  projectId: string,
  sources: ProcessingSource[],
  lock = false,
) {
  const assets = [
    ...new Set(
      sources.flatMap((source) =>
        source.kind === "assets" ? source.assetIds : [],
      ),
    ),
  ];
  const versions = [
    ...new Set(
      sources.flatMap((source) =>
        source.kind === "version" ? [source.id] : [],
      ),
    ),
  ];
  const drafts = [
    ...new Set(
      sources.flatMap((source) => (source.kind === "draft" ? [source.id] : [])),
    ),
  ];
  const assetRows = assets.length
    ? (
        await db.query(
          `SELECT da.id,da.file_name,da.collection_id FROM data_asset da WHERE da.project_id=$1 AND da.id=ANY($2::text[])
      AND da.status='stored' AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id=da.id)
      ${lock ? "FOR SHARE OF da" : ""}`,
          [projectId, assets],
        )
      ).rows
    : [];
  const versionRows = versions.length
    ? (
        await db.query(
          `SELECT v.id,ts.id AS test_set_id,ts.name,v.version_label FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
      WHERE v.id=ANY($2::text[]) AND ts.project_id=$1 AND v.status='published' AND ts.status='available'
      AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(v.id,ts.id))
      ${lock ? "FOR SHARE OF ts,v" : ""}`,
          [projectId, versions],
        )
      ).rows
    : [];
  if (drafts.length && lock)
    await db.query(
      "SELECT id FROM collaborative_draft WHERE id=ANY($1::text[]) AND project_id=$2 FOR SHARE",
      [drafts, projectId],
    );
  const draftRows = drafts.length
    ? (
        await db.query(
          `SELECT d.id,d.name FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id
      LEFT JOIN test_set_version v ON v.id=d.parent_version_id LEFT JOIN test_set_version published ON published.id=d.published_version_id
      WHERE d.id=ANY($2::text[]) AND d.project_id=$1 AND (d.status='editing' OR (d.status='published' AND published.status='published'))
      AND (ts.id IS NULL OR ts.status='available') AND (v.id IS NULL OR v.status='published')
      AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(d.id,ts.id,v.id))`,
          [projectId, drafts],
        )
      ).rows
    : [];
  const sessions = sources.flatMap((source) =>
    source.kind === "background" ? [source.id] : [],
  );
  const background = sessions.length
    ? (
        await db.query(
          `SELECT s.id FROM assistant_session s WHERE s.project_id=$1 AND s.id=ANY($2::text[]) AND EXISTS(SELECT 1 FROM assistant_background_document d WHERE d.session_id=s.id) ${lock ? "FOR SHARE OF s" : ""}`,
          [projectId, sessions],
        )
      ).rows
    : [];
  return {
    assets: assetRows,
    version: versionRows,
    draft: draftRows,
    background,
  };
}

// Read availability on every body access; a saved snapshot does not bypass recycling or deletion.
export async function processingSourceAvailable(
  db: Pick<Database, "query">,
  projectId: string,
  source: ProcessingSource,
  lock = false,
) {
  const rows = (await processingSourceRows(db, projectId, [source], lock))[
    source.kind
  ];
  if (
    source.kind === "assets"
      ? rows.length !== source.assetIds.length
      : !rows.length
  )
    throw new ProcessingError(409, "processing_source_unavailable");
}

async function snapshot(
  client: PoolClient,
  projectId: string,
  source: ProcessingSource,
): Promise<InputSnapshot> {
  await processingSourceAvailable(client, projectId, source, true);
  if (source.kind === "background") return { source, records: [] };
  let records: InputSnapshot["records"];
  let revision: number | undefined;
  if (source.kind === "assets") {
    const assets = await client.query(
      `SELECT da.id,da.size_bytes,pv.id AS view_id,pv.display_mapping,pv.mapping_ready
      FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
      WHERE da.project_id=$1 AND da.id=ANY($2::text[]) ORDER BY da.id FOR SHARE OF pv`,
      [projectId, source.assetIds],
    );
    if (assets.rowCount !== source.assetIds.length)
      throw new ProcessingError(409, "processing_source_unavailable");
    if (assets.rows.reduce((n, r) => n + Number(r.size_bytes), 0) > 100000000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    const byView = new Map(assets.rows.map((row) => [row.view_id, row]));
    const rows = await client.query(
      `SELECT sr.* FROM source_record sr JOIN parsed_view pv ON pv.id=sr.parsed_view_id
      WHERE sr.parsed_view_id=ANY($1::text[]) AND sr.parse_status='valid'
      AND concat(pv.asset_id,':',sr.ordinal)=ANY($2::text[]) ORDER BY pv.asset_id,sr.ordinal`,
      [[...byView.keys()], source.recordIds],
    );
    records = rows.rows.map((row) => {
      const asset = byView.get(row.parsed_view_id)!;
      return {
        id: `${asset.id}:${row.ordinal}`,
        ...mapMaterialRecord(
          row.value,
          normalizeDisplayMapping(asset.display_mapping) ?? { metadata: [] },
        ),
        ...(!asset.mapping_ready ? { raw: row.value } : {}),
        source: {
          assetId: asset.id,
          parsedViewId: asset.view_id,
          ordinal: row.ordinal,
        },
      };
    });
  } else if (source.kind === "draft") {
    const draft = await client.query(
      "SELECT revision FROM collaborative_draft WHERE id=$1",
      [source.id],
    );
    revision = Number(draft.rows[0].revision);
    const rows = await client.query(
      "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false ORDER BY position,id FOR SHARE",
      [source.id, source.recordIds],
    );
    records = rows.rows.map((row) => ({
      id: row.id,
      question: row.question,
      expectedOutput: row.expected_output,
      metadata: row.metadata,
      source: row.source,
      revisions: {
        question: Number(row.question_revision),
        expectedOutput: Number(row.expected_output_revision),
        metadata: Number(row.metadata_revision),
      },
    }));
  } else {
    const rows = await client.query(
      `SELECT vm.case_id,cr.input,cr.expected_output,cr.metadata,cr.origin_ref FROM resolve_version_members($1) vm
      JOIN case_revision cr ON cr.id=vm.case_revision_id WHERE vm.case_id=ANY($2::text[]) ORDER BY vm.ordinal`,
      [source.id, source.recordIds],
    );
    records = rows.rows.map((row) => ({
      id: row.case_id,
      question: isPlainObject(row.input)
        ? String(row.input.question ?? "")
        : displayText(row.input),
      expectedOutput: isPlainObject(row.expected_output)
        ? String(row.expected_output.text ?? "")
        : displayText(row.expected_output),
      metadata: readMetadataEntries(row.metadata),
      source: row.origin_ref,
    }));
  }
  if (records.length !== source.recordIds.length)
    throw new ProcessingError(409, "processing_scope_changed");
  const result = {
    source,
    records,
    ...(revision === undefined ? {} : { revision }),
  };
  if (Buffer.byteLength(canonicalJson(result)) > 100000000)
    throw new ProcessingError(422, "processing_capacity_exceeded");
  return result;
}

function missingCount(row: ProcessingRun) {
  const expected = generatesRecords(row.options.operation)
    ? (row.options.outputCount ?? row.input_count)
    : row.input_count;
  return Math.max(0, expected - Number(row.output_count ?? 0));
}

export function processingRunSummary(row: ProcessingRun) {
  return {
    id: row.id,
    taskId: (row as ProcessingRun & { task_id?: string }).task_id,
    parentRunId: row.parent_run_id ?? null,
    continuationKind: row.continuation_kind ?? null,
    jobId: row.job_id,
    source: row.source,
    options: row.options,
    inputCount: row.input_count,
    modelRevision: row.model_revision,
    execution: row.execution_config,
    outputCount: Number(row.output_count ?? 0),
    missingCount: missingCount(row),
    executionComplete:
      row.status === "succeeded" &&
      missingCount(row) === 0 &&
      row.has_execution_issues === false &&
      !row.error_code &&
      !(
        isPlainObject(row.result) &&
        row.result.partial === true &&
        Number(row.issue_count ?? 0) === 0
      ),
    partial:
      (row.status === "failed" && Number(row.output_count) > 0) ||
      (row.status === "succeeded" && Number(row.issue_count) > 0),
    targetDraftId: row.target_draft_id,
    status: row.status,
    progress: row.progress,
    errorCode: row.error_code,
    createdAt: row.created_at,
    result: row.result,
  };
}
const summary = processingRunSummary;
export const runStatusColumns =
  "j.payload->>'continuationKind' AS continuation_kind,j.status,j.progress,j.error_code,(SELECT coalesce(sum(output_count),0) FROM processing_batch WHERE run_id=r.id AND result_ref IS NOT NULL) AS output_count,(SELECT coalesce(sum(jsonb_array_length(issues)),0) FROM processing_batch WHERE run_id=r.id) AS issue_count,EXISTS(SELECT 1 FROM processing_batch pb CROSS JOIN LATERAL jsonb_array_elements(pb.issues) issue WHERE pb.run_id=r.id AND issue->>'code' NOT IN('empty_question','duplicate_content')) AS has_execution_issues";
const selectRun = `SELECT r.*,j.result,${runStatusColumns} FROM processing_run r JOIN job j ON j.id=r.job_id`;
export async function getProcessingRun(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  runId: string,
  lock = false,
) {
  await processingAccess(db, scope);
  const result = await db.query<ProcessingRun>(
    `${selectRun} WHERE r.id=$1 AND r.project_id=$2 AND (cardinality(r.background_document_ids)=0 OR r.actor_id=$3) ${lock ? "FOR UPDATE OF r,j" : ""}`,
    [runId, scope.projectId, scope.actorId],
  );
  const row = result.rows[0];
  if (!row || !row.input_ref)
    throw new ProcessingError(404, "processing_not_found");
  await processingSourceAvailable(db, scope.projectId, row.source, lock);
  return row;
}
export async function createProcessingRun(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  key: unknown,
  input: unknown,
) {
  await processingAccess(db, scope);
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    !isPlainObject(input) ||
    Object.keys(input).some(
      (k) => !["source", "options", "targetDraftId"].includes(k),
    ) ||
    (input.targetDraftId !== undefined &&
      (typeof input.targetDraftId !== "string" ||
        input.targetDraftId.length > 250))
  )
    throw new ProcessingError(422, "processing_request_invalid");
  let options: ProcessingOptions;
  try {
    options = processingOptions(input.options);
  } catch {
    throw new ProcessingError(422, "processing_configuration_invalid");
  }
  const source = parseSource(input.source, options.operation === "generate");
  if (
    (options.operation === "generate") !== (source.kind === "background") ||
    (source.kind === "background" &&
      source.id !== scope.assistantGuard?.sessionId)
  )
    throw new ProcessingError(422, "processing_scope_invalid");
  const target =
    typeof input.targetDraftId === "string"
      ? input.targetDraftId
      : source.kind === "draft"
        ? source.id
        : null;
  const digest = sha256(
    canonicalJson({
      source,
      options,
      target,
      ...(scope.taskRound
        ? {
            task: {
              id: scope.taskRound.taskId,
              revision: scope.taskRound.expectedRevision,
              kind: scope.taskRound.kind,
            },
          }
        : {}),
      ...(scope.expectedInputHash
        ? { expectedInputHash: scope.expectedInputHash }
        : {}),
    }),
  );
  const client = await db.connect();
  let storedInput: string | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing:${scope.projectId}:${scope.actorId}:${key}`,
    ]);
    const prior = await client.query<ProcessingRun>(
      `${selectRun} WHERE r.project_id=$1 AND r.actor_id=$2 AND r.idempotency_key=$3`,
      [scope.projectId, scope.actorId, key],
    );
    await processingAccess(client, scope, true);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== digest)
        throw new ProcessingError(409, "idempotency_conflict");
      const run = await getProcessingRun(client, scope, prior.rows[0].id);
      await client.query("COMMIT");
      return { run: summary(run), replayed: true };
    }
    await guardProcessingTask(client, scope);
    const data = await snapshot(client, scope.projectId, source);
    if (scope.taskRound?.recordKeys)
      data.records = data.records.map((row) => ({
        ...row,
        taskRecordKey: scope.taskRound!.recordKeys![row.id],
      }));
    if (
      scope.expectedInputHash &&
      scope.expectedInputHash !==
        sha256(
          canonicalJson({
            records: data.records,
            revision: data.revision ?? null,
          }),
        )
    )
      throw new ProcessingError(409, "processing_scope_changed");
    if (target)
      await processingSourceAvailable(
        client,
        scope.projectId,
        { kind: "draft", id: target, recordIds: [] },
        true,
      );
    if (
      target &&
      !(
        await client.query(
          "SELECT id FROM collaborative_draft WHERE id=$1 AND status='editing'",
          [target],
        )
      ).rowCount
    )
      throw new ProcessingError(409, "processing_source_unavailable");
    if (
      generatesRecords(options.operation) &&
      (target || source.kind === "draft")
    ) {
      const baseline = await client.query(
        "SELECT question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false ORDER BY position,id FOR SHARE",
        [target || (source as { id: string }).id],
      );
      data.deduplicationBaseline = baseline.rows.map((row) => ({
        question: row.question,
        expectedOutput: row.expected_output,
        metadata: row.metadata,
      }));
    }
    let modelRevision: number | null = null;
    if (options.operation !== "clean" || options.instructions) {
      const model = await client.query(
        "SELECT revision,enabled FROM model_connection ORDER BY revision DESC LIMIT 1",
      );
      if (!model.rows[0]?.enabled)
        throw new ProcessingError(409, "model_connection_unavailable");
      modelRevision = Number(model.rows[0].revision);
    } else if (data.records.some((row) => row.raw !== undefined))
      throw new ProcessingError(422, "processing_mapping_required");
    await guardAssistantCommit(client, scope);
    if (scope.assistantGuard) {
      const background = await freezeBackground(
        client,
        scope,
        scope.assistantGuard.sessionId,
        { options, records: data.records, source: data.source },
      );
      if (background) data.background = background;
    }
    if (
      options.operation === "generate" &&
      !data.background?.documents.length
    ) {
      throw new ProcessingError(422, "assistant_background_required");
    }
    const runId = opaqueId("processing"),
      jobId = opaqueId("job");
    if (options.operation === "generate")
      data.generation = createGenerationPlan(
        runId,
        options.outputCount!,
        options.scenarios,
      );
    const inputBytes = Buffer.from(canonicalJson(data));
    if (inputBytes.byteLength > 100000000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    const stored = await artifacts.storeProcessing(inputBytes, runId, "input");
    storedInput = stored.objectRef;
    await client.query(
      `INSERT INTO job(id,project_id,actor_id,kind,payload,status,idempotency_key,correlation_id)
      VALUES($1,$2,$3,'process_data',$4,'queued',$5,$1)`,
      [jobId, scope.projectId, scope.actorId, { runId }, `processing:${runId}`],
    );
    await client.query(
      `INSERT INTO processing_run(id,project_id,actor_id,job_id,idempotency_key,request_hash,source,options,input_ref,input_hash,input_count,model_revision,target_draft_id,execution_config,background_document_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        runId,
        scope.projectId,
        scope.actorId,
        jobId,
        key,
        digest,
        source,
        options,
        stored.objectRef,
        stored.sha256,
        data.records.length,
        modelRevision,
        target,
        {
          ...PROCESSING_EXECUTION,
          recipeVersion:
            options.operation === "generate"
              ? GENERATION_RECIPE
              : PROCESSING_EXECUTION.recipeVersion,
        },
        data.background?.documents.map((document) => document.id) ?? [],
      ],
    );
    const run = (
      await client.query<ProcessingRun>(`${selectRun} WHERE r.id=$1`, [runId])
    ).rows[0];
    await linkAssistantProcessing(client, scope, runId);
    await attachProcessingRound(client, scope, runId);
    await client.query("COMMIT");
    return { run: summary(run), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    if (storedInput) {
      await db.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [scope.projectId, storedInput],
      );
      await cleanupProcessingObjects(db, artifacts, scope.projectId);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function readProcessingStatus(
  db: Database,
  scope: ProcessingScope,
  id: string,
) {
  const run = await getProcessingRun(db, scope, id);
  const { canRetry, canContinue, reason } = await processingRecovery(db, run);
  return {
    recovery: { canRetry, canContinue, reason },
    run: {
      id: run.id,
      status: run.status,
      progress: run.progress,
      inputCount: run.input_count,
      missingCount: missingCount(run),
      partial: summary(run).partial,
      errorCode: run.error_code,
      options: {
        operation: run.options.operation,
        outputCount: run.options.outputCount,
      },
    },
    total: Number(run.output_count ?? 0),
  };
}
export async function listProcessingRuns(
  db: Database,
  scope: ProcessingScope,
  query: {
    limit?: string;
    offset?: string;
    search?: string;
    status?: string;
  } = {},
) {
  await processingAccess(db, scope);
  const limit = Number(query.limit ?? 20),
    offset = Number(query.offset ?? 0);
  if (
    Object.values(query).some((value) => typeof value !== "string") ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (query.search?.length ?? 0) > 200 ||
    ![
      "all",
      "active",
      "complete",
      "attention",
      "queued",
      "running",
      "retry_wait",
      "cancel_requested",
      "succeeded",
      "failed",
      "cancelled",
    ].includes(query.status ?? "all")
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const text = (query.search ?? "").trim().toLowerCase();
  // ponytail: inspect at most the existing 100-task window; paginate after lifecycle/search checks.
  // Project out record-ID arrays and execution bodies even on the database-to-Web hop.
  const rows = await db.query<ProcessingRun & { actor_name: string }>(
    `SELECT r.id,r.parent_run_id,r.job_id,r.input_count,r.created_at,
      jsonb_set(r.source,'{recordIds}','[]'::jsonb) AS source,
      jsonb_build_object('operation',r.options->'operation','instructions',r.options->'instructions','outputCount',r.options->'outputCount') AS options,
      jsonb_build_object('partial',j.result->'partial') AS result,
      coalesce(u.display_name,u.username) AS actor_name,${runStatusColumns}
      FROM processing_run r JOIN job j ON j.id=r.job_id LEFT JOIN app_user u ON u.id=r.actor_id
      WHERE r.project_id=$1 AND r.input_ref IS NOT NULL AND (cardinality(r.background_document_ids)=0 OR r.actor_id=$2)
      ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
    [scope.projectId, scope.actorId],
  );
  const sources = new Map<
    string,
    Promise<Awaited<ReturnType<typeof processingSourceSummary>>>
  >();
  const visible = [];
  let hasActive = false;
  for (const row of rows.rows) {
    const key = JSON.stringify(row.source);
    let source = sources.get(key);
    if (!source) {
      source = (async () => {
        await processingSourceAvailable(db, scope.projectId, row.source);
        return processingSourceSummary(db, scope, row.source);
      })();
      sources.set(key, source);
    }
    try {
      const sourceSummary = await source;
      hasActive ||= [
        "queued",
        "running",
        "retry_wait",
        "cancel_requested",
      ].includes(row.status);
      const group = [
        "queued",
        "running",
        "retry_wait",
        "cancel_requested",
      ].includes(row.status)
        ? "active"
        : row.status === "cancelled"
          ? "cancelled"
          : summary(row).executionComplete
            ? "complete"
            : "attention";
      if (
        query.status &&
        query.status !== "all" &&
        row.status !== query.status &&
        group !== query.status
      )
        continue;
      if (
        text &&
        ![
          sourceSummary.name,
          sourceSummary.kindLabel,
          row.options.instructions,
        ].some((value) => value?.toLowerCase().includes(text))
      )
        continue;
      visible.push({ row, sourceSummary });
    } catch (error) {
      if (!(error instanceof ProcessingError)) throw error;
    }
  }
  const page = visible.slice(offset, offset + limit);
  const savedRuns = await db.query(
    `SELECT DISTINCT pa.run_id FROM processing_acceptance pa
    JOIN data_asset da ON da.id=pa.receipt->>'assetId' AND da.project_id=$1 AND da.status='stored'
    LEFT JOIN collaborative_draft d ON d.id=pa.draft_id AND d.project_id=$1
    LEFT JOIN test_set ts ON ts.id=d.test_set_id LEFT JOIN test_set_version v ON v.id=d.parent_version_id
    WHERE pa.project_id=$1 AND pa.run_id=ANY($2::text[])
    AND (pa.draft_id IS NULL OR (d.id IS NOT NULL AND d.status IN('editing','published') AND (ts.id IS NULL OR ts.status='available') AND (v.id IS NULL OR v.status='published')))
    AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(da.id,d.id,ts.id,v.id))`,
    [scope.projectId, page.map(({ row }) => row.id)],
  );
  const saved = new Set(savedRuns.rows.map((row) => row.run_id));
  const runs = page.map(({ row, sourceSummary }) => {
    const state = summary(row),
      instructions = row.options.instructions ?? "";
    return {
      id: row.id,
      parentRunId: row.parent_run_id ?? null,
      continuationKind: row.continuation_kind ?? null,
      source:
        row.source.kind === "assets"
          ? { kind: "assets" }
          : { kind: row.source.kind, id: row.source.id },
      options: {
        operation: row.options.operation,
        instructions:
          instructions.length > 240
            ? `${instructions.slice(0, 240)}…`
            : instructions,
      },
      inputCount: row.input_count,
      outputCount: state.outputCount,
      missingCount: state.missingCount,
      executionComplete: state.executionComplete,
      partial: state.partial,
      status: row.status,
      progress: row.progress,
      errorCode: row.error_code,
      createdAt: row.created_at,
      hasSavedResult: saved.has(row.id),
      sourceSummary,
      actorName: row.actor_name ?? "未记录",
    };
  });
  return {
    runs,
    pagination: { total: visible.length, limit, offset },
    hasActive,
  };
}
export async function readProcessingRun(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
  query: { offset?: string; limit?: string },
  all = false,
) {
  const offset = Number(query.offset ?? 0),
    limit = Number(query.limit ?? 20);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (all ? 10000 : 100)
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const run = await getProcessingRun(db, scope, runId);
  const input = JSON.parse(
    (await artifacts.readBytes(run.input_ref!, 100000000)).toString("utf8"),
  ) as InputSnapshot;
  const originals = new Map(input.records.map((row) => [row.id, row]));
  const inputOrdinals = new Map(
    input.records.map((row, index) => [row.id, index + 1]),
  );
  const origins = await processingCandidateOrigins(db, artifacts, scope, input);
  const batches = await db.query(
    "SELECT * FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
    [runId],
  );
  const records = [];
  const issues = [];
  let cursor = 0;
  for (const batch of batches.rows) {
    const count = Number(batch.output_count);
    if (batch.error_code)
      issues.push({ batch: batch.ordinal, code: batch.error_code });
    if (
      batch.result_ref &&
      cursor < offset + limit &&
      cursor + count > offset
    ) {
      const result = JSON.parse(
        (await artifacts.readBytes(batch.result_ref, 100000000)).toString(
          "utf8",
        ),
      ) as ProcessingResult;
      for (let i = 0; i < result.records.length; i++)
        if (cursor + i >= offset && cursor + i < offset + limit)
          records.push({
            id: `${batch.ordinal}:${batch.result_indices?.[i] ?? i}`,
            candidateOrigin: origins.get(result.records[i].sourceId) ?? {
              runId,
              resultId: `${batch.ordinal}:${batch.result_indices?.[i] ?? i}`,
            },
            original:
              originals.get(result.records[i].sourceId) ??
              (run.options.operation === "generate"
                ? ({
                    id: result.records[i].sourceId,
                    question: result.records[i].question,
                    expectedOutput: result.records[i].expectedOutput,
                    metadata: result.records[i].metadata,
                  } as InputSnapshot["records"][number])
                : undefined),
            result: result.records[i],
          });
    }
    issues.push(
      ...(batch.issues ?? []).map(
        (issue: { code: string; sourceId?: string; count?: number }) => {
          const original = issue.sourceId
            ? originals.get(issue.sourceId)
            : undefined;
          return {
            ...issue,
            batch: batch.ordinal,
            ...(original
              ? {
                  inputOrdinal: inputOrdinals.get(original.id),
                  sourceQuestion: original.question.slice(0, 160),
                }
              : {}),
          };
        },
      ),
    );
    cursor += count;
  }
  const current = await getProcessingRun(db, scope, runId);
  if (
    current.input_ref !== run.input_ref ||
    current.input_hash !== run.input_hash
  )
    throw new ProcessingError(409, "processing_source_unavailable");
  const { diagnostics, ...recovery } = await processingRecovery(db, run);
  return {
    recovery,
    diagnostics,
    run: summary(run),
    usableCount: all
      ? deduplicate(
          records
            .filter((row) => row.result.question.trim())
            .map((row) => ({ id: row.id, ...row.result })),
          generatesRecords(run.options.operation)
            ? [...input.records, ...(input.deduplicationBaseline ?? [])]
            : [],
        ).keptIds.length
      : undefined,
    rootOperation:
      input.continuation?.rootOperation ??
      input.refinement?.rootOperation ??
      run.options.operation,
    adoptionFields:
      input.continuation?.adoptionFields ??
      input.refinement?.adoptionFields ??
      run.options.allowedFields,
    ...(all
      ? {
          backgroundGoal: {
            requirements: input.background?.requirements ?? [],
            classifications: input.background?.classifications ?? [],
          },
        }
      : {}),
    backgroundEvidence: (input.background?.documents ?? []).flatMap(
      (document) =>
        document.fragments.map((fragment) => ({
          documentId: document.id,
          sha256: document.sha256,
          fragmentIndex: fragment.index,
        })),
    ),
    records,
    issues,
    allIds: batches.rows.flatMap((batch) =>
      Array.from(
        { length: Number(batch.output_count) },
        (_, index) =>
          `${batch.ordinal}:${batch.result_indices?.[index] ?? index}`,
      ),
    ),
    total: cursor,
    offset,
    limit,
  };
}
export async function processingCandidateOrigins(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  input: InputSnapshot,
): Promise<Map<string, CandidateOrigin>> {
  const origins = new Map<string, CandidateOrigin>();
  let parent: Awaited<ReturnType<typeof readProcessingRun>> | undefined;
  if (input.refinement && input.records.some((row) => !row.candidateOrigin)) {
    parent = await readProcessingRun(
      db,
      artifacts,
      scope,
      input.refinement.parentRunId,
      { limit: "10000" },
      true,
    );
  }
  const parentOrigins = new Map(
    parent?.records.map((row) => [
      `candidate:${row.id}`,
      row.candidateOrigin,
    ]) ?? [],
  );
  for (const row of input.records) {
    const origin = row.candidateOrigin ?? parentOrigins.get(row.id);
    if (origin) origins.set(row.id, origin);
    else if (input.refinement)
      throw new ProcessingError(409, "processing_input_corrupt");
  }
  return origins;
}
export async function controlProcessingRun(
  db: Database,
  scope: ProcessingScope,
  runId: string,
  action: "cancel" | "retry",
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-candidates:${scope.projectId}`,
    ]);
    const run = await getProcessingRun(client, scope, runId, true);
    const workspace = (
      await client.query(
        "SELECT latest_run_id FROM processing_task WHERE id=(SELECT task_id FROM processing_run WHERE id=$1) FOR UPDATE",
        [runId],
      )
    ).rows[0];
    if (workspace && workspace.latest_run_id !== runId)
      throw new ProcessingError(409, "processing_task_changed");
    await processingAccess(client, scope, true);
    await guardAssistantCommit(client, scope);
    if (action === "cancel")
      await client.query(
        "UPDATE job SET status='cancel_requested',updated_at=now() WHERE id=$1 AND status IN('queued','running','retry_wait')",
        [run.job_id],
      );
    else {
      if (!["failed", "cancelled", "succeeded"].includes(run.status))
        throw new ProcessingError(409, "processing_still_running");
      if (!(await processingRecovery(client, run)).canRetry)
        throw new ProcessingError(409, "processing_retry_unavailable");
      await client.query(
        "UPDATE job SET status='queued',stage='queued',attempt=0,next_run_at=now(),error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
        [run.job_id],
      );
    }
    const updated = (
      await client.query<ProcessingRun>(`${selectRun} WHERE r.id=$1`, [runId])
    ).rows[0];
    if (action === "retry" && updated.status === "queued")
      await linkAssistantProcessing(client, scope, runId);
    else await guardAssistantCommit(client, scope);
    await client.query("COMMIT");
    return { run: summary(updated) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function previewProcessingInput(
  db: Database,
  scope: ProcessingScope,
  input: unknown,
  capability: "read" | "write" = "write",
  fullSource = false,
) {
  if (
    !isPlainObject(input) ||
    !isPlainObject(input.source) ||
    Object.keys(input).some(
      (k) =>
        ![
          "source",
          "offset",
          "limit",
          "search",
          "conditions",
          "selectedIds",
          "selectedOnly",
        ].includes(k),
    )
  )
    throw new ProcessingError(422, "processing_scope_invalid");
  const source = parseSource({ ...input.source, recordIds: ["preview"] });
  const requiredCapability = source.kind === "draft" ? "write" : capability;
  await processingAccess(db, scope, false, requiredCapability);
  const offset = Number(input.offset ?? 0),
    limit = Number(input.limit ?? 20);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (fullSource ? 10000 : 100)
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const selectedIds = input.selectedIds ?? [];
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length > 10000 ||
    selectedIds.some((id) => typeof id !== "string") ||
    new Set(selectedIds).size !== selectedIds.length ||
    (input.selectedOnly !== undefined &&
      typeof input.selectedOnly !== "boolean")
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await processingSourceAvailable(client, scope.projectId, source, true);
    let allIds: string[];
    if (source.kind === "assets")
      allIds = (
        await client.query(
          `SELECT concat(da.id,':',sr.ordinal) AS id FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
      JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid' WHERE da.project_id=$1 AND da.id=ANY($2::text[]) ORDER BY da.id,sr.ordinal LIMIT 10001`,
          [scope.projectId, source.assetIds],
        )
      ).rows.map((r) => r.id);
    else if (source.kind === "draft")
      allIds = (
        await client.query(
          "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted ORDER BY position,id LIMIT 10001",
          [source.id],
        )
      ).rows.map((r) => r.id);
    else
      allIds = (
        await client.query(
          "SELECT case_id AS id FROM resolve_version_members($1) ORDER BY ordinal LIMIT 10001",
          [source.id],
        )
      ).rows.map((r) => r.id);
    if (allIds.length > 10000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    if (selectedIds.some((id) => !allIds.includes(id)))
      throw new ProcessingError(409, "processing_scope_changed");
    filterProcessingRecords([], input.search, input.conditions);
    const filtered = Boolean(
      String(input.search ?? "").trim() ||
      (Array.isArray(input.conditions) && input.conditions.length) ||
      input.selectedOnly,
    );
    const page = filtered ? allIds : allIds.slice(offset, offset + limit);
    const data =
      page.length || source.kind === "draft"
        ? await snapshot(client, scope.projectId, {
            ...source,
            recordIds: page,
          })
        : { records: [], revision: undefined };
    const matched = filtered
      ? filterProcessingRecords(data.records, input.search, input.conditions)
      : data.records;
    const matchedIds = filtered ? matched.map((row) => row.id) : allIds;
    const selected = new Set(selectedIds);
    const visible = input.selectedOnly
      ? matched.filter((row) => selected.has(row.id))
      : matched;
    const views =
      source.kind === "assets"
        ? (
            await client.query(
              "SELECT id,display_mapping FROM parsed_view WHERE asset_id=ANY($1::text[]) AND is_current AND status='ready' ORDER BY id FOR SHARE",
              [source.assetIds],
            )
          ).rows
        : [];
    const keys = new Set<string>();
    for (const view of views)
      for (const path of normalizeDisplayMapping(view.display_mapping)
        ?.metadata ?? [])
        keys.add(displayFieldName(path));
    const metadataSql =
      source.kind === "draft"
        ? "SELECT metadata FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted ORDER BY position,id LIMIT 10000"
        : source.kind === "version"
          ? "SELECT cr.metadata FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id=vm.case_revision_id ORDER BY vm.ordinal LIMIT 10000"
          : "SELECT sr.value->'metadata' AS metadata FROM source_record sr WHERE sr.parsed_view_id=ANY($1::text[]) AND sr.parse_status='valid' AND jsonb_typeof(sr.value->'metadata')='array' ORDER BY sr.ordinal LIMIT 10000";
    const metadata = await client.query(metadataSql, [
      source.kind === "assets"
        ? views
            .filter(
              (view) =>
                normalizeDisplayMapping(view.display_mapping)
                  ?.metadataEntries === "/metadata",
            )
            .map((view) => view.id)
        : source.id,
    ]);
    for (const row of metadata.rows)
      for (const entry of readMetadataEntries(row.metadata))
        if (entry.key) keys.add(entry.key);
    const sourceRevision = sha256(
      canonicalJson([
        source.kind,
        source.kind === "assets" ? views : source.id,
        data.revision ?? null,
        allIds,
      ]),
    );
    const sourceSummary = await processingSourceSummary(client, scope, source);
    await processingAccess(client, scope, true, requiredCapability);
    await client.query("COMMIT");
    return {
      records: filtered ? visible.slice(offset, offset + limit) : data.records,
      allIds: matchedIds,
      total: input.selectedOnly ? visible.length : matchedIds.length,
      sourceTotal: allIds.length,
      matchedTotal: matchedIds.length,
      sourceRevision,
      metadataKeys: [...keys].sort().slice(0, 100),
      hiddenSelected: selectedIds.filter((id) => !matchedIds.includes(id))
        .length,
      sourceSummary,
      offset,
      limit,
      revision: data.revision,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function preflightDocumentGeneration(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  options?: ProcessingOptions,
) {
  if (options) {
    try {
      options = processingOptions(options);
    } catch {
      throw new ProcessingError(422, "processing_configuration_invalid");
    }
  }
  await processingAccess(db, scope);
  if (!scope.assistantGuard)
    throw new ProcessingError(422, "processing_scope_invalid");
  await guardAssistantCommit(db, scope);
  const documents = await db.query(
    `SELECT d.id FROM assistant_background_document d JOIN assistant_session s ON s.id=d.session_id WHERE s.id=$1 AND s.project_id=$2 AND s.actor_id=$3`,
    [scope.assistantGuard.sessionId, scope.projectId, scope.actorId],
  );
  if (!documents.rowCount)
    throw new ProcessingError(422, "assistant_background_required");
  const model = await db.query(
    "SELECT enabled FROM model_connection ORDER BY revision DESC LIMIT 1",
  );
  if (!model.rows[0]?.enabled)
    throw new ProcessingError(409, "model_connection_unavailable");
  if (options) {
    const frozen = await freezeBackground(
      db,
      scope,
      scope.assistantGuard.sessionId,
      {
        options,
        records: [],
        source: {
          kind: "background",
          id: scope.assistantGuard.sessionId,
          recordIds: [],
        },
      },
    );
    if (!frozen?.documents.length)
      throw new ProcessingError(422, "assistant_background_required");
    return frozen;
  }
}
