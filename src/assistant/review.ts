import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  previewProcessingInput,
  readProcessingRun,
} from "../processing/store.js";
import { reviewCandidates } from "../processing/review.js";
import { adoptedCandidateKeys, candidateKey } from "../processing/adoption.js";
import { canonicalJson } from "../package/contract.js";
import { planRequirementsKey } from "./plan.js";
import { requirementSummary, validateRules } from "./requirements.js";
import { AssistantError, type AssistantScope } from "./store.js";
import {
  scopeCandidateRun,
  candidateScopeForRun,
  candidateSelectionShortfalls,
} from "./candidates.js";

/** Reviews the current leaves and, for a final-total goal, the actual draft after pending adoption. */
export async function reviewTask(
  db: Database,
  artifacts: ArtifactRepository,
  scope: AssistantScope,
  task: Record<string, any>,
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  publication = false,
) {
  const runIds: string[] = task.runIds?.includes(data.run.id)
    ? task.runIds
    : [data.run.id];
  let runs = [];
  for (const runId of runIds)
    runs.push(
      scopeRunToTask(
        task,
        scopeCandidateRun(
          runId === data.run.id
            ? data
            : await readProcessingRun(
                db,
                artifacts,
                scope,
                runId,
                { offset: "0", limit: "10000" },
                true,
              ),
          candidateScopeForRun(task, runId),
        ),
      ),
    );
  runs = effectiveTaskRuns(runs);
  if (runs.reduce((count, item) => count + item.total, 0) > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
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
  const goal = task.candidateScope
    ? {
        ...task,
        targetCount: task.targetCount ?? task.candidateScope.targetCount,
      }
    : task;
  const review = reviewCandidates(
    data,
    publication && goal.targetCount === undefined
      ? { ...goal, targetCount: runs.reduce((sum, run) => sum + run.total, 0) }
      : goal,
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
      ...(publication
        ? {
            deliveryComplete:
              review.complete &&
              !compatibilityProblem &&
              final?.remainingCount === 0,
          }
        : {}),
      compatibilityProblem,
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
    finished: runs.every((item) =>
      ["succeeded", "failed", "cancelled"].includes(item.run.status),
    ),
    checkedStatus: runs.every((item) => item.run.status === "succeeded")
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
          data.rootOperation === "augment" ||
          data.run.options?.operation === "augment"
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
        if (
          canonicalJson(item.backgroundGoal.requirements ?? []) !==
            canonicalJson(requirementSummary(task)) ||
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
