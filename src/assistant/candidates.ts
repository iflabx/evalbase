import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "../package/contract.js";
import { selectRecords, type SelectionCondition } from "../selection/index.js";
import type { readProcessingRun } from "../processing/store.js";
import { AssistantError } from "./store.js";
import { candidateKey } from "../processing/adoption.js";

type Run = Awaited<ReturnType<typeof readProcessingRun>>;
export type CandidateScope = {
  scope?: "task";
  members?: CandidateScope[];
  excludedOriginKeys?: string[];
  runId: string;
  resultIds: string[];
  originKeys: string[];
  parentRunId?: string;
  hash: string;
  targetCount: number;
  sourceCount: number;
  seed: string;
  conditions?: SelectionCondition[][];
  groups: {
    label: string;
    requested: number;
    available: number;
    selected: number;
  }[];
};
// Hash the same JSON representation used by persisted/public candidate results.
const digest = (records: Run["records"]) =>
  sha256(canonicalJson(JSON.parse(JSON.stringify(records))));

/** Freeze the same current collection used by preview and adoption, retaining real run references. */
export function selectCandidateCollection(
  data: Run,
  runs: Run[],
  input: Parameters<typeof selectCandidateRun>[1],
  previous?: CandidateScope,
): CandidateScope {
  const records = runs.flatMap((run) =>
    run.records.map((row) => ({
      ...row,
      id: candidateKey(row.candidateOrigin),
    })),
  );
  const selected = selectCandidateRun(
    { ...data, records, total: records.length },
    input,
  );
  const keys = new Set(selected.originKeys);
  const members = runs.map((run) => {
    const rows = run.records.filter((row) =>
      keys.has(candidateKey(row.candidateOrigin)),
    );
    return {
      ...selected,
      runId: run.run.id,
      resultIds: rows.map((row) => row.id),
      originKeys: rows.map((row) => candidateKey(row.candidateOrigin)),
      hash: digest(rows),
    };
  });
  const excludedOriginKeys = [
    ...new Set([
      ...(previous?.excludedOriginKeys ?? []),
      ...records.filter((row) => !keys.has(row.id)).map((row) => row.id),
    ]),
  ];
  return {
    ...selected,
    scope: "task",
    members,
    excludedOriginKeys,
    hash: sha256(canonicalJson({ members, excludedOriginKeys })),
  };
}

export function candidateCollectionHashValid(scope: CandidateScope) {
  return (
    scope.hash ===
    sha256(
      canonicalJson({
        members: scope.members,
        excludedOriginKeys: scope.excludedOriginKeys,
      }),
    )
  );
}

/** Use existing deterministic selection against persisted classifications, never model-enumerated IDs. */
export function selectCandidateRun(
  data: Run,
  input: {
    seed?: string;
    selection?: unknown;
    groups?: { count: number; conditions: SelectionCondition[] }[];
  },
): CandidateScope {
  if (data.run.status !== "succeeded" || data.records.length !== data.total)
    throw new AssistantError(409, "processing_still_running");
  if (Boolean(input.selection) === Boolean(input.groups))
    throw new AssistantError(422, "selection_invalid");
  const seed = input.seed?.trim() || randomUUID();
  const rows = data.records.map((row, ordinal) => ({
    ...row.result,
    id: row.id,
    assetId: data.run.id,
    ordinal,
  }));
  const selected = new Set<string>();
  const configurations = input.groups?.map((group, index) => ({
    method: "random",
    mode: "count",
    value: group.count,
    conditions: group.conditions,
    seed: `${seed}:${index}`,
  })) ?? [input.selection];
  const groups = configurations.map((configuration) => {
    const group = selectRecords(
      rows.filter((row) => !selected.has(row.id)),
      configuration,
    );
    for (const row of group.selected) selected.add(row.id);
    return {
      label: (
        (configuration as { conditions: SelectionCondition[] }).conditions
          .map((condition) => condition.value)
          .filter(Boolean)
          .join(" · ") || "全部记录"
      ).slice(0, 120),
      requested: group.targetCount,
      available: group.candidates.length,
      selected: group.selected.length,
    };
  });
  const targetCount = groups.reduce(
    (count, group) => count + group.requested,
    0,
  );
  if (targetCount > 10000)
    throw new AssistantError(422, "processing_capacity_exceeded");
  const records = data.records.filter((row) => selected.has(row.id));
  return {
    runId: data.run.id,
    resultIds: records.map((row) => row.id),
    originKeys: records.map((row) => candidateKey(row.candidateOrigin)),
    hash: digest(records),
    targetCount,
    sourceCount: data.total,
    seed,
    conditions: configurations.map(
      (configuration) =>
        (configuration as { conditions: SelectionCondition[] }).conditions,
    ),
    groups,
  };
}

/** A refinement changes result IDs, while existing adoption identities stay fixed. */
export function carryCandidateScope(
  scope: CandidateScope | undefined,
  runId: string,
  parentRunId?: string,
): CandidateScope | null {
  if (scope?.runId === runId) return scope;
  if (!scope) return null;
  if (scope.scope === "task") return scope;
  if (scope.runId !== parentRunId) return scope;
  return {
    ...scope,
    runId,
    parentRunId,
    hash: sha256(canonicalJson({ parentHash: scope.hash, runId })),
  };
}

/** A supplement is a separate leaf; only the selected source leaf is narrowed. */
export function candidateScopeForRun(
  task: { candidateScope?: CandidateScope; runIds?: string[] } | undefined,
  runId: string,
): CandidateScope | undefined {
  const scope = task?.candidateScope;
  if (scope?.scope === "task") return;
  if (!scope || scope.runId === runId) return scope;
  if (!task?.runIds?.includes(runId))
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  return undefined;
}

/** Allocate real supplements to missing groups once, without reopening source selection. */
export function candidateSelectionShortfalls(
  scope: CandidateScope | undefined,
  runs: Run[],
) {
  if (!scope) return [];
  const supplements = runs
    .filter((run) => scope.scope === "task" || run.run.id !== scope.runId)
    .flatMap((run) =>
      run.records
        .filter(
          (row) =>
            scope.scope !== "task" ||
            !scope.originKeys.includes(candidateKey(row.candidateOrigin)),
        )
        .map((row, ordinal) => ({
          ...row.result,
          id: `${run.run.id}:${row.id}`,
          assetId: run.run.id,
          ordinal,
        })),
    );
  const assigned = new Set<string>();
  return scope.groups.flatMap((group, index) => {
    if (group.selected >= group.requested) return [];
    const conditions = scope.conditions?.[index];
    if (!conditions) return [group]; // Legacy scopes cannot infer rules from display labels.
    const eligible = selectRecords(
      supplements.filter((row) => !assigned.has(row.id)),
      { method: "all", conditions },
    ).selected;
    const additions = eligible.slice(0, group.requested - group.selected);
    additions.forEach((row) => assigned.add(row.id));
    const selected = group.selected + additions.length;
    return selected < group.requested
      ? [{ ...group, selected, available: group.available + eligible.length }]
      : [];
  });
}

/** Recheck fixed candidate identity before preview, review and adoption. */
export function scopeCandidateRun(data: Run, scope?: CandidateScope): Run {
  if (!scope) return data;
  if (scope.runId !== data.run.id)
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  if (scope.parentRunId) {
    if (data.run.parentRunId !== scope.parentRunId)
      throw new AssistantError(409, "assistant_candidate_selection_changed");
    const origins = new Set(scope.originKeys);
    const records = data.records.filter((row) =>
      origins.has(candidateKey(row.candidateOrigin)),
    );
    if (
      new Set(records.map((row) => candidateKey(row.candidateOrigin))).size !==
        records.length ||
      (data.run.status === "succeeded" && records.length !== origins.size)
    )
      throw new AssistantError(409, "assistant_candidate_selection_changed");
    return {
      ...data,
      records,
      allIds: records.map((row) => row.id),
      total: records.length,
    };
  }
  const ids = new Set(scope.resultIds);
  const records = data.records.filter((row) => ids.has(row.id));
  if (records.length !== ids.size || digest(records) !== scope.hash)
    throw new AssistantError(409, "assistant_candidate_selection_changed");
  return {
    ...data,
    records,
    allIds: records.map((row) => row.id),
    total: records.length,
  };
}
