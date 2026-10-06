import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "../package/contract.js";
import { selectRecords, type SelectionCondition } from "../selection/index.js";
import type { readProcessingRun } from "../processing/store.js";
import { AssistantError } from "./store.js";
import { candidateKey } from "../processing/adoption.js";

type Run = Awaited<ReturnType<typeof readProcessingRun>>;
export type CandidateScope = {
  runId: string;
  resultIds: string[];
  originKeys: string[];
  parentRunId?: string;
  hash: string;
  targetCount: number;
  sourceCount: number;
  seed: string;
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
  if (!scope || scope.runId !== parentRunId) return null;
  return {
    ...scope,
    runId,
    parentRunId,
    hash: sha256(canonicalJson({ parentHash: scope.hash, runId })),
  };
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
