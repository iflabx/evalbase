import { generatesRecords } from "./protocol.js";
import {
  isGenerationRecipe,
  remainingGenerationPositions,
  generationPosition,
} from "./generation.js";
import { processingRecovery } from "./recovery.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { isPlainObject } from "../server/support.js";
import { deduplicate } from "./deduplication.js";
import { adoptedCandidateKeys, candidateKey } from "./adoption.js";
import { acceptProcessingResults, selectedProcessingGroup } from "./accept.js";
import { createRefinementRun } from "./refine.js";
import { processingOptions, type ProcessingOptions } from "./protocol.js";
import {
  presentProcessingReview,
  processingReviewPage,
  processingSourceSummary,
  filterProcessingRecords,
} from "./presentation.js";
import {
  processingAccess,
  getProcessingRun,
  readProcessingRun,
  processingRunSummary,
  processingSourceRows,
  runStatusColumns,
  createProcessingRun,
  ProcessingError,
  type ProcessingScope,
  type InputSnapshot,
  type ProcessingRun,
  type ProcessingSource,
} from "./store.js";
import {
  guardProcessingTask,
  excludeTaskReferences,
  type TaskRef,
} from "./task-state.js";

type Task = {
  id: string;
  project_id: string;
  root_run_id: string;
  latest_run_id: string;
  revision: number;
  current_refs: TaskRef[];
  excluded_refs: TaskRef[];
  applied_run_id: string | null;
  applied_hash: string | null;
  incomplete: boolean;
};
const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled"].includes(status);
const groupRefs = (refs: TaskRef[]) =>
  [...new Set(refs.filter((r) => !r.inputId).map((r) => r.runId))].map(
    (runId) => ({
      runId,
      resultIds: [
        ...new Set(
          refs
            .filter((r) => r.runId === runId && !r.inputId)
            .map((r) => r.resultId),
        ),
      ],
    }),
  );
async function frozen(
  artifacts: ArtifactRepository,
  run: { input_ref: string | null; input_hash: string },
) {
  if (!run.input_ref)
    throw new ProcessingError(409, "processing_source_unavailable");
  const bytes = await artifacts.readBytes(run.input_ref, 100000000);
  if (sha256(bytes) !== run.input_hash)
    throw new ProcessingError(409, "processing_input_corrupt");
  return JSON.parse(bytes.toString("utf8")) as InputSnapshot;
}

/** Materialize references only after a round settles; its input and output objects remain immutable. */
async function taskState(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
) {
  await processingAccess(db, scope);
  const client = await db.connect();
  const baselines: { runId: string; before: TaskRef[] }[] = [];
  try {
    await client.query("BEGIN");
    const task = (
      await client.query<Task>(
        `SELECT t.* FROM processing_task t JOIN processing_run r ON r.task_id=t.id
      WHERE r.id=$1 AND t.project_id=$2 FOR UPDATE OF t`,
        [id, scope.projectId],
      )
    ).rows[0];
    if (!task) throw new ProcessingError(404, "processing_task_not_found");
    const rounds = (
      await client.query(
        "SELECT id,round_number,round_kind,task_before FROM processing_run WHERE task_id=$1 ORDER BY round_number",
        [task.id],
      )
    ).rows;
    // A task is not a way to reveal an inaccessible historical source or assistant background.
    const runs = [];
    for (const round of rounds)
      runs.push({
        ...(await getProcessingRun(client, scope, round.id)),
        ...round,
      });
    const latest = runs.at(-1)!;
    const batches = (
      await client.query(
        "SELECT result_ref,result_indices,issues FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
        [latest.id],
      )
    ).rows;
    const hash = sha256(canonicalJson({ status: latest.status, batches }));
    if (
      terminal(latest.status)
        ? task.applied_run_id !== latest.id || task.applied_hash !== hash
        : !task.applied_run_id && task.applied_hash !== hash
    ) {
      let refs = task.current_refs;
      const pending = task.applied_run_id ? [latest] : runs;
      for (const run of pending) {
        const input = await frozen(artifacts, run);
        const before = (run.task_before as TaskRef[] | null) ?? refs;
        if (run.task_before === null) baselines.push({ runId: run.id, before });
        let base = [...before];
        if (!base.length && !generatesRecords(run.options.operation))
          base = input.records.map((row, index) => ({
            key: `${run.round_number}:${index + 1}`,
            runId: run.id,
            resultId: "",
            inputId: row.id,
          }));
        if (!terminal(run.status)) {
          refs = base;
          break;
        }
        const data = await readProcessingRun(
          db,
          artifacts,
          scope,
          run.id,
          { limit: "10000" },
          true,
        );
        const inputs = new Map(
          input.records.map((row, index) => [row.id, { row, index }]),
        );
        const next = new Map(base.map((ref) => [ref.key, ref]));
        let changed = 0;
        for (const output of data.records) {
          const located = inputs.get(output.result.sourceId);
          if (!located && run.options.operation !== "generate")
            throw new ProcessingError(409, "processing_input_corrupt");
          const old = before.find(
            (ref) =>
              ref.runId === run.parent_run_id &&
              `candidate:${ref.resultId}` === located?.row.id,
          );
          const position = isGenerationRecipe(
            run.execution_config.recipeVersion,
          )
            ? generationPosition(output)
            : undefined;
          const generatedRef =
            position === undefined
              ? undefined
              : before.find((ref) => ref.generationPosition === position);
          const key =
            generatedRef?.key ??
            (generatesRecords(run.options.operation)
              ? `${run.round_number}:${Number(output.id.split(":")[0]) * 10000 + Number(output.id.split(":")[1]) + 1}`
              : (located!.row.taskRecordKey ??
                old?.key ??
                `${run.round_number}:${located!.index + 1}`));
          next.set(key, {
            key,
            runId: run.id,
            resultId: output.id,
            origin: output.candidateOrigin,
            replaces:
              run.round_kind === "saved"
                ? undefined
                : (generatedRef ?? next.get(key)?.replaces),
            generationPosition: position ?? next.get(key)?.generationPosition,
          });
          changed++;
        }
        refs = [...next.values()];
        if (refs.length > 10000)
          throw new ProcessingError(422, "processing_capacity_exceeded");
        task.incomplete =
          refs.some((ref) => Boolean(ref.inputId)) ||
          run.status !== "succeeded" ||
          changed <
            (generatesRecords(run.options.operation)
              ? (run.options.outputCount ?? run.input_count)
              : input.records.length) ||
          data.run.executionComplete === false;
        task.applied_run_id = run.id;
      }
      task.current_refs = refs;
      // Active rounds never publish a partial workspace as the current result.
      task.applied_hash = hash;
      await client.query(
        `UPDATE processing_task SET current_refs=$2,applied_run_id=$3,applied_hash=$4,incomplete=$5,
        revision=revision+1 WHERE id=$1 RETURNING revision`,
        [
          task.id,
          JSON.stringify(refs),
          task.applied_run_id,
          task.applied_hash,
          task.incomplete,
        ],
      );
      task.revision++;
    }
    await client.query("COMMIT");
    // Source cleanup locks the run before its task; don't acquire a run lock while holding the task.
    for (const baseline of baselines)
      await client.query(
        "UPDATE processing_run SET task_before=$2 WHERE id=$1 AND input_ref IS NOT NULL AND task_before IS NULL",
        [baseline.runId, JSON.stringify(baseline.before)],
      );
    return { task, runs, latest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function currentRows(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  task: Task,
) {
  const map = new Map<
    string,
    Awaited<ReturnType<typeof selectedProcessingGroup>>["selected"][number]
  >();
  for (const group of groupRefs(task.current_refs)) {
    const loaded = await selectedProcessingGroup(
      db,
      artifacts,
      scope,
      group.runId,
      group.resultIds,
    );
    loaded.selected.forEach((row) => map.set(`${row.runId}\0${row.id}`, row));
  }
  const inputs = new Map<string, InputSnapshot>();
  const rows = [];
  for (const ref of task.current_refs) {
    const selected = map.get(`${ref.runId}\0${ref.resultId}`);
    if (selected)
      rows.push({
        ...selected,
        id: ref.key,
        localId: selected.id,
        generationPosition: ref.generationPosition,
        original: selected.input,
        result: {
          sourceId: selected.sourceId,
          question: selected.question,
          expectedOutput: selected.expectedOutput,
          metadata: selected.metadata,
        },
      });
    else if (ref.inputId) {
      if (!inputs.has(ref.runId))
        inputs.set(
          ref.runId,
          await frozen(artifacts, await getProcessingRun(db, scope, ref.runId)),
        );
      const input = inputs
        .get(ref.runId)!
        .records.find((row) => row.id === ref.inputId);
      if (!input) throw new ProcessingError(409, "processing_input_corrupt");
      rows.push({
        id: ref.key,
        localId: "",
        generationPosition: ref.generationPosition,
        runId: ref.runId,
        original: input,
        input,
        rootOperation: input.adoptionOperation ?? "clean",
        adoptionFields: input.adoptionFields ?? [],
        source: inputs.get(ref.runId)!.source,
        originalId: input.baseline?.id ?? input.id,
        candidateOrigin: { runId: ref.runId, resultId: ref.key },
        result: {
          sourceId: input.id,
          question: input.question,
          expectedOutput: input.expectedOutput,
          metadata: input.metadata,
        },
      });
    }
  }
  return rows;
}
/** Reuse the current-reference resolver for the assistant's multi-task workspace. */
export async function processingTaskCandidates(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
) {
  const { task, runs, latest } = await taskState(db, artifacts, scope, runId);
  return {
    id: task.id,
    revision: task.revision,
    refs: task.current_refs,
    latestRunId: latest.id,
    rows: await currentRows(db, artifacts, scope, task),
    excluded: task.excluded_refs.filter((ref) => !ref.inputId),
    runs,
  };
}

async function adopted(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  rows: Awaited<ReturnType<typeof currentRows>>,
) {
  const ids = new Set<string>();
  for (const runId of new Set(
    rows.filter((r) => r.localId).map((r) => r.runId),
  )) {
    const data = {
      run: { id: runId },
      records: rows
        .filter((r) => r.runId === runId)
        .map((r) => ({ ...r, id: r.localId })),
    };
    const keys = await adoptedCandidateKeys(
      db,
      artifacts,
      scope,
      [data],
      undefined,
      true,
    );
    data.records.forEach((r) => {
      if (keys.has(candidateKey({ runId, resultId: r.localId })))
        ids.add(
          r.id === r.localId
            ? rows.find(
                (row) => row.runId === runId && row.localId === r.localId,
              )!.id
            : r.id,
        );
    });
  }
  return ids;
}

export async function readProcessingTask(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  query: {
    limit?: string;
    offset?: string;
    view?: string;
    search?: string;
  } = {},
) {
  const { task, runs, latest } = await taskState(db, artifacts, scope, id);
  const rows = await currentRows(db, artifacts, scope, task);
  const excludedRows = task.excluded_refs.length
    ? await currentRows(db, artifacts, scope, {
        ...task,
        current_refs: task.excluded_refs,
      })
    : [];
  const status = { run: processingRunSummary(latest) };
  const root = runs[0]!;
  const taskSource = await processingSourceSummary(db, scope, root.source);
  const sourceSummary = await processingSourceSummary(db, scope, latest.source);
  const actor = (
    await db.query(
      "SELECT coalesce(display_name,username) name FROM app_user WHERE id=$1",
      [latest.actor_id],
    )
  ).rows[0];
  const data = {
    run: { ...status.run, sourceSummary, actorName: actor?.name ?? "未记录" },
    records: rows,
    allIds: rows.map((r) => r.id),
    total: rows.length,
    issues: [],
    rootOperation: root.options.operation,
    adoptionFields: [...new Set(rows.flatMap((r) => r.adoptionFields))],
  } as unknown as Awaited<ReturnType<typeof readProcessingRun>>;
  const page = processingReviewPage(data, query);
  const presentations = new Map<string, unknown>();
  for (const runId of new Set(
    page.records.map((row) => (row as unknown as { runId: string }).runId),
  )) {
    const slice = page.records.filter(
      (row) => (row as unknown as { runId: string }).runId === runId,
    );
    const rawRun = processingRunSummary(
      await getProcessingRun(db, scope, runId),
    );
    const raw = {
      ...data,
      run: rawRun,
      rootOperation:
        slice[0]?.original?.adoptionOperation ?? data.rootOperation,
      records: slice.map((row) => ({
        ...row,
        id: (row as unknown as { localId: string }).localId || row.id,
      })),
      allIds: [],
    } as unknown as typeof data;
    const shown = await presentProcessingReview(db, artifacts, scope, raw, {
      limit: "100",
    });
    shown.records.forEach((row, index) =>
      presentations.set(slice[index]!.id, row.sourcePresentation),
    );
  }
  const adoptedIds = await adopted(db, artifacts, scope, rows);
  const receipts = (
    await db.query(
      `SELECT DISTINCT ON(receipt->>'acceptanceId') receipt,da.collection_id FROM processing_acceptance pa
    JOIN processing_run r ON r.id=pa.run_id JOIN data_asset da ON da.id=pa.asset_id AND da.status='stored'
    WHERE r.task_id=$1 ORDER BY receipt->>'acceptanceId',pa.created_at`,
      [task.id],
    )
  ).rows;
  const saved = rows.filter((r) => adoptedIds.has(r.id)).length;
  let canContinueSaved = false;
  if (rows.length && saved === rows.length) {
    try {
      await savedInput(db, artifacts, scope, task);
      canContinueSaved = true;
    } catch (error) {
      if (!(error instanceof ProcessingError)) throw error;
    }
  }
  const sourceDraft =
    root.source.kind === "draft"
      ? root.source.id
      : latest.source.kind === "draft"
        ? latest.source.id
        : null;
  const unsavedIds = rows
    .filter((row) => row.localId && !adoptedIds.has(row.id))
    .map((row) => row.id);
  const latestData = terminal(latest.status)
    ? await readProcessingRun(
        db,
        artifacts,
        scope,
        latest.id,
        { limit: "10000" },
        true,
      )
    : null;
  const latestReview = latestData ? processingReviewPage(latestData, {}) : null;
  const unprocessed = new Set(
    rows.filter((row) => !row.localId).map((row) => row.id),
  );
  if (
    latestData &&
    latest.options.operation !== "augment" &&
    !latestData.run.executionComplete
  ) {
    const inputs = await frozen(artifacts, latest);
    const succeeded = new Set(
      latestData.records.map((row) => row.result.sourceId),
    );
    inputs.records.forEach((row, index) => {
      if (succeeded.has(row.id)) return;
      const previous = (latest.task_before as TaskRef[] | null)?.find(
        (ref) =>
          ref.runId === latest.parent_run_id &&
          `candidate:${ref.resultId}` === row.id,
      );
      unprocessed.add(
        row.taskRecordKey ??
          previous?.key ??
          `${latest.round_number}:${index + 1}`,
      );
    });
  }
  const { diagnostics, ...recovery } = await processingRecovery(db, latest);
  let generation:
    | { targetCount: number; validCount: number; missingCount: number }
    | undefined;
  if (isGenerationRecipe(root.execution_config.recipeVersion)) {
    const input = await frozen(artifacts, root);
    if (!input.generation)
      throw new ProcessingError(409, "processing_input_corrupt");
    const pending = remainingGenerationPositions(
      input.generation,
      rows,
      input.background?.questionPolicy,
    ).length;
    const live =
      !terminal(latest.status) && latest.options.operation === "generate"
        ? Number(latest.output_count ?? 0)
        : 0;
    const missingCount = Math.max(0, pending - live);
    generation = {
      targetCount: input.generation.total,
      validCount: input.generation.total - missingCount,
      missingCount,
    };
    const budget = recovery.generationBudget;
    recovery.canContinue =
      (latest.options.operation !== "generate" && recovery.canContinue) ||
      (terminal(latest.status) &&
        latest.status !== "cancelled" &&
        missingCount > 0 &&
        Boolean(budget && !budget.exhausted && !budget.blocked) &&
        !recovery.canRetry);
    if (missingCount && budget?.exhausted) recovery.reason = "budget_exhausted";
  }
  return {
    ...page,
    diagnostics,
    recovery,
    run: data.run,
    task: {
      id: task.id,
      revision: task.revision,
      title: `${taskSource.name} · 数据处理`,
      latestRunId: latest.id,
      roundCount: runs.length,
      currentCount: rows.length,
      ...(generation ? { generation } : {}),
      incomplete: task.incomplete,
      excludedCount: task.excluded_refs.length,
      savedCount: saved,
      unsavedCount: rows.length - saved,
      fullySaved: rows.length > 0 && saved === rows.length,
      canContinueSaved,
      latestUsableCount: latestReview?.usableCount ?? 0,
    },
    adoptedIds: [...adoptedIds],
    unsavedIds,
    saveDisposition: {
      updateIds: rows
        .filter(
          (row) =>
            row.localId &&
            row.source.kind === "draft" &&
            row.source.id === sourceDraft &&
            row.rootOperation !== "augment",
        )
        .map((row) => row.id),
      addIds: rows
        .filter(
          (row) =>
            row.localId &&
            !(
              row.source.kind === "draft" &&
              row.source.id === sourceDraft &&
              row.rootOperation !== "augment"
            ),
        )
        .map((row) => row.id),
      removeCount: new Set(
        excludedRows
          .filter(
            (row) =>
              row.source.kind === "draft" &&
              row.source.id === sourceDraft &&
              row.rootOperation !== "augment",
          )
          .map((row) => row.originalId),
      ).size,
    },
    unprocessedIds: rows.filter((r) => unprocessed.has(r.id)).map((r) => r.id),
    records: page.records.map((row) => ({
      ...row,
      unprocessed: unprocessed.has(row.id),
      sourcePresentation: presentations.get(row.id),
      sourceLabel: (presentations.get(row.id) as { label?: string })?.label,
    })),
    receipts: receipts.map((row) => ({
      ...row.receipt,
      collectionId: row.collection_id,
    })),
  };
}

function idsOf(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 10000 ||
    value.some((id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new ProcessingError(422, "processing_result_invalid");
  return value as string[];
}
export async function previewTaskInput(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  body: unknown,
) {
  if (!isPlainObject(body))
    throw new ProcessingError(422, "processing_scope_invalid");
  const { task, latest } = await taskState(db, artifacts, scope, id);
  let rows: InputSnapshot["records"];
  if (body.mode === "rerun") {
    const input = await frozen(artifacts, latest);
    rows = input.records;
  } else if (body.mode === "saved")
    rows = (await savedInput(db, artifacts, scope, task)).records;
  else {
    const selected = idsOf(body.resultIds);
    const current = await currentRows(db, artifacts, scope, task);
    if (selected.some((id) => !current.some((r) => r.id === id)))
      throw new ProcessingError(422, "processing_result_invalid");
    rows = current
      .filter((r) => selected.includes(r.id))
      .map((r) => ({ id: `candidate:${r.id}`, ...r.result }));
  }
  const matched = filterProcessingRecords(rows, body.search, body.conditions);
  const limit = Math.min(100, Math.max(1, Number(body.limit ?? 20))),
    offset = Math.max(0, Number(body.offset ?? 0));
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset))
    throw new ProcessingError(422, "query_parameter_invalid");
  return {
    records: matched.slice(offset, offset + limit),
    allIds: matched.map((r) => r.id),
    total: matched.length,
    sourceRevision: String(task.revision),
    options: latest.options,
    parent: {
      id: latest.id,
      options: latest.options,
      createdAt: latest.created_at,
    },
    sourceSummary: await processingSourceSummary(db, scope, latest.source),
    metadataKeys: [
      ...new Set(rows.flatMap((row) => row.metadata.map((entry) => entry.key))),
    ],
  };
}

export async function createProcessingTaskRound(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  key: unknown,
  body: unknown,
) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) => !["expectedRevision", "mode", "resultIds", "options"].includes(k),
    ) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    !["continue", "rerun", "complete", "saved"].includes(String(body.mode))
  )
    throw new ProcessingError(422, "processing_scope_invalid");
  // Replay a submitted key before checking the now-advanced workspace revision.
  const prior =
    typeof key === "string"
      ? (
          await db.query(
            "SELECT id FROM processing_run WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [scope.projectId, scope.actorId, key],
          )
        ).rows[0]
      : null;
  const { task, latest, runs } = await taskState(db, artifacts, scope, id);
  if (task.revision !== body.expectedRevision && !prior)
    throw new ProcessingError(409, "processing_task_changed");
  const mode = body.mode as "continue" | "rerun" | "complete" | "saved";
  if (
    mode === "complete" &&
    (body.options !== undefined || body.resultIds !== undefined)
  )
    throw new ProcessingError(422, "processing_scope_invalid");
  let options: ProcessingOptions;
  try {
    options = processingOptions(body.options ?? latest.options);
  } catch {
    throw new ProcessingError(422, "processing_configuration_invalid");
  }
  let records: InputSnapshot["records"] | undefined,
    before = task.current_refs,
    parentId = latest.id;
  let generation: InputSnapshot["generation"];
  if (mode === "saved") {
    const saved = prior ? null : await savedInput(db, artifacts, scope, task);
    const run = prior ? await getProcessingRun(db, scope, prior.id) : null;
    return createProcessingRun(
      db,
      artifacts,
      {
        ...scope,
        taskRound: {
          taskId: task.id,
          expectedRevision: body.expectedRevision as number,
          before,
          kind: mode,
          recordKeys: saved?.recordKeys,
        },
      },
      key,
      { source: saved?.source ?? run!.source, options },
    );
  } else if (prior) {
    const run = await getProcessingRun(db, scope, prior.id);
    const input = await frozen(artifacts, run);
    records = input.records;
    generation = input.generation;
    if (mode === "complete") options = run.options;
    parentId = run.parent_run_id ?? latest.id;
    const existing = (
      await db.query(
        "SELECT task_before FROM processing_run WHERE id=$1 AND task_id=$2",
        [prior.id, task.id],
      )
    ).rows[0];
    if (!existing) throw new ProcessingError(409, "idempotency_conflict");
    before = existing.task_before;
  } else if (mode === "complete") {
    const recovery = await processingRecovery(db, latest);
    const root = runs[0]!;
    if (
      isGenerationRecipe(root.execution_config.recipeVersion) &&
      !(latest.options.operation !== "generate" && recovery.canContinue)
    ) {
      const input = await frozen(artifacts, root);
      const current = await currentRows(db, artifacts, scope, task);
      const budget = recovery.generationBudget;
      if (
        !input.generation ||
        !budget ||
        budget.exhausted ||
        budget.blocked ||
        latest.status === "cancelled"
      )
        throw new ProcessingError(409, "processing_completion_unavailable");
      const positions = remainingGenerationPositions(
        input.generation,
        current,
        input.background?.questionPolicy,
      );
      if (!positions.length)
        throw new ProcessingError(409, "processing_completion_unavailable");
      generation = {
        ...input.generation,
        positions,
        previousFailure: recovery.diagnostics.at(-1)?.calls.at(-1)?.code,
      };
      records = [];
      options = { ...root.options, outputCount: positions.length };
    } else {
      if (!recovery.canContinue)
        throw new ProcessingError(409, "processing_completion_unavailable");
      const input = await frozen(artifacts, latest);
      options = latest.options;
      if (generatesRecords(options.operation)) {
        records = input.records;
        options = {
          ...options,
          outputCount: Math.max(
            0,
            (options.outputCount ?? latest.input_count) -
              Number(latest.output_count ?? 0),
          ),
        };
      } else {
        const data = await readProcessingRun(
          db,
          artifacts,
          scope,
          latest.id,
          { limit: "10000" },
          true,
        );
        const succeeded = new Set(
          data.records.map((row) => row.result.sourceId),
        );
        records = input.records
          .filter((row) => !succeeded.has(row.id))
          .map((row) => ({
            ...row,
            taskRecordKey:
              row.taskRecordKey ??
              task.current_refs.find(
                (ref) => ref.inputId === row.id && ref.runId === latest.id,
              )?.key,
          }));
        if (!records.length || records.some((row) => !row.taskRecordKey))
          throw new ProcessingError(409, "processing_completion_unavailable");
        const rows = await currentRows(db, artifacts, scope, task),
          saved = await adopted(db, artifacts, scope, rows);
        const fromSavedRange =
          input.source.kind === "draft" &&
          runs.some(
            (run) =>
              run.round_kind === "saved" &&
              run.source.kind === "draft" &&
              run.source.id === (input.source as { id: string }).id &&
              run.round_number <= latest.round_number,
          );
        if (
          !fromSavedRange &&
          records.some((row) => saved.has(row.taskRecordKey!))
        )
          throw new ProcessingError(409, "processing_already_adopted");
      }
    }
  } else if (mode === "rerun") {
    const current = await currentRows(db, artifacts, scope, task);
    const saved = await adopted(db, artifacts, scope, current);
    if (current.some((row) => row.runId === latest.id && saved.has(row.id)))
      throw new ProcessingError(409, "processing_already_adopted");
    const input = await frozen(artifacts, latest);
    records = input.records.map(({ candidateOrigin: _origin, ...row }) => row);
    before =
      (
        await db.query("SELECT task_before FROM processing_run WHERE id=$1", [
          latest.id,
        ])
      ).rows[0].task_before ?? [];
  } else {
    const ids = idsOf(body.resultIds);
    const rows = await currentRows(db, artifacts, scope, task),
      saved = await adopted(db, artifacts, scope, rows);
    if (ids.some((id) => !rows.some((r) => r.id === id)))
      throw new ProcessingError(422, "processing_result_invalid");
    if (ids.some((id) => saved.has(id)))
      throw new ProcessingError(409, "processing_already_adopted");
    records = rows
      .filter((r) => ids.includes(r.id))
      .map((r) => ({
        id: `candidate:${r.id}`,
        taskRecordKey: r.id,
        question: r.result.question,
        expectedOutput: r.result.expectedOutput,
        metadata: r.result.metadata,
        ...(options.operation === "augment"
          ? {}
          : { candidateOrigin: r.candidateOrigin }),
        baseline: r.original.baseline ?? r.original,
        ...(r.original.source === undefined
          ? {}
          : { source: r.original.source }),
        ...(r.original.revisions === undefined
          ? {}
          : { revisions: r.original.revisions }),
        adoptionOperation: generatesRecords(options.operation)
          ? options.operation
          : generatesRecords(r.rootOperation)
            ? r.rootOperation
            : options.operation,
        adoptionFields: [
          ...new Set([...r.adoptionFields, ...options.allowedFields]),
        ],
      }));
  }
  if (!terminal(latest.status) && !prior)
    throw new ProcessingError(409, "processing_still_running");
  const taskRound = {
    taskId: task.id,
    expectedRevision: body.expectedRevision as number,
    before,
    records,
    ...(generation ? { generation } : {}),
    kind: mode,
    deduplicationBaseline: generatesRecords(options.operation)
      ? (await currentRows(db, artifacts, scope, task)).map((row) => ({
          ...row.result,
          ...(generation
            ? { sourceId: `generated:${generationPosition(row)}` }
            : {}),
        }))
      : undefined,
  };
  return createRefinementRun(
    db,
    artifacts,
    { ...scope, taskRound },
    parentId,
    key,
    mode === "rerun"
      ? { options }
      : {
          resultIds:
            (body.resultIds as string[] | undefined) ??
            records!.map((_, i) => `0:${i}`),
          options,
        },
    mode === "rerun" ? "rerun" : "continue",
  );
}

/** Saved continuation reads only the receipt-proven range, with fresh field revisions. */
async function savedInput(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  task: Task,
) {
  const rows = await currentRows(db, artifacts, scope, task),
    saved = await adopted(db, artifacts, scope, rows);
  if (!rows.length || saved.size !== rows.length)
    throw new ProcessingError(409, "processing_saved_range_unavailable");
  const receipts = (
    await db.query(
      `SELECT pa.receipt FROM processing_acceptance pa JOIN processing_run r ON r.id=pa.run_id WHERE r.task_id=$1 AND pa.draft_id IS NOT NULL ORDER BY pa.created_at DESC`,
      [task.id],
    )
  ).rows;
  const mappings = new Map<string, { draftId: string; recordId: string }>();
  for (const item of receipts)
    for (const entry of item.receipt.savedRows ?? [])
      if (!mappings.has(`${entry.runId}:${entry.resultId}`))
        mappings.set(`${entry.runId}:${entry.resultId}`, {
          draftId: item.receipt.draftId,
          recordId: entry.recordId,
        });
  const matched = rows.map((row) =>
    mappings.get(`${row.runId}:${row.localId}`),
  );
  if (
    matched.some((r) => !r) ||
    new Set(matched.map((r) => r!.draftId)).size !== 1
  )
    throw new ProcessingError(409, "processing_saved_range_unavailable");
  const draftId = matched[0]!.draftId;
  const records = (
    await db.query(
      "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false ORDER BY position",
      [draftId, matched.map((r) => r!.recordId)],
    )
  ).rows;
  if (records.length !== matched.length)
    throw new ProcessingError(409, "processing_saved_range_unavailable");
  return {
    source: {
      kind: "draft" as const,
      id: draftId,
      recordIds: records.map((r) => r.id),
    },
    records: records.map((row) => ({
      id: row.id,
      question: row.question,
      expectedOutput: row.expected_output,
      metadata: row.metadata,
    })),
    recordKeys: Object.fromEntries(
      matched.map((match, index) => [match!.recordId, rows[index]!.id]),
    ),
  };
}

export async function deduplicateTask(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  body: unknown,
) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) => !["resultIds", "action", "expectedRevision"].includes(k),
    )
  )
    throw new ProcessingError(422, "processing_deduplication_invalid");
  const { task } = await taskState(db, artifacts, scope, id);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (body.action === "restore" || body.action === "exclude") {
      if (!Number.isSafeInteger(body.expectedRevision))
        throw new ProcessingError(422, "processing_scope_invalid");
      await guardProcessingTask(client, {
        ...scope,
        taskSave: {
          taskId: task.id,
          expectedRevision: body.expectedRevision as number,
          excludedGroups: [],
        },
      });
    }
    if (body.action === "restore") {
      const restored = [...task.current_refs, ...task.excluded_refs].sort(
        (a, b) =>
          Number(a.key.split(":")[0]) - Number(b.key.split(":")[0]) ||
          Number(a.key.split(":")[1]) - Number(b.key.split(":")[1]),
      );
      await client.query(
        "UPDATE processing_task SET current_refs=$2,excluded_refs='[]',revision=revision+1 WHERE id=$1",
        [task.id, JSON.stringify(restored)],
      );
      await client.query("COMMIT");
      return {
        restored: true,
        restoredIds: task.excluded_refs.map((ref) => ref.key),
      };
    }
    const ids = idsOf(body.resultIds),
      current = await currentRows(db, artifacts, scope, task),
      rows = current.filter((r) => ids.includes(r.id));
    if (rows.length !== ids.length)
      throw new ProcessingError(422, "processing_result_invalid");
    if ((await adopted(db, artifacts, scope, rows)).size)
      throw new ProcessingError(409, "processing_already_adopted");
    const baseline = current
      .filter((row) => !ids.includes(row.id))
      .map((row) => row.result);
    const draftId = rows.find(
      (row) => row.rootOperation === "augment" && row.source.kind === "draft",
    )?.source;
    if (draftId && draftId.kind === "draft")
      baseline.push(
        ...(
          await db.query(
            "SELECT question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
            [draftId.id],
          )
        ).rows.map((row) => ({
          sourceId: "baseline",
          question: row.question,
          expectedOutput: row.expected_output,
          metadata: row.metadata,
        })),
      );
    const plan = deduplicate(
      rows.map((row) => ({ id: row.id, ...row.result })),
      baseline,
    );
    if (body.action === "exclude") {
      const excluded = new Set(plan.excludedIds);
      await excludeTaskReferences(
        client,
        scope.projectId,
        task.id,
        groupRefs(task.current_refs.filter((ref) => excluded.has(ref.key))),
      );
    } else if (body.action !== undefined)
      throw new ProcessingError(422, "processing_scope_invalid");
    await client.query("COMMIT");
    return {
      ...plan,
      checkedIds: ids,
      inspected: ids.length,
      removedRecordIds: rows
        .filter(
          (r) =>
            plan.excludedIds.includes(r.id) &&
            r.source.kind === "draft" &&
            r.rootOperation !== "augment",
        )
        .map((r) => r.originalId),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptTask(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  key: unknown,
  body: unknown,
) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) => !["resultIds", "target", "expectedRevision"].includes(k),
    ) ||
    !Number.isSafeInteger(body.expectedRevision)
  )
    throw new ProcessingError(422, "processing_accept_invalid");
  const { task } = await taskState(db, artifacts, scope, id);
  const prior =
    typeof key === "string"
      ? (
          await db.query(
            "SELECT receipt,request_hash FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [scope.projectId, scope.actorId, key],
          )
        ).rows[0]
      : null;
  const requestHash = sha256(canonicalJson({ taskId: task.id, body }));
  if (prior) {
    if (prior.receipt.taskRequestHash !== requestHash)
      throw new ProcessingError(409, "idempotency_conflict");
    return { receipt: prior.receipt, replayed: true };
  }
  const ids = idsOf(body.resultIds),
    refs = task.current_refs.filter((r) => ids.includes(r.key));
  if (refs.length !== ids.length || refs.some((r) => r.inputId))
    throw new ProcessingError(422, "processing_result_invalid");
  const saved = await adopted(
    db,
    artifacts,
    scope,
    await currentRows(db, artifacts, scope, task),
  );
  const replaced: TaskRef[] = [];
  for (const ref of refs) {
    if (saved.has(ref.key)) continue;
    for (let old = ref.replaces; old; old = old.replaces) replaced.push(old);
  }
  const groups = groupRefs(refs),
    primary = groups[0]!;
  const taskSave = {
    taskId: task.id,
    expectedRevision: body.expectedRevision as number,
    excludedGroups: groupRefs([...task.excluded_refs, ...replaced]),
    requestHash,
  };
  // The adoption service reconciles the original idempotency key before any new writes.
  if (!prior && task.revision !== body.expectedRevision)
    throw new ProcessingError(409, "processing_task_changed");
  return acceptProcessingResults(
    db,
    artifacts,
    { ...scope, acceptanceGroups: groups, taskSave },
    primary.runId,
    key,
    { resultIds: primary.resultIds, target: body.target },
  );
}

export async function processingTaskHistory(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  id: string,
  query: { offset?: string; limit?: string } = {},
) {
  const { task, runs } = await taskState(db, artifacts, scope, id);
  const offset = Number(query.offset ?? 0),
    limit = Number(query.limit ?? 20);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const rounds = [];
  for (const run of [...runs].reverse().slice(offset, offset + limit)) {
    const status = processingRunSummary(run);
    const actor = (
      await db.query(
        "SELECT coalesce(display_name,username) name FROM app_user WHERE id=$1",
        [run.actor_id],
      )
    ).rows[0];
    const saved = Number(
      (
        await db.query(
          "SELECT count(DISTINCT result_id) n FROM processing_acceptance, jsonb_array_elements_text(result_ids) result_id WHERE run_id=$1",
          [run.id],
        )
      ).rows[0].n,
    );
    rounds.push({
      ...status,
      roundNumber: run.round_number,
      kind: run.round_kind,
      actorName: actor?.name ?? "未记录",
      savedCount: saved,
    });
  }
  return { taskId: task.id, rounds, total: runs.length, offset, limit };
}

async function processingTaskListPage(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  query: {
    offset?: string;
    limit?: string;
    search?: string;
    status?: string;
  } = {},
) {
  await processingAccess(db, scope);
  const offset = Number(query.offset ?? 0),
    limit = Number(query.limit ?? 20),
    text = (query.search ?? "").trim().toLowerCase();
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    text.length > 200 ||
    ![
      undefined,
      "all",
      "active",
      "complete",
      "attention",
      "cancelled",
    ].includes(query.status)
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const summaries = (
    await db.query<
      ProcessingRun & {
        task_id: string;
        applied_run_id: string | null;
        applied_hash: string | null;
        incomplete: boolean;
        current_count: number;
        round_count: number;
        root_source: ProcessingSource;
        actor_name: string | null;
        revision: number;
      }
    >(
      `SELECT t.id AS task_id,t.revision,t.applied_run_id,t.applied_hash,t.incomplete,
      jsonb_array_length(t.current_refs) AS current_count,
      (SELECT count(*)::int FROM processing_run WHERE task_id=t.id) AS round_count,
      root.source AS root_source,r.id,r.source,r.options,r.input_count,r.created_at,
      r.actor_id,j.result,${runStatusColumns},coalesce(u.display_name,u.username) AS actor_name
      FROM processing_task t JOIN processing_run root ON root.id=t.root_run_id
      JOIN processing_run r ON r.id=t.latest_run_id JOIN job j ON j.id=r.job_id
      LEFT JOIN app_user u ON u.id=r.actor_id WHERE t.project_id=$1
    AND NOT EXISTS(SELECT 1 FROM processing_run r WHERE r.task_id=t.id AND (r.input_ref IS NULL OR (cardinality(r.background_document_ids)>0 AND r.actor_id<>$2)))
    ORDER BY t.updated_at DESC,t.id DESC`,
      [scope.projectId, scope.actorId],
    )
  ).rows;
  const sources = summaries.length
    ? (
        await db.query<{
          task_id: string;
          project_id: string;
          source: ProcessingSource;
          input_ref: string | null;
          actor_id: string;
          background_document_ids: string[];
        }>(
          "SELECT task_id,project_id,source,input_ref,actor_id,background_document_ids FROM processing_run WHERE task_id=ANY($1::text[])",
          [summaries.map((row) => row.task_id)],
        )
      ).rows
    : [];
  const available = await processingSourceRows(
    db,
    scope.projectId,
    sources.map((row) => row.source),
  );
  const sourceMaps = {
    assets: new Map(available.assets.map((row) => [row.id as string, row])),
    version: new Map(available.version.map((row) => [row.id as string, row])),
    draft: new Map(available.draft.map((row) => [row.id as string, row])),
    background: new Map(
      available.background.map((row) => [row.id as string, row]),
    ),
  };
  const unavailable = new Set(
    sources
      .filter(
        (row) =>
          row.project_id !== scope.projectId ||
          !row.input_ref ||
          (row.background_document_ids.length > 0 &&
            row.actor_id !== scope.actorId) ||
          (row.source.kind === "assets"
            ? row.source.assetIds.some((id) => !sourceMaps.assets.has(id))
            : !sourceMaps[row.source.kind].has(row.source.id)),
      )
      .map((row) => row.task_id),
  );
  const eligible = summaries.filter((row) => !unavailable.has(row.task_id));
  const batchRows = eligible.length
    ? (
        await db.query(
          "SELECT run_id,result_ref,result_indices,issues FROM processing_batch WHERE run_id=ANY($1::text[]) ORDER BY run_id,ordinal",
          [eligible.map((row) => row.id)],
        )
      ).rows
    : [];
  const batches = new Map<
    string,
    { result_ref: unknown; result_indices: unknown; issues: unknown }[]
  >();
  for (const { run_id, ...batch } of batchRows) {
    const group = batches.get(run_id) ?? [];
    group.push(batch);
    batches.set(run_id, group);
  }
  const recent = [];
  const taskRevisions = new Map<string, number>();
  for (const row of eligible) {
    try {
      const hash = sha256(
        canonicalJson({
          status: row.status,
          batches: batches.get(row.id) ?? [],
        }),
      );
      const changed = terminal(row.status)
        ? row.applied_run_id !== row.id || row.applied_hash !== hash
        : !row.applied_run_id && row.applied_hash !== hash;
      // A changed task is rechecked under the existing lock; this snapshot never writes state.
      const synced = changed
        ? await taskState(db, artifacts, scope, row.task_id)
        : null;
      const rootSource: ProcessingSource =
        synced?.runs[0]?.source ?? row.root_source;
      const rootRows =
        rootSource.kind === "assets"
          ? available.assets.filter((asset) =>
              rootSource.assetIds.includes(asset.id),
            )
          : available[rootSource.kind].filter(
              (source) => source.id === rootSource.id,
            );
      const run = processingRunSummary(synced?.latest ?? row),
        sourceSummary = await processingSourceSummary(
          db,
          scope,
          rootSource,
          rootRows,
        );
      const actorName =
        synced && synced.latest.actor_id !== row.actor_id
          ? (
              await db.query(
                "SELECT coalesce(display_name,username) name FROM app_user WHERE id=$1",
                [synced.latest.actor_id],
              )
            ).rows[0]?.name
          : row.actor_name;
      taskRevisions.set(row.task_id, synced?.task.revision ?? row.revision);
      recent.push({
        status: run.status,
        progress: run.progress,
        errorCode: run.errorCode,
        partial: run.partial,
        executionComplete: run.executionComplete,
        inputCount: run.inputCount,
        outputCount: run.outputCount,
        createdAt: run.createdAt,
        source:
          run.source.kind === "assets"
            ? { kind: run.source.kind }
            : { kind: run.source.kind, id: run.source.id },
        options: {
          operation: run.options.operation,
          instructions: run.options.instructions.slice(0, 240),
        },
        id: row.task_id,
        sourceSummary,
        actorName: actorName ?? "未记录",
        title: `${sourceSummary.name} · 数据处理`,
        roundCount: synced?.runs.length ?? row.round_count,
        currentCount: synced?.task.current_refs.length ?? row.current_count,
        incomplete: synced?.task.incomplete ?? row.incomplete,
      });
      if (recent.length === 100) break;
    } catch (error) {
      if (
        !(
          error instanceof ProcessingError &&
          [403, 404, 409].includes(error.status)
        )
      )
        throw error;
    }
  }
  const matched = recent.filter(
    (run) =>
      (!text ||
        [run.title, run.options.instructions].some((v) =>
          v.toLowerCase().includes(text),
        )) &&
      (!query.status ||
        query.status === "all" ||
        (query.status === "active"
          ? !terminal(run.status)
          : query.status === "complete"
            ? run.status === "succeeded" && !run.incomplete
            : query.status === "cancelled"
              ? run.status === "cancelled"
              : run.status === "failed" || run.incomplete)),
  );
  const selected = matched.slice(offset, offset + limit);
  const currentRefs = new Map<string, TaskRef[]>(
    (selected.length
      ? (
          await db.query<{ id: string; current_refs: TaskRef[] }>(
            `SELECT t.id,t.current_refs FROM processing_task t
            JOIN jsonb_to_recordset($2::jsonb) AS expected(id text,revision int) ON t.id=expected.id AND t.revision=expected.revision
            WHERE t.project_id=$1`,
            [
              scope.projectId,
              JSON.stringify(
                selected.map((row) => ({
                  id: row.id,
                  revision: taskRevisions.get(row.id),
                })),
              ),
            ],
          )
        ).rows
      : []
    ).map((row) => [row.id, row.current_refs]),
  );
  // A new round or source cleanup may have changed both visibility and references during this read.
  if (currentRefs.size !== selected.length) {
    throw new ProcessingError(409, "processing_task_changed");
  }
  const page = [];
  const adoptedReads = new Map<
    string,
    Awaited<ReturnType<typeof readProcessingRun>>
  >();
  const candidateRuns = selected.flatMap((row) =>
    groupRefs(currentRefs.get(row.id) ?? []).map((group) => ({
      run: { id: group.runId },
      records: (currentRefs.get(row.id) ?? [])
        .filter((ref) => ref.runId === group.runId && !ref.inputId)
        .map((ref) => ({
          id: ref.resultId,
          candidateOrigin: ref.origin ?? {
            runId: ref.runId,
            resultId: ref.resultId,
          },
        })),
    })),
  );
  const adopted = candidateRuns.length
    ? await adoptedCandidateKeys(
        db,
        artifacts,
        scope,
        candidateRuns,
        undefined,
        true,
        [],
        adoptedReads,
        true,
      )
    : new Set<string>();
  for (const row of selected) {
    const refs = currentRefs.get(row.id)!;
    let savedCount = 0;
    for (const group of groupRefs(refs)) {
      const candidates = refs.filter(
        (ref) => ref.runId === group.runId && !ref.inputId,
      );
      savedCount += candidates.filter((ref) =>
        adopted.has(candidateKey({ runId: ref.runId, resultId: ref.resultId })),
      ).length;
    }
    page.push({
      ...row,
      savedCount,
      currentCount: refs.length,
      unsavedCount: refs.length - savedCount,
    });
  }
  return {
    runs: page,
    pagination: { total: matched.length, offset, limit },
    recentLimit: 100,
    hasActive: recent.some((run) => !terminal(run.status)),
  };
}

export async function listProcessingTasks(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  query: Parameters<typeof processingTaskListPage>[3] = {},
) {
  try {
    return await processingTaskListPage(db, artifacts, scope, query);
  } catch (error) {
    if (
      !(error instanceof ProcessingError) ||
      error.code !== "processing_task_changed"
    )
      throw error;
    return processingTaskListPage(db, artifacts, scope, query);
  }
}
