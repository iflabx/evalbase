import { randomUUID } from "node:crypto";
import { evaluateRecipe } from "../recipe/index.js";

export interface SelectionRecord {
  assetId: string;
  ordinal: number;
  question: string;
  expectedOutput: string;
  metadata: { key: string; value: string }[];
}

export interface SelectionCondition {
  field: "question" | "expectedOutput" | "metadata";
  key?: string;
  operator: "contains" | "equals" | "empty" | "filled";
  value?: string;
}

export const SELECTION_ALGORITHM = "sha256-rank-v1";

export function sourceIdentity(
  record: Pick<SelectionRecord, "assetId" | "ordinal">,
): string {
  return JSON.stringify([record.assetId, record.ordinal]);
}

function invalid(): never {
  throw new Error("selection_invalid");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function conditionsFrom(value: unknown): SelectionCondition[] {
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map((item) => {
    const condition = object(item);
    if (
      typeof condition.field !== "string" ||
      typeof condition.operator !== "string" ||
      (condition.value !== undefined && typeof condition.value !== "string") ||
      (condition.key !== undefined && typeof condition.key !== "string") ||
      !["question", "expectedOutput", "metadata"].includes(
        String(condition.field),
      ) ||
      !["contains", "equals", "empty", "filled"].includes(
        String(condition.operator),
      ) ||
      (condition.field === "metadata" &&
        (typeof condition.key !== "string" || !condition.key.trim())) ||
      (["contains", "equals"].includes(String(condition.operator)) &&
        (typeof condition.value !== "string" || !condition.value.trim()))
    )
      invalid();
    return condition as unknown as SelectionCondition;
  });
}

export function selectRecords<T extends SelectionRecord>(
  records: T[],
  config: unknown,
) {
  const input = object(config);
  const conditions = conditionsFrom(input.conditions);
  if (
    typeof input.method !== "string" ||
    !["all", "random"].includes(input.method)
  )
    invalid();
  if (
    input.method === "random" &&
    (typeof input.mode !== "string" ||
      !["count", "percent"].includes(input.mode) ||
      typeof input.value !== "number" ||
      !Number.isFinite(input.value) ||
      input.value <= 0 ||
      (input.mode === "count" &&
        (!Number.isInteger(input.value) || input.value > 10000)) ||
      (input.mode === "percent" && input.value > 100) ||
      (input.seed !== undefined &&
        (typeof input.seed !== "string" || input.seed.length > 200)))
  )
    invalid();
  const ordered = [...records].sort((a, b) =>
    a.assetId < b.assetId
      ? -1
      : a.assetId > b.assetId
        ? 1
        : a.ordinal - b.ordinal,
  );
  const candidates = ordered.filter((record) =>
    conditions.every((condition) => {
      const text = (
        condition.field === "metadata"
          ? (record.metadata.find((entry) => entry.key === condition.key)
              ?.value ?? "")
          : record[condition.field]
      )
        .trim()
        .toLowerCase();
      const value = condition.value?.trim().toLowerCase() ?? "";
      switch (condition.operator) {
        case "contains":
          return text.includes(value);
        case "equals":
          return text === value;
        case "empty":
          return text.length === 0;
        case "filled":
          return text.length > 0;
      }
    }),
  );
  const seed =
    input.method === "random"
      ? String(input.seed ?? "").trim() || randomUUID()
      : null;
  const targetCount =
    input.method === "all"
      ? candidates.length
      : input.mode === "percent"
        ? Math.floor((candidates.length * Number(input.value)) / 100)
        : Number(input.value);
  const selectedIds = seed
    ? new Set(
        evaluateRecipe(
          candidates.map((record, index) => ({
            id: sourceIdentity(record),
            ordinal: index,
            fields: null,
          })),
          [
            {
              kind: "sample",
              mode: "count",
              value: Math.min(targetCount, candidates.length),
              seed,
            },
          ],
        ).records.map(({ id }) => id),
      )
    : null;
  return {
    candidates,
    selected: selectedIds
      ? candidates.filter((record) => selectedIds.has(sourceIdentity(record)))
      : candidates,
    seed,
    targetCount,
    algorithm: SELECTION_ALGORITHM,
  };
}
