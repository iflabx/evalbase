import type { CandidateGoal } from "../processing/review.js";
import type { ProcessingOptions } from "../processing/protocol.js";

type Rule = NonNullable<CandidateGoal["classifications"]>[number];
type RuleUpdate = Rule & { clear?: boolean };
type Requirements = CandidateGoal & {
  overallTargetCount?: number | null;
  requirements?: string[];
  allowedFields?: string[];
  metadataKeys?: string[] | null;
  executionPlan?: { contractVersion?: number; steps: any[] };
};

import {
  RequirementError,
  normalizedRequirements,
  fieldName,
  fieldId,
  normalizedKeys,
  effectiveRules,
  validateRules,
} from "../processing/requirements.js";
export {
  RequirementError,
  normalizedRequirements,
  fieldName,
  effectiveRules,
  validateRules,
  validateProcessingRequirements,
} from "../processing/requirements.js";

/** Only standalone, affirmative goal clauses; per-row counts and input scopes are not goals. */
export function explicitRequirementCount(
  text: string,
  countKind?: "new" | "final",
) {
  if (
    /(?:解释|说明含义|举例|例如|比如|引用)/u.test(text) ||
    /(?:不要|不得|别|不再|禁止)[^，,；;。\n]*\d+\s*条/u.test(text)
  )
    return undefined;
  const goals = text.split(/[：:，,；;。\n]/u).flatMap((part) => {
    const match = part
      .trim()
      .match(
        /^(?:请)?(最终总数|(?:当前)?(?:目标数量|数量))\s*(?:再)?(?:改为|改成|调整为|为|是)?\s*([1-9]\d*)\s*条$/u,
      );
    if (!match || Number(match[2]) > 10000) return [];
    return [
      {
        targetCount: Number(match[2]),
        countKind: match[1] === "最终总数" ? ("final" as const) : countKind,
      },
    ];
  });
  return goals.length === 1 ? goals[0] : undefined;
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
  const knownCounts = new Set([current.targetCount, merged.targetCount]);
  const processingCount =
    /^(?:本次|当前)?处理\s*([1-9]\d*)\s*条(?:记录|数据)?[。.]?$/u;
  if (
    merged.countKind !== "final" &&
    input.targetCount !== undefined &&
    input.requirements === undefined &&
    current.requirements?.some((r) => processingCount.test(r.trim()))
  )
    throw new RequirementError(
      "assistant_requirement_conflict",
      "现有要求包含处理条数，不能仅凭目标数量认定它是旧目标或真实输入范围。请结合用户原要求完整提交requirements：旧目标数量句删除；真实输入范围保留并明确为输入范围。其余语义要求不变，不让用户填写工具参数。",
    );
  return {
    ...input,
    requirements: [
      ...new Set(
        (input.requirements ?? current.requirements ?? [])
          .map((r) => r.trim())
          .filter(Boolean)
          .filter((r) => {
            // A scalar goal is shown from execution facts; input scope is not a goal.
            if (
              merged.countKind === "final" &&
              merged.targetCount != null &&
              /^最终总数\s*(?:为|是|：|:)?\s*[1-9]\d*\s*条[。.]?$/u.test(r)
            )
              return false;
            if (
              /^(?:本次|当前)?目标(?:数量|条数)?\s*(?:为|是|：|:)?\s*[1-9]\d*\s*条[。.]?$/u.test(
                r,
              )
            )
              return merged.targetCount == null;
            const count = r.match(
              /^(?:(?:本次|当前)?(?:做|生成|新增|设计|创建|扩写|扩充))\s*([1-9]\d*)\s*条(?:记录|数据|测试题|题目|问题|候选)?[。.]?$/u,
            );
            return (
              !count ||
              merged.countKind === "final" ||
              !knownCounts.has(Number(count[1]))
            );
          }),
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

type OutputForm = "labels" | "per-item";

/** Recognize explicit field declarations, never category headings or model summaries. */
export function expectedOutputForm(
  text: string,
  document = false,
): OutputForm | undefined {
  let form: OutputForm | undefined;
  for (const clause of text.normalize("NFKC").split(/[。；;，,\n]/u)) {
    const field = clause.match(/(?:期望输出|expectedOutput)(.*)/iu)?.[1];
    if (document && field === undefined) continue;
    if (field === undefined && /metadata|问题/iu.test(clause)) continue;
    if (
      field === undefined &&
      !/(?:固定(?:值|标签|输出)|枚举|原样填写)/u.test(clause)
    )
      continue;
    const declaration = field ?? clause;
    if (
      /(?:不设|不使用|不要|不得|不再).{0,6}(?:固定标签|枚举|固定值|标签)/u.test(
        declaration,
      )
    )
      form = "per-item";
    else if (
      /(?:固定(?:值|标签|输出|为)|枚举|标签|原样填写|(?:对应|所属).{0,6}(?:意图|类别|分类)(?:名称)?|(?:意图|类别|分类)名称)/u.test(
        declaration,
      )
    )
      form = "labels";
    else if (
      field !== undefined &&
      /自然语言|逐题|具体.{0,8}(?:行为|应答)|安全行为|期望行为|应答行为/u.test(
        declaration,
      )
    )
      form = "per-item";
  }
  return form;
}

/** New delivery planning sends changes; omission and internal repair never erase other semantics. */
export function reviseDeliveryRequirements(
  current: Requirements,
  input: Record<string, any>,
  userText: string,
  replaceSemantics = false,
) {
  const affirmative = (text: string) =>
    /(?:取消|撤销|删除|去掉|不再|改为|改成|调整|允许|可以|可修改)/u.test(
      text,
    ) &&
    !/(?:不要|不得|别|禁止|不允许|不能).{0,8}(?:取消|撤销|删除|去掉|允许|修改)/u.test(
      text,
    );
  const touches = (old: string) =>
    userText.split(/[。；;，,\n]/u).some((part) => {
      if (!affirmative(part)) return false;
      const cancelled = part
        .match(
          /(?:取消|撤销|删除|去掉|不再要求)\s*[“"「]?(.+?)(?:[”"」]?(?:的)?(?:要求|约束|限制)|$)/u,
        )?.[1]
        ?.trim();
      return (
        part.includes(old) ||
        (cancelled && cancelled.length >= 2 && old.includes(cancelled)) ||
        (/期望输出/iu.test(old) &&
          /期望输出.{0,12}(?:改为|改成)/u.test(part) &&
          expectedOutputForm(old, true) !== undefined)
      );
    });
  const removed = input.removeRequirements ?? [];
  if (
    removed.some(
      (value: string) =>
        !current.requirements?.includes(value) || !touches(value),
    )
  )
    throw new RequirementError(
      "assistant_requirement_conflict",
      "本轮未明确撤销这些要求，未变更的语义要求保持。",
    );
  const fields = {
    question: "问题",
    expectedOutput: "期望输出",
    metadata: "Metadata",
  };
  for (const field of input.allowedFields ?? [])
    if (
      current.allowedFields &&
      !current.allowedFields.includes(field) &&
      !userText
        .split(/[。；;，,\n]/u)
        .some(
          (part) =>
            affirmative(part) &&
            part
              .toLowerCase()
              .includes(fields[field as keyof typeof fields].toLowerCase()),
        )
    )
      throw new RequirementError(
        "assistant_requirement_conflict",
        "本轮未明确放开受保护字段，原字段保护保持。",
      );
  if (
    current.metadataKeys &&
    Object.hasOwn(input, "metadataKeys") &&
    (input.metadataKeys === null ||
      input.metadataKeys.some(
        (key: string) => !current.metadataKeys!.includes(key),
      ))
  )
    if (!affirmative(userText) || !/metadata|元数据/iu.test(userText))
      throw new RequirementError(
        "assistant_requirement_conflict",
        "本轮未明确扩大 Metadata 字段范围，原保护保持。",
      );
  return {
    requirements: normalizedRequirements(
      replaceSemantics && input.requirements !== undefined
        ? input.requirements
        : [
            ...(current.requirements ?? []).filter(
              (value) => !removed.includes(value),
            ),
            ...(input.requirements ?? []),
          ],
    ),
  };
}

/** Runs inside the fenced transaction, before storing an input or creating a job. */
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
    ...(task.executionPlan?.contractVersion === 1
      ? task.executionPlan.steps
          .filter((step: any) => step.action === "generate_candidates")
          .map(
            (step: any) =>
              `交付「${step.input.name}」：${step.countKind === "final" ? "最终总数" : "新增"} ${step.input.outputCount} 条`,
          )
      : []),
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

export function requestedSceneCount(request: string) {
  const matches = [
    ...request.matchAll(
      /(?:只|仅)(?:使用|用|保留|要)?\s*([1-9]\d?|一|二|两)\s*(?:个|种)?(?:场景|情境)/gu,
    ),
  ];
  const positive = matches.filter(
    (m) =>
      !/(?:不|别|不要|不能|禁止|并非|不是).{0,2}$/u.test(
        request.slice(Math.max(0, (m.index ?? 0) - 8), m.index),
      ),
  );
  const counts = [
    ...new Set(
      positive.map((m) => ({ 一: 1, 二: 2, 两: 2 })[m[1]] ?? Number(m[1])),
    ),
  ];
  return counts.length === 1 && counts[0] <= 20 ? counts[0] : undefined;
}

/** One policy for advertised plans, business validation and contextual correction. */
export function minimumPlanScenes(request: string, prior?: readonly string[]) {
  return (
    requestedSceneCount(request) ?? (prior ? Math.min(3, prior.length) : 3)
  );
}
