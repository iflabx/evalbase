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

export type SelectionProblem = {
  path: string;
  keyword: string;
  message: string;
};
/** Semantic configuration checks shared by all assistant adapters and the actual selector. */
export function selectionProblems(
  value: unknown,
  path = "",
): SelectionProblem[] {
  const issues: SelectionProblem[] = [];
  const add = (field: string, message: string) =>
    issues.push({ path: path + field, keyword: "selection", message });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add("", "选取规则必须是对象。");
    return issues;
  }
  const input = value as Record<string, any>;
  if (!["all", "random"].includes(input.method))
    add("/method", "请选择全部或随机选取。");
  if (!Array.isArray(input.conditions) || input.conditions.length > 20)
    add("/conditions", "筛选条件必须为数组，最多20项。");
  else
    input.conditions.forEach((c: any, i: number) => {
      const p = "/conditions/" + i;
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        add(p, "条件必须是对象。");
        return;
      }
      if (!["question", "expectedOutput", "metadata"].includes(c.field))
        add(p + "/field", "筛选字段无效。");
      if (!["contains", "equals", "empty", "filled"].includes(c.operator))
        add(p + "/operator", "筛选方式无效。");
      if (
        c.field === "metadata" &&
        (typeof c.key !== "string" || !c.key.trim())
      )
        add(p + "/key", "筛选 Metadata 必须说明具体字段名。");
      if (
        ["contains", "equals"].includes(c.operator) &&
        (typeof c.value !== "string" || !c.value.trim())
      )
        add(p + "/value", "等于或包含条件必须有非空值。");
      if (c.key !== undefined && typeof c.key !== "string")
        add(p + "/key", "字段名必须是文字。");
      if (c.value !== undefined && typeof c.value !== "string")
        add(p + "/value", "筛选值必须是文字。");
    });
  if (input.method === "all")
    for (const k of ["mode", "value"])
      if (input[k] !== undefined)
        add("/" + k, "全部选取不填写随机数量或单位。");
  if (input.method === "random") {
    if (!["count", "percent"].includes(input.mode))
      add("/mode", "随机选取须明确条数或百分比，不能猜测单位。");
    if (
      typeof input.value !== "number" ||
      !Number.isFinite(input.value) ||
      input.value <= 0 ||
      (input.mode === "count" &&
        (!Number.isInteger(input.value) || input.value > 10000)) ||
      (input.mode === "percent" && input.value > 100)
    )
      add("/value", "条数须为1至10000的整数，百分比须大于0且不超过100。");
  }
  if (
    input.seed !== undefined &&
    (typeof input.seed !== "string" || input.seed.length > 200)
  )
    add("/seed", "随机种子须为不超过200字符的文字。");
  return issues;
}
export function matchesSelection(
  record: Pick<SelectionRecord, "question" | "expectedOutput" | "metadata">,
  condition: SelectionCondition,
) {
  const text = (
    condition.field === "metadata"
      ? (record.metadata.find((e) => e.key === condition.key)?.value ?? "")
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
      return !text.length;
    case "filled":
      return !!text.length;
  }
}

export function selectRecords<T extends SelectionRecord>(
  records: T[],
  config: unknown,
) {
  const issues = selectionProblems(config);
  if (issues.length)
    throw Object.assign(new Error("selection_invalid"), { issues });
  const input = config as Record<string, any>;
  const conditions = input.conditions as SelectionCondition[];
  const ordered = [...records].sort((a, b) =>
    a.assetId < b.assetId
      ? -1
      : a.assetId > b.assetId
        ? 1
        : a.ordinal - b.ordinal,
  );
  const candidates = ordered.filter((record) =>
    conditions.every((condition) => matchesSelection(record, condition)),
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
