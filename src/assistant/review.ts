import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  previewProcessingInput,
  readProcessingRun,
} from "../processing/store.js";
import { reviewCandidates } from "../processing/review.js";
import { adoptedCandidateKeys } from "../processing/adoption.js";
import { canonicalJson } from "../package/contract.js";
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
) {
  const runIds: string[] = task.runIds?.includes(data.run.id)
    ? task.runIds
    : [data.run.id];
  const runs = [];
  for (const runId of runIds)
    runs.push(
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
    );
  if (runs.reduce((count, item) => count + item.total, 0) > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  let final;
  if (task.countKind === "final" && task.targetDraftId) {
    const base = await previewProcessingInput(
      db,
      scope,
      { source: { kind: "draft", id: task.targetDraftId }, limit: 10000 },
      "write",
      true,
    );
    const adopted = await adoptedCandidateKeys(
      db,
      artifacts,
      scope,
      runs,
      task.targetDraftId,
    );
    const baseIds = new Set(base.allIds);
    const replacing = new Set<string>();
    const pending = [];
    for (const run of runs)
      for (const row of run.records) {
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
    const records = [
      ...base.records.filter((row) => !replacing.has(row.id)),
      ...pending,
    ];
    if (records.length > 10000)
      throw new AssistantError(422, "processing_capacity_exceeded");
    final = {
      records,
      baseCount: base.total,
      remainingCount: pending.length,
      revision,
    };
  }
  const review = reviewCandidates(
    data,
    task.candidateScope
      ? {
          ...task,
          targetCount: task.targetCount ?? task.candidateScope.targetCount,
        }
      : task,
    runs,
    final,
    Boolean(task.candidateScope),
  );
  const selectionShortfalls = candidateSelectionShortfalls(
    task.candidateScope,
    runs,
  );
  const compatibilityProblem = taskCompatibilityProblem(task, runs);
  return {
    runIds,
    runs,
    review: {
      ...review,
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

/** Partial adoption relaxes totals, never the current source or plan revision. */
export function taskCompatibilityProblem(
  task: Record<string, any>,
  runs: Pick<Awaited<ReturnType<typeof readProcessingRun>>, "run">[],
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
          const actual = identity(item.run.source);
          const allowed = identity(source);
          return actual.kind === "assets" && allowed.kind === "assets"
            ? actual.assetIds!.every((id: string) =>
                allowed.assetIds!.includes(id),
              )
            : canonicalJson(actual) === canonicalJson(allowed);
        }),
    );
  return task.executionPlan?.needsReview
    ? "要求已变化，请先核对步骤和已有成果。"
    : sourceMismatch
      ? "已有成果的来源与当前任务对象不同，不能按当前要求采用。"
      : null;
}
