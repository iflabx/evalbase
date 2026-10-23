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
) {
  const goals = deliveryGoals(task.executionPlan);
  if (task.executionPlan?.contractVersion !== 1 || !goals.length)
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
  }
  if (/类别|分类|标签|Metadata|元数据/iu.test(text))
    requested.add("classifications");
  if (/场景|情境/u.test(text)) requested.add("scenarios");
  if (/要求|改写|定义|边界|期望|行为/u.test(text))
    requested.add("instructions");
  if (/取消|撤销|删除/u.test(text)) requested.add("remove");
  const adding = changes.some(deliveryAdditionClause);
  const focused = amendmentTargets(task, request);
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
        !["control", "deliveries"].includes(name) &&
        (!requested.size ||
          ["executionMode", "question", "nextAction"].includes(name) ||
          (/要求|约束|字段/iu.test(text) &&
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
            : { required: ["id"] }),
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
