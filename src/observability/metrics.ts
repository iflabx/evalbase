import { statfs } from "node:fs/promises";

import type { Database } from "../db/pool.js";
import type { DependencyHealth } from "./health.js";

export interface MetricSnapshot {
  queueDepth: number;
  oldestQueuedAgeSeconds: number;
  jobSuccesses: number;
  jobFailures: number;
  jobRetries: number;
  stageDurations: Array<{
    kind: string;
    stage: string;
    status: string;
    count: number;
    durationSeconds: number;
  }>;
  health: DependencyHealth;
  diskUsagePercent: number;
  hashMismatches: number;
  orphanCount: number;
}

const KNOWN_JOB_KINDS = new Set([
  "parse_asset",
  "parse_csv",
  "materialize_candidate",
  "publish_version",
  "generate_package",
  "generate_langfuse_csv",
  "controlled_deletion",
]);
const KNOWN_JOB_STAGES = new Set([
  "claim",
  "starting",
  "queued",
  "retry_wait",
  "cancel_requested",
  "cancelled",
  "failed",
  "succeeded",
  "terminal",
  "parse:starting",
  "parse:records",
  "parse:database",
  "parse:commit",
  "candidate:capacity",
  "candidate:sources",
  "candidate:identity",
  "candidate:items",
  "candidate:finalize",
  "candidate:commit",
  "publication:precheck",
  "publication:payload",
  "publication:identity",
  "publication:evidence",
  "publication:precommit",
  "publication:transaction",
  "package:load",
  "package:assets",
  "package:build",
  "package:commit",
  "csv:load",
  "csv:build",
  "csv:commit",
  "deletion:payload_removal",
]);
const KNOWN_JOB_STATUSES = new Set(["running"]);

function boundedLabel(value: unknown, allowed: Set<string>): string {
  const label = String(value);
  return allowed.has(label) ? label : "unknown";
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

async function diskUsagePercent(): Promise<number> {
  try {
    const disk = await statfs("/", { bigint: false });
    return (
      Math.round(((disk.blocks - disk.bfree) / disk.blocks) * 100 * 100) / 100
    );
  } catch {
    return 0;
  }
}

export async function metricSnapshot(
  db: Database,
  health: DependencyHealth,
): Promise<MetricSnapshot> {
  const disk = await diskUsagePercent();
  try {
    const jobs = await db.query(
      `WITH current_jobs AS (
         SELECT count(*) FILTER (WHERE status='queued')::int AS queue_depth,
                COALESCE(extract(epoch from (
                  now() - min(created_at) FILTER (WHERE status='queued')
                )),0)::int AS oldest_queued_age_seconds
         FROM job
       ), outcomes AS (
         SELECT count(*) FILTER (WHERE action='job_succeeded')::int AS successes,
                count(*) FILTER (WHERE action='job_failed')::int AS failures,
                count(*) FILTER (WHERE action='job_retry_scheduled')::int AS retries
         FROM audit_event
         WHERE object_type='job'
       )
       SELECT * FROM current_jobs CROSS JOIN outcomes`,
    );
    const stages = await db.query(
      `SELECT kind, stage, 'running' AS status, count(*)::int AS count,
              COALESCE(sum(duration_ms) / 1000.0, 0) AS duration
       FROM job_stage_duration GROUP BY kind, stage ORDER BY kind, stage`,
    );
    const consistency = await db.query(
      `SELECT count(*) FILTER (
         WHERE error_code IN ('object_hash_mismatch','marker_missing',
                              'marker_hash_mismatch','manifest_hash_mismatch',
                              'evidence_hash_mismatch')
           AND status='open'
       )::int AS hash_mismatches,
         count(*) FILTER (
           WHERE error_code='aged_orphan' AND status='open'
         )::int AS orphan_count
       FROM consistency_finding`,
    );
    return {
      queueDepth: Number(jobs.rows[0].queue_depth),
      oldestQueuedAgeSeconds: Number(jobs.rows[0].oldest_queued_age_seconds),
      jobSuccesses: Number(jobs.rows[0].successes),
      jobFailures: Number(jobs.rows[0].failures),
      jobRetries: Number(jobs.rows[0].retries),
      stageDurations: stages.rows.map((row: Record<string, unknown>) => ({
        kind: boundedLabel(row.kind, KNOWN_JOB_KINDS),
        stage: boundedLabel(row.stage, KNOWN_JOB_STAGES),
        status: boundedLabel(row.status, KNOWN_JOB_STATUSES),
        count: Number(row.count),
        durationSeconds: Number(row.duration),
      })),
      health,
      diskUsagePercent: disk,
      hashMismatches: Number(consistency.rows[0].hash_mismatches),
      orphanCount: Number(consistency.rows[0].orphan_count),
    };
  } catch {
    return {
      queueDepth: 0,
      oldestQueuedAgeSeconds: 0,
      jobSuccesses: 0,
      jobFailures: 0,
      jobRetries: 0,
      stageDurations: [],
      health,
      diskUsagePercent: disk,
      hashMismatches: 0,
      orphanCount: 0,
    };
  }
}

export function renderMetrics(snapshot: MetricSnapshot): string {
  const lines = [
    "# HELP agentbench_queue_depth Jobs currently queued.",
    "# TYPE agentbench_queue_depth gauge",
    `agentbench_queue_depth ${snapshot.queueDepth}`,
    "# HELP agentbench_oldest_queued_age_seconds Age of the oldest queued job.",
    "# TYPE agentbench_oldest_queued_age_seconds gauge",
    `agentbench_oldest_queued_age_seconds ${snapshot.oldestQueuedAgeSeconds}`,
    "# HELP agentbench_job_successes_total Jobs that have succeeded.",
    "# TYPE agentbench_job_successes_total counter",
    `agentbench_job_successes_total ${snapshot.jobSuccesses}`,
    "# HELP agentbench_job_failures_total Jobs that have failed.",
    "# TYPE agentbench_job_failures_total counter",
    `agentbench_job_failures_total ${snapshot.jobFailures}`,
    "# HELP agentbench_job_retries_total Job retry attempts observed.",
    "# TYPE agentbench_job_retries_total counter",
    `agentbench_job_retries_total ${snapshot.jobRetries}`,
    "# HELP agentbench_stage_duration_seconds Job stage duration observations.",
    "# TYPE agentbench_stage_duration_seconds summary",
  ];
  if (!snapshot.stageDurations.length)
    lines.push("agentbench_stage_duration_seconds_count 0");
  for (const stage of snapshot.stageDurations) {
    const labels = `{kind="${escapeLabel(stage.kind)}",stage="${escapeLabel(
      stage.stage,
    )}",status="${escapeLabel(stage.status)}"}`;
    lines.push(
      `agentbench_stage_duration_seconds_count${labels} ${stage.count}`,
      `agentbench_stage_duration_seconds_sum${labels} ${stage.durationSeconds}`,
    );
  }
  lines.push(
    "# HELP agentbench_postgresql_health PostgreSQL readiness state.",
    "# TYPE agentbench_postgresql_health gauge",
    `agentbench_postgresql_health ${
      snapshot.health.postgresql === "ok" ? 1 : 0
    }`,
    "# HELP agentbench_minio_health MinIO readiness state.",
    "# TYPE agentbench_minio_health gauge",
    `agentbench_minio_health ${snapshot.health.minio === "ok" ? 1 : 0}`,
    "# HELP agentbench_disk_usage_percent Local host filesystem usage approximation.",
    "# TYPE agentbench_disk_usage_percent gauge",
    `agentbench_disk_usage_percent ${snapshot.diskUsagePercent}`,
    "# HELP agentbench_hash_mismatches_total Open integrity hash mismatches.",
    "# TYPE agentbench_hash_mismatches_total counter",
    `agentbench_hash_mismatches_total ${snapshot.hashMismatches}`,
    "# HELP agentbench_orphan_count Aged orphan objects observed.",
    "# TYPE agentbench_orphan_count gauge",
    `agentbench_orphan_count ${snapshot.orphanCount}`,
  );
  return `${lines.join("\n")}\n`;
}
