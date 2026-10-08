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
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  isPlainObject,
  opaqueId,
  mapMaterialRecord,
  normalizeDisplayMapping,
  displayText,
  readMetadataEntries,
} from "../server/support.js";
import {
  processingOptions,
  PROCESSING_EXECUTION,
  type ProcessingInput,
  type ProcessingOptions,
  type ProcessingResult,
} from "./protocol.js";

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
};
export type ProcessingSource =
  | { kind: "assets"; assetIds: string[]; recordIds: string[] }
  | { kind: "draft" | "version"; id: string; recordIds: string[] };
export type CandidateOrigin = { runId: string; resultId: string };
export type InputSnapshot = {
  background?: BackgroundSnapshot;
  records: (ProcessingInput & {
    candidateOrigin?: CandidateOrigin;
    baseline?: ProcessingInput & {
      source?: unknown;
      revisions?: Record<string, number>;
    };
    source?: unknown;
    revisions?: Record<string, number>;
  })[];
  source: ProcessingSource;
  revision?: number;
  refinement?: {
    parentRunId: string;
    selectedIds: string[];
    rootOperation: ProcessingOptions["operation"];
    adoptionFields: ProcessingOptions["allowedFields"];
  };
};
export type ProcessingRun = {
  id: string;
  project_id: string;
  actor_id: string;
  job_id: string;
  parent_run_id?: string | null;
  background_document_ids: string[];
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
function parseSource(value: unknown): ProcessingSource {
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

// Read availability on every body access; a saved snapshot does not bypass recycling or deletion.
export async function processingSourceAvailable(
  db: Pick<Database, "query">,
  projectId: string,
  source: ProcessingSource,
  lock = false,
) {
  if (source.kind === "assets") {
    const rows = await db.query(
      `SELECT da.id FROM data_asset da WHERE da.project_id=$1 AND da.id=ANY($2::text[])
      AND da.status='stored' AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id=da.id)
      ${lock ? "FOR SHARE OF da" : ""}`,
      [projectId, source.assetIds],
    );
    if (rows.rowCount !== source.assetIds.length)
      throw new ProcessingError(409, "processing_source_unavailable");
  } else if (source.kind === "version") {
    const rows = await db.query(
      `SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
      WHERE v.id=$2 AND ts.project_id=$1 AND v.status='published' AND ts.status='available'
      AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(v.id,ts.id))
      ${lock ? "FOR SHARE OF ts,v" : ""}`,
      [projectId, source.id],
    );
    if (!rows.rowCount)
      throw new ProcessingError(409, "processing_source_unavailable");
  } else {
    if (lock)
      await db.query(
        "SELECT id FROM collaborative_draft WHERE id=$1 AND project_id=$2 FOR SHARE",
        [source.id, projectId],
      );
    const rows = await db.query(
      `SELECT d.id FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id
      LEFT JOIN test_set_version v ON v.id=d.parent_version_id LEFT JOIN test_set_version published ON published.id=d.published_version_id
      WHERE d.id=$2 AND d.project_id=$1 AND (d.status='editing' OR (d.status='published' AND published.status='published'))
      AND (ts.id IS NULL OR ts.status='available') AND (v.id IS NULL OR v.status='published')
      AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(d.id,ts.id,v.id))`,
      [projectId, source.id],
    );
    if (!rows.rowCount)
      throw new ProcessingError(409, "processing_source_unavailable");
  }
}

async function snapshot(
  client: PoolClient,
  projectId: string,
  source: ProcessingSource,
): Promise<InputSnapshot> {
  await processingSourceAvailable(client, projectId, source, true);
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
  const expected =
    row.options.operation === "augment"
      ? (row.options.outputCount ?? row.input_count)
      : row.input_count;
  return Math.max(0, expected - Number(row.output_count ?? 0));
}

function summary(row: ProcessingRun) {
  return {
    id: row.id,
    parentRunId: row.parent_run_id ?? null,
    jobId: row.job_id,
    source: row.source,
    options: row.options,
    inputCount: row.input_count,
    modelRevision: row.model_revision,
    execution: row.execution_config,
    outputCount: Number(row.output_count ?? 0),
    missingCount: missingCount(row),
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
const selectRun =
  "SELECT r.*,j.status,j.progress,j.error_code,j.result,(SELECT coalesce(sum(output_count),0) FROM processing_batch WHERE run_id=r.id AND result_ref IS NOT NULL) AS output_count,(SELECT coalesce(sum(jsonb_array_length(issues)),0) FROM processing_batch WHERE run_id=r.id) AS issue_count FROM processing_run r JOIN job j ON j.id=r.job_id";
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
  const source = parseSource(input.source);
  let options: ProcessingOptions;
  try {
    options = processingOptions(input.options);
  } catch {
    throw new ProcessingError(422, "processing_configuration_invalid");
  }
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
    const data = await snapshot(client, scope.projectId, source);
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
    const runId = opaqueId("processing"),
      jobId = opaqueId("job");
    const stored = await artifacts.storeProcessing(
      Buffer.from(canonicalJson(data)),
      runId,
      "input",
    );
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
        PROCESSING_EXECUTION,
        data.background?.documents.map((document) => document.id) ?? [],
      ],
    );
    const run = (
      await client.query<ProcessingRun>(`${selectRun} WHERE r.id=$1`, [runId])
    ).rows[0];
    await linkAssistantProcessing(client, scope, runId);
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
  return {
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
export async function listProcessingRuns(db: Database, scope: ProcessingScope) {
  await processingAccess(db, scope);
  const rows = await db.query<ProcessingRun>(
    `${selectRun} WHERE r.project_id=$1 AND r.input_ref IS NOT NULL AND (cardinality(r.background_document_ids)=0 OR r.actor_id=$2) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
    [scope.projectId, scope.actorId],
  );
  // Do not disclose prompts or snapshots of recycled sources through the index.
  const runs = [];
  for (const row of rows.rows) {
    try {
      await processingSourceAvailable(db, scope.projectId, row.source);
      runs.push(summary(row));
    } catch (error) {
      if (!(error instanceof ProcessingError)) throw error;
    }
  }
  return { runs };
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
            original: originals.get(result.records[i].sourceId),
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
  return {
    run: summary(run),
    rootOperation: input.refinement?.rootOperation ?? run.options.operation,
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
    const run = await getProcessingRun(client, scope, runId, true);
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
      const incomplete = await client.query(
        `SELECT 1 FROM processing_batch WHERE run_id=$1 AND (result_ref IS NULL OR error_code IS NOT NULL
        OR issues @> '[{"code":"missing_output"}]'::jsonb) LIMIT 1`,
        [runId],
      );
      if (run.status !== "succeeded" || incomplete.rowCount)
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
    Object.keys(input).some((k) => !["source", "offset", "limit"].includes(k))
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
    const page = allIds.slice(offset, offset + limit);
    const data =
      page.length || source.kind === "draft"
        ? await snapshot(client, scope.projectId, {
            ...source,
            recordIds: page,
          })
        : { records: [], revision: undefined };
    await processingAccess(client, scope, true, requiredCapability);
    await client.query("COMMIT");
    return {
      records: data.records,
      allIds,
      total: allIds.length,
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
