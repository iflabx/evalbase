import { opaqueId } from "../server/support.js";
import {
  RequirementError,
  explicitRequirementCount,
  expectedOutputForm,
  reviseRequirements,
  validateRules,
} from "./requirements.js";

type VerifiedRule = NonNullable<
  Parameters<typeof validateRules>[0]["classifications"]
>[number];
// Planning accepts OPT-34 references; its resolver fills text before this contract is saved.
type Rule = Omit<VerifiedRule, "definitions"> & {
  definitions?: (Omit<
    NonNullable<VerifiedRule["definitions"]>[number],
    "text"
  > & {
    text?: string;
    reference?: string;
  })[];
};
export type DeliveryGoal = {
  id: string;
  name: string;
  count: number;
  countKind: "new" | "final";
  instructions: string;
  scenarios: string[];
  classifications: Rule[];
};
export type DeliveryChange = Partial<Omit<DeliveryGoal, "classifications">> & {
  classifications?: (Rule & { clear?: boolean })[];
  remove?: boolean;
};

function fail(hint: string): never {
  throw new RequirementError("assistant_requirement_conflict", hint);
}
const field = (rule: any) =>
  rule?.field === "expectedOutput"
    ? "expectedOutput"
    : rule?.field === "metadata" && typeof rule.key === "string"
      ? "metadata:" + rule.key.trim().toLowerCase()
      : undefined;
const positive = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10000;
const namedCount = (request: string, name: string, count: number) =>
  request
    .split(/[。；;，,\n]/u)
    .some(
      (clause) =>
        clause.includes(name) &&
        new RegExp(
          "(?:改为|改成|调整为|变为)\\s*" + count + "\\s*条",
          "u",
        ).test(clause) &&
        !/(?:不要|不得|别|禁止).{0,8}(?:改为|改成|调整为|变为)/u.test(clause),
    );

function requestsRuleChange(request: string, rule: Rule) {
  const clauses = request.split(/[。；;，,\n]|并且?|同时|但/u);
  const refers = (clause: string) => {
    if (rule.field === "expectedOutput")
      return /期望输出|expectedOutput/u.test(clause);
    const key = rule.key?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return (
      Boolean(
        key &&
        new RegExp("(?:^|[^A-Za-z0-9_])" + key + "(?![A-Za-z0-9_])", "iu").test(
          clause,
        ),
      ) ||
      /(?:全部|所有)(?:的)?\s*(?:Metadata|元数据)\s*(?:分类|字段|规则)/iu.test(
        clause,
      )
    );
  };
  if (
    clauses.some(
      (clause) =>
        refers(clause) &&
        /保留|保持|不变|不要修改/u.test(clause) &&
        !/(?:不再|不用|不要)(?:保留|保持)/u.test(clause),
    )
  )
    return false;
  return clauses.some((clause) => {
    return (
      refers(clause) &&
      /取消|撤销|删除|去掉|不再|不用|改为|改成|调整|更改|修改|清空/u.test(
        clause,
      ) &&
      !/(?:不要|不得|别|禁止).{0,8}(?:取消|撤销|删除|去掉|改为|改成|调整|更改|修改|清空)/u.test(
        clause,
      )
    );
  });
}

function ruleChanges(
  prior: DeliveryGoal,
  changes: DeliveryChange["classifications"],
  request: string,
  resizing: boolean,
) {
  if (changes === undefined) return undefined;
  if (!changes.length) {
    if (
      prior.classifications.some((rule) => !requestsRuleChange(request, rule))
    )
      fail("本轮未撤销全部分类约束，不能清空交付的分类、定义和配额。");
    return [];
  }
  return changes.map((change) => {
    const original = prior.classifications.find(
      (rule) => field(rule) === field(change),
    );
    if (!original) return change;
    const permitted = requestsRuleChange(request, original);
    if (change.clear) {
      if (!permitted) fail("本轮未撤销该分类字段，原规则保持。");
      return change;
    }
    const merged = {
      ...original,
      ...Object.fromEntries(
        Object.entries(change).filter(([, value]) => value !== undefined),
      ),
    } as Rule;
    const valuesChanged = ["allowedValues", "requiredValues"].some((key) => {
      const before = (original as any)[key] ?? [];
      const after = (merged as any)[key] ?? [];
      return (
        before.some((value: string) => !after.includes(value)) ||
        after.some((value: string) => !before.includes(value))
      );
    });
    const definitionKey = (
      definition: NonNullable<Rule["definitions"]>[number],
    ) =>
      JSON.stringify([
        definition.value,
        definition.text ?? null,
        definition.reference ?? null,
        definition.basis ?? null,
      ]);
    const definitionsChanged =
      (original.definitions ?? []).some(
        (definition) =>
          !merged.definitions?.some(
            (value) => definitionKey(value) === definitionKey(definition),
          ),
      ) ||
      (merged.definitions ?? []).some(
        (definition) =>
          !original.definitions?.some(
            (value) => definitionKey(value) === definitionKey(definition),
          ),
      );
    const quotasChanged = original.quotas?.some(
      (quota) =>
        !merged.quotas?.some(
          (value) => value.value === quota.value && value.count === quota.count,
        ),
    );
    const basisChanged = original.basis !== merged.basis;
    if (
      !permitted &&
      (basisChanged ||
        valuesChanged ||
        definitionsChanged ||
        (quotasChanged && !(resizing && original.allowedValues?.length === 1)))
    )
      fail(
        "本轮未更改对应分类约束，不能删除类别、定义或缩减配额；省略的规则保持。",
      );
    return merged;
  });
}

/** The generation steps are the contract; this is a derived view, not another state. */
export function deliveryGoals(
  plan: Record<string, any> | undefined,
): DeliveryGoal[] {
  if (plan?.contractVersion !== 1) return [];
  return (plan.steps ?? [])
    .filter(
      (step: any) => step.action === "generate_candidates" && step.deliveryId,
    )
    .map((step: any) => ({
      id: step.deliveryId,
      name: step.input.name,
      count: step.input.outputCount,
      countKind: step.countKind ?? "new",
      instructions: step.input.instructions,
      scenarios: step.input.scenarios ?? [],
      classifications: step.input.classifications ?? [],
    }));
}

function changedCount(request: string) {
  if (/(?:解释|举例|例如|比如|引用)/u.test(request)) return undefined;
  const clauses = request
    .split(/[。；;，,\n]/u)
    .filter(
      (clause) =>
        !/(?:不要|不得|别|禁止).{0,8}(?:改为|改成|调整为|变为|总共|合计|总计|总数)/u.test(
          clause,
        ) &&
        !/(?:每条|每题|每个问题|输入|参考记录).{0,12}(?:改为|改成|调整为|变为|总共|合计|总计|总数)/u.test(
          clause,
        ),
    );
  const each = clauses.flatMap((clause) => [
    ...clause.matchAll(
      /(?:改为|改成|调整为|变为)\s*(?:各|每份|每个(?:测试集|集合)?)\s*([1-9]\d*)\s*条/gu,
    ),
  ]);
  const overall = clauses.flatMap((clause) => [
    ...clause.matchAll(
      /(?:总共|合计|总计|总数(?:改为|改成|调整为|为)?)\s*([1-9]\d*)\s*条/gu,
    ),
  ]);
  const values = new Set(
    [...each, ...overall].map((match) => Number(match[1])),
  );
  if (values.size > 1 || (each.length && overall.length))
    fail("本轮同时给出了不同的每份或整体数量，请明确采用哪一项；原方案保持。");
  return each.length
    ? { each: Number(each[0][1]) }
    : overall.length
      ? { overall: Number(overall[0][1]) }
      : undefined;
}

function fitCount(goal: DeliveryGoal, count: number, suppliedRules: boolean) {
  if (goal.count === count) return goal;
  return {
    ...goal,
    count,
    classifications: goal.classifications.map((rule) => {
      // One category has an unambiguous new quota; multi-category allocation is a business choice.
      if (!suppliedRules && rule.quotas?.length) {
        if (rule.allowedValues?.length !== 1 || rule.quotas.length !== 1)
          fail(
            `「${goal.name}」包含多个类别配额，请同时说明新数量的类别分配；其他约束保持。`,
          );
        return { ...rule, quotas: [{ ...rule.quotas[0], count }] };
      }
      return rule;
    }),
  };
}

const numeric = (value: string) =>
  value === "两"
    ? 2
    : Number(value) || "一二三四五六七八九十".indexOf(value) + 1;

/** Only explicit collection/count clauses; internal category quotas never create collections. */
function validateRequestedShape(goals: DeliveryGoal[], request: string) {
  const number = "([1-9]\\d*|两|[一二三四五六七八九十])";
  const eachOne = request.match(/各\s*(?:建|创建)?\s*一份\s*([1-9]\d*)\s*条/u);
  const compact = request.match(
    new RegExp(
      "(?:^|[，,。；;\\n])\\s*" +
        number +
        "\\s*份\\s*([1-9]\\d*)\\s*条(?=\\s*(?:[，,。；;\\n]|$))",
      "u",
    ),
  );
  const separate = request.match(
    new RegExp(
      number + "\\s*份(?:[^，。；;\\n]{0,20})?(?:各|每份)\\s*([1-9]\\d*)\\s*条",
      "u",
    ),
  );
  const count = separate
    ? numeric(separate[1])
    : compact
      ? numeric(compact[1])
      : eachOne
        ? undefined
        : request.match(
            new RegExp(
              "(?<!各)" +
                number +
                "\\s*(?:份|个)[^，。；;\\n]{0,15}(?:测试集|集合)",
              "u",
            ),
          )?.[1];
  if (
    count !== undefined &&
    goals.length !== (typeof count === "number" ? count : numeric(count))
  )
    fail(
      "方案的测试集份数与本轮明确要求不一致。集合内的分类配额不能拆成独立测试集。",
    );
  const per =
    separate?.[2] ??
    (compact && numeric(compact[1]) === 1 ? compact[2] : undefined) ??
    eachOne?.[1];
  if (per && goals.some((goal) => goal.count !== Number(per)))
    fail("每份测试集的数量与本轮明确要求不一致，请保留全部交付并修正数量。");
  if (eachOne) {
    const named = request
      .slice(0, eachOne.index)
      .split(/和|与|及|、/u)
      .filter((part) => part.trim());
    if (named.length > 1 && goals.length !== named.length)
      fail("本轮要求分别交付多个测试集，不能只保存首项或合并为一个集合。");
  }
  const total = request.match(/(?:共|总共|合计|总计)\s*([1-9]\d*)\s*条/u)?.[1];
  if (
    total &&
    goals.reduce((sum, goal) => sum + goal.count, 0) !== Number(total)
  )
    fail("整体交付数量与本轮明确要求不一致；整体数量由各交付相加计算。");
}

type Category = { value: string; aliases?: string[]; name?: string };
const aliases = (category: Category) => [
  ...new Set(
    [category.value, category.name, ...(category.aliases ?? [])].filter(
      (value): value is string => Boolean(value),
    ),
  ),
];

/** Only categories named in affirmative, explicit per-category quantity clauses are binding here. */
export function validateRequestedCategories(
  goals: DeliveryGoal[],
  request: string,
  catalog: Category[],
) {
  for (const clause of request.split(/[。；;，,\n]/u)) {
    const count = clause.match(
      /(?:各\s*(?:一份)?|每类)\s*([1-9]\d*)\s*条/u,
    )?.[1];
    if (!count || /不要|不得|禁止|举例|例如|解释/u.test(clause)) continue;
    const matches = catalog.flatMap((category) =>
      aliases(category).flatMap((alias) => {
        const index = clause.indexOf(alias);
        return index < 0 ? [] : [{ category, alias, index }];
      }),
    );
    const requested = [
      ...new Map(
        matches
          .filter(
            (match) =>
              !matches.some(
                (other) =>
                  other.category.value !== match.category.value &&
                  other.index <= match.index &&
                  other.index + other.alias.length >=
                    match.index + match.alias.length &&
                  other.alias.length > match.alias.length,
              ),
          )
          .map((match) => [match.category.value, match.category]),
      ).values(),
    ];
    const deliveries = new Set<string>();
    for (const category of requested) {
      const names = aliases(category);
      const matching = goals.filter((goal) =>
        goal.classifications.some(
          (rule) =>
            rule.allowedValues?.some((value) => names.includes(value)) &&
            rule.quotas?.some(
              (quota) =>
                names.includes(quota.value) && quota.count === Number(count),
            ),
        ),
      );
      if (!matching.length)
        fail(
          `本轮要求「${category.value}」${count}条，方案须保留该类别及对应配额，不能用空分类代替。`,
        );
      if (/各\s*一份/u.test(clause)) {
        if (
          matching.length !== 1 ||
          matching[0].count !== Number(count) ||
          deliveries.has(matching[0].id)
        )
          fail("分别交付的类别须各有独立测试集及明确数量，不能合并或遗漏。");
        deliveries.add(matching[0].id);
      }
    }
  }
}

function requestedRepairCount(
  original: any,
  originals: any[],
  request: string,
) {
  if (/解释|举例|例如|比如|引用/u.test(request)) return undefined;
  const scalar = explicitRequirementCount(request);
  if (originals.length === 1 && scalar) return scalar.targetCount;
  const each =
    changedCount(request)?.each ??
    Number(request.match(/各\s*一份\s*([1-9]\d*)\s*条/u)?.[1]);
  if (positive(each)) return each;
  const total = request.match(/(?:共|总共|合计|总计)\s*([1-9]\d*)\s*条/u)?.[1];
  if (
    total &&
    (originals.length === 1 ||
      new Set(originals.map((goal) => goal.count)).size === 1)
  ) {
    const count = Number(total) / originals.length;
    if (positive(count)) return count;
  }
  return request.split(/[。；;，,\n]/u).flatMap((clause) => {
    const match =
      clause.includes(original.name) &&
      clause.match(/(?:改为|改成|调整为|变为)\s*([1-9]\d*)\s*条/u);
    return match && !/不要|不得|禁止/u.test(clause) ? [Number(match[1])] : [];
  })[0];
}

function requestedQuota(value: string, request: string) {
  return request.split(/[。；;，,\n]/u).flatMap((clause) => {
    const match =
      clause.includes(value) &&
      clause.match(/(?:各\s*(?:一份)?|每类)\s*([1-9]\d*)\s*条/u);
    return match && !/不要|不得|禁止|解释|举例/u.test(clause)
      ? [Number(match[1])]
      : [];
  })[0];
}

/** Omission preserves goals and fields; IDs, not names or array positions, identify updates. */
export function reviseDeliveryGoals(
  current: DeliveryGoal[],
  changes: DeliveryChange[] | undefined,
  userText: string,
): DeliveryGoal[] {
  if (changes && (!Array.isArray(changes) || !changes.length))
    fail("交付目标不能为空；省略表示保持，取消已有交付须明确指定该项。");
  const scalarCount = current.length
    ? explicitRequirementCount(userText, current[0].countKind)
    : undefined;
  if (scalarCount && current.length > 1)
    fail(
      "当前有多份交付，单个目标数量的指向不明确；请说明每份数量或整体数量，原方案保持。",
    );
  const goals = current.map((goal) => structuredClone(goal));
  const seen = new Set<string>();
  for (const change of changes ?? []) {
    if (!change || typeof change !== "object")
      fail("每项交付必须是完整的业务目标。");
    const prior = change.id
      ? current.find((goal) => goal.id === change.id)
      : undefined;
    if (change.id && !prior)
      fail("交付引用已失效，请使用当前方案中的真实交付引用。");
    if (change.id && seen.has(change.id))
      fail("同一交付不能在一次修改中重复提交。");
    if (change.id) seen.add(change.id);
    if (change.remove) {
      if (
        !prior ||
        !userText
          .split(/[。；;，,\n]/u)
          .some(
            (clause) =>
              clause.includes(prior.name) &&
              /(?:取消|撤销|删除|去掉|不再需要)/u.test(clause) &&
              !/(?:不要|不得|别|禁止).{0,8}(?:取消|撤销|删除|去掉)/u.test(
                clause,
              ),
          )
      )
        fail("本轮没有明确取消这项交付；原交付及其约束保持。");
      goals.splice(
        goals.findIndex((goal) => goal.id === prior.id),
        1,
      );
      continue;
    }
    if (current.length && !change.id)
      fail(
        "更新交付必须使用当前方案中的真实引用，不能按名称覆盖或另建重复交付。",
      );
    const candidate = {
      ...prior,
      ...change,
      id: prior?.id ?? opaqueId("delivery"),
      countKind: change.countKind ?? prior?.countKind ?? "new",
    } as DeliveryGoal;
    if (!positive(candidate.count)) fail("每份交付数量须为1至10000的整数。");
    if (
      prior &&
      candidate.countKind !== prior.countKind &&
      scalarCount?.countKind !== candidate.countKind &&
      !userText
        .split(/[。；;，,\n]/u)
        .some(
          (clause) =>
            /改为|改成|改按|调整为/u.test(clause) &&
            (candidate.countKind === "final"
              ? /最终总数/u.test(clause)
              : /新增(?:数量|候选|记录)/u.test(clause)) &&
            !/(?:不要|不得|别|禁止).{0,8}(?:改为|改成|改按|调整为)/u.test(
              clause,
            ),
        )
    )
      fail("本轮未改变新增或最终数量的含义，原数量约定保持。");
    if (
      prior &&
      candidate.count !== prior.count &&
      scalarCount?.targetCount !== candidate.count &&
      !changedCount(userText) &&
      !namedCount(userText, prior.name, candidate.count)
    )
      fail("本轮没有明确改变这项交付的数量，不能在参数修正时缩减或改写目标。");
    if (
      !candidate.name?.trim() ||
      !candidate.instructions?.trim() ||
      !Array.isArray(candidate.scenarios) ||
      candidate.scenarios.length < 3 ||
      candidate.scenarios.some(
        (scene) => typeof scene !== "string" || scene.trim().length < 2,
      )
    )
      fail("每份交付须有名称、具体要求及至少三个完整且不同的情境。");
    if (
      new Set(candidate.scenarios.map((scene) => scene.trim())).size !==
      candidate.scenarios.length
    )
      fail("同一交付的情境不能重复。");
    if (!Array.isArray(candidate.classifications))
      fail("交付须明确分类约定；普通文档可以填写空分类。");
    const resizing = Boolean(prior && candidate.count !== prior.count);
    const patches = prior
      ? ruleChanges(prior, change.classifications, userText, resizing)
      : change.classifications;
    const resized = prior
      ? fitCount(
          {
            ...candidate,
            count: prior.count,
            classifications: prior.classifications,
          },
          candidate.count,
          patches !== undefined,
        )
      : candidate;
    candidate.classifications = reviseRequirements(
      {
        targetCount: candidate.count,
        classifications: resized.classifications as VerifiedRule[],
      },
      {
        targetCount: candidate.count,
        ...(patches !== undefined
          ? {
              classifications: patches as (VerifiedRule & {
                clear?: boolean;
              })[],
            }
          : {}),
      },
    ).classifications;
    candidate.name = candidate.name.trim();
    if (prior)
      goals[goals.findIndex((goal) => goal.id === prior.id)] = candidate;
    else goals.push(candidate);
  }
  const count: { each?: number; overall?: number } | undefined = current.length
    ? (changedCount(userText) ??
      (scalarCount ? { each: scalarCount.targetCount } : undefined))
    : undefined;
  if (count) {
    const unequal =
      count.overall !== undefined &&
      goals.length > 1 &&
      new Set(current.map((goal) => goal.count)).size > 1;
    if (
      unequal &&
      !goals.every((goal) => namedCount(userText, goal.name, goal.count))
    )
      fail(
        "原交付数量不同，整体数量尚未明确如何分配到各份；请说明各份数量，原方案保持。",
      );
    if (
      unequal &&
      goals.reduce((sum, goal) => sum + goal.count, 0) !== count.overall
    )
      fail("本轮逐份数量与整体数量不一致，原方案保持。");
    const target = count.each ?? count.overall! / goals.length;
    if (!unequal && !positive(target))
      fail("整体数量不能平均分配到当前交付，请明确各份数量；原方案保持。");
    goals.forEach((goal, index) => {
      if (unequal) return;
      const change = changes?.find((item) => item.id === goal.id);
      if (change?.count !== undefined && change.count !== target)
        fail("交付数量与本轮明确的每份或整体数量不一致。");
      goals[index] = {
        ...fitCount(goal, target, change?.classifications !== undefined),
        ...(scalarCount?.countKind ? { countKind: scalarCount.countKind } : {}),
      };
    });
  }
  if (
    !goals.length ||
    goals.length > 10 ||
    goals.reduce((sum, goal) => sum + goal.count, 0) > 10000
  )
    fail("需保留1至10份交付，整体数量不超过10000条。");
  // This validator checks field/quota structure only; document authority is checked by OPT-34.
  for (const goal of goals)
    validateRules({
      targetCount: goal.count,
      classifications: goal.classifications as VerifiedRule[],
    });
  if (!current.length || changes?.length || count)
    validateRequestedShape(goals, userText);
  return goals;
}

/** Repair may move known fields, but may not turn a rejected proposal into a weaker goal. */
export function assertDeliveryRepair(
  originalInput: any,
  nextInput: any,
  userText = "",
  rejectedOutputEnum = false,
) {
  const relocatedLabels = new Set<string>();
  const label = (text: string) =>
    text
      .normalize("NFKC")
      .replace(/[\s“”"'「」『』]/gu, "")
      .replace(/[。.]$/u, "");
  const next = nextInput?.deliveries;
  if (Array.isArray(originalInput?.deliveries) && !Array.isArray(next))
    fail("修正参数时须保留全部交付和分类要求，不能改为不含交付的方案。");
  for (const original of Array.isArray(originalInput?.deliveries)
    ? originalInput.deliveries
    : []) {
    if (!original || (!original.id && typeof original.name !== "string"))
      continue;
    const matches = next.filter((goal: any) =>
      original.id ? goal.id === original.id : goal.name === original.name,
    );
    if (matches.length !== 1 || matches[0].remove)
      fail("修正参数时不能删除、合并或遗漏原交付。");
    const repaired = matches[0];
    const requested = requestedRepairCount(
      original,
      originalInput.deliveries,
      userText,
    );
    if (
      positive(original.count) &&
      (!positive(repaired.count) ||
        (repaired.count !== original.count && repaired.count !== requested))
    )
      fail("修正参数不能缩减交付数量。");
    if (
      original.countKind &&
      (repaired.countKind ?? "new") !== original.countKind
    )
      fail("修正参数不能改变新增或最终数量的含义。");
    for (const rule of Array.isArray(original.classifications)
      ? original.classifications
      : []) {
      const identity = field(rule);
      if (!identity) continue;
      let replacement = Array.isArray(repaired.classifications)
        ? repaired.classifications.find(
            (candidate: any) => field(candidate) === identity,
          )
        : undefined;
      let relocated = false;
      // Only rejected proposals may relocate an intact enum. The extra allowance
      // comes from a server validation receipt, never a model parameter; saved
      // rules still use scoped ruleChanges.
      if (
        !replacement &&
        identity === "expectedOutput" &&
        rule.basis === "background" &&
        (expectedOutputForm(userText) === "per-item" ||
          (rejectedOutputEnum && expectedOutputForm(userText) !== "labels")) &&
        Array.isArray(rule.allowedValues) &&
        rule.allowedValues.length > 0 &&
        rule.allowedValues.every(
          (value: unknown) => typeof value === "string" && value.trim(),
        )
      ) {
        const alternatives = (
          Array.isArray(repaired.classifications)
            ? repaired.classifications
            : []
        ).filter(
          (candidate: any) =>
            candidate.field === "metadata" &&
            typeof candidate.key === "string" &&
            candidate.key.trim() &&
            !candidate.clear &&
            Array.isArray(candidate.allowedValues) &&
            candidate.allowedValues.length === rule.allowedValues.length &&
            rule.allowedValues.every((value: string) =>
              candidate.allowedValues.includes(value),
            ),
        );
        if (alternatives.length === 1) {
          replacement = alternatives[0];
          relocated = true;
          if (rejectedOutputEnum)
            for (const value of rule.allowedValues)
              relocatedLabels.add(label(value));
        }
      }
      if (!replacement || replacement.clear)
        fail("修正参数不能清空原分类字段及其约束。");
      if (rule.basis === "background" && replacement.basis === "user")
        fail("修正参数不能把文档分类冒充为用户自定义分类。");
      for (const key of ["allowedValues", "requiredValues"])
        if (
          Array.isArray(rule[key]) &&
          rule[key].some(
            (value: any) =>
              typeof value === "string" && !replacement[key]?.includes(value),
          )
        )
          fail("修正参数不能删除原分类类别或覆盖要求。");
      for (const definition of Array.isArray(rule.definitions)
        ? rule.definitions
        : [])
        if (
          typeof definition?.value === "string" &&
          !replacement.definitions?.some(
            (value: any) =>
              value.value === definition.value &&
              ((typeof value.text === "string" && value.text.trim()) ||
                (typeof value.reference === "string" &&
                  value.reference.trim())),
          )
        )
          fail("修正参数不能丢弃原类别的定义依据。");
      for (const quota of Array.isArray(rule.quotas) ? rule.quotas : []) {
        const quotaCount =
          requestedQuota(quota.value, userText) ??
          (rule.allowedValues?.length === 1 ? requested : undefined) ??
          quota.count;
        if (
          Number.isInteger(quota?.count) &&
          quota.count >= 0 &&
          !replacement.quotas?.some(
            (value: any) =>
              value.value === quota.value &&
              Number.isInteger(value.count) &&
              (value.count === quota.count ||
                (!relocated && value.count === quotaCount)),
          )
        )
          fail("修正参数不能删除或缩减原类别配额。");
      }
    }
  }
  for (const key of ["allowedFields", "metadataKeys"]) {
    const original = originalInput?.[key];
    if (!Array.isArray(original)) continue;
    const valid = original.filter(
      (value: unknown) =>
        typeof value === "string" &&
        value.trim() &&
        (key !== "allowedFields" ||
          ["question", "expectedOutput", "metadata"].includes(value)),
    );
    if (original.length && !valid.length) continue;
    if (
      !Array.isArray(nextInput?.[key]) ||
      nextInput[key].some((value: unknown) => !valid.includes(value))
    )
      fail(
        "修正参数不能扩大允许修改的字段或Metadata键范围，原字段保护必须保持。",
      );
  }
  const requirements = Array.isArray(originalInput?.requirements)
    ? originalInput.requirements.filter(
        (value: unknown) => typeof value === "string" && value.trim(),
      )
    : [];
  if (
    requirements.some((value: string) => {
      if (
        Array.isArray(nextInput?.requirements) &&
        nextInput.requirements.includes(value)
      )
        return false;
      // A rejected model proposal is not a user contract. Discard only a
      // standalone directive for the exact relocated label, not a compound
      // instruction or any other semantic requirement.
      const directive = value
        .trim()
        .match(
          /^(?:每条(?:记录)?的?)?(?:期望输出|expectedOutput)\s*(?:标签)?\s*(?:固定为|固定值为|填写|填为|[:：=])\s*(.+?)\s*$/iu,
        )?.[1];
      return !directive || !relocatedLabels.has(label(directive));
    })
  )
    fail("修正参数不能删除原语义要求；本轮有效要求必须保留。");
}

export function generationSteps(goals: DeliveryGoal[]) {
  return goals.map((goal) => ({
    deliveryId: goal.id,
    countKind: goal.countKind,
    title: "生成「" + goal.name + "」",
    action: "generate_candidates",
    input: {
      name: goal.name,
      instructions: goal.instructions,
      outputCount: goal.count,
      scenarios: goal.scenarios,
      classifications: goal.classifications,
    },
  }));
}
