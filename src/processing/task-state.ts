import type { Database } from "../db/pool.js";
import {
  ProcessingError,
  type InputSnapshot,
  type ProcessingScope,
} from "./store.js";

export type TaskRef = {
  key: string;
  runId: string;
  resultId: string;
  inputId?: string;
  origin?: { runId: string; resultId: string };
};
export type TaskRound = {
  taskId: string;
  expectedRevision: number;
  before: TaskRef[];
  records?: InputSnapshot["records"];
  deduplicationBaseline?: InputSnapshot["deduplicationBaseline"];
  recordKeys?: Record<string, string>;
  kind: "continue" | "rerun" | "complete" | "saved";
};
export type TaskSave = {
  taskId: string;
  expectedRevision: number;
  excludedGroups: { runId: string; resultIds: string[] }[];
  requestHash?: string;
};

/** The same project fence is used by round submission and adoption. */
export async function guardProcessingTask(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
) {
  const request = scope.taskRound ?? scope.taskSave;
  if (scope.assistantResultsGuard) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-candidates:${scope.projectId}`,
    ]);
    for (const state of scope.assistantResultsGuard.states) {
      const row = (
        await db.query(
          `SELECT t.revision,j.status FROM processing_task t JOIN processing_run r ON r.id=t.latest_run_id JOIN job j ON j.id=r.job_id WHERE t.id=$1 AND t.project_id=$2 FOR SHARE OF t`,
          [state.id, scope.projectId],
        )
      ).rows[0];
      if (!row || Number(row.revision) !== state.revision)
        throw new ProcessingError(409, "assistant_candidate_selection_changed");
      if (!["succeeded", "failed", "cancelled"].includes(row.status))
        throw new ProcessingError(409, "processing_still_running");
    }
  }
  if (!request) return;
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `processing-candidates:${scope.projectId}`,
  ]);
  const row = (
    await db.query(
      `SELECT t.revision,j.status FROM processing_task t
    JOIN processing_run r ON r.id=t.latest_run_id JOIN job j ON j.id=r.job_id
    WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE OF t`,
      [request.taskId, scope.projectId],
    )
  ).rows[0];
  if (!row || row.revision !== request.expectedRevision)
    throw new ProcessingError(409, "processing_task_changed");
  if (!["succeeded", "failed", "cancelled"].includes(row.status))
    throw new ProcessingError(409, "processing_still_running");
}

export async function attachProcessingRound(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  runId: string,
  parentId?: string,
) {
  let taskId = scope.taskRound?.taskId;
  // Existing assistant calls share a chain only while its last run is their actual parent.
  if (!taskId && parentId) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-candidates:${scope.projectId}`,
    ]);
    const parent = (
      await db.query(
        `SELECT t.id FROM processing_task t JOIN processing_run r ON r.task_id=t.id
      WHERE r.id=$1 AND t.latest_run_id=$1 AND t.project_id=$2 AND t.assistant_session_id IS NOT DISTINCT FROM $3::text FOR UPDATE OF t`,
        [parentId, scope.projectId, scope.assistantGuard?.sessionId ?? null],
      )
    ).rows[0];
    taskId = parent?.id;
  }
  if (!taskId) {
    await db.query(
      "INSERT INTO processing_task(id,project_id,root_run_id,latest_run_id,assistant_session_id) VALUES($1,$2,$1,$1,$3)",
      [runId, scope.projectId, scope.assistantGuard?.sessionId ?? null],
    );
    await db.query(
      "UPDATE processing_run SET task_id=$1,round_number=1 WHERE id=$1",
      [runId],
    );
    return;
  }
  const count = Number(
    (
      await db.query(
        "SELECT coalesce(max(round_number),0)+1 AS n FROM processing_run WHERE task_id=$1",
        [taskId],
      )
    ).rows[0].n,
  );
  await db.query(
    "UPDATE processing_run SET task_id=$2,round_number=$3,task_before=$4,round_kind=$5 WHERE id=$1",
    [
      runId,
      taskId,
      count,
      scope.taskRound ? JSON.stringify(scope.taskRound.before) : null,
      scope.taskRound?.kind ?? "continue",
    ],
  );
  await db.query(
    "UPDATE processing_task SET latest_run_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",
    [taskId, runId],
  );
}
