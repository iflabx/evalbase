import { generatesRecords } from "../processing/protocol.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  previewProcessingInput,
  readProcessingRun,
  processingRunSummary,
} from "../processing/store.js";
import { reviewCandidates } from "../processing/review.js";
import { adoptedCandidateKeys, candidateKey } from "../processing/adoption.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { processingTaskCandidates } from "../processing/tasks.js";
import { presentProcessingReview } from "../processing/presentation.js";
import { planRequirementsKey } from "./plan.js";
import {
  requirementSummary,
  validateRules,
  normalizedRequirements,
} from "./requirements.js";
import { AssistantError, type AssistantScope } from "./store.js";
import {
  scopeCandidateRun,
  candidateScopeForRun,
  candidateSelectionShortfalls,
  candidateCollectionHashValid,
} from "./candidates.js";

/** Reviews the current leaves and, for a final-total goal, the actual draft after pending adoption. */
export async function taskCandidateCollection(
  db: Database,
  artifacts: ArtifactRepository,
  scope: AssistantScope,
  task: Record<string, any>,
  data?: Awaited<ReturnType<typeof readProcessingRun>>,
) {
  const ids: string[] = [
    ...new Set<string>(task.runIds ?? (task.runId ? [task.runId] : [])),
  ];
  if (!ids.length) throw new AssistantError(404, "processing_not_found");
  if (ids.length > 12) throw new AssistantError(422, "assistant_task_limit");
  const loaded = new Map<
    string,
    Awaited<ReturnType<typeof readProcessingRun>>
  >();
  const read = async (id: string) => {
    if (!loaded.has(id))
      loaded.set(
        id,
        data?.run.id === id
          ? data
          : await readProcessingRun(
              db,
              artifacts,
              scope,
              id,
              { limit: "10000" },
              true,
            ),
      );
    return loaded.get(id)!;
  };
  const states: { id: string; revision: number }[] = [],
    history: {
      runId: string;
      status: string;
      operation: string;
      round: number;
      count: number;
    }[] = [],
    excluded: { runId: string; resultIds: string[] }[] = [];
  const executionRuns: { id: string; status: string }[] = [];
  const excludedInputIdentities: { taskId: string; identity?: string }[] = [];
  const seenTasks = new Set<string>();
  const candidates: Awaited<ReturnType<typeof readProcessingRun>>[] = [];
  const fixedTaskScope =
    task.candidateScope?.scope === "task" ? task.candidateScope : undefined;
  if (fixedTaskScope) {
    if (!candidateCollectionHashValid(fixedTaskScope))
      throw new AssistantError(409, "assistant_candidate_selection_changed");
    for (const member of fixedTaskScope.members ?? [])
      scopeCandidateRun(await read(member.runId), member);
  }
  for (const id of ids) {
    const root = await read(id);
    if (!root.run.taskId) {
      executionRuns.push({ id, status: root.run.status });
      candidates.push(
        scopeRunToTask(
          task,
          scopeCandidateRun(root, candidateScopeForRun(task, id)),
        ),
      );
      continue;
    }
    if (seenTasks.has(root.run.taskId)) continue;
    seenTasks.add(root.run.taskId);
    const current = await processingTaskCandidates(db, artifacts, scope, id);
    states.push({ id: current.id, revision: current.revision });
    const latest = current.runs.find((run) => run.id === current.latestRunId)!;
    const completedGeneration =
      latest.source.kind === "background" &&
      latest.status === "succeeded" &&
      current.runs.some(
        (run) =>
          run.round_kind === "complete" &&
          processingRunSummary(run).executionComplete,
      );
    executionRuns.push({ id: latest.id, status: latest.status });
    current.runs.forEach((run) =>
      history.push({
        runId: run.id,
        status: run.status,
        operation: run.options.operation,
        round: run.round_number,
        count: Number(run.output_count ?? 0),
      }),
    );
    for (const runId of new Set(current.excluded.map((ref) => ref.runId))) {
      const raw = await read(runId);
      for (const ref of current.excluded.filter((ref) => ref.runId === runId)) {
        const row = raw.records.find((row) => row.id === ref.resultId);
        const id =
          row?.original?.baseline?.id ??
          row?.original?.id ??
          row?.result.sourceId;
        excludedInputIdentities.push({
          taskId: current.id,
          identity: id ? frozenInputIdentity(raw.run.source, id) : undefined,
        });
      }
      excluded.push({
        runId,
        resultIds: current.excluded
          .filter((ref) => ref.runId === runId)
          .map((ref) => ref.resultId),
      });
    }
    const scopeRoot =
      task.candidateScope && !fixedTaskScope
        ? await read(task.candidateScope.runId)
        : undefined;
    if (scopeRoot) scopeCandidateRun(scopeRoot, task.candidateScope);
    const fixed =
      scopeRoot?.run.taskId === current.id ? task.candidateScope : undefined;
    for (const runId of new Set(
      current.rows.filter((row) => row.localId).map((row) => row.runId),
    )) {
      const raw = await read(runId),
        refs = new Set(
          current.rows
            .filter((row) => row.runId === runId && row.localId)
            .map((row) => row.localId),
        );
      const rows = raw.records.filter(
        (row) =>
          refs.has(row.id) &&
          (!fixed ||
            fixed.originKeys.includes(candidateKey(row.candidateOrigin))),
      );
      candidates.push(
        scopeRunToTask(task, {
          ...raw,
          // Current valid candidates survive a failed generation. A successful explicit
          // completion resolves its old missing-output diagnostics; history stays raw.
          ...(completedGeneration && runId !== latest.id
            ? {
                run: { ...raw.run, status: latest.status, missingCount: 0 },
                issues: [],
              }
            : {}),
          records: rows,
          allIds: rows.map((row) => row.id),
          total: rows.length,
        }),
      );
    }
  }
  const excludedKeys = new Set<string>(
    fixedTaskScope?.excludedOriginKeys ?? [],
  );
  const runs = effectiveTaskRuns(candidates).map((run) => {
    const rows = run.records.filter(
      (row) => !excludedKeys.has(candidateKey(row.candidateOrigin)),
    );
    return {
      ...run,
      records: rows,
      allIds: rows.map((row) => row.id),
      total: rows.length,
    };
  });
  if (runs.reduce((n, run) => n + run.total, 0) > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  const records = runs.flatMap((run) =>
    run.records.map((row) => ({
      ...row,
      id: candidateKey(row.candidateOrigin),
      resultRef: {
        runId: run.run.id,
        resultId: row.id,
        identity: candidateKey(row.candidateOrigin),
      },
    })),
  );
  if (new Set(records.map((row) => row.id)).size !== records.length)
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  const digest = sha256(
    canonicalJson({
      states,
      executionRuns,
      records: records.map((row) => ({
        id: row.id,
        ref: row.resultRef,
        result: row.result,
      })),
      scope: task.candidateScope?.hash ?? null,
    }),
  );
  return {
    runs,
    records,
    digest,
    states,
    history,
    excluded,
    executionRuns,
    excludedInputIdentities,
  };
}

export async function presentTaskCandidates(
  db: Database,
  artifacts: ArtifactRepository,
  scope: AssistantScope,
  task: Record<string, any>,
  revision: number,
  query: { offset?: string; limit?: string; view?: string; search?: string },
) {
  const collection = await taskCandidateCollection(db, artifacts, scope, task);
  const primary =
    collection.runs.at(-1) ??
    (await readProcessingRun(db, artifacts, scope, task.runId, { limit: "1" }));
  const data = {
    ...primary,
    records: taskCompatibilityProblem(task, collection.runs)
      ? collection.records.map((row) => ({
          ...row,
          contentReview: row.contentReview
            ? {
                ...row.contentReview,
                verdict: "pending" as const,
                reason: "要求已变化，旧核对结论已失效",
              }
            : undefined,
        }))
      : collection.records,
    allIds: collection.records.map((row) => row.id),
    total: collection.records.length,
    issues: collection.runs.flatMap((run) => run.issues),
  };
  const page = await presentProcessingReview(
    db,
    artifacts,
    scope,
    data,
    query,
    collection.runs,
  );
  const target =
    task.targetDraftId ??
    (task.target?.kind === "draft" ? task.target.id : undefined);
  const saved = await adoptedCandidateKeys(
    db,
    artifacts,
    scope,
    collection.runs,
    target,
    Boolean(target),
  );
  const savedIds = collection.records
    .filter((row) =>
      saved.has(`${row.resultRef.runId}:${row.resultRef.resultId}`),
    )
    .map((row) => row.id);
  const reviewRevision = sha256(
    canonicalJson({ revision, digest: collection.digest }),
  );
  const selected = task.selectedCandidates as
    | TaskCandidateSelection
    | undefined;
  const selection =
    selected?.scope === "task" && selected.catalogDigest === collection.digest
      ? {
          scope: "task",
          reviewRevision,
          resultIds: selected.resultIds,
          previousReviewRevision: selected.reviewRevision,
        }
      : undefined;
  return {
    ...page,
    scope: "task",
    taskTotal: data.total,
    reviewRevision,
    savedIds,
    savedCount: savedIds.length,
    history: collection.history,
    selection,
    ...(target ? { saveTarget: { kind: "draft", id: target } } : {}),
  };
}

export type TaskCandidateSelection = {
  scope: "task";
  reviewRevision: string;
  resultIds: string[];
  catalogDigest?: string;
  groups?: { runId: string; resultIds: string[] }[];
};

/** Resolve browser identities once, and reuse the immutable references inside the turn. */
export function resolveTaskSelection(
  collection: Awaited<ReturnType<typeof taskCandidateCollection>>,
  selection: TaskCandidateSelection,
  revision?: number,
) {
  if (
    (revision !== undefined &&
      selection.reviewRevision !==
        sha256(canonicalJson({ revision, digest: collection.digest }))) ||
    (selection.catalogDigest !== undefined &&
      selection.catalogDigest !== collection.digest)
  )
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  const chosen = new Set(selection.resultIds),
    rows = collection.records.filter((row) => chosen.has(row.id));
  if (
    rows.length !== chosen.size ||
    collection.executionRuns.some(
      (run) => !["succeeded", "failed", "cancelled"].includes(run.status),
    )
  )
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  const groups = [...new Set(rows.map((row) => row.resultRef.runId))].map(
    (runId) => ({
      runId,
      resultIds: rows
        .filter((row) => row.resultRef.runId === runId)
        .map((row) => row.resultRef.resultId),
    }),
  );
  return { ...selection, catalogDigest: collection.digest, groups };
}

/** Recover only recorded goals or the frozen input range; generation request sizes are not delivery goals. */
function frozenInputIdentity(
  source: Awaited<ReturnType<typeof readProcessingRun>>["run"]["source"],
  id: string,
) {
  const assetId =
    source.kind === "assets"
      ? rowAssetId({ result: { sourceId: id } }, source)
      : undefined;
  if (source.kind === "assets" && !source.assetIds.includes(assetId)) return;
  return canonicalJson({
    source:
      source.kind === "assets"
        ? { kind: "assets", assetId }
        : { kind: source.kind, id: source.id },
    id,
  });
}

export function resolveCandidateGoal(
  task: Record<string, any>,
  runs: Awaited<ReturnType<typeof readProcessingRun>>[],
  excludedIdentities: { taskId: string; identity?: string }[] = [],
) {
  if (Object.hasOwn(task, "targetCount") && task.targetCount !== undefined)
    return task;
  const goals = new Map<
    string,
    { targetCount: number; countKind: "new" | "final" }
  >();
  for (const text of [
    ...(task.requirements ?? []),
    ...runs.flatMap((run) => run.backgroundGoal?.requirements ?? []),
  ]) {
    const match = /^(新增候选|最终总数)：\s*(\d+)\s*条$/u.exec(text.trim());
    if (match && Number(match[2]) > 0 && Number(match[2]) <= 10000) {
      const goal = {
        targetCount: Number(match[2]),
        countKind:
          match[1] === "最终总数" ? ("final" as const) : ("new" as const),
      };
      goals.set(canonicalJson(goal), goal);
    }
  }
  if (goals.size === 1)
    return { ...task, ...[...goals.values()][0], goalRecovered: true };
  if (
    !goals.size &&
    runs.length &&
    runs.every(
      (run) =>
        (run.rootOperation ?? run.run.options.operation) !== "augment" &&
        run.run.source.recordIds?.length,
    )
  ) {
    const identities = runs.flatMap((run) => {
      const fixed = currentRecordScope(task, run.run.source, run.run.id);
      const excluded = new Set(
        excludedIdentities
          .filter((entry) => entry.taskId === (run.run.taskId ?? run.run.id))
          .map((entry) => entry.identity),
      );
      return run.run.source.recordIds
        .filter((id) => !fixed || fixed.has(id))
        .map((id) => frozenInputIdentity(run.run.source, id))
        .filter(
          (identity) => identity === undefined || !excluded.has(identity),
        );
    });
    if (
      [
        ...identities,
        ...excludedIdentities.map((entry) => entry.identity),
      ].every((identity) => identity !== undefined)
    )
      return {
        ...task,
        targetCount: new Set(identities).size,
      };
  }
  return { ...task, countUnverified: true };
}

export async function reviewTask(
  db: Database,
  artifacts: ArtifactRepository,
  scope: AssistantScope,
  task: Record<string, any>,
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  publication = false,
) {
  const runIds: string[] = task.runIds?.length
    ? task.runIds
    : task.runId
      ? [task.runId]
      : [data.run.id];
  const { runs, executionRuns, history, excludedInputIdentities } =
    await taskCandidateCollection(
      db,
      artifacts,
      scope,
      { ...task, runIds },
      data,
    );
  if (
    !runIds.includes(data.run.id) &&
    !runs.some((run) => run.run.id === data.run.id) &&
    !history.some((run) => run.runId === data.run.id)
  )
    throw new AssistantError(409, "assistant_processing_context_changed");
  if (runs.reduce((count, item) => count + item.total, 0) > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  const goal = resolveCandidateGoal(task, runs, excludedInputIdentities);
  task = goal;
  let final;
  const destinationId =
    task.targetDraftId ??
    (task.target?.kind === "draft" ? task.target.id : undefined);
  const adopted = destinationId
    ? await adoptedCandidateKeys(db, artifacts, scope, runs, destinationId)
    : new Set<string>();
  // Actual destination receipts account for adopted candidates; unadopted results still check their input source.
  const pendingRuns = runs.filter(
    (run) =>
      !run.records.length ||
      run.records.some((row) => !adopted.has(`${run.run.id}:${row.id}`)),
  );
  let reviewedRuns = runs;
  let persistedCandidateViolations = 0;
  if ((task.countKind === "final" || publication) && destinationId) {
    const base = await previewProcessingInput(
      db,
      scope,
      { source: { kind: "draft", id: destinationId }, limit: 10000 },
      "write",
      true,
    );
    const baseIds = new Set(base.allIds);
    const replacing = new Set<string>();
    const pending = [];
    for (const run of runs)
      for (const row of publication ? [] : run.records) {
        if (adopted.has(`${run.run.id}:${row.id}`)) continue;
        if (
          run.run.source.kind === "draft" &&
          run.run.source.id === task.targetDraftId &&
          run.rootOperation !== "augment"
        ) {
          const originalId = row.original?.baseline?.id ?? row.original?.id;
          if (
            !originalId ||
            replacing.has(originalId) ||
            !baseIds.has(originalId)
          )
            throw new AssistantError(409, "processing_results_overlap");
          replacing.add(originalId);
        }
        pending.push({ ...row.result, id: `${run.run.id}:${row.id}` });
      }
    const revision = Number(
      (
        await db.query(
          "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2",
          [task.targetDraftId, scope.projectId],
        )
      ).rows[0]?.revision,
    );
    if (revision !== base.revision)
      throw new AssistantError(409, "draft_revision_conflict");
    let records = [
      ...base.records.filter((row) => !replacing.has(row.id)),
      ...pending,
    ];
    if (publication) {
      // Count only rows that exist now, using adoption provenance rather than a projected union.
      const sourceAssets = [
        ...new Set(
          base.records.flatMap((row) => {
            const source = row.source as { assetId?: string } | undefined;
            return source?.assetId ? [source.assetId] : [];
          }),
        ),
      ];
      const receipts = (
        await db.query(
          "SELECT run_id,result_ids,receipt FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND receipt->>'assetId'=ANY($3::text[])",
          [scope.projectId, scope.actorId, sourceAssets],
        )
      ).rows;
      const origins = new Map<string, string>();
      for (const saved of receipts) {
        const receipt = saved.receipt;
        let candidateOrigins = receipt.candidateOrigins;
        if (!Array.isArray(candidateOrigins)) {
          candidateOrigins = [];
          for (const group of receipt.resultGroups ?? [
            { runId: saved.run_id, resultIds: saved.result_ids },
          ]) {
            const old = await readProcessingRun(
              db,
              artifacts,
              scope,
              group.runId,
              { limit: "10000" },
              true,
            );
            candidateOrigins.push(
              ...old.records
                .filter((row) => group.resultIds.includes(row.id))
                .map((row) => row.candidateOrigin),
            );
          }
        }
        for (const [index, origin] of candidateOrigins.entries())
          origins.set(`${receipt.assetId}:${index + 1}`, candidateKey(origin));
      }
      const actual = new Map(
        base.records.flatMap((row) => {
          const source = row.source as
            | { assetId?: string; ordinal?: number }
            | undefined;
          const origin =
            source && origins.get(`${source.assetId}:${source.ordinal}`);
          return origin ? [[origin, row] as const] : [];
        }),
      );
      reviewedRuns = runs.map((run) => {
        const rows = run.records.flatMap((row) => {
          const result = actual.get(candidateKey(row.candidateOrigin));
          return result
            ? [
                {
                  ...row,
                  result: {
                    ...row.result,
                    question: result.question,
                    expectedOutput: result.expectedOutput,
                    metadata: result.metadata,
                  },
                },
              ]
            : [];
        });
        return { ...run, records: rows, total: rows.length };
      });
      const included = new Set(
        reviewedRuns.flatMap((run) =>
          run.records.map((row) => candidateKey(row.candidateOrigin)),
        ),
      );
      // Model outputs obey their frozen batch rules; later manual edits obey the current goal.
      persistedCandidateViolations = reviewCandidates(
        data,
        undefined,
        runs.map((run) => {
          const rows = run.records.filter((row) =>
            included.has(candidateKey(row.candidateOrigin)),
          );
          return { ...run, records: rows, total: rows.length };
        }),
        undefined,
        true,
      ).protectedFieldChanges;
      records =
        task.countKind === "final"
          ? base.records
          : base.records.filter((row) => {
              const source = row.source as
                | { assetId?: string; ordinal?: number }
                | undefined;
              const origin =
                source && origins.get(`${source.assetId}:${source.ordinal}`);
              return origin && included.has(origin);
            });
    }
    if (records.length > 10000)
      throw new AssistantError(422, "processing_capacity_exceeded");
    final = {
      records,
      baseCount: base.total,
      remainingCount: publication
        ? runs.reduce(
            (sum, run, index) => sum + run.total - reviewedRuns[index]!.total,
            0,
          )
        : pending.length,
      revision,
    };
  }
  const review = reviewCandidates(
    data,
    goal,
    reviewedRuns,
    final,
    publication ||
      Boolean(task.candidateScope) ||
      runs.some(
        (run) =>
          run.total !== run.run.inputCount &&
          run.run.options.outputCount === undefined,
      ),
    publication,
  );
  if (persistedCandidateViolations) {
    review.protectedFieldChanges += persistedCandidateViolations;
    review.complete = false;
  }
  const selectionShortfalls = candidateSelectionShortfalls(
    task.candidateScope,
    runs,
  );
  const compatibilityProblem = taskCompatibilityProblem(
    task,
    publication ? reviewedRuns : pendingRuns,
    publication ? destinationId : undefined,
  );
  return {
    runIds,
    runs,
    review: {
      ...review,
      ...(goal.goalRecovered ? { goalRecovered: true } : {}),
      ...(publication
        ? {
            deliveryComplete:
              review.complete &&
              !compatibilityProblem &&
              final?.remainingCount === 0,
          }
        : {}),
      compatibilityProblem,
      ...(compatibilityProblem
        ? {
            content: {
              ...review.content,
              checked: 0,
              conforms: 0,
              nonconforms: 0,
              uncertain: 0,
              pending: review.candidateCount,
            },
          }
        : {}),
      complete: review.complete && !compatibilityProblem,
      ...(task.candidateScope
        ? {
            selectionShortfalls,
            complete:
              review.complete &&
              !compatibilityProblem &&
              runs.some((item) => item.total > 0) &&
              !selectionShortfalls.length,
          }
        : {}),
    },
    finished: executionRuns.every((item) =>
      ["succeeded", "failed", "cancelled"].includes(item.status),
    ),
    checkedStatus: executionRuns.every((item) => item.status === "succeeded")
      ? "succeeded"
      : "failed",
  };
}

/** A newer transformation replaces the same source row; independent generated rows stay distinct. */
export function effectiveTaskRuns(
  runs: Awaited<ReturnType<typeof readProcessingRun>>[],
) {
  const seen = new Set<string>();
  return [...runs]
    .reverse()
    .flatMap((data) => {
      const records = data.records.filter((row) => {
        if (
          generatesRecords(data.rootOperation) ||
          generatesRecords(data.run.options?.operation ?? "")
        )
          return true;
        const original = row.original?.baseline ?? row.original;
        const id = original?.id ?? row.result.sourceId;
        const source = data.run.source;
        const key = canonicalJson({
          source:
            source.kind === "assets"
              ? { kind: source.kind, assetId: rowAssetId(row, source) }
              : { kind: source.kind, id: source.id },
          id,
        });
        if (!id) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (
        data.records.length > 0 &&
        records.length === 0 &&
        ["succeeded", "failed", "cancelled"].includes(data.run.status)
      )
        return [];
      return [
        {
          ...data,
          records,
          allIds: records.map((row) => row.id),
          total: records.length,
        },
      ];
    })
    .reverse();
}

/** Partial adoption relaxes totals, never the current source or plan revision. */
export function taskCompatibilityProblem(
  task: Record<string, any>,
  runs: (Pick<Awaited<ReturnType<typeof readProcessingRun>>, "run"> &
    Partial<
      Pick<
        Awaited<ReturnType<typeof readProcessingRun>>,
        "records" | "backgroundEvidence" | "backgroundGoal"
      >
    >)[],
  adoptedDestinationId?: string,
) {
  const identity = (source: Record<string, any>) =>
    source.kind === "asset"
      ? { kind: "assets", assetIds: [source.id] }
      : source.kind === "assets"
        ? { kind: "assets", assetIds: [...source.assetIds].sort() }
        : { kind: source.kind, id: source.id };
  // A changed destination is independent of the input; targetDraftId names it explicitly.
  const sources = (task.executionPlan?.steps ?? []).flatMap((step: any) =>
    step.input?.source ? [step.input.source] : [],
  );
  if (
    task.target &&
    !(
      task.target.kind === "draft" &&
      task.targetDraftId &&
      task.target.id === task.targetDraftId
    )
  )
    sources.push(task.target);
  const sourceMismatch =
    sources.length > 0 &&
    runs.some(
      (item) =>
        !sources.some((source: any) => {
          if (source.kind === "draft" && source.id === adoptedDestinationId)
            return true;
          const actual = identity(item.run.source);
          const allowed = identity(source);
          return actual.kind === "assets" && allowed.kind === "assets"
            ? (actual.assetIds!.every((id: string) =>
                allowed.assetIds!.includes(id),
              )
                ? actual.assetIds!
                : (item.records?.map((row) =>
                    rowAssetId(row, item.run.source),
                  ) ?? actual.assetIds!)
              ).every((id: string) => allowed.assetIds!.includes(id))
            : canonicalJson(actual) === canonicalJson(allowed);
        }),
    );
  const rangeMismatch = runs.some((item) => {
    if (
      adoptedDestinationId &&
      task.target?.kind === "draft" &&
      task.target.id === adoptedDestinationId
    )
      return false;
    const ids = currentRecordScope(task, item.run.source, item.run.id);
    return (
      ids &&
      (item.records
        ? item.records.map(
            (row) =>
              row.original?.baseline?.id ??
              row.original?.id ??
              row.result.sourceId,
          )
        : item.run.source.recordIds
      ).some((id) => !ids.has(id))
    );
  });
  const backgroundMismatch =
    task.backgroundEvidence !== undefined &&
    runs.some((item) => {
      const actual = item.backgroundEvidence ?? [];
      const expected = task.backgroundEvidence as {
        documentId: string;
        fragmentIndex: number;
        sha256?: string;
      }[];
      if (item.backgroundGoal) {
        // Local edits can narrow field permissions. Reconstruct only the exact
        // server-generated enum at its fixed summary slot; never filter business
        // requirements that happen to use the same prefix.
        const fieldNames: Record<string, string> = {
          问题: "question",
          期望输出: "expectedOutput",
          Metadata: "metadata",
        };
        const slot =
          Number(task.overallTargetCount != null) +
          Number(task.targetCount != null);
        const line = item.backgroundGoal.requirements[slot];
        const names = line?.slice("允许修改：".length).split("、");
        const fields =
          line === "允许修改：不修改任何字段"
            ? []
            : line?.startsWith("允许修改：") &&
                names?.every((name) => Object.hasOwn(fieldNames, name))
              ? names.map((name) => fieldNames[name])
              : undefined;
        const currentSummary = requirementSummary(
          fields ? { ...task, allowedFields: fields } : task,
        );
        if (
          canonicalJson(
            normalizedRequirements(item.backgroundGoal.requirements),
          ) !== canonicalJson(normalizedRequirements(currentSummary)) ||
          canonicalJson(item.backgroundGoal.classifications ?? []) !==
            canonicalJson(validateRules(task))
        )
          return true;
      } else if (validateRules(task).some((rule) => rule.basis !== "user")) {
        // Legacy evidence alone cannot prove which document definitions were applied.
        return true;
      }
      return (
        // Additional compatible citations can reuse outputs only after replanning and
        // checking that their frozen semantic requirements and definitions are unchanged.
        !(
          (item.backgroundGoal &&
            actual.every((frozen) =>
              expected.some(
                (ref) =>
                  ref.documentId === frozen.documentId &&
                  ref.fragmentIndex === frozen.fragmentIndex &&
                  (!ref.sha256 || frozen.sha256 === ref.sha256),
              ),
            )) ||
          (actual.length === expected.length &&
            !expected.some(
              (ref) =>
                !actual.some(
                  (frozen) =>
                    frozen.documentId === ref.documentId &&
                    frozen.fragmentIndex === ref.fragmentIndex &&
                    (!ref.sha256 || frozen.sha256 === ref.sha256),
                ),
            ))
        )
      );
    });
  return task.executionPlan?.needsReview
    ? "要求已变化，请先核对步骤和已有成果。"
    : sourceMismatch || rangeMismatch
      ? "已有成果的来源或记录范围与当前要求不同，不能按当前要求采用。"
      : backgroundMismatch
        ? "背景依据已变化，请核对已有成果是否适用，再继续处理或采用。"
        : null;
}

function currentRecordScope(
  task: Record<string, any>,
  source: Record<string, any>,
  runId?: string,
) {
  const identity = (value: Record<string, any>) =>
    canonicalJson(
      value.kind === "asset"
        ? { kind: "assets", assetIds: [value.id] }
        : value.kind === "assets"
          ? { kind: "assets", assetIds: [...value.assetIds].sort() }
          : { kind: value.kind, id: value.id },
    );
  const same = (value: Record<string, any> | undefined) => {
    if (!value) return false;
    const allowed =
      value.kind === "asset"
        ? [value.id]
        : value.kind === "assets"
          ? value.assetIds
          : undefined;
    const actual =
      source.kind === "asset"
        ? [source.id]
        : source.kind === "assets"
          ? source.assetIds
          : undefined;
    return allowed && actual
      ? actual.some((id: string) => allowed.includes(id))
      : identity(value) === identity(source);
  };
  if (same(task.target) && task.target.recordIds)
    return new Set<string>(task.target.recordIds);
  // A live multi-step plan authorizes each committed batch's own frozen range.
  // A later standalone selection has no stepId and immediately replaces that authority.
  const plan = task.executionPlan;
  const processingSteps = (plan?.steps ?? []).filter(
    (step: any) =>
      step.action === "submit_processing" &&
      step.input?.operation !== "augment" &&
      same(step.input?.source),
  );
  const repeatsFixedSelection = processingSteps.some(
    (step: any, index: number) =>
      step.input?.selection &&
      processingSteps
        .slice(index + 1)
        .some(
          (later: any) =>
            later.input?.selection &&
            later.input.reselect !== true &&
            (!later.input.selection.seed ||
              later.input.selection.seed === step.input.selection.seed) &&
            canonicalJson({ ...step.input.selection, seed: null }) ===
              canonicalJson({ ...later.input.selection, seed: null }),
        ),
  );
  // Legacy repeated random steps were meant to transform the fixed batch, not authorize another batch.
  if (
    repeatsFixedSelection &&
    !task.candidateScope &&
    same(task.processingScope?.source)
  )
    return new Set<string>(task.processingScope.recordIds);
  if (
    runId &&
    task.processingScope?.stepId &&
    !plan?.needsReview &&
    plan?.requirementsKey === planRequirementsKey(task) &&
    plan.steps.some((step: any) => step.id === task.processingScope.stepId) &&
    plan.steps.some((step: any) => step.receipt?.runId === runId)
  )
    return new Set<string>(source.recordIds);
  // A fixed candidate selection is independent of the smaller reference scope used to supplement it.
  if (!task.candidateScope && same(task.processingScope?.source))
    return new Set<string>(task.processingScope.recordIds);
  const explicit = (task.executionPlan?.steps ?? [])
    .filter(
      (step: any) =>
        step.action === "submit_processing" && same(step.input?.source),
    )
    .flatMap(
      (step: any) => step.input.recordIds ?? step.input.source.recordIds ?? [],
    );
  if (explicit.length) return new Set<string>(explicit);
  return;
}

/** Retain the compatible part of an old run; never expand the current fixed scope. */
export function scopeRunToTask(
  task: Record<string, any>,
  data: Awaited<ReturnType<typeof readProcessingRun>>,
) {
  const ids = currentRecordScope(task, data.run.source, data.run.id);
  const sources = [
    ...(task.executionPlan?.steps ?? []).flatMap((step: any) =>
      step.input?.source ? [step.input.source] : [],
    ),
    ...(task.target ? [task.target] : []),
  ];
  const assets = sources.flatMap((source: any) =>
    source.kind === "asset"
      ? [source.id]
      : source.kind === "assets"
        ? source.assetIds
        : [],
  );
  const wholeSourceAllowed =
    data.run.source.kind === "assets" &&
    data.run.source.assetIds.every((id: string) => assets.includes(id));
  if (!ids && !assets.length) return data;
  const records = data.records.filter((row) => {
    const id =
      row.original?.baseline?.id ?? row.original?.id ?? row.result.sourceId;
    return (
      (!ids || ids.has(id)) &&
      (!assets.length ||
        data.run.source.kind !== "assets" ||
        wholeSourceAllowed ||
        assets.includes(rowAssetId(row, data.run.source)))
    );
  });
  return {
    ...data,
    records,
    allIds: records.map((row) => row.id),
    total: records.length,
  };
}

function rowAssetId(row: any, source: Record<string, any>) {
  const original = row.original?.baseline ?? row.original;
  if (original?.source?.assetId) return original.source.assetId;
  const id = original?.id ?? row.result.sourceId;
  return id?.includes(":")
    ? id.split(":").slice(0, -1).join(":")
    : source.assetIds?.length === 1
      ? source.assetIds[0]
      : undefined;
}
