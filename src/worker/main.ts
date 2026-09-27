import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";

import { strFromU8, unzipSync } from "fflate";
import { jobRetryDelayMs, loadConfig } from "../config.js";
import { isAllowedSourceAttribution } from "../attribution.js";
import {
  CAPACITY_LIMITS,
  CANDIDATE_CAPACITY_SQL,
  draftCapacityExceeded,
  draftCapacityFromRow,
} from "../capacity.js";
import { createPool, type Database } from "../db/pool.js";
import { parseSourceRecords } from "../parser/index.js";
import { validateForPublication } from "../transformation/index.js";
import {
  canonicalJson,
  createFullProvenancePackage,
  createLangfuseCsv,
  createStandardEvidence,
  createStandardManifest,
  createStandardPackage,
  EVIDENCE_FILES,
  sha256,
  type PackageItem,
} from "../package/contract.js";
import { validateLangfuseCsv } from "../package/langfuse.js";
import { evaluateRecipe, recipeSteps } from "../recipe/index.js";
import { normalizeDraftMapping, replayMapping } from "../mapping/index.js";
import { isValidCaseMetadata, validateFormalItems } from "../schema/formal.js";
import {
  capabilitiesForRole,
  hasProjectCapability,
  type ProjectCapability,
} from "../security/project-access.js";
import { ArtifactRepository } from "../storage/artifacts.js";
import {
  dependencyHealth,
  startHealthServer,
} from "../observability/health.js";
import { metricSnapshot, renderMetrics } from "../observability/metrics.js";
import { scanConsistency } from "../observability/consistency.js";
import { validatePackageBytes } from "../validator/validate.js";
import { materializePeriodicCheckpoint } from "../version/checkpoint.js";
import {
  ControlledDeletionError,
  executeControlledDeletion,
  markDeletionFailure,
} from "../deletion/index.js";

interface Job {
  id: string;
  kind: string;
  project_id: string;
  actor_id: string;
  payload: Record<string, string>;
  status?: string;
  lease_owner?: string;
  attempt?: number;
}

const activeJobStages = new Map<string, { stage: string; startedAt: number }>();

async function recordStageDuration(
  queryable: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<{ rowCount?: number | null }>;
  },
  job: Job,
  nextStage: string,
): Promise<void> {
  const active = activeJobStages.get(job.id);
  if (active) {
    await queryable.query(
      `INSERT INTO job_stage_duration (job_id, kind, stage, duration_ms)
       VALUES ($1,$2,$3,$4)`,
      [job.id, job.kind, active.stage, Date.now() - active.startedAt],
    );
  }
  activeJobStages.set(job.id, {
    stage: nextStage,
    startedAt: Date.now(),
  });
}

class JobCancelledError extends Error {
  readonly code = "job_cancel_requested";

  constructor() {
    super("job_cancel_requested");
  }
}

class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly code = "job_failed",
  ) {
    super(message);
  }
}

class CandidateValidationError extends Error {
  constructor(readonly report: Record<string, unknown>) {
    super("candidate_validation_failed");
  }
}

class PublicationCapacityError extends Error {
  readonly code = "publication_capacity_exceeded";

  constructor(readonly report: Record<string, unknown>) {
    super("publication_capacity_exceeded");
  }
}

class PublicationIntegrityError extends Error {
  constructor(
    readonly code: string,
    readonly report: Record<string, unknown>,
  ) {
    super(code);
  }
}

async function assertJobCapability(
  db: Database,
  job: Job,
  capability: ProjectCapability,
): Promise<void> {
  if (
    !(await hasProjectCapability(db, job.project_id, job.actor_id, capability))
  )
    throw new PermanentJobError(
      "Job actor capability revoked",
      "job_actor_capability_revoked",
    );
}

async function assertTransactionalJobCapability(
  client: PoolClient,
  job: Job,
  capability: ProjectCapability,
): Promise<void> {
  const member = await client.query(
    `SELECT role FROM project_member
     WHERE project_id = $1 AND user_id = $2
     FOR SHARE`,
    [job.project_id, job.actor_id],
  );
  if (!member.rowCount || !capabilitiesForRole(member.rows[0].role)[capability])
    throw new PermanentJobError(
      "Job actor capability revoked",
      "job_actor_capability_revoked",
    );
}

function publicationCapacityError({
  exceededDimension,
  actual,
  limit,
  retry,
  object = undefined,
  ...details
}: {
  exceededDimension: string;
  actual: unknown;
  limit: unknown;
  retry: string;
  object?: { type: string; id?: string };
} & Record<string, unknown>) {
  const measurement = {
    ...details,
    valid: false,
    errorCode: "publication_capacity_exceeded",
    capacityBlock: true,
    object: object ?? { type: "candidate_snapshot" },
    blockingPhase: "publication_transaction",
    exceededDimension,
    actual,
    limit,
    retry,
  };
  return new PublicationCapacityError({
    ...measurement,
    errors: [{ code: measurement.errorCode, ...measurement }],
  });
}

function publicationIntegrityError({
  code,
  retry,
  object = undefined,
  ...details
}: {
  code: string;
  retry: string;
  object?: { type: string; id?: string };
} & Record<string, unknown>) {
  const measurement = {
    ...details,
    valid: false,
    errorCode: code,
    object: object ?? { type: "candidate_snapshot" },
    blockingPhase: "publication_transaction",
    retry,
  };
  return new PublicationIntegrityError(code, {
    ...measurement,
    errors: [{ code, ...measurement }],
  });
}

function manualExclusions(recipe: any) {
  return recipeSteps(recipe)
    .flatMap((step) => (step.kind === "manual" ? (step.exclude ?? []) : []))
    .map(({ id, reason, actorId }) => ({
      id,
      reason: reason ?? null,
      actorId: actorId ?? null,
    }));
}

async function claim(
  db: Database,
  workerId: string,
  leaseDurationMs: number,
): Promise<Job | undefined> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cancellation = await client.query(
      `WITH selected AS (
         SELECT id FROM job WHERE status = 'cancel_requested'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE job job SET status = 'cancelled', stage = 'cancelled',
         progress = 100, updated_at = now()
       FROM selected WHERE job.id = selected.id
      RETURNING job.id, job.kind, job.project_id, job.actor_id,
                job.payload, job.status, job.attempt`,
    );
    if (cancellation.rowCount) {
      const cancelled = cancellation.rows[0];
      if (cancelled.kind === "parse_asset" || cancelled.kind === "parse_csv")
        await client.query(
          `UPDATE parsed_view pv SET status = 'cancelled'
           FROM data_asset da
           WHERE pv.asset_id = da.id AND pv.id = $1
             AND da.project_id = $2
             AND pv.status IN ('queued', 'parsing')`,
          [cancelled.payload.parsedViewId, cancelled.project_id],
        );
      if (cancelled.kind === "materialize_candidate")
        await client.query(
          `UPDATE candidate_snapshot cs
             SET status = 'failed', validation_report = $3
           FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE cs.id = $1 AND cs.draft_id = wd.id
             AND ts.project_id = $2 AND cs.status = 'materializing'`,
          [
            cancelled.payload.candidateId,
            cancelled.project_id,
            {
              valid: false,
              errorCode: "job_cancelled",
              capacityBlock: false,
              blockingPhase: "candidate_materialization",
              retry: "Materialize a new Candidate after cancellation.",
            },
          ],
        );
      if (cancelled.kind === "materialize_candidate")
        await client.query(
          `UPDATE working_draft wd SET status = 'editing'
           FROM candidate_snapshot cs
           JOIN working_draft wd_source ON wd_source.id = cs.draft_id
           JOIN test_set ts ON ts.id = wd_source.test_set_id
           WHERE cs.id = $1 AND wd.id = wd_source.id
             AND ts.project_id = $2 AND wd.status = 'materializing'`,
          [cancelled.payload.candidateId, cancelled.project_id],
        );
      if (cancelled.kind === "publish_version")
        await client.query(
          `UPDATE candidate_snapshot cs SET status = 'ready_to_publish'
           FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE cs.id = $1 AND cs.draft_id = wd.id
             AND ts.project_id = $2 AND cs.status = 'publishing'`,
          [cancelled.payload.candidateId, cancelled.project_id],
        );
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'job_cancelled', 'job', $3, $4)`,
        [
          cancelled.project_id,
          cancelled.actor_id,
          cancelled.id,
          { correlationId: cancelled.id },
        ],
      );
      await client.query("COMMIT");
      return cancelled as Job;
    }
    const result = await client.query(
      `WITH selected AS (
         SELECT id FROM job
         WHERE (status = 'queued' AND next_run_at <= now())
            OR (status = 'running' AND lease_expires_at < now()
                AND attempt < max_attempts)
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE job job
       SET status = 'running', stage = 'starting', attempt = job.attempt + 1,
           lease_owner = $1,
           lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
           updated_at = now()
       FROM selected WHERE job.id = selected.id
      RETURNING job.id, job.kind, job.project_id, job.actor_id,
                job.payload, job.lease_owner, job.attempt`,
      [workerId, leaseDurationMs],
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return undefined;
    }
    await client.query("COMMIT");
    return result.rows[0] as Job;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertJobDeletionSafe(
  queryable: { query: (text: string, values?: unknown[]) => Promise<any> },
  job: Job,
): Promise<void> {
  let result;
  if (job.kind === "parse_asset" || job.kind === "parse_csv") {
    result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       WHERE dl.project_id = $1 AND (
         (dl.object_type = 'data_asset' AND dl.object_id = $2)
         OR (dl.object_type = 'parsed_view' AND dl.object_id = $3)
       )
       UNION ALL
       SELECT 1 FROM data_asset da JOIN parsed_view pv ON pv.asset_id = da.id
       WHERE da.project_id = $1 AND da.id = $2 AND pv.id = $3
         AND (da.status IN ('deletion_pending', 'tombstoned')
              OR pv.status IN ('deletion_pending', 'tombstoned'))
       LIMIT 1`,
      [job.project_id, job.payload.assetId, job.payload.parsedViewId],
    );
  } else if (job.kind === "materialize_candidate") {
    result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN candidate_snapshot cs ON cs.id = $2
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'candidate_snapshot' AND dl.object_id = cs.id)
         OR (dl.object_type = 'working_draft' AND dl.object_id = wd.id)
         OR (dl.object_type = 'test_set' AND dl.object_id = ts.id)
         OR (dl.object_type = 'data_asset' AND dl.object_id IN (
           SELECT ds.asset_id FROM draft_source ds WHERE ds.draft_id = wd.id
         ))
         OR (dl.object_type = 'parsed_view' AND dl.object_id IN (
           SELECT ds.parsed_view_id FROM draft_source ds WHERE ds.draft_id = wd.id
         ))
       ) LIMIT 1`,
      [job.project_id, job.payload.candidateId],
    );
  } else if (job.kind === "publish_version") {
    result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN candidate_snapshot cs ON cs.id = $2
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         dl.object_type IN ('candidate_snapshot', 'working_draft', 'test_set')
         AND dl.object_id IN (cs.id, wd.id, ts.id)
         OR (dl.object_type = 'test_set_version' AND dl.object_id IN (
           SELECT v.id FROM test_set_version v WHERE v.candidate_id = cs.id
         ))
         OR (dl.object_type = 'data_asset' AND dl.object_id IN (
           SELECT ds.asset_id FROM draft_source ds WHERE ds.draft_id = wd.id
         ))
         OR (dl.object_type = 'parsed_view' AND dl.object_id IN (
           SELECT ds.parsed_view_id FROM draft_source ds WHERE ds.draft_id = wd.id
         ))
       ) LIMIT 1`,
      [job.project_id, job.payload.candidateId],
    );
  } else if (
    job.kind === "generate_package" ||
    job.kind === "generate_langfuse_csv"
  ) {
    result = await queryable.query(
      `SELECT 1 FROM deletion_lock dl
       JOIN test_set_version v ON v.id = $2
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE dl.project_id = $1 AND ts.project_id = $1 AND (
         (dl.object_type = 'test_set_version' AND dl.object_id = v.id)
         OR (dl.object_type = 'test_set' AND dl.object_id = ts.id)
         OR (dl.object_type = 'candidate_snapshot' AND dl.object_id = v.candidate_id)
         OR (dl.object_type = 'delivery_record' AND dl.object_id IN (
           SELECT dr.id FROM delivery_record dr WHERE dr.version_id = v.id
         ))
         OR v.status = 'degraded_by_deletion'
         OR ts.status = 'unavailable_by_deletion'
       ) LIMIT 1`,
      [job.project_id, job.payload.versionId],
    );
  }
  if (result?.rowCount)
    throw new PermanentJobError(
      "Controlled deletion has made this job unavailable",
      "deletion_locked",
    );
}

async function updateJobProgress(
  db: Database,
  job: Job,
  stage: string,
  progress: number,
  counts?: Record<string, unknown>,
) {
  const current = await db.query(
    "SELECT status FROM job WHERE id = $1 AND lease_owner = $2 AND status = 'running'",
    [job.id, job.lease_owner],
  );
  if (!current.rowCount) throw new JobCancelledError();
  await recordStageDuration(db, job, stage).catch(() => undefined);
  const claimed = await db.query(
    `UPDATE job SET stage = $2, progress = $3,
        counts = COALESCE($4::jsonb, counts), updated_at = now()
     WHERE id = $1 AND lease_owner = $5 AND status = 'running'
     RETURNING id`,
    [
      job.id,
      stage,
      progress,
      counts ? JSON.stringify(counts) : null,
      job.lease_owner,
    ],
  );
  if (!claimed.rowCount) throw new JobCancelledError();
}

async function assertJobActive(db: Database, job: Job) {
  const active = await db.query(
    `SELECT 1 FROM job
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [job.id, job.lease_owner],
  );
  if (!active.rowCount) throw new JobCancelledError();
}

async function updateJobProgressInTransaction(
  client: PoolClient,
  job: Job,
  stage: string,
  progress: number,
  counts?: Record<string, unknown>,
) {
  await recordStageDuration(client, job, stage).catch(() => undefined);
  const claimed = await client.query(
    `UPDATE job SET stage = $2, progress = $3,
        counts = COALESCE($4::jsonb, counts), updated_at = now()
     WHERE id = $1 AND lease_owner = $5 AND status = 'running'
     RETURNING id`,
    [
      job.id,
      stage,
      progress,
      counts ? JSON.stringify(counts) : null,
      job.lease_owner,
    ],
  );
  if (!claimed.rowCount) throw new JobCancelledError();
}

async function completeJobInTransaction(
  client: PoolClient,
  job: Job,
  result: Record<string, unknown>,
) {
  const completed = await client.query(
    `UPDATE job SET status = 'succeeded', stage = 'succeeded', progress = 100,
        result = $2, counts = COALESCE($3::jsonb, counts), error_code = NULL,
        retryable = NULL, lease_owner = NULL, lease_expires_at = NULL,
        next_run_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_owner = $4 AND status = 'running'
     RETURNING id`,
    [job.id, result, JSON.stringify(result.counts ?? null), job.lease_owner],
  );
  if (!completed.rowCount) throw new JobCancelledError();
  await client.query(
    `INSERT INTO audit_event
     (project_id, actor_id, action, object_type, object_id, details)
     VALUES ($1, $2, 'job_succeeded', 'job', $3, $4)`,
    [job.project_id, job.actor_id, job.id, { correlationId: job.id }],
  );
}

async function parseAsset(
  db: Database,
  artifacts: ArtifactRepository,
  job: Job,
): Promise<Record<string, unknown>> {
  await assertJobDeletionSafe(db, job);
  const asset = await db.query(
    `SELECT da.object_ref, pv.status, pv.format, pv.parser_version, pv.parser_config
     FROM data_asset da
     JOIN parsed_view pv ON pv.id = $3 AND pv.asset_id = da.id
     JOIN project_member pm ON pm.project_id = da.project_id AND pm.user_id = $4
     WHERE da.id = $1 AND da.project_id = $2 AND pm.role IN ('owner', 'editor')`,
    [
      job.payload.assetId,
      job.project_id,
      job.payload.parsedViewId,
      job.actor_id,
    ],
  );
  if (!asset.rowCount)
    throw new PermanentJobError("Authorized parse context not found");
  if (["ready", "superseded"].includes(asset.rows[0].status)) {
    return { parsedViewId: job.payload.parsedViewId };
  }
  await updateJobProgress(db, job, "parse:starting", 10);
  const started = await db.query(
    `UPDATE parsed_view pv SET status = 'parsing'
     FROM data_asset da
     WHERE pv.id = $1 AND pv.asset_id = da.id AND da.id = $2
       AND da.project_id = $3 AND pv.status IN ('queued', 'parsing', 'parse_failed')
     RETURNING pv.id`,
    [job.payload.parsedViewId, job.payload.assetId, job.project_id],
  );
  if (!started.rowCount) {
    const current = await db.query(
      `SELECT pv.status
       FROM parsed_view pv JOIN data_asset da ON da.id = pv.asset_id
       WHERE pv.id = $1 AND da.id = $2 AND da.project_id = $3`,
      [job.payload.parsedViewId, job.payload.assetId, job.project_id],
    );
    const status = current.rows[0]?.status;
    if (["ready", "superseded"].includes(status))
      return { parsedViewId: job.payload.parsedViewId };
    if (["deletion_pending", "tombstoned"].includes(status))
      throw new PermanentJobError(
        "Controlled deletion has made this parse unavailable",
        "deletion_locked",
      );
    throw new PermanentJobError("Parse context is no longer active");
  }
  const stream = await artifacts.read(asset.rows[0].object_ref);
  await updateJobProgress(db, job, "parse:records", 40);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const parsed = await parseSourceRecords({
      assetId: job.payload.assetId,
      parsedViewId: job.payload.parsedViewId,
      format: asset.rows[0].format,
      parserVersion: asset.rows[0].parser_version,
      config: asset.rows[0].parser_config,
      bytes: stream,
      onBatch: async () => assertJobActive(db, job),
    });
    await updateJobProgress(db, job, "parse:database", 70, {
      totalRecords: parsed.summary.totalCount,
    });
    for (const [index, record] of parsed.records.entries()) {
      if (index % 100 === 0) await assertJobActive(db, job);
      await client.query(
        `INSERT INTO source_record
         (parsed_view_id, ordinal, value, locator, record_hash, parse_status, parse_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          job.payload.parsedViewId,
          record.ordinal,
          record.fields,
          record.locator,
          record.recordHash,
          record.parseStatus,
          record.error ?? null,
        ],
      );
    }
    const status = parsed.summary.boundaryTrusted ? "ready" : "parse_failed";
    if (status === "ready") {
      await client.query(
        `UPDATE parsed_view SET is_current = false,
           status = CASE WHEN status = 'ready' THEN 'superseded' ELSE status END
         WHERE asset_id = $1 AND id <> $2 AND is_current
           AND EXISTS (
             SELECT 1 FROM data_asset da
             WHERE da.id = parsed_view.asset_id AND da.project_id = $3
           )`,
        [job.payload.assetId, job.payload.parsedViewId, job.project_id],
      );
    }
    const finalized = await client.query(
      `UPDATE parsed_view SET status = $2, record_count = $3, success_count = $4,
         failure_count = $5, boundary_trusted = $6, draft_eligible = $7,
         is_current = $8, field_summary = $9, error_summary = $10
       FROM data_asset da
       WHERE parsed_view.id = $1 AND parsed_view.asset_id = da.id
         AND da.id = $11 AND da.project_id = $12
         AND parsed_view.status = 'parsing'
       RETURNING parsed_view.id`,
      [
        job.payload.parsedViewId,
        status,
        parsed.summary.totalCount,
        parsed.summary.successCount,
        parsed.summary.failureCount,
        parsed.summary.boundaryTrusted,
        parsed.summary.draftEligible ?? false,
        status === "ready",
        {
          profiles: parsed.summary.fieldProfiles ?? [],
          fields: parsed.summary.fields ?? [],
          detectedEncoding: parsed.summary.detectedEncoding,
          warnings: parsed.summary.warnings ?? [],
        },
        { errors: parsed.summary.blockingErrors ?? [] },
        job.payload.assetId,
        job.project_id,
      ],
    );
    if (!finalized.rowCount)
      throw new PermanentJobError(
        "Controlled deletion has made this parse unavailable",
        "deletion_locked",
      );
    const capacityBlock = parsed.summary.blockingErrors?.find(
      (error) => error.code === "source_record_limit_exceeded",
    );
    if (capacityBlock) {
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'parsed_view_capacity_blocked', 'parsed_view', $3, $4)`,
        [
          job.project_id,
          job.actor_id,
          job.payload.parsedViewId,
          {
            correlationId: job.id,
            assetId: job.payload.assetId,
            errorCode: capacityBlock.code,
            capacityBlock: true,
            blockingPhase: "parsed_view",
            actualRecords: capacityBlock.actualRecords,
            limitRecords: capacityBlock.limitRecords,
            retry: capacityBlock.retry,
          },
        ],
      );
    }
    await updateJobProgressInTransaction(client, job, "parse:commit", 90, {
      totalRecords: parsed.summary.totalCount,
    });
    const result = {
      parsedViewId: job.payload.parsedViewId,
      status,
      totalCount: parsed.summary.totalCount,
      counts: { totalRecords: parsed.summary.totalCount },
    };
    await assertJobDeletionSafe(client, job);
    await completeJobInTransaction(client, job, result);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (!(error instanceof JobCancelledError))
      await db.query(
        `UPDATE parsed_view pv
         SET status = 'parse_failed', record_count = NULL, field_summary = NULL
         FROM data_asset da
         WHERE pv.asset_id = da.id
           AND pv.id = $1 AND da.project_id = $2
           AND pv.status = 'parsing'`,
        [job.payload.parsedViewId, job.project_id],
      );
    throw error;
  } finally {
    client.release();
  }
}

async function materializeCandidate(
  db: Database,
  artifacts: ArtifactRepository,
  job: Job,
): Promise<Record<string, unknown>> {
  await assertJobDeletionSafe(db, job);
  const result = { candidateId: job.payload.candidateId };
  const context = await db.query(
    `SELECT cs.id AS candidate_id, cs.status AS candidate_status,
            COALESCE(dr.base_version_id, cs.base_version_id) AS base_version_id,
            cs.change_note, wd.id AS draft_id,
            COALESCE(dr.recipe, cs.recipe) AS recipe,
            COALESCE(dr.sources, cs.sources, '[]'::jsonb) AS sources,
            COALESCE(dr.operations, '[]'::jsonb) AS operations,
            cs.schema_revision_id AS formal_schema_id,
            ts.id AS test_set_id, ts.name AS test_set_name,
            fs.dialect, fs.mode, fs.input_schema, fs.expected_output_schema
     FROM candidate_snapshot cs JOIN working_draft wd ON wd.id = cs.draft_id
     LEFT JOIN draft_revision dr ON dr.id = cs.draft_revision_id
     JOIN test_set ts ON ts.id = wd.test_set_id
     JOIN formal_schema_revision fs ON fs.id = cs.schema_revision_id
     JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
     WHERE cs.id = $1 AND ts.project_id = $2
       AND cs.status IN ('materializing', 'ready_to_publish')
       AND pm.role IN ('owner', 'editor')`,
    [job.payload.candidateId, job.project_id, job.actor_id],
  );
  if (!context.rowCount)
    throw new PermanentJobError("Candidate context not found");
  const row = context.rows[0];
  if (row.candidate_status === "ready_to_publish")
    return { candidateId: row.candidate_id, replayed: true };
  await updateJobProgress(db, job, "candidate:capacity", 10);

  const draftCapacityResult = await db.query(CANDIDATE_CAPACITY_SQL, [
    JSON.stringify(row.sources ?? []),
  ]);
  const draftCapacity = draftCapacityFromRow(draftCapacityResult.rows[0]);
  const aggregateExceeded = draftCapacityExceeded(draftCapacity);
  const singleAssetExceeded =
    draftCapacity.largestAssetBytes > CAPACITY_LIMITS.dataAssetBytes
      ? "dataAssetBytes"
      : draftCapacity.largestAssetRecords > CAPACITY_LIMITS.parsedViewRecords
        ? "parsedViewRecords"
        : undefined;
  if (aggregateExceeded || singleAssetExceeded)
    throw new CandidateValidationError({
      valid: false,
      errorCode: "draft_capacity_exceeded",
      capacityBlock: true,
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      exceededDimension: aggregateExceeded ?? singleAssetExceeded,
      actual: draftCapacity,
      limit: {
        assets: CAPACITY_LIMITS.draftAssets,
        originalBytes: CAPACITY_LIMITS.draftOriginalBytes,
        sourceRecords: CAPACITY_LIMITS.draftSourceRecords,
        largestAssetBytes: CAPACITY_LIMITS.dataAssetBytes,
        largestAssetRecords: CAPACITY_LIMITS.parsedViewRecords,
      },
      retry:
        "Correct the Working Draft attachment capacity, then materialize a new Candidate.",
      errors: [
        {
          code: "draft_capacity_exceeded",
          exceededDimension: aggregateExceeded ?? singleAssetExceeded,
          actual: draftCapacity,
          limit: {
            assets: CAPACITY_LIMITS.draftAssets,
            originalBytes: CAPACITY_LIMITS.draftOriginalBytes,
            sourceRecords: CAPACITY_LIMITS.draftSourceRecords,
            largestAssetBytes: CAPACITY_LIMITS.dataAssetBytes,
            largestAssetRecords: CAPACITY_LIMITS.parsedViewRecords,
          },
        },
      ],
    });

  const sourceRows = await db.query(
    `SELECT source.value ->> 'draftSourceId' AS draft_source_id,
            source.value ->> 'assetId' AS asset_id,
            source.value ->> 'parsedViewId' AS parsed_view_id,
            source.value -> 'mapping' AS mapping,
            source.value -> 'unmappedFields' AS unmapped_fields,
            (source.value ->> 'unmappedConfirmed')::boolean AS unmapped_confirmed,
            (source.value ->> 'position')::integer AS position,
            source.value ->> 'parserName' AS parser_name,
            source.value ->> 'parserVersion' AS parser_version,
            (source.value ->> 'recordCount')::integer AS record_count,
            source.value -> 'attribution' ->> 'id' AS attribution_id,
            source.value -> 'attribution' ->> 'sourceType' AS source_type,
            source.value -> 'attribution' ->> 'sourceName' AS source_name,
            source.value -> 'attribution' ->> 'responsibleActor' AS responsible_actor,
            source.value -> 'attribution' ->> 'responsiblePerson' AS responsible_person,
            source.value -> 'attribution' ->> 'purpose' AS purpose,
            source.value -> 'attribution' ->> 'licenseStatus' AS license_status,
            source.value -> 'attribution' ->> 'sensitivity' AS sensitivity,
            source.value -> 'attribution' ->> 'sourceAddress' AS source_address,
            source.value -> 'attribution' ->> 'acquiredAt' AS acquired_at,
            (source.value -> 'attribution' ->> 'deidentificationConfirmed')::boolean
              AS deidentification_confirmed,
            pv.parser_name AS parsed_parser_name, pv.parser_version AS parsed_parser_version,
            pv.record_count AS parsed_record_count,
            pv.format AS parser_format, pv.parser_config AS parser_config
     FROM candidate_snapshot cs
     LEFT JOIN draft_revision dr ON dr.id = cs.draft_revision_id
     CROSS JOIN LATERAL jsonb_array_elements(
       COALESCE(dr.sources, cs.sources, '[]'::jsonb)
     ) source(value)
     JOIN parsed_view pv
       ON pv.id = source.value ->> 'parsedViewId'
     JOIN data_asset da
       ON da.id = pv.asset_id
      AND da.project_id = $2
      AND da.id = source.value ->> 'assetId'
     WHERE cs.id = $1
     ORDER BY (source.value ->> 'position')::integer`,
    [row.candidate_id, job.project_id],
  );
  if (
    sourceRows.rowCount !==
    (Array.isArray(row.sources) ? row.sources.length : 0)
  )
    throw publicationIntegrityError({
      code: "publication_project_scope_mismatch",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      retry:
        "Repair the frozen source reference before retrying materialization.",
    });
  await updateJobProgress(db, job, "candidate:sources", 25, {
    sources: sourceRows.rowCount,
  });
  if (
    sourceRows.rows.some(
      (source) =>
        !isAllowedSourceAttribution({
          sourceType: source.source_type,
          sourceName: source.source_name,
          responsiblePerson: source.responsible_person,
          purpose: source.purpose,
          licenseStatus: source.license_status,
          sensitivity: source.sensitivity,
          sourceAddress: source.source_address,
          acquiredAt: source.acquired_at
            ? new Date(source.acquired_at).toISOString()
            : null,
          deidentificationConfirmed: source.deidentification_confirmed,
        }),
    )
  )
    throw new CandidateValidationError({
      valid: false,
      errorCode: "data_classification_not_allowed",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      errors: [{ code: "data_classification_not_allowed" }],
      retry:
        "Use only allowed non-sensitive synthetic, public, or deidentified source attributions.",
    });

  const attachedAssetIds = sourceRows.rows.map((source) => source.asset_id);
  const transformationRunRows = await db.query(
    `SELECT tr.*, tro.asset_id, tro.sha256 AS output_sha256,
            tro.record_count AS output_record_count
     FROM transformation_run_output tro
     JOIN transformation_run tr ON tr.id = tro.run_id
     WHERE tr.project_id = $1 AND tro.asset_id = ANY($2::text[])`,
    [job.project_id, attachedAssetIds],
  );
  const derivedWithoutRun = await db.query(
    `SELECT da.id FROM data_asset da
     WHERE da.project_id = $1 AND da.asset_kind = 'derived'
       AND da.id = ANY($2::text[])
       AND NOT EXISTS (
         SELECT 1 FROM transformation_run_output tro
         WHERE tro.asset_id = da.id AND tro.project_id = da.project_id
       )`,
    [job.project_id, attachedAssetIds],
  );
  if (derivedWithoutRun.rowCount)
    throw new CandidateValidationError({
      valid: false,
      errorCode: "transformation_run_missing",
      object: { type: "data_asset", id: derivedWithoutRun.rows[0].id },
      blockingPhase: "candidate_materialization",
      errors: [
        {
          code: "transformation_run_missing",
          assetId: derivedWithoutRun.rows[0].id,
        },
      ],
      retry:
        "Register a complete Transformation Run for every derived Data Asset.",
    });
  const lineageReport = validateForPublication(
    transformationRunRows.rows.map((run) => ({
      ...run,
      validation_report: run.validation_report,
    })),
  );
  if (!lineageReport.valid)
    throw new CandidateValidationError({
      ...lineageReport,
      valid: false,
    });
  const transformationRuns = transformationRunRows.rows.map((run) => ({
    ...run.manifest,
    id: run.id,
    manifestHash: run.manifest_hash,
  }));
  const evidenceSources = mergeSourceSnapshots(
    sourceRows.rows,
    await collectReferencedVersionSources(
      db,
      job.project_id,
      transformationRuns,
      row.base_version_id ? [String(row.base_version_id)] : [],
    ),
  );
  const transformationRunByAsset = new Map(
    transformationRunRows.rows.map((run) => [run.asset_id, run]),
  );
  const transformationEdges = transformationRunRows.rowCount
    ? await db.query(
        `SELECT run_id, output_ordinal, input_ref
         FROM transformation_record_edge
         WHERE run_id = ANY($1::text[])
         ORDER BY run_id, output_ordinal, id`,
        [transformationRunRows.rows.map((run) => run.id)],
      )
    : { rows: [] as Array<Record<string, unknown>> };
  const transformationEdgesByRunAndOrdinal = new Map<string, Array<unknown>>();
  for (const edge of transformationEdges.rows) {
    const key = `${edge.run_id}:${Number(edge.output_ordinal)}`;
    transformationEdgesByRunAndOrdinal.set(key, [
      ...(transformationEdgesByRunAndOrdinal.get(key) ?? []),
      edge.input_ref,
    ]);
  }

  type ComposedItem = {
    case_id: string;
    input: Record<string, unknown>;
    expected_output: unknown;
    metadata: Record<string, unknown>;
    contentHash: string;
    lineageFingerprint?: string;
    lineageLevel: "record_level" | "asset_level";
    source?: NonNullable<PackageItem["source"]>;
    lineage: Record<string, unknown>;
    originKind:
      | "source_record"
      | "parent_revision"
      | "manual_revision"
      | "manual_creation"
      | "transformation_run";
    draftSourceId?: string;
    parsedViewId?: string;
    sourceRecordOrdinal?: number;
    parentRevisionId?: string;
    manualReason?: string;
    transformationRunId?: string;
  };

  const lineageFingerprintFor = (item: {
    originKind: ComposedItem["originKind"];
    lineage: Record<string, unknown>;
    parentRevisionId?: string;
    sourceRecordOrdinal?: number;
  }) =>
    sha256(
      canonicalJson({
        originKind: item.originKind,
        originRef: item.lineage,
        parentRevisionId: item.parentRevisionId ?? null,
        sourceRecordOrdinal: Number(item.sourceRecordOrdinal ?? 0),
      }),
    );

  const items: ComposedItem[] = [];
  if (row.base_version_id) {
    const base = await db.query(
      `SELECT cr.id AS revision_id, cr.case_id, cr.input, cr.expected_output,
              cr.metadata, cr.content_hash, cr.lineage_fingerprint,
              cr.lineage_level, cr.origin_ref, cr.transformation_run_id
       FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id = vm.case_revision_id
       WHERE vm.version_id = $1 ORDER BY vm.ordinal`,
      [row.base_version_id],
    );
    for (const member of base.rows) {
      const input = member.input as Record<string, unknown>;
      const metadata = member.metadata as Record<string, unknown>;
      const originalLineage = member.origin_ref as Record<
        string,
        unknown
      > | null;
      const lineage =
        originalLineage?.transformation_run ||
        originalLineage?.level === "asset_level"
          ? originalLineage
          : {
              level: "record_level",
              parent_case_revision: {
                caseId: member.case_id,
                revisionId: member.revision_id,
              },
            };
      items.push({
        case_id: member.case_id,
        input,
        expected_output: member.expected_output,
        metadata,
        contentHash: member.content_hash,
        lineageFingerprint: member.lineage_fingerprint,
        lineageLevel: member.lineage_level ?? "record_level",
        lineage,
        originKind: "parent_revision",
        parentRevisionId: member.revision_id,
        transformationRunId: member.transformation_run_id ?? undefined,
      });
    }
  }
  await updateJobProgress(db, job, "candidate:identity", 55, {
    items: items.length,
  });

  const recipe = row.recipe;
  const mappingErrors: any[] = [];
  for (const source of sourceRows.rows) {
    if (!source.mapping || !source.unmapped_confirmed)
      throw new CandidateValidationError({
        valid: false,
        errors: [
          {
            code: "mapping_invalid",
            sourceId: source.draft_source_id,
          },
        ],
      });
    const mapping = normalizeDraftMapping(source.mapping);
    if (!mapping)
      throw new CandidateValidationError({
        valid: false,
        errors: [{ code: "mapping_invalid", sourceId: source.draft_source_id }],
      });
    const records = await db.query(
      `SELECT sr.ordinal, sr.value, sr.locator, sr.record_hash
       FROM source_record sr
       JOIN parsed_view pv ON pv.id = sr.parsed_view_id
       JOIN data_asset da ON da.id = pv.asset_id AND da.project_id = $2
       WHERE sr.parsed_view_id = $1 AND sr.parse_status = 'valid'
       ORDER BY sr.ordinal`,
      [source.parsed_view_id, job.project_id],
    );
    const selected = new Set(
      evaluateRecipe(
        records.rows.map((record: any) => ({
          id: `${source.parsed_view_id}:${record.ordinal}`,
          sampleKey: record.record_hash,
          ordinal: Number(record.ordinal),
          fields: record.value,
        })),
        recipeSteps(recipe),
      ).records.map((record) => record.ordinal),
    );
    const bindingClient = await db.connect();
    try {
      await bindingClient.query("BEGIN");
      for (const [index, record] of records.rows.entries()) {
        if (index % 100 === 0) await assertJobActive(db, job);
        if (!selected.has(Number(record.ordinal))) continue;
        const proposed = `case_${randomUUID().replaceAll("-", "")}`;
        await bindingClient.query(
          `INSERT INTO draft_case_binding
           (test_set_id, draft_source_id, source_id, source_record_ordinal, output_slot, case_id)
           VALUES ($1, $2, $3, $4, 'primary', $5) ON CONFLICT DO NOTHING`,
          [
            row.test_set_id,
            row.draft_id,
            source.draft_source_id,
            record.ordinal,
            proposed,
          ],
        );
        const binding = await bindingClient.query(
          `SELECT case_id FROM draft_case_binding
           WHERE test_set_id = $1 AND source_record_ordinal = $2 AND output_slot = 'primary'
             AND ((source_id = $3) OR (source_id IS NULL AND draft_source_id = $4))`,
          [
            row.test_set_id,
            record.ordinal,
            source.draft_source_id,
            row.draft_id,
          ],
        );
        const replay = replayMapping(record.value, mapping);
        for (const error of replay.errors)
          mappingErrors.push({
            sourceId: source.draft_source_id,
            ordinal: Number(record.ordinal),
            locator: record.locator,
            ...error,
          });
        const input = replay.item.input as Record<string, unknown>;
        const metadata = replay.item.metadata as Record<string, unknown>;
        const outputSource = {
          assetId: source.asset_id,
          parsedViewId: source.parsed_view_id,
          ordinal: Number(record.ordinal),
          locator: record.locator,
          recordHash: record.record_hash,
        };
        const transformationRun = transformationRunByAsset.get(source.asset_id);
        const runEvidence = transformationRun
          ? {
              ...transformationRun.manifest,
              id: transformationRun.id,
              manifestHash: transformationRun.manifest_hash,
            }
          : undefined;
        let lineage: Record<string, unknown>;
        let originKind: ComposedItem["originKind"] = "source_record";
        let lineageLevel: ComposedItem["lineageLevel"] = "record_level";
        if (transformationRun?.lineage_level === "asset_level") {
          lineage = {
            level: "asset_level",
            transformation_run: runEvidence,
            input_scope: transformationRun.manifest.inputs,
            output_asset: {
              assetId: transformationRun.asset_id,
              sha256: transformationRun.output_sha256,
              recordCount: Number(transformationRun.output_record_count),
            },
          };
          originKind = "transformation_run";
          lineageLevel = "asset_level";
        } else if (transformationRun) {
          const parents = transformationEdgesByRunAndOrdinal.get(
            `${transformationRun.id}:${Number(record.ordinal)}`,
          );
          if (!parents?.length)
            throw new CandidateValidationError({
              valid: false,
              errorCode: "transformation_record_edge_missing",
              object: { type: "transformation_run", id: transformationRun.id },
              blockingPhase: "candidate_materialization",
              errors: [
                {
                  code: "transformation_record_edge_missing",
                  runId: transformationRun.id,
                  outputOrdinal: Number(record.ordinal),
                },
              ],
              retry:
                "Provide one or more concrete input references for every output record.",
            });
          lineage = {
            level: "record_level",
            transformation_run: runEvidence,
            parent_inputs: parents,
          };
          originKind = "transformation_run";
        } else {
          lineage = {
            level: "record_level",
            source_record: outputSource,
          };
        }
        items.push({
          case_id: binding.rows[0].case_id,
          input,
          expected_output: replay.item.expected_output,
          metadata,
          contentHash: sha256(
            canonicalJson({
              input,
              expected_output: replay.item.expected_output,
              metadata,
            }),
          ),
          ...(originKind === "source_record" ? { source: outputSource } : {}),
          lineage,
          lineageLevel,
          lineageFingerprint: lineageFingerprintFor({
            originKind,
            lineage,
            sourceRecordOrdinal: Number(record.ordinal),
          }),
          originKind,
          draftSourceId: source.draft_source_id,
          parsedViewId: source.parsed_view_id,
          sourceRecordOrdinal: Number(record.ordinal),
          transformationRunId: transformationRun?.id,
        });
      }
      await bindingClient.query("COMMIT");
    } catch (error) {
      await bindingClient.query("ROLLBACK");
      throw error;
    } finally {
      bindingClient.release();
    }
  }

  const operations = Array.isArray(row.operations) ? row.operations : [];
  for (const operation of operations) {
    const index = items.findIndex((item) => item.case_id === operation.case_id);
    if (operation.operation === "delete") {
      if (index >= 0) items.splice(index, 1);
      continue;
    }
    if (operation.operation === "update") {
      if (index < 0)
        throw new CandidateValidationError({
          valid: false,
          errors: [{ code: "case_not_found", caseId: operation.case_id }],
        });
      const current = items[index];
      const input = (operation.input ?? current.input) as Record<
        string,
        unknown
      >;
      const expectedOutput =
        operation.expected_output === null &&
        !Object.prototype.hasOwnProperty.call(
          operation.diff ?? {},
          "expected_output",
        )
          ? current.expected_output
          : operation.expected_output;
      const metadata = (operation.metadata ?? current.metadata) as Record<
        string,
        unknown
      >;
      const contentHash = sha256(
        canonicalJson({ input, expected_output: expectedOutput, metadata }),
      );
      const lineage = {
        ...current.lineage,
        manual_event: {
          kind: "revision",
          actorId: operation.created_by,
          reason: operation.reason,
        },
      };
      items[index] = {
        ...current,
        input,
        expected_output: expectedOutput,
        metadata,
        contentHash,
        lineage,
        lineageLevel: current.lineageLevel,
        lineageFingerprint: lineageFingerprintFor({
          originKind: "manual_revision",
          lineage,
          parentRevisionId: current.parentRevisionId,
          sourceRecordOrdinal: current.sourceRecordOrdinal,
        }),
        originKind: "manual_revision",
        manualReason: operation.reason,
        transformationRunId: current.transformationRunId,
      };
      continue;
    }
    const input = operation.input as Record<string, unknown>;
    const metadata = (operation.metadata ?? {}) as Record<string, unknown>;
    const lineage = {
      level: "record_level",
      manual_creation: {
        actorId: operation.created_by,
        reason: operation.reason,
      },
    };
    items.push({
      case_id: operation.case_id,
      input,
      expected_output: operation.expected_output,
      metadata,
      contentHash: sha256(
        canonicalJson({
          input,
          expected_output: operation.expected_output,
          metadata,
        }),
      ),
      lineage,
      lineageLevel: "record_level",
      lineageFingerprint: lineageFingerprintFor({
        originKind: "manual_creation",
        lineage,
      }),
      originKind: "manual_creation",
      manualReason: operation.reason,
    });
  }

  const invalidMetadata = items.find(
    (item) => !isValidCaseMetadata(item.metadata),
  );
  if (invalidMetadata)
    throw new CandidateValidationError({
      valid: false,
      errorCode: "item_metadata_invalid",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      caseId: invalidMetadata.case_id,
      errors: [
        { code: "item_metadata_invalid", caseId: invalidMetadata.case_id },
      ],
      retry:
        "Correct each Test Case metadata to a JSON object without _agentbench.",
    });

  const byContent = new Map<string, ComposedItem[]>();
  for (const item of items)
    byContent.set(item.contentHash, [
      ...(byContent.get(item.contentHash) ?? []),
      item,
    ]);
  const duplicateGroups = [...byContent.values()].filter(
    (group) => group.length > 1,
  );
  const duplicateDecisions = new Map<string, "include" | "exclude">(
    Object.entries(recipe?.duplicateDecisions ?? {}),
  );
  const duplicateContentHashes = new Map<string, string>(
    Object.entries(recipe?.duplicateContentHashes ?? {}),
  );
  for (const [caseId, decision] of duplicateDecisions) {
    if (decision !== "exclude") continue;
    const index = items.findIndex(
      (item) =>
        item.case_id === caseId &&
        duplicateContentHashes.get(caseId) === item.contentHash,
    );
    if (index >= 0) items.splice(index, 1);
  }
  const includedDuplicates: string[] = [];
  for (const group of duplicateGroups) {
    for (const item of group) {
      const decision = duplicateDecisions.get(item.case_id);
      if (
        decision === "exclude" &&
        duplicateContentHashes.get(item.case_id) !== item.contentHash
      ) {
        const contentHashes = Object.fromEntries(
          group.map((duplicate) => [duplicate.case_id, duplicate.contentHash]),
        );
        throw new CandidateValidationError({
          valid: false,
          errorCode: "duplicate_content_requires_decision",
          object: { type: "candidate_snapshot", id: row.candidate_id },
          blockingPhase: "candidate_materialization",
          duplicateCaseIds: group.map((duplicate) => duplicate.case_id),
          duplicateContentHashes: contentHashes,
          retry: "Explicitly include or exclude every duplicate Test Case.",
          errors: [
            {
              code: "duplicate_content_requires_decision",
              duplicateCaseIds: group.map((duplicate) => duplicate.case_id),
              duplicateContentHashes: contentHashes,
            },
          ],
        });
      }
      if (decision !== "include" && decision !== "exclude") {
        const contentHashes = Object.fromEntries(
          group.map((duplicate) => [duplicate.case_id, duplicate.contentHash]),
        );
        throw new CandidateValidationError({
          valid: false,
          errorCode: "duplicate_content_requires_decision",
          object: { type: "candidate_snapshot", id: row.candidate_id },
          blockingPhase: "candidate_materialization",
          duplicateCaseIds: group.map((duplicate) => duplicate.case_id),
          duplicateContentHashes: contentHashes,
          retry: "Explicitly include or exclude every duplicate Test Case.",
          errors: [
            {
              code: "duplicate_content_requires_decision",
              duplicateCaseIds: group.map((duplicate) => duplicate.case_id),
              duplicateContentHashes: contentHashes,
            },
          ],
        });
      }
      if (decision === "exclude") {
        const index = items.indexOf(item);
        if (index >= 0) items.splice(index, 1);
      } else includedDuplicates.push(item.case_id);
    }
  }

  if (!items.length)
    throw new CandidateValidationError({
      valid: false,
      errorCode: "candidate_empty",
      capacityBlock: true,
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      exceededDimension: "candidate_minimum_items",
      actual: 0,
      limit: 1,
      minimumItems: 1,
      maximumItems: CAPACITY_LIMITS.candidateItems,
      actualItems: 0,
      limitItems: CAPACITY_LIMITS.candidateItems,
      retry:
        "A Candidate needs at least one item; include a Source Record or create a manual Test Case.",
      errors: [
        {
          code: "candidate_empty",
          actual: 0,
          limit: 1,
          minimumItems: 1,
          maximumItems: CAPACITY_LIMITS.candidateItems,
          retry:
            "A Candidate needs at least one item; include a Source Record or create a manual Test Case.",
        },
      ],
    });
  if (items.length > CAPACITY_LIMITS.candidateItems)
    throw new CandidateValidationError({
      valid: false,
      capacityBlock: true,
      errorCode: "candidate_item_count_exceeded",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      actualItems: items.length,
      limitItems: CAPACITY_LIMITS.candidateItems,
      errors: [
        {
          code: "candidate_item_count_exceeded",
          actualItems: items.length,
          limitItems: CAPACITY_LIMITS.candidateItems,
        },
      ],
      retry: "Reduce the selected records before materializing a Candidate.",
    });
  if (mappingErrors.length)
    throw new CandidateValidationError({
      valid: false,
      errors: mappingErrors,
      exclusions: manualExclusions(recipe),
    });

  const inputCapacityErrors = items.flatMap((item) => {
    const actualBytes = Buffer.byteLength(canonicalJson(item.input));
    return actualBytes > CAPACITY_LIMITS.inputBytes
      ? [
          {
            code: "input_capacity_exceeded",
            caseId: item.case_id,
            ordinal: item.sourceRecordOrdinal ?? null,
            locator: item.source?.locator,
            actualBytes,
            limitBytes: CAPACITY_LIMITS.inputBytes,
            blockingPhase: "candidate_materialization",
          },
        ]
      : [];
  });
  if (inputCapacityErrors.length)
    throw new CandidateValidationError({
      valid: false,
      capacityBlock: true,
      errorCode: "input_capacity_exceeded",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      errors: inputCapacityErrors,
      blockingPhase: "candidate_materialization",
      actualBytes: Math.max(
        ...inputCapacityErrors.map((item) => item.actualBytes),
      ),
      limitBytes: CAPACITY_LIMITS.inputBytes,
      retry: "Reduce the mapped input or exclude this Test Case explicitly.",
    });

  let projectedItemsBytes = 0;
  for (const item of items) {
    projectedItemsBytes += Buffer.byteLength(
      `${canonicalJson({
        case_id: item.case_id,
        input: item.input,
        expected_output: item.expected_output,
        metadata: item.metadata,
      })}\n`,
    );
    if (projectedItemsBytes > CAPACITY_LIMITS.itemsBytes) break;
  }
  if (projectedItemsBytes > CAPACITY_LIMITS.itemsBytes)
    throw new CandidateValidationError({
      valid: false,
      capacityBlock: true,
      errorCode: "items_capacity_exceeded",
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization_projection",
      actualItems: items.length,
      limitItems: CAPACITY_LIMITS.candidateItems,
      actualBytes: projectedItemsBytes,
      limitBytes: CAPACITY_LIMITS.itemsBytes,
      errors: [
        {
          code: "items_capacity_exceeded",
          actualItems: items.length,
          limitItems: CAPACITY_LIMITS.candidateItems,
          actualBytes: projectedItemsBytes,
          limitBytes: CAPACITY_LIMITS.itemsBytes,
        },
      ],
      retry:
        "Reduce the selected records or mapping output before materialization work starts.",
    });

  const formalValidation = validateFormalItems(
    row.input_schema,
    row.expected_output_schema,
    items,
    row.mode,
  );
  if (!formalValidation.valid) {
    const formalErrors = items.flatMap((item) =>
      validateFormalItems(
        row.input_schema,
        row.expected_output_schema,
        [item],
        row.mode,
      ).errors.map((error) => ({
        caseId: item.case_id,
        ordinal: item.sourceRecordOrdinal ?? null,
        locator: item.source?.locator,
        instancePath: error.instancePath ?? "/",
        code: error.keyword,
      })),
    );
    throw new CandidateValidationError({
      valid: false,
      errors: formalErrors,
      exclusions: manualExclusions(recipe),
    });
  }

  const packageItems: PackageItem[] = items.map((item) => ({
    case_id: item.case_id,
    input: item.input,
    expected_output: item.expected_output,
    metadata: item.metadata,
    ...(item.source ? { source: item.source } : {}),
    lineage: item.lineage,
  }));
  const packageInput = {
    testSet: { id: row.test_set_id, name: row.test_set_name },
    version: {
      id: "candidate",
      number: 1,
      publishedAt: "1980-01-01T00:00:00.000Z",
      parentId: row.base_version_id ?? null,
    },
    schema: {
      dialect: row.dialect,
      revisionId: row.formal_schema_id,
      mode: row.mode,
      input: row.input_schema,
      expectedOutput: row.expected_output_schema,
    },
    recipe,
    sources: evidenceSources.map(sourceSnapshotToPackageSource),
    items: packageItems,
    transformationRuns,
  };
  let itemIndex = 0;
  const itemStream = new Readable({
    read() {
      if (itemIndex >= items.length) {
        this.push(null);
        return;
      }
      const item = items[itemIndex];
      this.push(
        Buffer.from(
          `${canonicalJson({
            case_id: item.case_id,
            input: item.input,
            expected_output: item.expected_output,
            metadata: item.metadata,
          })}\n`,
        ),
      );
      itemIndex += 1;
    },
  });
  let stagedItems;
  try {
    await updateJobProgress(db, job, "candidate:items", 70, {
      items: items.length,
    });
    stagedItems = await artifacts.stageStream(
      row.candidate_id,
      itemStream,
      CAPACITY_LIMITS.itemsBytes,
      "items_capacity_exceeded",
    );
    await updateJobProgress(db, job, "candidate:finalize", 80, {
      items: items.length,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "items_capacity_exceeded")
      throw error;
    throw new CandidateValidationError({
      valid: false,
      errorCode: "items_capacity_exceeded",
      capacityBlock: true,
      object: { type: "candidate_snapshot", id: row.candidate_id },
      blockingPhase: "candidate_materialization",
      actualItems: items.length,
      limitItems: CAPACITY_LIMITS.candidateItems,
      actualBytes: (error as { observedBytes?: number }).observedBytes,
      limitBytes: CAPACITY_LIMITS.itemsBytes,
      errors: [
        {
          code: "items_capacity_exceeded",
          actualItems: items.length,
          limitItems: CAPACITY_LIMITS.candidateItems,
          actualBytes: (error as { observedBytes?: number }).observedBytes,
          limitBytes: CAPACITY_LIMITS.itemsBytes,
        },
      ],
      retry:
        "Reduce the selected records or mapping output, then materialize a new Candidate.",
    });
  }
  const storedItems = await artifacts.commitStaged(stagedItems);
  const prepared = createStandardEvidence({
    ...packageInput,
    itemsSha256: stagedItems.sha256,
  });
  const evidenceFiles = Object.fromEntries(
    EVIDENCE_FILES.map((path) => [path, prepared.files[path]]),
  );
  const storedEvidence = await artifacts.storeCollection(evidenceFiles);
  await updateJobProgress(db, job, "candidate:commit", 90, {
    items: items.length,
  });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE candidate_snapshot
       SET status = 'ready_to_publish',
           asset_id = COALESCE($2, asset_id), parsed_view_id = COALESCE($3, parsed_view_id),
           schema_revision_id = $4, recipe = $5, item_count = $6,
           payload_hash = $7, evidence_hash = $8, validation_report = $9,
           object_ref = $10, evidence_object_ref = $11, sources = $12
       WHERE id = $1`,
      [
        row.candidate_id,
        sourceRows.rows[0]?.asset_id ?? null,
        sourceRows.rows[0]?.parsed_view_id ?? null,
        row.formal_schema_id,
        recipe,
        items.length,
        prepared.payloadHash,
        prepared.evidenceHash,
        {
          ...formalValidation,
          mode: row.mode,
          lineageLevels: {
            recordLevel: items.filter(
              (item) => item.lineageLevel === "record_level",
            ).length,
            assetLevel: items.filter(
              (item) => item.lineageLevel === "asset_level",
            ).length,
          },
          exclusions: manualExclusions(recipe),
          warnings: includedDuplicates.length
            ? [
                {
                  code: "duplicate_content_included",
                  caseIds: includedDuplicates,
                },
              ]
            : [],
        },
        storedItems.objectRef,
        storedEvidence.objectRef,
        JSON.stringify(
          sourceRows.rows.map((source) => ({
            draftSourceId: source.draft_source_id,
            assetId: source.asset_id,
            parsedViewId: source.parsed_view_id,
            position: Number(source.position),
            mapping: source.mapping,
            unmappedFields: source.unmapped_fields,
            parserName: source.parser_name,
            parserVersion: source.parser_version,
            recordCount: source.record_count,
            parserFormat: source.parser_format,
            parserConfig: source.parser_config,
            attribution: {
              id: source.attribution_id,
              sourceType: source.source_type,
              sourceName: source.source_name,
              purpose: source.purpose,
              responsibleActor: source.responsible_actor,
              responsiblePerson: source.responsible_person,
              licenseStatus: source.license_status,
              sensitivity: source.sensitivity,
              sourceAddress: source.source_address,
              acquiredAt: source.acquired_at,
              deidentificationConfirmed: source.deidentification_confirmed,
            },
          })),
        ),
      ],
    );
    await updateJobProgressInTransaction(
      client,
      job,
      "candidate:visibility",
      95,
      {
        items: items.length,
      },
    );
    for (const [index, item] of items.entries()) {
      if (index % 100 === 0) await assertJobActive(db, job);
      await client.query(
        `INSERT INTO candidate_item
         (candidate_id, ordinal, case_id, source_record_ordinal, content_hash,
          draft_source_id, parsed_view_id, origin_kind, parent_case_revision_id,
          manual_reason, origin_ref, lineage_fingerprint, lineage_level,
          transformation_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (candidate_id, ordinal) DO NOTHING`,
        [
          row.candidate_id,
          index + 1,
          item.case_id,
          item.sourceRecordOrdinal ?? 0,
          item.contentHash,
          item.draftSourceId ?? null,
          item.parsedViewId ?? null,
          item.originKind,
          item.parentRevisionId ?? null,
          item.manualReason ?? null,
          JSON.stringify(item.lineage),
          item.lineageFingerprint ?? null,
          item.lineageLevel,
          item.transformationRunId ?? null,
        ],
      );
    }
    for (const transformationRun of transformationRuns) {
      await client.query(
        `INSERT INTO candidate_transformation_run
         (candidate_id, run_id, evidence, manifest_hash)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [
          row.candidate_id,
          transformationRun.id,
          JSON.stringify(transformationRun),
          transformationRun.manifestHash,
        ],
      );
    }
    await client.query(
      "UPDATE working_draft SET status = 'editing' WHERE id = $1",
      [row.draft_id],
    );
    await assertJobDeletionSafe(client, job);
    await completeJobInTransaction(client, job, result);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return result;
}

async function publishVersion(
  db: Database,
  artifacts: ArtifactRepository,
  job: Job,
): Promise<Record<string, unknown>> {
  await assertJobDeletionSafe(db, job);
  const context = await db.query(
    `SELECT cs.*, wd.id AS draft_id, wd.base_version_id,
            COALESCE(cs.sources, dr.sources) AS frozen_sources,
            fs.dialect, fs.mode, fs.input_schema, fs.expected_output_schema,
            ts.id AS test_set_id, ts.name AS test_set_name,
            pv.parser_name, pv.parser_version, pv.record_count,
            pv.format AS parser_format, pv.parser_config,
            sar.source_type, sar.source_name, sar.purpose, sar.responsible_actor,
            sar.responsible_person,
            sar.license_status, sar.sensitivity, sar.source_address,
            sar.acquired_at, sar.deidentification_confirmed
     FROM candidate_snapshot cs JOIN working_draft wd ON wd.id = cs.draft_id
     LEFT JOIN draft_revision dr ON dr.id = cs.draft_revision_id
     JOIN test_set ts ON ts.id = wd.test_set_id
     JOIN formal_schema_revision fs ON fs.id = cs.schema_revision_id
     LEFT JOIN parsed_view pv ON pv.id = cs.parsed_view_id
     LEFT JOIN source_attribution_revision sar ON sar.id = cs.attribution_revision_id
     JOIN project_member pm ON pm.project_id = ts.project_id AND pm.user_id = $3
     WHERE cs.id = $1 AND cs.status IN ('publishing', 'published_as_version')
       AND ts.project_id = $2 AND pm.role IN ('owner', 'editor')`,
    [job.payload.candidateId, job.project_id, job.actor_id],
  );
  if (!context.rowCount)
    throw new PermanentJobError("Publishable candidate not found");
  const row = context.rows[0];
  const frozenSources = await hydrateSourceSnapshots(
    db,
    job.project_id,
    sourceSnapshotsFromRow(row, row.frozen_sources ?? row.sources),
  );
  await updateJobProgress(db, job, "publication:precheck", 10);
  const storedCandidateObjectBytes = await artifacts.size(row.object_ref);
  if (storedCandidateObjectBytes > CAPACITY_LIMITS.itemsBytes)
    throw publicationCapacityError({
      exceededDimension: "candidate_object_bytes",
      retry:
        "Materialize a new Candidate after correcting the oversized items artifact.",
      object: { type: "candidate_snapshot", id: row.id },
      actual: storedCandidateObjectBytes,
      limit: CAPACITY_LIMITS.itemsBytes,
    });
  const precheckCandidate = {
    itemCount: Number(row.item_count),
    objectRef: row.object_ref as string,
    payloadHash: row.payload_hash as string,
    evidenceObjectRef: row.evidence_object_ref as string,
    evidenceHash: row.evidence_hash as string,
    sourcesHash: sha256(
      canonicalJson(row.frozen_sources ?? row.sources ?? null),
    ),
    objectBytes: storedCandidateObjectBytes,
  };
  const itemBytes = await artifacts.readBytes(
    row.object_ref,
    CAPACITY_LIMITS.itemsBytes,
  );
  await updateJobProgress(db, job, "publication:payload", 35);
  if (sha256(itemBytes) !== row.payload_hash)
    throw publicationIntegrityError({
      code: "publication_candidate_payload_hash_mismatch",
      object: { type: "candidate_snapshot", id: row.id },
      expectedPayloadHash: row.payload_hash,
      actualPayloadHash: sha256(itemBytes),
      retry:
        "Materialize a new Candidate after correcting the items-artifact hash.",
    });
  const payloadItems = itemBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const identities = await db.query(
    `SELECT ci.*, sr.locator, sr.record_hash
     FROM candidate_item ci
     LEFT JOIN source_record sr
       ON ci.origin_kind = 'source_record'
      AND sr.parsed_view_id = ci.parsed_view_id
      AND sr.ordinal = ci.source_record_ordinal
     WHERE ci.candidate_id = $1 ORDER BY ci.ordinal`,
    [row.id],
  );
  await updateJobProgress(db, job, "publication:identity", 55, {
    items: identities.rowCount,
  });
  if (payloadItems.length !== identities.rowCount)
    throw publicationIntegrityError({
      code: "publication_candidate_identity_mismatch",
      object: { type: "candidate_snapshot", id: row.id },
      retry:
        "Materialize a new Candidate after correcting the frozen identity rows.",
    });
  const frozenSourceByDraftSource = new Map(
    frozenSources.map((source) => [source.draftSourceId, source]),
  );
  const contentHashMismatches: any[] = [];
  const items: PackageItem[] = payloadItems.map((item, index) => {
    const identity = identities.rows[index];
    if (item.case_id !== identity.case_id)
      throw publicationIntegrityError({
        code: "publication_candidate_identity_mismatch",
        object: { type: "candidate_item", id: identity.case_id },
        retry:
          "Materialize a new Candidate after correcting the frozen case identity.",
      });
    const contentHash = sha256(
      canonicalJson({
        input: item.input,
        expected_output: item.expected_output,
        metadata: item.metadata,
      }),
    );
    if (contentHash !== identity.content_hash)
      contentHashMismatches.push({
        caseId: item.case_id,
        expectedContentHash: identity.content_hash,
        actualContentHash: contentHash,
      });
    const frozenSource = frozenSourceByDraftSource.get(
      identity.draft_source_id,
    );
    const source =
      identity.origin_kind === "source_record"
        ? {
            assetId: frozenSource?.assetId ?? identity.asset_id ?? row.asset_id,
            parsedViewId: frozenSource?.parsedViewId ?? identity.parsed_view_id,
            ordinal: Number(identity.source_record_ordinal),
            locator: identity.locator,
            recordHash: identity.record_hash,
          }
        : undefined;
    return {
      ...item,
      ...(source ? { source } : {}),
      lineage: identity.origin_ref ?? {
        level: "record_level",
        parent_case_revision: {
          caseId: identity.case_id,
          revisionId: identity.parent_case_revision_id,
        },
      },
    };
  });
  if (
    frozenSources.some(
      (source) =>
        !isAllowedSourceAttribution({
          sourceType: source.attribution.sourceType,
          sourceName: source.attribution.sourceName,
          responsiblePerson: source.attribution.responsiblePerson,
          purpose: source.attribution.purpose,
          licenseStatus: source.attribution.licenseStatus,
          sensitivity: source.attribution.sensitivity,
          sourceAddress: source.attribution.sourceAddress ?? null,
          acquiredAt: source.attribution.acquiredAt ?? null,
          deidentificationConfirmed:
            source.attribution.deidentificationConfirmed ?? false,
        }),
    )
  )
    throw publicationIntegrityError({
      code: "data_classification_not_allowed",
      object: { type: "candidate_snapshot", id: row.id },
      retry:
        "Materialize a new Candidate after correcting source classification.",
    });
  const frozenTransformationRuns = await db.query(
    `SELECT ctr.run_id, ctr.evidence, tr.project_id
     FROM candidate_transformation_run ctr
     LEFT JOIN transformation_run tr ON tr.id = ctr.run_id
     WHERE ctr.candidate_id = $1 ORDER BY ctr.run_id`,
    [row.id],
  );
  for (const frozenRun of frozenTransformationRuns.rows) {
    if (frozenRun.project_id !== job.project_id)
      throw publicationIntegrityError({
        code: "publication_project_scope_mismatch",
        object: { type: "transformation_run", id: frozenRun.run_id },
        retry:
          "Repair the frozen transformation reference before retrying publication.",
      });
  }
  const transformationRuns = frozenTransformationRuns.rows.map(
    (frozenRun) => frozenRun.evidence,
  );
  const evidenceSources = mergeSourceSnapshots(
    frozenSources,
    await collectReferencedVersionSources(
      db,
      job.project_id,
      transformationRuns,
      row.base_version_id ? [String(row.base_version_id)] : [],
    ),
  );
  const packageInput = {
    testSet: { id: row.test_set_id, name: row.test_set_name },
    schema: {
      dialect: row.dialect,
      revisionId: row.schema_revision_id,
      mode: row.mode,
      input: row.input_schema,
      expectedOutput: row.expected_output_schema,
    },
    recipe: row.recipe,
    sources: evidenceSources.map(sourceSnapshotToPackageSource),
    items,
    transformationRuns,
  };
  const candidateEvidence = createStandardEvidence({
    ...packageInput,
    itemsSha256: row.payload_hash,
  });
  await artifacts.verifyCollection(
    row.evidence_object_ref,
    Object.fromEntries(
      EVIDENCE_FILES.map((path) => [path, candidateEvidence.files[path]]),
    ),
  );
  await updateJobProgress(db, job, "publication:evidence", 70);
  if (row.evidence_hash !== candidateEvidence.evidenceHash)
    throw publicationIntegrityError({
      code: "publication_candidate_evidence_hash_mismatch",
      object: { type: "candidate_snapshot", id: row.id },
      expectedEvidenceHash: row.evidence_hash,
      actualEvidenceHash: candidateEvidence.evidenceHash,
      retry:
        "Materialize a new Candidate after correcting the evidence collection.",
    });

  let published = await db.query(
    `SELECT id, sequence, published_at, manifest_hash
     FROM test_set_version WHERE candidate_id = $1`,
    [row.id],
  );
  const client = await db.connect();
  if (!published.rowCount) {
    try {
      await updateJobProgress(db, job, "publication:precommit", 80);
      await client.query("BEGIN");
      await assertJobDeletionSafe(client, job);
      await client.query(
        "SELECT default_version_id FROM test_set WHERE id = $1 FOR UPDATE",
        [row.test_set_id],
      );
      const enteredTransaction = await db.query(
        `UPDATE job SET stage = 'publication_transaction', progress = 90,
            updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'
         RETURNING id`,
        [job.id, job.lease_owner],
      );
      if (!enteredTransaction.rowCount) throw new JobCancelledError();
      published = await client.query(
        `SELECT id, sequence, published_at, manifest_hash
         FROM test_set_version WHERE candidate_id = $1`,
        [row.id],
      );
      if (!published.rowCount) {
        const candidate = await client.query(
          `SELECT cs.status, cs.item_count, cs.object_ref, cs.payload_hash,
                  cs.evidence_object_ref, cs.evidence_hash,
                  COALESCE(cs.sources, dr.sources) AS frozen_sources
           FROM candidate_snapshot cs
           LEFT JOIN draft_revision dr ON dr.id = cs.draft_revision_id
           WHERE cs.id = $1 FOR UPDATE OF cs`,
          [row.id],
        );
        if (candidate.rows[0]?.status !== "publishing")
          throw new PermanentJobError("Candidate publication state changed");
        const lockedCandidate = candidate.rows[0];
        const lockedCandidateSnapshot = {
          itemCount: Number(lockedCandidate.item_count),
          objectRef: lockedCandidate.object_ref as string,
          payloadHash: lockedCandidate.payload_hash as string,
          evidenceObjectRef: lockedCandidate.evidence_object_ref as string,
          evidenceHash: lockedCandidate.evidence_hash as string,
          sourcesHash: sha256(
            canonicalJson(lockedCandidate.frozen_sources ?? null),
          ),
        };
        if (
          lockedCandidateSnapshot.itemCount !== precheckCandidate.itemCount ||
          lockedCandidateSnapshot.objectRef !== precheckCandidate.objectRef ||
          lockedCandidateSnapshot.payloadHash !==
            precheckCandidate.payloadHash ||
          lockedCandidateSnapshot.evidenceObjectRef !==
            precheckCandidate.evidenceObjectRef ||
          lockedCandidateSnapshot.evidenceHash !==
            precheckCandidate.evidenceHash ||
          lockedCandidateSnapshot.sourcesHash !== precheckCandidate.sourcesHash
        )
          throw publicationIntegrityError({
            code: "publication_candidate_drift",
            object: { type: "candidate_snapshot", id: row.id },
            expected: precheckCandidate,
            actual: lockedCandidateSnapshot,
            retry:
              "Materialize a new Candidate after correcting the publication drift.",
          });
        const transactionObjectBytes = await artifacts.size(
          lockedCandidateSnapshot.objectRef,
        );
        await client.query(
          "SELECT id FROM working_draft WHERE id = $1 FOR UPDATE",
          [row.draft_id],
        );
        const draftCapacityResult = await client.query(CANDIDATE_CAPACITY_SQL, [
          JSON.stringify(frozenSources),
        ]);
        const draftCapacity = draftCapacityFromRow(draftCapacityResult.rows[0]);
        const recordedItems = Number(candidate.rows[0].item_count);
        const object = { type: "candidate_snapshot", id: row.id };
        if (
          recordedItems > CAPACITY_LIMITS.candidateItems ||
          items.length > CAPACITY_LIMITS.candidateItems
        )
          throw publicationCapacityError({
            exceededDimension: "candidate_item_count",
            object,
            actual: Math.max(recordedItems, items.length),
            payloadItems: items.length,
            recordedItems,
            limit: CAPACITY_LIMITS.candidateItems,
            retry:
              "Materialize a new Candidate after correcting the item-count drift.",
          });
        if (recordedItems !== items.length)
          throw publicationIntegrityError({
            code: "publication_item_count_mismatch",
            object,
            payloadItems: items.length,
            recordedItems,
            retry:
              "Materialize a new Candidate after correcting the item-count drift.",
          });
        if (
          transactionObjectBytes !== itemBytes.byteLength ||
          transactionObjectBytes > CAPACITY_LIMITS.itemsBytes
        )
          throw publicationCapacityError({
            exceededDimension: "candidate_object_bytes",
            object,
            actual: transactionObjectBytes,
            expectedBytes: itemBytes.byteLength,
            limit: CAPACITY_LIMITS.itemsBytes,
            retry:
              "Materialize a new Candidate after correcting the items-artifact drift.",
          });
        const aggregateDimension = draftCapacityExceeded(draftCapacity);
        if (aggregateDimension)
          throw publicationCapacityError({
            exceededDimension: `draft_${aggregateDimension}`,
            object,
            actual: draftCapacity[aggregateDimension],
            limit:
              CAPACITY_LIMITS[
                aggregateDimension === "assets"
                  ? "draftAssets"
                  : aggregateDimension === "originalBytes"
                    ? "draftOriginalBytes"
                    : "draftSourceRecords"
              ],
            draftCapacity,
            retry:
              "Materialize a new Candidate after correcting the Working Draft aggregate capacity.",
          });
        if (draftCapacity.largestAssetBytes > CAPACITY_LIMITS.dataAssetBytes)
          throw publicationCapacityError({
            exceededDimension: "largest_asset_bytes",
            object,
            actual: draftCapacity.largestAssetBytes,
            limit: CAPACITY_LIMITS.dataAssetBytes,
            retry:
              "Materialize a new Candidate after correcting the oversized Data Asset.",
          });
        if (
          draftCapacity.largestAssetRecords > CAPACITY_LIMITS.parsedViewRecords
        )
          throw publicationCapacityError({
            exceededDimension: "largest_asset_records",
            object,
            actual: draftCapacity.largestAssetRecords,
            limit: CAPACITY_LIMITS.parsedViewRecords,
            retry:
              "Materialize a new Candidate after correcting the over-record Data Asset.",
          });
        const oversizedInput = items
          .map((item) => ({
            item,
            inputBytes: Buffer.byteLength(canonicalJson(item.input)),
          }))
          .find(({ inputBytes }) => inputBytes > CAPACITY_LIMITS.inputBytes);
        if (oversizedInput)
          throw publicationCapacityError({
            exceededDimension: "candidate_item_input_bytes",
            object: { type: "candidate_item", id: oversizedInput.item.case_id },
            ordinal: oversizedInput.item.source?.ordinal ?? null,
            actual: oversizedInput.inputBytes,
            limit: CAPACITY_LIMITS.inputBytes,
            retry:
              "Materialize a new Candidate after reducing the oversized item input.",
          });
        if (contentHashMismatches.length)
          throw publicationIntegrityError({
            code: "publication_item_content_hash_mismatch",
            object,
            mismatches: contentHashMismatches,
            retry:
              "Materialize a new Candidate after correcting the item content drift.",
          });

        const allocation = await client.query(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence,
                  transaction_timestamp() AS published_at
           FROM test_set_version WHERE test_set_id = $1`,
          [row.test_set_id],
        );
        const sequence = Number(allocation.rows[0].sequence);
        const versionId = `version_${randomUUID().replaceAll("-", "")}`;
        const publishedAt = new Date(
          allocation.rows[0].published_at,
        ).toISOString();
        const manifest = createStandardManifest({
          testSet: packageInput.testSet,
          version: {
            id: versionId,
            number: sequence,
            publishedAt,
            parentId: row.base_version_id ?? null,
          },
          schema: {
            revisionId: row.schema_revision_id,
            mode: row.mode,
            sha256: sha256(candidateEvidence.files["schema.json"]),
          },
          payloadHash: row.payload_hash,
          evidenceHash: row.evidence_hash,
          counts: {
            items: items.length,
            recordLevel: items.filter(
              (item) => item.lineage?.level === "record_level",
            ).length,
            assetLevel: items.filter(
              (item) => item.lineage?.level === "asset_level",
            ).length,
          },
        });
        const storedManifest = await artifacts.storeImmutable(
          Buffer.from(manifest.text),
          `publication-${job.id}`,
        );
        await client.query(
          `INSERT INTO test_set_version
           (id, test_set_id, sequence, candidate_id, schema_revision_id, payload_hash, evidence_hash,
            manifest_hash, manifest_object_ref, item_count, published_by, published_at,
            parent_version_id, change_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            versionId,
            row.test_set_id,
            sequence,
            row.id,
            row.schema_revision_id,
            row.payload_hash,
            row.evidence_hash,
            manifest.hash,
            storedManifest.objectRef,
            items.length,
            job.actor_id,
            publishedAt,
            row.base_version_id ?? null,
            row.change_note ?? "",
          ],
        );
        const existingRevisions = identities.rows.length
          ? await client.query(
              `SELECT id, case_id, content_hash, lineage_fingerprint
               FROM case_revision WHERE case_id = ANY($1::text[])`,
              [identities.rows.map((identity) => identity.case_id)],
            )
          : { rows: [] as Array<Record<string, string>> };
        const revisionsByCase = new Map<
          string,
          Array<Record<string, string>>
        >();
        for (const revision of existingRevisions.rows) {
          const revisions = revisionsByCase.get(revision.case_id) ?? [];
          revisions.push(revision);
          revisionsByCase.set(revision.case_id, revisions);
        }
        for (const [index, identity] of identities.rows.entries()) {
          const fallbackLineageFingerprint = sha256(
            canonicalJson({
              originKind: identity.origin_kind ?? "source_record",
              originRef: identity.origin_ref ?? {},
              parentRevisionId: identity.parent_case_revision_id ?? null,
              sourceRecordOrdinal: Number(identity.source_record_ordinal ?? 0),
            }),
          );
          const lineageFingerprint =
            identity.lineage_fingerprint ?? fallbackLineageFingerprint;
          const parent = identity.parent_case_revision_id
            ? (revisionsByCase.get(identity.case_id) ?? []).find(
                (revision) => revision.id === identity.parent_case_revision_id,
              )
            : undefined;
          let revisionId: string | undefined =
            parent &&
            parent.content_hash === identity.content_hash &&
            parent.lineage_fingerprint === lineageFingerprint
              ? parent.id
              : undefined;
          if (!revisionId)
            revisionId = (revisionsByCase.get(identity.case_id) ?? []).find(
              (revision) =>
                revision.content_hash === identity.content_hash &&
                revision.lineage_fingerprint === lineageFingerprint,
            )?.id;
          if (!revisionId) {
            await client.query(
              "INSERT INTO test_case (id, test_set_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [identity.case_id, row.test_set_id],
            );
            revisionId = `revision_${randomUUID().replaceAll("-", "")}`;
            await client.query(
              `INSERT INTO case_revision
               (id, case_id, input, expected_output, metadata, source_record_ordinal,
                content_hash, parent_revision_id, origin_kind, origin_ref, reason,
                lineage_fingerprint, lineage_level, transformation_run_id)
               VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9,
                       $10::jsonb, $11, $12, $13, $14)`,
              [
                revisionId,
                identity.case_id,
                JSON.stringify(items[index].input),
                JSON.stringify(items[index].expected_output),
                JSON.stringify(items[index].metadata),
                identity.source_record_ordinal ?? 0,
                identity.content_hash,
                identity.parent_case_revision_id ?? null,
                identity.origin_kind,
                JSON.stringify(identity.origin_ref ?? {}),
                identity.manual_reason ?? null,
                lineageFingerprint,
                identity.lineage_level ?? "record_level",
                identity.transformation_run_id ?? null,
              ],
            );
          }
          await client.query(
            "INSERT INTO version_member (version_id, case_revision_id, ordinal) VALUES ($1, $2, $3)",
            [versionId, revisionId, index + 1],
          );
        }
        if (sequence === 1)
          await client.query(
            "UPDATE test_set SET default_version_id = $2 WHERE id = $1",
            [row.test_set_id, versionId],
          );
        await client.query(
          "UPDATE candidate_snapshot SET status = 'published_as_version' WHERE id = $1",
          [row.id],
        );
        await client.query(
          "UPDATE working_draft SET status = 'published' WHERE id = $1",
          [row.draft_id],
        );
        await client.query(
          `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'test_set_version_published', 'test_set_version', $3, $4)`,
          [
            job.project_id,
            job.actor_id,
            versionId,
            { manifestHash: manifest.hash, correlationId: job.id },
          ],
        );
        published = {
          rowCount: 1,
          rows: [
            {
              id: versionId,
              sequence,
              published_at: publishedAt,
              manifest_hash: manifest.hash,
            },
          ],
        } as typeof published;
      }
      await assertJobDeletionSafe(client, job);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    client.release();
  }

  const version = published.rows[0];
  const packageResult = createStandardPackage({
    ...packageInput,
    version: {
      id: version.id,
      number: Number(version.sequence),
      publishedAt: new Date(version.published_at).toISOString(),
      parentId: row.base_version_id ?? null,
    },
  });
  if (packageResult.versionManifestHash !== version.manifest_hash)
    throw publicationIntegrityError({
      code: "publication_manifest_mismatch",
      object: { type: "test_set_version", id: version.id },
      retry: "Retry publication after reviewing the committed Manifest.",
    });
  const storedPackage = await artifacts.storeImmutable(packageResult.bytes);
  const deliveryId = `delivery_${randomUUID().replaceAll("-", "")}`;
  await db.query(
    `INSERT INTO delivery_record
     (id, version_id, project_id, target_type, package_type,
      package_format_version, object_ref, delivery_hash, status, created_by)
     VALUES ($1,$2,$3,'standard_package','standard','1.0',$4,$5,'generated',$6)
     ON CONFLICT (version_id, package_type, package_format_version)
       DO UPDATE SET delivery_hash = delivery_record.delivery_hash`,
    [
      deliveryId,
      version.id,
      job.project_id,
      storedPackage.objectRef,
      packageResult.deliveryHash,
      job.actor_id,
    ],
  );
  const delivery = await db.query(
    "SELECT id, delivery_hash FROM delivery_record WHERE version_id = $1",
    [version.id],
  );
  if (delivery.rows[0].delivery_hash !== packageResult.deliveryHash)
    throw publicationIntegrityError({
      code: "publication_delivery_mismatch",
      object: { type: "delivery_record", id: delivery.rows[0].id },
      retry: "Retry publication after reviewing the committed delivery hash.",
    });
  return { versionId: version.id, deliveryId: delivery.rows[0].id };
}

async function collectVersionAssets(
  db: Database,
  versionId: string,
  projectId: string,
) {
  const assetsById = new Map<
    string,
    { id: string; file_name: string; blob_sha256: string }
  >();
  const seenVersions = new Set<string>();
  const collect = async (currentVersionId: string) => {
    if (seenVersions.has(currentVersionId)) return;
    seenVersions.add(currentVersionId);
    const assets = await db.query(
      `SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_item ci ON ci.candidate_id=cs.id
       JOIN parsed_view pv ON pv.id=ci.parsed_view_id
       JOIN data_asset da ON da.id=pv.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       LEFT JOIN draft_revision dr ON dr.id=cs.draft_revision_id
       CROSS JOIN LATERAL jsonb_to_recordset(
         COALESCE(cs.sources, dr.sources, '[]'::jsonb)
       ) frozen("assetId" text)
       JOIN data_asset da ON da.id=frozen."assetId"
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       LEFT JOIN draft_revision dr ON dr.id=cs.draft_revision_id
       JOIN data_asset da ON da.id=cs.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
         AND cs.sources IS NULL AND dr.sources IS NULL
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_run_input input
         ON input.run_id=ctr.run_id AND input.object_type='data_asset'
       JOIN data_asset da ON da.id=input.object_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_run_output output ON output.run_id=ctr.run_id
       JOIN data_asset da ON da.id=output.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT output_asset.id, output_asset.file_name,
                       output_asset.blob_sha256, output_asset.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_record_edge edge ON edge.run_id=ctr.run_id
       JOIN parsed_view output_view ON output_view.id=edge.output_parsed_view_id
       JOIN data_asset output_asset ON output_asset.id=output_view.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_record_edge edge ON edge.run_id=ctr.run_id
       JOIN parsed_view pv ON pv.id=(edge.input_ref->>'parsedViewId')
       JOIN data_asset da ON da.id=pv.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_record_edge edge ON edge.run_id=ctr.run_id
       JOIN case_revision input_revision
         ON input_revision.id=(edge.input_ref->>'id')
       JOIN candidate_item original_item
         ON original_item.case_id=input_revision.case_id
        AND original_item.content_hash=input_revision.content_hash
        AND original_item.lineage_fingerprint=input_revision.lineage_fingerprint
        AND original_item.parsed_view_id IS NOT NULL
       JOIN parsed_view original_view ON original_view.id=original_item.parsed_view_id
       JOIN data_asset da ON da.id=original_view.asset_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT da.id, da.file_name, da.blob_sha256, da.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_record_edge edge ON edge.run_id=ctr.run_id
       JOIN case_revision input_revision
         ON input_revision.id=(edge.input_ref->>'id')
       JOIN transformation_run_input input
         ON input.run_id=input_revision.transformation_run_id
        AND input.object_type='data_asset'
       JOIN data_asset da ON da.id=input.object_id
       WHERE v.id=$1 AND ts.project_id=$2`,
      [currentVersionId, projectId],
    );
    for (const asset of assets.rows) {
      if (asset.project_id !== projectId)
        throw publicationIntegrityError({
          code: "publication_project_scope_mismatch",
          object: { type: "data_asset", id: asset.id },
          retry:
            "Repair the frozen version reference before retrying package delivery.",
        });
      assetsById.set(asset.id, {
        id: asset.id,
        file_name: asset.file_name,
        blob_sha256: asset.blob_sha256,
      });
    }

    // A test_set_version input is an immutable version-level range. Record-edge
    // inputs are resolved exactly above rather than importing a whole parent.
    const parentVersions = await db.query(
      `SELECT DISTINCT parent.id, parent_ts.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       LEFT JOIN test_set_version parent ON parent.id=v.parent_version_id
       LEFT JOIN test_set parent_ts ON parent_ts.id=parent.test_set_id
       WHERE v.id=$1 AND ts.project_id=$2 AND v.parent_version_id IS NOT NULL
       UNION
       SELECT DISTINCT parent.id, parent_ts.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       LEFT JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_run_input version_input
         ON version_input.run_id=ctr.run_id
        AND version_input.object_type='test_set_version'
       LEFT JOIN test_set_version parent ON parent.id=version_input.object_id
       LEFT JOIN test_set parent_ts ON parent_ts.id=parent.test_set_id
       WHERE v.id=$1 AND ts.project_id=$2
       UNION
       SELECT DISTINCT parent.id, parent_ts.project_id
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       JOIN candidate_transformation_run ctr ON ctr.candidate_id=cs.id
       JOIN transformation_record_edge edge ON edge.run_id=ctr.run_id
       JOIN case_revision input_revision
         ON input_revision.id=(edge.input_ref->>'id')
       JOIN transformation_run_input input
         ON input.run_id=input_revision.transformation_run_id
        AND input.object_type='test_set_version'
       LEFT JOIN test_set_version parent ON parent.id=input.object_id
       LEFT JOIN test_set parent_ts ON parent_ts.id=parent.test_set_id
       WHERE v.id=$1 AND ts.project_id=$2`,
      [currentVersionId, projectId],
    );
    for (const parent of parentVersions.rows) {
      if (!parent.id || parent.project_id !== projectId)
        throw publicationIntegrityError({
          code: "publication_project_scope_mismatch",
          object: { type: "test_set_version", id: parent.id ?? undefined },
          retry:
            "Repair the frozen version reference before retrying package delivery.",
        });
      await collect(String(parent.id));
    }
  };
  await collect(versionId);
  return [...assetsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

type SourceSnapshot = Record<string, any> & {
  assetId?: string | null;
  parsedViewId?: string | null;
  attribution: Record<string, any>;
};

function legacySourceSnapshotFromRow(
  row: Record<string, any>,
): SourceSnapshot | undefined {
  if (!row.asset_id) return undefined;
  return {
    parsedViewId: row.parsed_view_id,
    assetId: row.asset_id,
    parserName: row.parser_name,
    parserVersion: row.parser_version,
    recordCount: row.record_count,
    parserFormat: row.parser_format,
    parserConfig: row.parser_config,
    attribution: {
      id: row.attribution_id ?? row.attribution_revision_id,
      sourceType: row.source_type,
      sourceName: row.source_name,
      purpose: row.purpose,
      responsibleActor: row.responsible_actor,
      responsiblePerson: row.responsible_person,
      licenseStatus: row.license_status,
      sensitivity: row.sensitivity,
      sourceAddress: row.source_address,
      acquiredAt: row.acquired_at
        ? new Date(row.acquired_at).toISOString()
        : null,
      deidentificationConfirmed: row.deidentification_confirmed,
    },
  };
}

function sourceSnapshotsFromRow(
  row: Record<string, any>,
  sources: unknown,
): SourceSnapshot[] {
  if (Array.isArray(sources)) return sources;
  const legacy = legacySourceSnapshotFromRow(row);
  return legacy ? [legacy] : [];
}

async function hydrateSourceSnapshots(
  db: { query: (...args: any[]) => Promise<any> },
  projectId: string,
  snapshots: SourceSnapshot[],
): Promise<SourceSnapshot[]> {
  const parsedViewIds = [
    ...new Set(
      snapshots
        .map((source) => source.parsedViewId ?? source.parsed_view_id)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const assetIds = [
    ...new Set(
      snapshots
        .map((source) => source.assetId ?? source.asset_id)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const attributionIds = [
    ...new Set(
      snapshots
        .map((source) => {
          const attribution = source.attribution ?? source;
          return (
            attribution.id ??
            attribution.attributionId ??
            attribution.attribution_id
          );
        })
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (assetIds.length) {
    const assets = await db.query(
      `SELECT id FROM data_asset
       WHERE id = ANY($1::text[]) AND project_id = $2`,
      [assetIds, projectId],
    );
    const missingAssetId = assetIds.find(
      (id) => !assets.rows.some((asset: any) => String(asset.id) === id),
    );
    if (missingAssetId)
      throw publicationIntegrityError({
        code: "publication_project_scope_mismatch",
        object: { type: "data_asset", id: missingAssetId },
        retry:
          "Repair the frozen source asset reference before retrying publication or package delivery.",
      });
  }
  const attributions = attributionIds.length
    ? await db.query(
        `SELECT sar.id, sar.asset_id
         FROM source_attribution_revision sar
         JOIN data_asset da ON da.id = sar.asset_id AND da.project_id = $2
         WHERE sar.id = ANY($1::text[])`,
        [attributionIds, projectId],
      )
    : { rows: [] };
  const attributionById = new Map<string, any>(
    attributions.rows.map((row: any) => [String(row.id), row]),
  );
  const missingAttributionId = attributionIds.find(
    (id) => !attributionById.has(id),
  );
  if (missingAttributionId)
    throw publicationIntegrityError({
      code: "publication_project_scope_mismatch",
      object: {
        type: "source_attribution_revision",
        id: missingAttributionId,
      },
      retry:
        "Repair the frozen source attribution reference before retrying publication or package delivery.",
    });
  const assertAttributionAsset = (
    source: SourceSnapshot,
    assetId: string | null | undefined,
  ) => {
    const attribution = source.attribution ?? source;
    const attributionId = String(
      attribution.id ??
        attribution.attributionId ??
        attribution.attribution_id ??
        "",
    );
    const attributionRow = attributionId
      ? attributionById.get(attributionId)
      : undefined;
    if (attributionRow && String(assetId) !== String(attributionRow.asset_id))
      throw publicationIntegrityError({
        code: "publication_project_scope_mismatch",
        object: { type: "source_attribution_revision", id: attributionId },
        retry:
          "Repair the frozen source attribution and asset relationship before retrying publication or package delivery.",
      });
  };
  if (!parsedViewIds.length) {
    snapshots.forEach((source) =>
      assertAttributionAsset(source, source.assetId ?? source.asset_id),
    );
    return snapshots;
  }
  const parsedViews = await db.query(
    `SELECT pv.id, pv.asset_id, pv.parser_name, pv.parser_version, pv.record_count,
            pv.format AS parser_format, pv.parser_config
     FROM parsed_view pv
     JOIN data_asset da ON da.id = pv.asset_id AND da.project_id = $2
     WHERE pv.id = ANY($1::text[])`,
    [parsedViewIds, projectId],
  );
  const byId = new Map<string, any>(
    parsedViews.rows.map((view: any) => [String(view.id), view]),
  );
  const missingId = parsedViewIds.find((id) => !byId.has(id));
  if (missingId)
    throw publicationIntegrityError({
      code: "publication_project_scope_mismatch",
      object: { type: "parsed_view", id: missingId },
      retry:
        "Repair the frozen source reference before retrying publication or package delivery.",
    });
  return snapshots.map((source) => {
    const parsedViewId = String(source.parsedViewId ?? source.parsed_view_id);
    const view = byId.get(parsedViewId);
    const sourceAssetId = source.assetId ?? source.asset_id;
    if (sourceAssetId && String(sourceAssetId) !== String(view.asset_id))
      throw publicationIntegrityError({
        code: "publication_project_scope_mismatch",
        object: { type: "parsed_view", id: parsedViewId },
        retry:
          "Repair the frozen source asset and parsed-view relationship before retrying publication or package delivery.",
      });
    assertAttributionAsset(source, sourceAssetId ?? view.asset_id);
    return {
      ...source,
      assetId: sourceAssetId ?? view.asset_id,
      parserName: source.parserName ?? source.parser_name ?? view.parser_name,
      parserVersion:
        source.parserVersion ?? source.parser_version ?? view.parser_version,
      recordCount:
        source.recordCount ?? source.record_count ?? view.record_count,
      parserFormat:
        source.parserFormat ?? source.parser_format ?? view.parser_format,
      parserConfig:
        source.parserConfig ?? source.parser_config ?? view.parser_config,
    };
  });
}

function sourceSnapshotKey(source: SourceSnapshot): string {
  return `${source.assetId ?? source.asset_id}:${source.parsedViewId ?? source.parsed_view_id}`;
}

function sourceSnapshotToPackageSource(source: SourceSnapshot) {
  const attribution = source.attribution ?? source;
  return {
    parsedView: {
      id: source.parsedViewId ?? source.parsed_view_id,
      assetId: source.assetId ?? source.asset_id,
      parserName: source.parserName ?? source.parser_name ?? null,
      parserVersion: source.parserVersion ?? source.parser_version ?? null,
      recordCount: Number(source.recordCount ?? source.record_count ?? 0),
      parserFormat: source.parserFormat ?? source.parser_format ?? null,
      parserConfig: source.parserConfig ?? source.parser_config ?? null,
    },
    attribution: {
      id: attribution.id ?? attribution.attribution_id ?? null,
      assetId: source.assetId ?? source.asset_id,
      sourceType: attribution.sourceType ?? attribution.source_type ?? null,
      sourceName: attribution.sourceName ?? attribution.source_name ?? null,
      purpose: attribution.purpose ?? null,
      responsibleActor:
        attribution.responsibleActor ?? attribution.responsible_actor ?? null,
      responsiblePerson:
        attribution.responsiblePerson ?? attribution.responsible_person ?? null,
      licenseStatus:
        attribution.licenseStatus ?? attribution.license_status ?? null,
      sensitivity: attribution.sensitivity ?? null,
      sourceAddress:
        attribution.sourceAddress ?? attribution.source_address ?? null,
      acquiredAt: attribution.acquiredAt ?? attribution.acquired_at ?? null,
      deidentificationConfirmed: Boolean(
        attribution.deidentificationConfirmed ??
        attribution.deidentification_confirmed,
      ),
    },
  };
}

function mergeSourceSnapshots(
  current: SourceSnapshot[],
  inherited: SourceSnapshot[],
): SourceSnapshot[] {
  const merged: SourceSnapshot[] = [];
  const seen = new Set<string>();
  for (const source of [...current, ...inherited]) {
    const key = sourceSnapshotKey(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

async function collectReferencedVersionSources(
  db: Database,
  projectId: string,
  transformationRuns: Array<Record<string, any>>,
  initialVersionIds: string[] = [],
): Promise<SourceSnapshot[]> {
  const pending = [
    ...initialVersionIds,
    ...transformationRuns.flatMap((run) =>
      (Array.isArray(run.inputs) ? run.inputs : [])
        .filter((input: any) => input?.objectType === "test_set_version")
        .map((input: any) => String(input.id)),
    ),
  ];
  const seenVersions = new Set<string>();
  const inherited: SourceSnapshot[] = [];
  while (pending.length) {
    const versionIds = [...new Set(pending.splice(0))]
      .filter((id) => id && !seenVersions.has(id))
      .sort();
    if (!versionIds.length) break;
    versionIds.forEach((id) => seenVersions.add(id));
    const versions = await db.query(
      `SELECT v.id AS version_id, v.parent_version_id,
              COALESCE(cs.sources, dr.sources) AS sources,
              cs.asset_id, cs.parsed_view_id,
              pv.parser_name, pv.parser_version, pv.record_count,
              pv.format AS parser_format, pv.parser_config,
              sar.id AS attribution_id, sar.source_type, sar.source_name,
              sar.responsible_actor, sar.responsible_person, sar.purpose,
              sar.license_status, sar.sensitivity, sar.source_address,
              sar.acquired_at, sar.deidentification_confirmed
       FROM test_set_version v
       JOIN test_set ts ON ts.id=v.test_set_id
       JOIN candidate_snapshot cs ON cs.id=v.candidate_id
       LEFT JOIN draft_revision dr ON dr.id=cs.draft_revision_id
       LEFT JOIN parsed_view pv
         ON pv.id=cs.parsed_view_id
        AND EXISTS (
          SELECT 1 FROM data_asset da
          WHERE da.id=pv.asset_id AND da.project_id=$2
        )
       LEFT JOIN source_attribution_revision sar
         ON sar.id = cs.attribution_revision_id
        AND EXISTS (
          SELECT 1 FROM data_asset da
          WHERE da.id=sar.asset_id AND da.project_id=$2
        )
       WHERE v.id = ANY($1::text[]) AND ts.project_id=$2
         AND v.status <> 'degraded_by_deletion'
       ORDER BY v.id`,
      [versionIds, projectId],
    );
    const missingVersionId = versionIds.find(
      (id) => !versions.rows.some((row: any) => String(row.version_id) === id),
    );
    if (missingVersionId)
      throw publicationIntegrityError({
        code: "publication_project_scope_mismatch",
        object: { type: "test_set_version", id: missingVersionId },
        retry:
          "Repair the frozen version reference before retrying publication or package delivery.",
      });
    for (const row of versions.rows) {
      if (row.parent_version_id) pending.push(String(row.parent_version_id));
      const snapshots = await hydrateSourceSnapshots(
        db,
        projectId,
        sourceSnapshotsFromRow(row, row.sources),
      );
      if (!Array.isArray(row.sources) && row.asset_id && !row.attribution_id)
        throw new PermanentJobError(
          `Frozen source attribution is missing for referenced version ${row.version_id}`,
        );
      inherited.push(...snapshots);
    }
    const nestedRuns = await db.query(
      `SELECT ctr.run_id, tr.project_id, ctr.evidence
       FROM candidate_transformation_run ctr
       JOIN test_set_version v ON v.candidate_id=ctr.candidate_id
       JOIN test_set ts ON ts.id=v.test_set_id
       LEFT JOIN transformation_run tr ON tr.id=ctr.run_id
       WHERE v.id = ANY($1::text[]) AND ts.project_id=$2`,
      [versionIds, projectId],
    );
    for (const row of nestedRuns.rows) {
      if (row.project_id !== projectId)
        throw publicationIntegrityError({
          code: "publication_project_scope_mismatch",
          object: { type: "transformation_run", id: row.run_id },
          retry:
            "Repair the frozen transformation reference before retrying publication or package delivery.",
        });
      for (const input of Array.isArray(row.evidence?.inputs)
        ? row.evidence.inputs
        : []) {
        if (input?.objectType === "test_set_version")
          pending.push(String(input.id));
      }
    }
  }
  return inherited;
}

async function generatePackage(
  db: Database,
  artifacts: ArtifactRepository,
  job: Job,
): Promise<Record<string, unknown>> {
  await assertJobDeletionSafe(db, job);
  await assertJobCapability(db, job, "export");
  await updateJobProgress(db, job, "package:load", 20);
  const packageType = job.payload.packageType as "standard" | "full_provenance";
  const formatVersion = job.payload.formatVersion;
  if (
    !["standard", "full_provenance"].includes(packageType) ||
    formatVersion !== "1.0"
  )
    throw new PermanentJobError("Unsupported package configuration");

  const standard = await db.query(
    `SELECT dr.id, dr.object_ref, dr.delivery_hash
     FROM delivery_record dr
     JOIN test_set_version v ON v.id = dr.version_id
     JOIN test_set ts ON ts.id = v.test_set_id
     WHERE dr.version_id = $1 AND ts.project_id = $2
       AND v.status <> 'degraded_by_deletion'
       AND dr.package_type = 'standard'
     ORDER BY dr.created_at DESC LIMIT 1`,
    [job.payload.versionId, job.project_id],
  );
  if (!standard.rowCount)
    throw new PermanentJobError("Standard package evidence is missing");
  const standardBytes = await artifacts.readBytes(
    standard.rows[0].object_ref,
    120_000_000,
  );
  if (sha256(standardBytes) !== standard.rows[0].delivery_hash)
    throw new PermanentJobError("Standard package hash mismatch");

  const targetType =
    packageType === "standard" ? "standard_package" : "full_provenance_package";
  if (packageType === "standard") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await assertTransactionalJobCapability(client, job, "export");
      const availableVersion = await client.query(
        `SELECT v.id
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         WHERE v.id = $1 AND ts.project_id = $2
           AND v.status <> 'degraded_by_deletion'
         FOR UPDATE OF v`,
        [job.payload.versionId, job.project_id],
      );
      if (!availableVersion.rowCount)
        throw publicationIntegrityError({
          code: "publication_version_degraded_by_deletion",
          object: { type: "test_set_version", id: job.payload.versionId },
          retry:
            "Repair or replace the deleted version before retrying package delivery.",
        });
      await assertJobDeletionSafe(client, job);
      const replay = await client.query(
        `SELECT dr.id
         FROM delivery_record dr
         JOIN test_set_version v ON v.id = dr.version_id
         JOIN test_set ts ON ts.id = v.test_set_id
         WHERE dr.version_id = $1 AND ts.project_id = $2
           AND v.status <> 'degraded_by_deletion'
           AND dr.package_type = 'standard'
         ORDER BY dr.created_at DESC LIMIT 1
         FOR SHARE OF dr`,
        [job.payload.versionId, job.project_id],
      );
      if (!replay.rowCount)
        throw new PermanentJobError("Standard package evidence is missing");
      await client.query("COMMIT");
      return {
        deliveryId: replay.rows[0].id,
        packageType,
        verificationLevel: "standard",
        formatVersion,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await updateJobProgress(db, job, "package:assets", 50);
  await collectReferencedVersionSources(
    db,
    job.project_id,
    [],
    [String(job.payload.versionId)],
  );
  const assets = await collectVersionAssets(
    db,
    job.payload.versionId,
    job.project_id,
  );
  const provenanceAssets = [];
  for (const asset of assets) {
    const bytes = await artifacts.readBytes(
      `blobs/sha256/${asset.blob_sha256}`,
      CAPACITY_LIMITS.dataAssetBytes,
    );
    if (sha256(bytes) !== asset.blob_sha256)
      throw new PermanentJobError(`Asset hash mismatch: ${asset.id}`);
    provenanceAssets.push({
      assetId: asset.id,
      fileName: asset.file_name,
      sha256: asset.blob_sha256,
      bytes,
    });
  }
  await assertJobActive(db, job);
  await updateJobProgress(db, job, "package:build", 80);
  const fullPackage = createFullProvenancePackage(
    standardBytes,
    provenanceAssets,
  );
  const packageValidation = await validatePackageBytes(fullPackage.bytes);
  if (!packageValidation.valid)
    throw new PermanentJobError(
      `Full package validation failed: ${packageValidation.errors.join(", ")}`,
    );
  const stored = await artifacts.storeImmutable(
    fullPackage.bytes,
    `package-${job.id}`,
  );

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertTransactionalJobCapability(client, job, "export");
    const availableVersion = await client.query(
      `SELECT v.id
       FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE v.id = $1 AND ts.project_id = $2
         AND v.status <> 'degraded_by_deletion'
       FOR UPDATE OF v`,
      [job.payload.versionId, job.project_id],
    );
    if (!availableVersion.rowCount)
      throw publicationIntegrityError({
        code: "publication_version_degraded_by_deletion",
        object: { type: "test_set_version", id: job.payload.versionId },
        retry:
          "Repair or replace the deleted version before retrying package delivery.",
      });
    await assertJobDeletionSafe(client, job);
    await updateJobProgressInTransaction(client, job, "package:commit", 90);
    const inserted = await client.query(
      `INSERT INTO delivery_record
       (id, version_id, project_id, target_type, package_type,
        package_format_version, object_ref, delivery_hash, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generated',$9)
       ON CONFLICT (version_id, package_type, package_format_version)
       DO UPDATE SET delivery_hash = delivery_record.delivery_hash
       RETURNING id, delivery_hash`,
      [
        `delivery_${randomUUID().replaceAll("-", "")}`,
        job.payload.versionId,
        job.project_id,
        targetType,
        packageType,
        formatVersion,
        stored.objectRef,
        fullPackage.deliveryHash,
        job.actor_id,
      ],
    );
    if (inserted.rows[0].delivery_hash !== fullPackage.deliveryHash)
      throw new PermanentJobError("Full package delivery mismatch");
    await client.query(
      `INSERT INTO audit_event
       (project_id, actor_id, action, object_type, object_id, details)
       VALUES ($1,$2,'package_generated','delivery_record',$3,$4)`,
      [
        job.project_id,
        job.actor_id,
        inserted.rows[0].id,
        {
          correlationId: job.id,
          packageType,
          verificationLevel: "full",
          formatVersion,
        },
      ],
    );
    const result = {
      deliveryId: inserted.rows[0].id,
      packageType,
      verificationLevel: "full",
      formatVersion,
    };
    await completeJobInTransaction(client, job, result);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function generateLangfuseCsv(
  db: Database,
  artifacts: ArtifactRepository,
  job: Job,
): Promise<Record<string, unknown>> {
  await assertJobDeletionSafe(db, job);
  await assertJobCapability(db, job, "write");
  await updateJobProgress(db, job, "csv:load", 30);
  const standard = await db.query(
    `SELECT dr.object_ref, dr.delivery_hash
     FROM delivery_record dr
     JOIN test_set_version v ON v.id = dr.version_id
     JOIN test_set ts ON ts.id = v.test_set_id
     WHERE dr.version_id = $1 AND ts.project_id = $2
       AND v.status <> 'degraded_by_deletion'
       AND dr.package_type = 'standard'`,
    [job.payload.versionId, job.project_id],
  );
  if (!standard.rowCount)
    throw new PermanentJobError("Standard package evidence is missing");
  const standardBytes = await artifacts.readBytes(
    standard.rows[0].object_ref,
    120_000_000,
  );
  if (sha256(standardBytes) !== standard.rows[0].delivery_hash)
    throw new PermanentJobError("Standard package hash mismatch");
  const archive = unzipSync(standardBytes);
  const items = strFromU8(archive["items.jsonl"])
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as PackageItem);
  await updateJobProgress(db, job, "csv:build", 70);
  const csv = createLangfuseCsv(job.payload.versionId, items);
  const frozenSchema = JSON.parse(strFromU8(archive["schema.json"])) as {
    mode: "gold_required" | "input_only";
    input: object;
    expectedOutput: object;
  };
  const localValidation = validateLangfuseCsv(csv.bytes, {
    schema: frozenSchema,
    versionId: job.payload.versionId,
    expectedItems: items,
  });
  if (!localValidation.valid)
    throw new PermanentJobError(
      `Langfuse CSV local validation failed: ${localValidation.errors.join(", ")}`,
    );
  await assertJobActive(db, job);
  const stored = await artifacts.storeImmutable(csv.bytes, `csv-${job.id}`);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertTransactionalJobCapability(client, job, "write");
    const availableVersion = await client.query(
      `SELECT v.id
       FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE v.id = $1 AND ts.project_id = $2
         AND v.status <> 'degraded_by_deletion'
       FOR UPDATE OF v`,
      [job.payload.versionId, job.project_id],
    );
    if (!availableVersion.rowCount)
      throw publicationIntegrityError({
        code: "publication_version_degraded_by_deletion",
        object: { type: "test_set_version", id: job.payload.versionId },
        retry:
          "Repair or replace the deleted version before retrying CSV delivery.",
      });
    await assertJobDeletionSafe(client, job);
    await updateJobProgressInTransaction(client, job, "csv:commit", 90);
    const inserted = await client.query(
      `INSERT INTO delivery_record
       (id, version_id, project_id, target_type, package_type,
        package_format_version, object_ref, delivery_hash, status, created_by)
       VALUES ($1,$2,$3,'langfuse_csv','langfuse_csv','csv-v1',$4,$5,
               'generated',$6)
       ON CONFLICT (version_id, package_type, package_format_version)
         DO UPDATE SET delivery_hash = delivery_record.delivery_hash
       RETURNING id, delivery_hash`,
      [
        `delivery_${randomUUID().replaceAll("-", "")}`,
        job.payload.versionId,
        job.project_id,
        stored.objectRef,
        csv.deliveryHash,
        job.actor_id,
      ],
    );
    if (inserted.rows[0].delivery_hash !== csv.deliveryHash)
      throw new PermanentJobError("Langfuse CSV delivery mismatch");
    await client.query(
      `INSERT INTO audit_event
       (project_id, actor_id, action, object_type, object_id, details)
       VALUES ($1,$2,'langfuse_csv_generated','delivery_record',$3,$4)`,
      [
        job.project_id,
        job.actor_id,
        inserted.rows[0].id,
        {
          correlationId: job.id,
          verificationLevel: "local_csv",
          formatVersion: "csv-v1",
          localValidation,
        },
      ],
    );
    const result = {
      deliveryId: inserted.rows[0].id,
      packageType: "langfuse_csv",
      verificationLevel: "local_csv",
      formatVersion: "csv-v1",
      localValidation,
    };
    await completeJobInTransaction(client, job, result);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const config = loadConfig();
const db = createPool(config.databaseUrl);
const artifacts = new ArtifactRepository(config.minio);
const workerId = randomUUID();

async function renewLease(job: Job) {
  await db.query(
    `UPDATE job
     SET lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
         updated_at = now()
     WHERE id = $1 AND lease_owner = $3 AND status = 'running'`,
    [job.id, config.jobLeaseDurationMs, job.lease_owner],
  );
}

async function failExpiredJobs(db: Database) {
  for (;;) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT id FROM job
         WHERE status = 'running' AND lease_expires_at < now()
           AND attempt >= max_attempts
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rowCount) {
        await client.query("COMMIT");
        return;
      }
      const expired = await client.query(
        `UPDATE job SET status = 'failed', stage = 'failed', progress = 100,
            error_code = 'job_lease_expired', retryable = true,
            lease_owner = NULL, lease_expires_at = NULL, next_run_at = NULL,
            updated_at = now()
         WHERE id = $1
         RETURNING id, kind, project_id, actor_id, payload`,
        [selected.rows[0].id],
      );
      const job = expired.rows[0];
      if (job.kind === "controlled_deletion")
        await markDeletionFailure(
          client,
          String(job.payload.eventId),
          job.project_id,
          "job_lease_expired",
          "lease_expired",
        );
      if (job.kind === "parse_asset" || job.kind === "parse_csv")
        await client.query(
          `UPDATE parsed_view pv
           SET status = 'parse_failed', record_count = NULL, field_summary = NULL
           FROM data_asset da
           WHERE pv.asset_id = da.id AND pv.id = $1
             AND da.project_id = $2
             AND pv.status IN ('queued', 'parsing')`,
          [job.payload.parsedViewId, job.project_id],
        );
      if (job.kind === "materialize_candidate")
        await client.query(
          `UPDATE candidate_snapshot cs
             SET status = 'failed', validation_report = $3
           FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE cs.id = $1 AND cs.draft_id = wd.id
             AND ts.project_id = $2 AND cs.status = 'materializing'`,
          [
            job.payload.candidateId,
            job.project_id,
            {
              valid: false,
              errorCode: "job_lease_expired",
              blockingPhase: "candidate_materialization",
              retry:
                "Retry the failed job after correcting the infrastructure issue.",
            },
          ],
        );
      if (job.kind === "materialize_candidate")
        await client.query(
          `UPDATE working_draft wd SET status = 'editing'
           FROM candidate_snapshot cs
           JOIN working_draft wd_source ON wd_source.id = cs.draft_id
           JOIN test_set ts ON ts.id = wd_source.test_set_id
           WHERE cs.id = $1 AND wd.id = wd_source.id
             AND ts.project_id = $2 AND wd.status = 'materializing'`,
          [job.payload.candidateId, job.project_id],
        );
      if (job.kind === "publish_version")
        await client.query(
          `UPDATE candidate_snapshot cs SET status = 'publish_failed'
           FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE cs.id = $1 AND cs.draft_id = wd.id
             AND ts.project_id = $2 AND cs.status = 'publishing'`,
          [job.payload.candidateId, job.project_id],
        );
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'job_lease_expired', 'job', $3, $4)`,
        [job.project_id, job.actor_id, job.id, { correlationId: job.id }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function requeueDueRetries(db: Database) {
  await db.query(
    `UPDATE job SET status = 'queued', stage = 'queued', updated_at = now()
     WHERE status = 'retry_wait' AND next_run_at <= now()`,
  );
}

async function collectOrphans(
  db: Database,
  artifacts: ArtifactRepository,
  orphanGraceMs: number,
) {
  const activeJobs = await db.query(
    `SELECT payload FROM job
     WHERE status = 'running' AND lease_expires_at > now()`,
  );
  const activeUploads = await db.query(
    `SELECT operation_id FROM upload_idempotency
     WHERE status = 'receiving'
       AND updated_at > now() - ($1::bigint * interval '1 millisecond')`,
    [orphanGraceMs],
  );
  const activeOperations = new Set<string>();
  for (const row of activeJobs.rows)
    for (const value of Object.values(row.payload ?? {}))
      if (typeof value === "string") activeOperations.add(value);
  for (const row of activeUploads.rows) activeOperations.add(row.operation_id);

  const cutoff = Date.now() - orphanGraceMs;
  // ponytail: any active lease conservatively protects all staging and markers;
  // map operations precisely only if cleanup throughput becomes a bottleneck.
  const hasActiveJob = activeJobs.rows.length > 0;
  let stagingCursor: string | undefined;
  do {
    const stagingObjects = await artifacts.list("staging/", stagingCursor);
    for (const object of stagingObjects) {
      const operationId = object.key.split("/")[1];
      if (
        object.lastModified.getTime() <= cutoff &&
        !hasActiveJob &&
        !activeOperations.has(operationId)
      )
        await artifacts.remove(object.key);
    }
    stagingCursor =
      stagingObjects.length >= 1000
        ? stagingObjects[stagingObjects.length - 1].key
        : undefined;
  } while (stagingCursor);

  const references = new Set(
    (
      await db.query(`
        SELECT object_ref FROM data_asset
        UNION SELECT object_ref FROM candidate_snapshot
        UNION SELECT evidence_object_ref FROM candidate_snapshot
        UNION SELECT manifest_object_ref FROM test_set_version
        UNION SELECT object_ref FROM delivery_record
      `)
    ).rows
      .map((row: { object_ref?: string | null }) => row.object_ref)
      .filter((ref): ref is string => typeof ref === "string"),
  );
  // Evidence descriptors reference additional content-addressed children;
  // protect their markers from the orphan sweep just like direct references.
  const evidenceRows = await db.query(
    `SELECT evidence_object_ref FROM candidate_snapshot
     WHERE evidence_object_ref IS NOT NULL`,
  );
  for (const row of evidenceRows.rows as Array<{
    evidence_object_ref: string;
  }>) {
    try {
      const descriptor = JSON.parse(
        (
          await artifacts.readBytes(row.evidence_object_ref, 1_000_000)
        ).toString("utf8"),
      ) as { objects?: Array<{ objectRef?: unknown }> };
      for (const object of descriptor.objects ?? [])
        if (typeof object.objectRef === "string")
          references.add(object.objectRef);
    } catch {
      // A consistency finding will report an unreadable descriptor or child.
    }
  }
  let markerCursor: string | undefined;
  do {
    const markers = await artifacts.list("markers/", markerCursor);
    for (const marker of markers) {
      const digest = marker.key.match(/([0-9a-f]{64})\.json$/)?.[1];
      if (
        digest &&
        marker.lastModified.getTime() <= cutoff &&
        !hasActiveJob &&
        !references.has(`blobs/sha256/${digest}`)
      )
        await artifacts.remove(marker.key);
    }
    markerCursor =
      markers.length >= 1000 ? markers[markers.length - 1].key : undefined;
  } while (markerCursor);
}

async function scheduleJobRetry(
  db: Database,
  job: Job,
  errorCode: string,
  backoffMs: number,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT id FROM job
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       FOR UPDATE`,
      [job.id, job.lease_owner],
    );
    if (!owned.rowCount) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `UPDATE job SET status = 'retry_wait', stage = 'retry_wait',
          error_code = $2, retryable = true, lease_owner = NULL,
          lease_expires_at = NULL,
          next_run_at = now() + ($3::bigint * interval '1 millisecond'),
          updated_at = now()
       WHERE id = $1`,
      [job.id, errorCode, backoffMs],
    );
    await client.query(
      `INSERT INTO audit_event
       (project_id, actor_id, action, object_type, object_id, details)
       VALUES ($1, $2, 'job_retry_scheduled', 'job', $3, $4)`,
      [
        job.project_id,
        job.actor_id,
        job.id,
        { correlationId: job.id, errorCode, attempt: job.attempt },
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeJobFailure(
  db: Database,
  job: Job,
  errorCode: string,
  error: unknown,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT id, kind, payload FROM job
       WHERE id = $1 AND lease_owner = $2 AND status = 'running'
       FOR UPDATE`,
      [job.id, job.lease_owner],
    );
    if (!owned.rowCount) {
      await client.query("COMMIT");
      return false;
    }
    const report =
      error instanceof CandidateValidationError ||
      error instanceof PublicationCapacityError ||
      error instanceof PublicationIntegrityError
        ? error.report
        : null;
    if (job.kind === "parse_asset" || job.kind === "parse_csv")
      await client.query(
        `UPDATE parsed_view pv
         SET status = 'parse_failed', record_count = NULL, field_summary = NULL
         FROM data_asset da
         WHERE pv.asset_id = da.id AND pv.id = $1
           AND da.project_id = $2
           AND pv.status IN ('queued', 'parsing', 'parse_failed')`,
        [job.payload.parsedViewId, job.project_id],
      );
    if (job.kind === "materialize_candidate") {
      await client.query(
        `UPDATE candidate_snapshot cs
           SET status = 'failed', validation_report = $3
         FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE cs.id = $1 AND cs.draft_id = wd.id
           AND ts.project_id = $2 AND cs.status = 'materializing'`,
        [job.payload.candidateId, job.project_id, report],
      );
      await client.query(
        `UPDATE working_draft wd SET status = 'editing'
         FROM candidate_snapshot cs
         JOIN working_draft wd_source ON wd_source.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd_source.test_set_id
         WHERE cs.id = $1 AND wd.id = wd_source.id
           AND ts.project_id = $2 AND wd.status = 'materializing'`,
        [job.payload.candidateId, job.project_id],
      );
    }
    if (job.kind === "publish_version")
      await client.query(
        `UPDATE candidate_snapshot cs SET status = 'publish_failed'
         FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE cs.id = $1 AND cs.draft_id = wd.id
           AND ts.project_id = $2 AND cs.status = 'publishing'`,
        [job.payload.candidateId, job.project_id],
      );
    if (job.kind === "controlled_deletion")
      await markDeletionFailure(
        client,
        String(job.payload.eventId),
        job.project_id,
        errorCode,
        error instanceof ControlledDeletionError
          ? error.stage
          : "finalize_failure",
      );
    await client.query(
      `UPDATE job
       SET status = 'failed', error_code = $2,
           result = CASE WHEN $3::jsonb IS NULL THEN result ELSE $3::jsonb END,
           stage = 'failed', progress = 100, retryable = false,
           lease_owner = NULL, lease_expires_at = NULL, next_run_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [
        job.id,
        errorCode,
        job.kind === "publish_version" && report
          ? { publicationReport: report }
          : null,
      ],
    );
    if (report?.capacityBlock)
      await client.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'candidate_capacity_blocked', 'candidate_snapshot', $3, $4)`,
        [
          job.project_id,
          job.actor_id,
          job.payload.candidateId,
          { ...report, correlationId: job.id },
        ],
      );
    await client.query(
      `INSERT INTO audit_event
       (project_id, actor_id, action, object_type, object_id, details)
       VALUES ($1, $2, 'job_failed', 'job', $3, $4)`,
      [
        job.project_id,
        job.actor_id,
        job.id,
        { correlationId: job.id, errorCode },
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await artifacts.initialize();
const workerHealth =
  config.workerHealthPort > 0
    ? await startHealthServer({
        hostname: config.workerHealthHost,
        port: config.workerHealthPort,
        gitSha: config.gitSha,
        dependencies: () => dependencyHealth(db, artifacts),
        metrics: async () =>
          renderMetrics(
            await metricSnapshot(db, await dependencyHealth(db, artifacts)),
          ),
      })
    : undefined;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  void workerHealth?.close();
});

let lastMaintenanceAt = 0;
let orphanScanRunning = false;
setInterval(() => {
  if (orphanScanRunning) return;
  orphanScanRunning = true;
  void collectOrphans(db, artifacts, config.jobOrphanGraceMs)
    .catch(() => undefined)
    .finally(() => {
      orphanScanRunning = false;
    });
}, config.orphanScanCadenceMs).unref();

let consistencyScanRunning = false;
setInterval(() => {
  if (consistencyScanRunning) return;
  consistencyScanRunning = true;
  const startedAt = Date.now();
  void scanConsistency(db, artifacts)
    .catch(() =>
      console.error(
        JSON.stringify({
          correlation_id: null,
          job_id: null,
          project_id: null,
          object_id: null,
          stage: "consistency:scan",
          duration_ms: Date.now() - startedAt,
          error_code: "infrastructure_unavailable",
        }),
      ),
    )
    .finally(() => {
      consistencyScanRunning = false;
    });
}, config.consistencyScanCadenceMs).unref();

while (!stopping) {
  let job: Awaited<ReturnType<typeof claim>> | undefined;
  try {
    if (Date.now() - lastMaintenanceAt >= 250) {
      await failExpiredJobs(db);
      await requeueDueRetries(db);
      lastMaintenanceAt = Date.now();
    }
    job = await claim(db, workerId, config.jobLeaseDurationMs);
  } catch {
    console.error(
      JSON.stringify({
        correlation_id: null,
        job_id: null,
        project_id: null,
        object_id: null,
        stage: "worker:poll",
        duration_ms: 0,
        error_code: "infrastructure_unavailable",
      }),
    );
    await delay(1000);
    continue;
  }
  if (!job) {
    await delay(50);
    continue;
  }
  if (job.status === "cancelled") continue;
  const startedAt = Date.now();
  activeJobStages.set(job.id, { stage: "claim", startedAt });
  const heartbeat = setInterval(() => {
    void renewLease(job).catch(() => undefined);
  }, config.jobHeartbeatIntervalMs);
  try {
    let result: Record<string, unknown> = {};
    if (job.kind === "parse_csv" || job.kind === "parse_asset")
      result = await parseAsset(db, artifacts, job);
    else if (job.kind === "materialize_candidate")
      result = await materializeCandidate(db, artifacts, job);
    else if (job.kind === "publish_version")
      result = await publishVersion(db, artifacts, job);
    else if (job.kind === "materialize_version_checkpoint")
      result = {
        outcome: await materializePeriodicCheckpoint(
          db,
          String(job.payload.versionId),
          job.project_id,
        ),
      };
    else if (job.kind === "generate_package")
      result = await generatePackage(db, artifacts, job);
    else if (job.kind === "generate_langfuse_csv")
      result = await generateLangfuseCsv(db, artifacts, job);
    else if (job.kind === "controlled_deletion") {
      await updateJobProgress(db, job, "deletion:payload_removal", 50);
      result = await executeControlledDeletion(
        db,
        artifacts,
        String(job.payload.eventId),
        job.project_id,
        String(job.payload.previewHash),
      );
    } else throw new PermanentJobError(`Unknown job kind: ${job.kind}`);
    await recordStageDuration(db, job, "succeeded").catch(() => undefined);
    const completed = await db.query(
      `UPDATE job SET status = 'succeeded', stage = 'succeeded', progress = 100,
          result = $2, counts = COALESCE($3::jsonb, counts), error_code = NULL,
          retryable = NULL, lease_owner = NULL, lease_expires_at = NULL,
          next_run_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $4 AND status = 'running'`,
      [job.id, result, JSON.stringify(result.counts ?? null), job.lease_owner],
    );
    if (completed.rowCount)
      await db.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ($1, $2, 'job_succeeded', 'job', $3, $4)`,
        [job.project_id, job.actor_id, job.id, { correlationId: job.id }],
      );
    console.log(
      JSON.stringify({
        correlation_id: job.id,
        job_id: job.id,
        project_id: job.project_id,
        object_id:
          job.payload.candidateId ??
          job.payload.assetId ??
          job.payload.parsedViewId ??
          job.payload.eventId ??
          null,
        stage: `${job.kind}:succeeded`,
        duration_ms: Date.now() - startedAt,
        error_code: null,
      }),
    );
  } catch (error) {
    await recordStageDuration(db, job, "terminal").catch(() => undefined);
    if (!(error instanceof JobCancelledError)) {
      const permanent =
        error instanceof CandidateValidationError ||
        error instanceof PermanentJobError ||
        error instanceof PublicationCapacityError ||
        error instanceof PublicationIntegrityError;
      const willRetry =
        !permanent && Number(job.attempt) < config.jobMaxAttempts;
      let errorCode = "infrastructure_unavailable";
      if (error instanceof CandidateValidationError)
        errorCode = "candidate_validation_failed";
      else if (error instanceof ControlledDeletionError) errorCode = error.code;
      else if (error instanceof PermanentJobError) errorCode = error.code;
      else if (error instanceof PublicationCapacityError)
        errorCode = error.code;
      else if (error instanceof PublicationIntegrityError)
        errorCode = error.code;
      console.error(
        JSON.stringify({
          correlation_id: job.id,
          job_id: job.id,
          project_id: job.project_id,
          object_id:
            job.payload.candidateId ??
            job.payload.assetId ??
            job.payload.parsedViewId ??
            job.payload.eventId ??
            null,
          stage: `${job.kind}:failure`,
          duration_ms: Date.now() - startedAt,
          error_code: errorCode,
        }),
      );
      if (willRetry) {
        await scheduleJobRetry(
          db,
          job,
          errorCode,
          jobRetryDelayMs(config, Number(job.attempt)),
        );
      } else {
        await finalizeJobFailure(db, job, errorCode, error);
      }
    }
  } finally {
    activeJobStages.delete(job.id);
    clearInterval(heartbeat);
  }
}
await db.end();
