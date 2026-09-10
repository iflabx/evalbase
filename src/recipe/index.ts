import { createHash } from "node:crypto";

import { canonicalJson } from "../package/contract.js";

export interface RecipeRecord {
  id: string;
  sampleKey?: string;
  ordinal: number;
  fields: unknown;
}

export type Filter =
  | {
      field: string;
      operator: "eq" | "neq" | "contains" | "range" | "is_null";
      value?: unknown;
      minimum?: unknown;
      maximum?: unknown;
    }
  | { all: Filter[] }
  | { any: Filter[] }
  | { not: Filter };

export type RecipeStep =
  | { kind: "filter"; filter: Filter }
  | { kind: "sample"; mode: "count" | "ratio"; value: number; seed: string }
  | {
      kind: "manual";
      include?: { id: string; reason?: string; actorId?: string }[];
      exclude?: { id: string; reason?: string; actorId?: string }[];
    };

export interface RecipeEvaluation {
  records: RecipeRecord[];
  steps: {
    kind: RecipeStep["kind"];
    inputCount: number;
    outputCount: number;
    excludedCount: number;
    errorCount: number;
  }[];
  exits: Record<string, { step: number; reason: string }>;
}

type FilterResult = { matched: boolean; error?: string };

function recipeInvalid(): never {
  throw new Error("recipe_invalid");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    recipeInvalid();
  return value as Record<string, unknown>;
}

function validateFilter(value: unknown): void {
  const filter = object(value);
  if ("all" in filter || "any" in filter) {
    const children = "all" in filter ? filter.all : filter.any;
    if (!Array.isArray(children) || !children.length) recipeInvalid();
    children.forEach(validateFilter);
    return;
  }
  if ("not" in filter) {
    validateFilter(filter.not);
    return;
  }
  if (typeof filter.field !== "string" || !filter.field) recipeInvalid();
  if (
    !["eq", "neq", "contains", "range", "is_null"].includes(
      String(filter.operator),
    )
  )
    recipeInvalid();
  if (filter.operator === "range") {
    if (
      numeric(filter.minimum) === undefined ||
      numeric(filter.maximum) === undefined
    )
      recipeInvalid();
  } else if (filter.operator !== "is_null" && !("value" in filter)) {
    recipeInvalid();
  }
}

export function validateRecipe(steps: unknown): asserts steps is RecipeStep[] {
  if (!Array.isArray(steps)) recipeInvalid();
  for (const value of steps) {
    const step = object(value);
    if (step.kind === "filter") {
      validateFilter(step.filter);
    } else if (step.kind === "sample") {
      if (
        !["count", "ratio"].includes(String(step.mode)) ||
        typeof step.value !== "number" ||
        !Number.isFinite(step.value) ||
        typeof step.seed !== "string" ||
        !step.seed ||
        (step.mode === "count" &&
          (!Number.isInteger(step.value) || step.value < 0)) ||
        (step.mode === "ratio" && (step.value < 0 || step.value > 1))
      )
        recipeInvalid();
    } else if (step.kind === "manual") {
      for (const decisions of [step.include, step.exclude]) {
        if (decisions === undefined) continue;
        if (!Array.isArray(decisions)) recipeInvalid();
        for (const value of decisions) {
          const decision = object(value);
          if (
            typeof decision.id !== "string" ||
            !decision.id ||
            (decision.reason !== undefined &&
              typeof decision.reason !== "string")
          )
            recipeInvalid();
        }
      }
    } else {
      recipeInvalid();
    }
  }
}

function valueAt(
  value: unknown,
  field: string,
): { found: boolean; value: unknown } {
  const parts = field.startsWith("/")
    ? field
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [field];
  let current = value;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function evaluateFilter(filter: Filter, fields: unknown): FilterResult {
  if ("all" in filter) {
    let error: string | undefined;
    let matched = true;
    for (const child of filter.all) {
      const result = evaluateFilter(child, fields);
      matched &&= result.matched;
      error ??= result.error;
    }
    return { matched, ...(error ? { error } : {}) };
  }
  if ("any" in filter) {
    const errors: string[] = [];
    for (const child of filter.any) {
      const result = evaluateFilter(child, fields);
      if (result.matched) return { matched: true };
      if (result.error) errors.push(result.error);
    }
    return { matched: false, ...(errors[0] ? { error: errors[0] } : {}) };
  }
  if ("not" in filter) {
    const result = evaluateFilter(filter.not, fields);
    return {
      matched: !result.matched,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  const source = valueAt(fields, filter.field);
  if (!source.found) return { matched: false };
  if (filter.operator === "is_null") return { matched: source.value === null };
  if (filter.operator === "eq")
    return { matched: same(source.value, filter.value) };
  if (filter.operator === "neq")
    return { matched: !same(source.value, filter.value) };
  if (filter.operator === "contains") {
    if (typeof source.value === "string" && typeof filter.value === "string")
      return { matched: source.value.includes(filter.value) };
    if (Array.isArray(source.value))
      return { matched: source.value.some((item) => same(item, filter.value)) };
    return { matched: same(source.value, filter.value) };
  }
  if (filter.operator !== "range") throw new Error("filter_operator_invalid");
  if (source.value === null) return { matched: false };
  const actual = numeric(source.value);
  const minimum = numeric(filter.minimum);
  const maximum = numeric(filter.maximum);
  if (actual === undefined || minimum === undefined || maximum === undefined)
    return { matched: false, error: "numeric_interpretation_failed" };
  return { matched: actual >= minimum && actual <= maximum };
}

export function evaluateRecipe(
  sourceRecords: RecipeRecord[],
  steps: RecipeStep[],
): RecipeEvaluation {
  validateRecipe(steps);
  let records = [...sourceRecords].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const exits: RecipeEvaluation["exits"] = {};
  const results: RecipeEvaluation["steps"] = [];
  for (const [index, step] of steps.entries()) {
    const input = records;
    let errors = 0;
    let excludedCount: number | undefined;
    if (step.kind === "filter") {
      records = input.filter((record) => {
        const result = evaluateFilter(step.filter, record.fields);
        if (!result.matched) {
          exits[record.id] = {
            step: index + 1,
            reason: result.error ?? "filter",
          };
          if (result.error) errors += 1;
        }
        return result.matched;
      });
    } else if (step.kind === "sample") {
      const count =
        step.mode === "count"
          ? step.value
          : Math.floor(input.length * step.value);
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count > input.length ||
        (step.mode === "ratio" && (step.value < 0 || step.value > 1)) ||
        !step.seed
      ) {
        throw new Error("sample_configuration_invalid");
      }
      const selected = new Set(
        [...input]
          .sort((left, right) => {
            const score = (record: RecipeRecord) =>
              createHash("sha256")
                .update(`${step.seed}:${record.sampleKey ?? record.id}`)
                .digest("hex");
            return (
              score(left).localeCompare(score(right)) ||
              left.ordinal - right.ordinal
            );
          })
          .slice(0, count)
          .map((record) => record.id),
      );
      records = input.filter((record) => selected.has(record.id));
      for (const record of input) {
        if (!selected.has(record.id))
          exits[record.id] = { step: index + 1, reason: "sample" };
      }
    } else {
      const excluded = new Set(
        step.exclude?.map((decision) => decision.id) ?? [],
      );
      const included = new Set(
        step.include?.map((decision) => decision.id) ?? [],
      );
      records = sourceRecords.filter(
        (record) =>
          (input.some((current) => current.id === record.id) ||
            included.has(record.id)) &&
          !excluded.has(record.id),
      );
      excludedCount = input.filter((record) => excluded.has(record.id)).length;
      for (const id of included) delete exits[id];
      for (const record of input) {
        if (excluded.has(record.id))
          exits[record.id] = { step: index + 1, reason: "manual_exclude" };
      }
    }
    results.push({
      kind: step.kind,
      inputCount: input.length,
      outputCount: records.length,
      excludedCount: excludedCount ?? input.length - records.length,
      errorCount: errors,
    });
  }
  return { records, steps: results, exits };
}

export function recipeSteps(recipe: unknown): RecipeStep[] {
  if (!recipe || typeof recipe !== "object") return [];
  const value = recipe as { steps?: unknown; filter?: unknown };
  if (Array.isArray(value.steps)) return value.steps as RecipeStep[];
  return value.filter
    ? [{ kind: "filter", filter: value.filter as Filter }]
    : [];
}
