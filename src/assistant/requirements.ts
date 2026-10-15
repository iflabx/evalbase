import type { CandidateGoal } from "../processing/review.js";
import type {
  ProcessingInput,
  ProcessingOptions,
} from "../processing/protocol.js";
import { processingOptions } from "../processing/protocol.js";

type Rule = NonNullable<CandidateGoal["classifications"]>[number];
type RuleUpdate = Rule & { clear?: boolean };
type Requirements = CandidateGoal & {
  overallTargetCount?: number | null;
  requirements?: string[];
  allowedFields?: string[];
  metadataKeys?: string[] | null;
};

/** Exact independent constraints, never semantic paraphrase equivalence. */
export const normalizedRequirements = (values: string[] = []) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

export class RequirementError extends Error {
  readonly status = 422;
  constructor(
    public code: string,
    public hint: string,
  ) {
    super(code);
  }
}

const fieldId = (rule: Rule) =>
  rule.field === "expectedOutput"
    ? "expectedOutput"
    : `metadata:${rule.key?.trim().toLowerCase()}`;
export const fieldName = (rule: Rule) =>
  rule.field === "expectedOutput" ? "期望输出" : `Metadata「${rule.key}」`;
const normalizedKeys = (keys: string[]) => {
  if (keys.some((key) => !key.trim()))
    throw new RequirementError(
      "assistant_requirement_conflict",
      "Metadata 字段名不能为空",
    );
  const unique = new Map<string, string>();
  for (const key of keys) {
    const trimmed = key.trim();
    if (!unique.has(trimmed.toLowerCase()))
      unique.set(trimmed.toLowerCase(), trimmed);
  }
  return [...unique.values()];
};

/** Legacy labels retain their original field meaning; no stored task or recipe is rewritten. */
export function effectiveRules(goal: CandidateGoal): Rule[] {
  return [
    ...(goal.classifications ?? []),
    ...(goal.allowedLabels?.length
      ? [
          {
            field: "expectedOutput" as const,
            allowedValues: goal.allowedLabels,
          },
        ]
      : []),
  ];
}

/** One effective rule per field; repeated constraints intersect, never silently relax. */
export function validateRules(goal: CandidateGoal): Rule[] {
  const fields = new Map<string, Rule>();
  for (const rule of effectiveRules(goal)) {
    const name = fieldName(rule);
    if (rule.field === "metadata" && !rule.key?.trim())
      throw new RequirementError(
        "assistant_requirement_conflict",
        "Metadata 分类缺少字段名",
      );
    const prior = fields.get(fieldId(rule));
    const values = rule.allowedValues?.length
      ? [...new Set(rule.allowedValues)]
      : undefined;
    const allowedValues =
      prior?.allowedValues && values
        ? prior.allowedValues.filter((value) => values.includes(value))
        : (prior?.allowedValues ?? values);
    if (allowedValues && !allowedValues.length)
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${name} 的允许值没有交集`,
      );
    const quotas = new Map(
      (prior?.quotas ?? []).map((q) => [q.value, q.count]),
    );
    for (const q of rule.quotas ?? []) {
      if (quotas.has(q.value) && quotas.get(q.value) !== q.count)
        throw new RequirementError(
          "assistant_plan_count_conflict",
          `${name}「${q.value}」的配额同时为 ${quotas.get(q.value)} 和 ${q.count} 条`,
        );
      quotas.set(q.value, q.count);
    }
    const requiredValues = [
      ...new Set([
        ...(prior?.requiredValues ?? []),
        ...(rule.requiredValues ?? []),
      ]),
    ];
    if (
      allowedValues &&
      (requiredValues.some((v) => !allowedValues.includes(v)) ||
        [...quotas].some(([v, n]) => n > 0 && !allowedValues.includes(v)))
    )
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${name} 的必需类别或非零配额不在允许值中`,
      );
    if (requiredValues.some((v) => quotas.get(v) === 0))
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${name} 的必需类别被分配为 0 条`,
      );
    fields.set(fieldId(rule), {
      field: rule.field,
      ...(rule.basis ? { basis: rule.basis } : {}),
      ...(rule.definitions ? { definitions: rule.definitions } : {}),
      ...(rule.field === "metadata" ? { key: rule.key!.trim() } : {}),
      ...(allowedValues ? { allowedValues } : {}),
      ...(requiredValues.length ? { requiredValues } : {}),
      ...(quotas.size
        ? { quotas: [...quotas].map(([value, count]) => ({ value, count })) }
        : {}),
    });
  }
  for (const rule of fields.values()) {
    const total = (rule.quotas ?? []).reduce((sum, q) => sum + q.count, 0);
    const complete = rule.allowedValues?.every((v) =>
      rule.quotas?.some((q) => q.value === v),
    );
    if (
      goal.targetCount != null &&
      (total > goal.targetCount || (complete && total !== goal.targetCount))
    ) {
      const adjustment = rule.quotas?.findLast(
        (q) =>
          (!rule.allowedValues || rule.allowedValues.includes(q.value)) &&
          q.count + goal.targetCount! - total > 0 &&
          q.count + goal.targetCount! - total <= 10000,
      );
      const example = adjustment
        ? `。仅当配额由你自行拟定且用户未固定该类别时，纠正示例：将${JSON.stringify(adjustment.value)}从${adjustment.count}改为${adjustment.count + goal.targetCount - total}条，其余配额不变，合计${goal.targetCount}条；示例不自动变更方案，须重新提交该字段规则`
        : "";
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${fieldName(rule)}：当前目标${goal.targetCount}条，配额合计${total}条，${total < goal.targetCount ? "还差" : "超出"}${Math.abs(goal.targetCount - total)}条${example}`,
      );
    }
    if (
      goal.targetCount != null &&
      (rule.requiredValues?.length ?? 0) > goal.targetCount
    )
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${fieldName(rule)} 要求覆盖${rule.requiredValues!.length}类，目标仅${goal.targetCount}条`,
      );
    const unassignedRequired = (rule.requiredValues ?? []).filter(
      (value) => !rule.quotas?.some((quota) => quota.value === value),
    ).length;
    if (
      goal.targetCount != null &&
      total + unassignedRequired > goal.targetCount
    )
      throw new RequirementError(
        "assistant_plan_count_conflict",
        `${fieldName(rule)}：已固定配额${total}条，另有${unassignedRequired}类至少各需1条，超过目标${goal.targetCount}条`,
      );
  }
  if (fields.size > 5)
    throw new RequirementError(
      "assistant_requirement_conflict",
      "当前最多设置5个字段规则，请先撤销不再需要的规则",
    );
  return [...fields.values()];
}

/** Omission preserves a field; an explicit field update replaces it; clear revokes it. */
export function reviseRequirements(
  current: Requirements,
  input: Omit<Requirements, "classifications"> & {
    classifications?: RuleUpdate[];
  },
) {
  let rules = effectiveRules(current);
  if (input.classifications !== undefined) {
    const updates = input.classifications;
    if (
      updates.some(
        (u) =>
          u.clear &&
          (u.allowedValues?.length ||
            u.requiredValues?.length ||
            u.quotas?.length ||
            updates.some(
              (other) => other !== u && fieldId(other) === fieldId(u),
            )),
      )
    )
      throw new RequirementError(
        "assistant_requirement_conflict",
        "同一字段不能同时撤销和设置规则，请选择其中一种操作",
      );
    rules = updates.length
      ? [
          ...rules.filter(
            (r) => !updates.some((u) => fieldId(u) === fieldId(r)),
          ),
          ...updates
            .filter((u) => !u.clear)
            .map(({ clear: _clear, ...r }) => r),
        ]
      : [];
  }
  if (input.allowedLabels !== undefined) {
    if (
      input.allowedLabels.length &&
      input.classifications?.some(
        (rule) => rule.field === "expectedOutput" && rule.clear,
      )
    )
      throw new RequirementError(
        "assistant_requirement_conflict",
        "期望输出规则不能同时撤销和设置旧标签限制",
      );
    // Compatibility for persisted tool intents, excluded from the new model schema.
    if (!input.classifications?.some((r) => r.field === "expectedOutput"))
      rules = rules.map((r) =>
        r.field === "expectedOutput"
          ? (({ allowedValues: _values, ...rest }) => rest)(r)
          : r,
      );
    if (input.allowedLabels.length)
      rules.push({
        field: "expectedOutput",
        allowedValues: input.allowedLabels,
      });
  }
  const merged = {
    ...current,
    ...input,
    allowedLabels: [],
    classifications: rules,
  };
  if (
    merged.overallTargetCount != null &&
    merged.targetCount != null &&
    merged.overallTargetCount < merged.targetCount
  )
    throw new RequirementError(
      "assistant_requirement_conflict",
      "整体交付目标不能小于当前目标。请分别核对全部测试集与当前测试集的条数。",
    );
  return {
    ...input,
    requirements: [
      ...new Set(
        (input.requirements ?? current.requirements ?? [])
          .map((r) => r.trim())
          .filter(Boolean),
      ),
    ],
    targetCount: merged.targetCount,
    ...(merged.metadataKeys == null
      ? {}
      : { metadataKeys: normalizedKeys(merged.metadataKeys) }),
    allowedLabels: [],
    classifications: validateRules(merged),
  };
}

/** Runs inside the fenced transaction, before storing an input or creating a job. */
export function validateProcessingRequirements(
  task: Requirements,
  options: ProcessingOptions,
  records: ProcessingInput[],
  retained: ProcessingInput[] = [],
  finalScopeKnown = false,
) {
  const rules = validateRules(task);
  const names: Record<string, string> = {
    question: "问题",
    expectedOutput: "期望输出",
    metadata: "Metadata",
  };
  const forbidden = options.allowedFields.filter(
    (field) => task.allowedFields && !task.allowedFields.includes(field),
  );
  if (forbidden.length)
    throw new RequirementError(
      "assistant_requirement_conflict",
      `当前要求保护${forbidden.map((f) => names[f]).join("、")}，本次处理却允许修改；请纠正处理字段或澄清要求`,
    );
  if (task.metadataKeys && options.allowedFields.includes("metadata")) {
    const keys = new Set(
      task.metadataKeys.map((key) => key.trim().toLowerCase()),
    );
    if (options.metadataKeys?.some((key) => !keys.has(key.toLowerCase())))
      throw new RequirementError(
        "assistant_requirement_conflict",
        "本次处理包含受保护的 Metadata 字段，请仅使用当前允许的字段",
      );
    // Omitted tool keys inherit the current restriction; omission never broadens it.
    if (!options.metadataKeys) {
      if (!task.metadataKeys.length)
        throw new RequirementError(
          "assistant_requirement_conflict",
          "当前要求不允许修改任何 Metadata 字段",
        );
      options.metadataKeys = processingOptions({
        ...options,
        metadataKeys: normalizedKeys(task.metadataKeys),
      }).metadataKeys;
    }
  }
  const protectedRules = rules.filter((rule) => {
    const editable =
      options.allowedFields.includes(rule.field) &&
      (rule.field !== "metadata" ||
        !options.metadataKeys ||
        options.metadataKeys.some(
          (key) => key.toLowerCase() === rule.key!.toLowerCase(),
        ));
    return !editable;
  });
  if (records.some((row) => row.raw !== undefined)) return;
  const valueOf = (row: ProcessingInput, rule: Rule) =>
    rule.field === "expectedOutput"
      ? row.expectedOutput
      : row.metadata.find(
          (entry) => entry.key.toLowerCase() === rule.key!.toLowerCase(),
        )?.value;
  // An augmented row copies every protected field from the SAME reference row.
  const anchors = records.filter((row) =>
    protectedRules.every(
      (rule) =>
        !rule.allowedValues?.length ||
        rule.allowedValues.includes(valueOf(row, rule) ?? ""),
    ),
  );
  const outputCount =
    options.operation === "augment" ? options.outputCount! : records.length;
  const complete =
    task.targetCount != null &&
    (task.countKind !== "final" || finalScopeKnown) &&
    retained.length + outputCount === task.targetCount;
  for (const rule of protectedRules) {
    const values = anchors.map((row) => valueOf(row, rule));
    if (
      options.operation === "augment"
        ? !anchors.length
        : anchors.length !== records.length
    )
      throw new RequirementError(
        "assistant_requirement_conflict",
        `${fieldName(rule)}受保护，来源值无法满足当前类别要求；请保留来源值、选择合适来源或明确允许修改该字段`,
      );
    // Coverage/quotas belong to the whole goal, not to one intermediate batch.
    if (!complete) continue;
    const fixed = (
      options.operation === "augment" ? retained : [...retained, ...records]
    ).map((row) => valueOf(row, rule));
    const count = (value: string) => fixed.filter((v) => v === value).length;
    const available = (value: string) =>
      options.operation === "augment" && values.includes(value);
    const quotas = rule.quotas ?? [];
    const needed =
      quotas.reduce(
        (n, quota) => n + Math.max(0, quota.count - count(quota.value)),
        0,
      ) +
      (rule.requiredValues ?? []).filter(
        (value) =>
          !count(value) &&
          !quotas.some((quota) => quota.value === value && quota.count > 0),
      ).length;
    if (
      (rule.allowedValues?.length &&
        fixed.some((value) => !rule.allowedValues!.includes(value ?? ""))) ||
      (rule.requiredValues ?? []).some(
        (value) => !count(value) && !available(value),
      ) ||
      quotas.some(
        (quota) =>
          count(quota.value) > quota.count ||
          (count(quota.value) < quota.count && !available(quota.value)),
      ) ||
      (options.operation === "augment" && needed > outputCount) ||
      (options.operation === "augment" &&
        values.every((value) =>
          quotas.some((quota) => quota.value === value),
        ) &&
        quotas.reduce(
          (n, quota) => n + Math.max(0, quota.count - count(quota.value)),
          0,
        ) < outputCount)
    )
      throw new RequirementError(
        "assistant_requirement_conflict",
        `${fieldName(rule)}受保护，固定结果无法满足当前覆盖或配额要求（${quotas.map((quota) => `${quota.value}要求${quota.count}条，已固定${count(quota.value)}条`).join("；")}；须覆盖${rule.requiredValues?.join("、") ?? "已指定类别"}，已固定${fixed.length}条${options.operation === "augment" ? `，还需至少${needed}条，本次仅新增${outputCount}条` : ""}）；请调整来源、配额或明确允许修改该字段`,
      );
  }
}

/** Numbers and field restrictions shown to the user are derived from the execution state. */
export function requirementSummary(
  task: Requirements,
  processing?: { options: ProcessingOptions; input_count: number },
): string[] {
  const names: Record<string, string> = {
    question: "问题",
    expectedOutput: "期望输出",
    metadata: "Metadata",
  };
  let rules: Rule[];
  try {
    rules = validateRules(task);
  } catch (error) {
    if (!(error instanceof RequirementError)) throw error;
    rules = effectiveRules(task);
  }
  return [
    ...(task.overallTargetCount != null
      ? [`整体交付：${task.overallTargetCount} 条（当前测试集单独核对）`]
      : []),
    ...(task.targetCount == null
      ? []
      : [
          `${task.countKind === "final" ? "最终总数" : "新增候选"}：${task.targetCount} 条`,
        ]),
    ...(task.allowedFields
      ? [
          `允许修改：${task.allowedFields.length ? task.allowedFields.map((f) => names[f]).join("、") : "不修改任何字段"}`,
        ]
      : []),
    ...(task.metadataKeys?.length
      ? [`可修改的 Metadata 字段：${task.metadataKeys.join("、")}`]
      : []),
    ...rules.flatMap((r) => [
      ...(r.allowedValues?.length
        ? [`${fieldName(r)}：允许 ${r.allowedValues.join("、")}`]
        : []),
      ...(r.requiredValues?.length
        ? [`${fieldName(r)}：须覆盖 ${r.requiredValues.join("、")}`]
        : []),
      ...(r.quotas?.length
        ? [
            `${fieldName(r)}：${r.quotas.map((q) => `${q.value} ${q.count} 条`).join("、")}；合计 ${r.quotas.reduce((n, q) => n + q.count, 0)} 条`,
          ]
        : []),
    ]),
    ...(task.requirements ?? []),
    ...(processing && task.targetCount == null
      ? [
          `本次${processing.options.operation === "augment" ? "新增候选" : "处理记录"}：${processing.options.outputCount ?? processing.input_count} 条`,
        ]
      : []),
    ...(processing && !task.allowedFields
      ? [
          `本次允许修改：${processing.options.allowedFields.map((field) => names[field]).join("、")}`,
        ]
      : []),
    ...(processing?.options.metadataKeys && task.metadataKeys == null
      ? [
          `本次可修改的 Metadata 字段：${processing.options.metadataKeys.join("、")}`,
        ]
      : []),
    ...(processing?.options.instructions && !task.requirements?.length
      ? [processing.options.instructions]
      : []),
  ];
}
