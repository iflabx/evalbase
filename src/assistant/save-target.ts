import { deliveryGoals, currentDeliveryId } from "./delivery-plan.js";

export type SaveTarget =
  | { kind: "newDraft"; name: string; purpose?: string }
  | { kind: "draft"; id: string };
export const saveTargetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { enum: ["newDraft", "draft"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    id: { type: "string", minLength: 1, maxLength: 200 },
    purpose: { type: "string", maxLength: 2000 },
  },
  required: ["kind"],
  allOf: [
    {
      if: { properties: { kind: { const: "newDraft" } } },
      then: { required: ["name"], not: { required: ["id"] } },
    },
    {
      if: { properties: { kind: { const: "draft" } } },
      then: {
        required: ["id"],
        not: { anyOf: [{ required: ["name"] }, { required: ["purpose"] }] },
      },
    },
  ],
};

/** A lossless fast path for an explicit quoted output name in user instructions. Other phrasing uses the structured plan field. */
export function namedSaveTarget(request: string): SaveTarget | undefined {
  const pattern =
    /(?:保存|另存|存为|存成)(?:到|为|成)?(?:一个|新的?|的|测试集|\s)*草稿[，,:：\s]*(?:(?:名字|名称)?(?:叫做?|为)|命名为|取名为)?[“"「]([^”"」\n]{1,200})[”"」]/gu;
  let target: SaveTarget | undefined;
  for (const match of request.matchAll(pattern)) {
    const prefix =
      request
        .slice(0, match.index)
        .split(/[，,。；;\n]/u)
        .at(-1) ?? "";
    if (
      /(?:不要|不得|不必|不需要|禁止|别|无需|不用|不)(?:再|先|暂时)?\s*$/u.test(
        prefix,
      )
    )
      continue;
    const name = match[1].trim();
    if (name) target = { kind: "newDraft", name };
  }
  return target;
}

export function requestsProcessingSave(request: string) {
  return request
    .split(/[。；;\n]/u)
    .some(
      (clause) =>
        /(?:保存|另存|存为|存成)(?!方案|要求|设置)/u.test(clause) &&
        /结果|成果|草稿|处理|清洗|改写|扩写|扩充/u.test(clause) &&
        !/(?:不要|不得|不必|不需要|禁止|别|先不|暂不|无需|不用|不)(?:再)?(?:保存|另存|存为|存成)/u.test(
          clause,
        ),
    );
}

/** Processing goals keep their destination separately from their source and chat title. No old rows are rewritten. */
export function savedSaveTarget(
  task: Record<string, any>,
): SaveTarget | undefined {
  if (deliveryGoals(task.executionPlan).length) return undefined;
  return (
    task.saveTarget ?? namedSaveTarget((task.requirements ?? []).join("\n"))
  );
}

export function newDraftSaveTarget(task: Record<string, any>): SaveTarget {
  const saved = savedSaveTarget(task);
  if (saved?.kind === "newDraft") return saved;
  const goals = deliveryGoals(task.executionPlan);
  const goal =
    goals.find((g) => g.id === currentDeliveryId(task.executionPlan)) ??
    (goals.length === 1 ? goals[0] : undefined);
  return {
    kind: "newDraft",
    name:
      goal?.name ??
      (task.targetName ? String(task.targetName).slice(0, 190) + "·" : "") +
        "处理结果",
  };
}

export function bindPlannedSaveTarget(
  input: Record<string, any>,
  task: Record<string, any>,
  request: string,
) {
  if (input.deliveries || deliveryGoals(task.executionPlan).length)
    return input;
  const prior = savedSaveTarget(task);
  const supplied =
    input.saveTarget &&
    prior &&
    !task.uiCandidateSave &&
    !/(?:保存|另存|存成|存为|存到|名称|名字|命名)/u.test(request)
      ? prior
      : input.saveTarget;
  const target =
    input.candidateSave?.target ?? namedSaveTarget(request) ?? supplied;
  return target ? { ...input, saveTarget: target } : input;
}
