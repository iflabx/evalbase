import { amendmentTargets } from "./plan-preparation.js";
import { requestedSceneCount } from "./requirements.js";
import { canonicalJson } from "../package/contract.js";
import {
  deliveryGoals,
  deliveryAdditionClause,
  type DeliveryGoal,
} from "./delivery-plan.js";

/** Only exact, complete factual restatements can be acknowledged without a write. */
export function satisfiedPlanRequest(goals: DeliveryGoal[], request: string) {
  if (!goals.length || goals.some((goal) => goal.question)) return undefined;
  const text = request.trim().replace(/[“”「」"'‘’]/gu, "");
  const categories = text.match(
    /^(?:请)?(?:类别名|分类名|类别名称|分类名称)(?:请)?(?:就|仍然|还是)?(?:用|使用|保持为)([^，,。；;\n]+)(?:[，,]\s*(?:不要|别)用([^。；;\n]+))?[。！!]?$/u,
  );
  if (categories) {
    const values = categories[1]
      .split(/以及|和|与|、/u)
      .map((value) => value.trim());
    const rules = goals.flatMap((goal) => goal.classifications);
    const fields = new Set(
      rules.map((rule) => rule.field + ":" + (rule.key ?? "")),
    );
    const actual = [
      ...new Set(rules.flatMap((rule) => rule.allowedValues ?? [])),
    ];
    if (categories[2] && actual.some((value) => categories[2].includes(value)))
      return undefined;
    if (
      fields.size === 1 &&
      values.every(Boolean) &&
      canonicalJson([...new Set(values)].sort()) ===
        canonicalJson(actual.sort())
    )
      return { field: "classifications", values };
  }
  if (goals.length !== 1) return undefined;
  const name = text.match(
    /^(?:请)?(?:名称|名字|测试集名)(?:请)?(?:就|还是)?(?:用|叫|保持为)([^，,。；;\n]+)[。！!]?$/u,
  );
  if (name?.[1].trim() === goals[0].name)
    return { field: "name", value: goals[0].name };
  const count = text.match(
    /^(?:请)?(?:数量|条数)(?:请)?(?:就|还是)?(?:用|保持为)\s*([1-9]\d*)\s*条[。！!]?$/u,
  );
  if (count && Number(count[1]) === goals[0].count)
    return { field: "count", value: goals[0].count };
  return undefined;
}

/** One projection supplies the amendment schema and its corresponding request facts. */
export function preparePlanAmendment(
  task: Record<string, any>,
  properties: Record<string, any>,
  request: string,
  revision: number,
  truncated = false,
):
  | {
      operation: "amend_plan" | "edit_current_candidates" | "save_candidates";
      needsBackground: boolean;
      properties: Record<string, any>;
      facts: Record<string, any>;
    }
  | undefined {
  const goals = deliveryGoals(task.executionPlan);
  if (task.executionPlan?.contractVersion !== 1 || !goals.length)
    return undefined;
  const answeringSave =
    task.planningClarification?.missingFact === "save_target" &&
    Boolean(task.planningClarification?.answer);
  if (answeringSave)
    request += "\n保存去向补充：" + task.planningClarification.answer;
  const clauses = request
    .split(/[，,。；;\n]/u)
    .filter(
      (clause) =>
        !/(?:不要|不得|禁止|不能|先不|暂不|不想|不|别)(?:再)?(?:保存|另存|存成|采用|加入)/u.test(
          clause,
        ),
    );
  const contentChange = clauses.some(
    (clause) =>
      /改写|重写|清洗|去重|(?:问法|说法|表达|语气).*(?:改|换)|(?:改|换).*(?:问法|说法|表达|语气)/u.test(
        clause,
      ) && !/(?:不要|不得|不|别).*(?:改写|重写|清洗|去重)/u.test(clause),
  );
  const asking =
    /怎么|如何|能不能|是否|什么|先.{0,5}(?:方案|规划)|不执行|别执行|先不|暂不/u.test(
      request,
    );
  // A compound request for new content is not a save-only operation.
  if (
    clauses.some((clause) =>
      /重新生成|再生成|新建.{0,16}测试集(?!草稿)/u.test(
        clause.replace(
          /(?:不要|不得|禁止|不能|先不|暂不|无需|不必|不用|不|别)(?:重新生成|再生成|生成|新建)/gu,
          "",
        ),
      ),
    )
  )
    return undefined;
  const saving = Boolean(
    !contentChange &&
    !asking &&
    task.runId &&
    (answeringSave ||
      clauses.some((clause) =>
        /(?:保存|另存|存成|存到|存为|保存确认|加入.{0,12}草稿)/u.test(clause),
      )) &&
    !/保存方案/u.test(request),
  );
  const missingSaveTarget = Boolean(
    task.runId &&
    /换.{0,8}(?:地方|位置|保存)|另存/u.test(request) &&
    !/新(?:的)?(?:测试集)?草稿|原草稿|当前草稿/u.test(request),
  );
  if (saving)
    return {
      operation: "save_candidates",
      needsBackground: false,
      properties: {
        baseRevision: { type: "integer", const: revision },
        ...(missingSaveTarget
          ? { question: { type: "string", minLength: 1, maxLength: 500 } }
          : { candidateSave: properties.candidateSave }),
      },
      facts: {
        operation: "save_candidates",
        ...(missingSaveTarget ? { missingFact: "save_target" } : {}),
        baseRevision: revision,
        request,
        runId: task.runId,
        target: task.target,
        draftId: task.targetDraftId ?? task.draftId,
        selectedCandidates: task.selectedCandidates,
      },
    };
  if (
    contentChange &&
    clauses.some((clause) => /保存|另存|存成|存到|存为/u.test(clause))
  )
    return undefined;
  const changes = request
    .split(/[，,。；;\n]/u)
    .filter((clause) => !/保持|不变|不要|不得|禁止|先不|不执行/u.test(clause));
  const text = changes.join("，");
  const requested = new Set<string>();
  if (/名称|名字|命名/u.test(text)) requested.add("name");
  if (/数量|条数|\d+\s*条/u.test(text)) {
    requested.add("count");
    requested.add("classifications");
    requested.add("instructions");
  }
  if (/类别|分类|标签|Metadata|元数据/iu.test(text))
    requested.add("classifications");
  if (/场景|情境/u.test(text)) requested.add("scenarios");
  if (
    /要求|改写|定义|边界|期望|行为|问法|说法|表达|语气|口语|生硬|模板/u.test(
      text,
    )
  )
    requested.add("instructions");
  if (/取消|撤销|删除/u.test(text)) requested.add("remove");
  const adding = changes.some(deliveryAdditionClause);
  const focused = amendmentTargets(task, request);
  if (
    task.runId &&
    requested.has("instructions") &&
    !requested.has("count") &&
    !requested.has("classifications")
  ) {
    return {
      operation: "edit_current_candidates",
      needsBackground: false,
      properties: {
        baseRevision: { type: "integer", const: revision },
        candidateEdit: properties.candidateEdit,
        executionMode: properties.executionMode,
      },
      facts: {
        operation: "edit_current_candidates",
        baseRevision: revision,
        request,
        requirements: task.requirements ?? [],
        runId: task.runId,
        instructions: focused.map((g) => g.instructions),
        allowedFields: task.allowedFields ?? ["question"],
      },
    };
  }
  const fields = properties.deliveries.items.properties;
  const patchFields = Object.fromEntries(
    Object.entries(fields).filter(
      ([name]) =>
        name === "id" || adding || !requested.size || requested.has(name),
    ),
  );
  const top = Object.fromEntries(
    Object.entries(properties).filter(
      ([name]) =>
        !["control", "deliveries", "candidateEdit", "candidateSave"].includes(
          name,
        ) &&
        (!requested.size ||
          ["executionMode", "question", "nextAction"].includes(name) ||
          ((/要求|约束|字段/iu.test(text) || requested.has("count")) &&
            [
              "requirements",
              "removeRequirements",
              "allowedFields",
              "metadataKeys",
            ].includes(name))),
    ),
  );
  const definitions = task.backgroundDefinitions ?? [];
  const projection = focused.map((goal) => ({
    id: goal.id,
    name: goal.name,
    count: goal.count,
    countKind: goal.countKind,
    ...(!truncated || requested.has("instructions")
      ? { instructions: goal.instructions }
      : {}),
    ...(!truncated || requested.has("scenarios")
      ? { scenarios: goal.scenarios }
      : {}),
    classifications: goal.classifications.map((rule) => ({
      ...rule,
      definitions:
        !truncated || requested.has("classifications")
          ? rule.definitions?.map((definition) => {
              const saved = definitions.find(
                (entry: any) =>
                  entry.field === rule.field &&
                  entry.key === rule.key &&
                  entry.value === definition.value,
              );
              return saved?.reference
                ? { value: definition.value, reference: saved.reference }
                : definition;
            })
          : undefined,
    })),
  }));
  return {
    operation: "amend_plan",
    needsBackground:
      adding ||
      requested.has("classifications") ||
      requested.has("instructions") ||
      requested.has("scenarios") ||
      /附件|文档|背景|定义/u.test(text),
    properties: {
      ...top,
      baseRevision: { type: "integer", const: revision },
      deliveries: {
        ...properties.deliveries,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...patchFields,
            ...(patchFields.scenarios
              ? {
                  scenarios: {
                    ...patchFields.scenarios,
                    minItems:
                      requestedSceneCount(request) ??
                      Math.min(3, ...focused.map((g) => g.scenarios.length)),
                    ...(requestedSceneCount(request)
                      ? { maxItems: requestedSceneCount(request) }
                      : {}),
                  },
                }
              : {}),
          },
          ...(adding
            ? {
                if: properties.deliveries.items.if,
                else: properties.deliveries.items.else,
              }
            : {
                required: [
                  "id",
                  ...(requested.has("instructions") && !requested.has("count")
                    ? ["instructions"]
                    : []),
                ],
              }),
        },
      },
    },
    facts: {
      operation: truncated ? "repair_plan_amendment" : "amend_plan",
      baseRevision: revision,
      request,
      requirements: task.requirements ?? [],
      allowedFields: task.allowedFields,
      metadataKeys: task.metadataKeys,
      deliveries: projection,
      ...(!focused.length
        ? {
            availableDeliveries: goals.map(({ id, name, count }) => ({
              id,
              name,
              count,
            })),
          }
        : {}),
    },
  };
}
