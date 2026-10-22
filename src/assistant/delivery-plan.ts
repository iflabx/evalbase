import { opaqueId } from "../server/support.js";
import { canonicalJson } from "../package/contract.js";
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
  question?: string;
  boundaryVersion?: 1;
  id: string;
  name: string;
  count: number;
  countKind: "new" | "final";
  instructions: string;
  scenarios: string[];
  classifications: Rule[];
};
export type DeliveryChange = Partial<
  Omit<DeliveryGoal, "classifications" | "question">
> & {
  classifications?: (Rule & { clear?: boolean })[];
  remove?: boolean;
  question?: string | null;
};

function fail(hint: string, clarification = false): never {
  throw new RequirementError(
    "assistant_requirement_conflict",
    hint,
    clarification,
  );
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

// A named replacement can change one frozen category without requiring internal field names.
// Keep the field, quota and every sibling rule; broader changes use the existing explicit rule editor.
function requestsSingleCategoryReplacement(
  request: string,
  before: Rule,
  after: Rule,
  prior: DeliveryGoal,
  goals: DeliveryGoal[],
  knownValues: string[],
) {
  const oldValue =
    before.allowedValues?.length === 1 ? before.allowedValues[0] : undefined;
  const nextValue =
    after.allowedValues?.length === 1 ? after.allowedValues[0] : undefined;
  if (
    !oldValue ||
    !nextValue ||
    oldValue === nextValue ||
    before.basis !== after.basis
  )
    return false;
  if (
    before.quotas?.length !== 1 ||
    before.quotas[0].value !== oldValue ||
    after.quotas?.length !== 1
  )
    return false;
  if (
    before.quotas[0].count !== after.quotas[0].count ||
    after.quotas[0].value !== nextValue
  )
    return false;
  return (
    requestedTopicValue(
      request,
      before,
      prior,
      goals,
      knownValues.length ? knownValues : [nextValue],
    ) === nextValue
  );
}

function requestedTopicValue(
  request: string,
  before: Rule,
  prior: DeliveryGoal,
  goals: DeliveryGoal[],
  knownValues: string[],
) {
  const oldValue =
    before.allowedValues?.length === 1 ? before.allowedValues[0] : undefined;
  if (!oldValue) return undefined;
  const rank = goals.findIndex((goal) => goal.id === prior.id) + 1;
  const chinese = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][
    rank - 1
  ];
  const names = [oldValue, prior.name].filter(
    (name) =>
      goals.filter(
        (goal) =>
          goal.name === name ||
          goal.classifications.some((rule) =>
            rule.allowedValues?.includes(name),
          ),
      ).length === 1,
  );
  const ordinalTargets =
    prior.classifications.length === 1 && names.includes(oldValue)
      ? [
          "第" + rank + "个",
          "第" + rank + "份",
          "第" + chinese + "个",
          "第" + chinese + "份",
        ]
      : [];
  const targets = [
    ...names.filter(
      (name) => name === oldValue || prior.classifications.length === 1,
    ),
    ...ordinalTargets,
  ];
  for (const sentence of request.split(/[。；;\n]|然后/u)) {
    const clause = sentence.replace(/^\s*(?:请|先|再)?\s*(?:把|将)?\s*/u, "");
    const match = clause.match(/^(.+?)(?:改成|改为|换成|替换为)\s*([^，,]+)/u);
    if (!match) continue;
    const target = match[1]
      .replace(/(?:不要了|取消了)\s*[，,]?\s*$/u, "")
      .trim();
    const topic = match[2].trim().replace(/^[“"「]|[”"」]$/gu, "");
    if (/^[1-9]\d*\s*条/u.test(topic)) continue;
    const allOrdinals = [
      "第" + rank + "个",
      "第" + rank + "份",
      "第" + chinese + "个",
      "第" + chinese + "份",
    ];
    if (prior.classifications.length > 1 && allOrdinals.includes(target))
      fail(
        "这份测试集包含多个分类方向，请说明要替换的业务主题；其他要求保持。",
        true,
      );
    if (!targets.includes(target)) continue;
    if (topic.length < 2) fail("请说明要替换成哪个业务主题。", true);
    const values = [...new Set(knownValues)];
    const exact = values.filter((value) => value === topic);
    const matches = exact.length
      ? exact
      : values.filter((value) => value.includes(topic));
    if (!matches.length) continue;
    if (matches.length !== 1)
      fail("新主题在当前依据中不能唯一确定，请说明具体业务主题。", true);
    return matches[0];
  }
  return undefined;
}

function ruleChanges(
  prior: DeliveryGoal,
  changes: DeliveryChange["classifications"],
  request: string,
  newCount: number,
  goals: DeliveryGoal[],
  knownValues: string[],
) {
  const resizing = newCount !== prior.count;
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
    const namedQuotaChange =
      original.quotas?.length === merged.quotas?.length &&
      original.quotas?.every((quota) => {
        const next = merged.quotas?.find((item) => item.value === quota.value);
        if (!next) return false;
        if (next.count === quota.count) return true;
        return (
          requestedDeliveryQuota(prior, goals, quota.value, request) ===
          next.count
        );
      });

    if (
      !permitted &&
      !requestsSingleCategoryReplacement(
        request,
        original,
        merged,
        prior,
        goals,
        knownValues,
      ) &&
      (basisChanged ||
        valuesChanged ||
        definitionsChanged ||
        (quotasChanged &&
          !namedQuotaChange &&
          !(resizing && original.allowedValues?.length === 1)))
    )
      fail(
        "本轮未更改对应分类约束，不能删除类别、定义或缩减配额；省略的规则保持。",
      );
    // A copied, unchanged single-category quota is a derived count, not a second user choice.
    if (
      resizing &&
      !valuesChanged &&
      !basisChanged &&
      original.quotas?.length === 1 &&
      original.allowedValues?.length === 1 &&
      merged.quotas?.length === 1 &&
      merged.quotas[0].value === original.quotas[0].value &&
      merged.quotas[0].count === original.quotas[0].count
    )
      return { ...merged, quotas: [{ ...merged.quotas[0], count: newCount }] };
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
      ...(step.question ? { question: step.question } : {}),
      ...(step.boundaryVersion
        ? { boundaryVersion: step.boundaryVersion }
        : {}),
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
            `「${goal.name}」的新目标为${count}条，原方案有多个类别配额。请说明新的类别分配：各类别分别保留多少条；其他约束保持。`,
            true,
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
  const namedEach = request.match(
    /([^，,。；;\n]+(?:和|与|及|、)[^，,。；;\n]+?)各\s*(?:做|生成|创建)?\s*([1-9]\d*)\s*条/u,
  );
  // An explicit single collection may contain several categories; do not split it.
  if (namedEach && !/(?<!各)(?:一|1)(?:份|个)|同一|合并/u.test(request)) {
    const names = namedEach[1]
      .split(/和|与|及|、/u)
      .map((name) => name.trim())
      .filter(Boolean);
    if (goals.length !== names.length)
      fail(
        "本轮要求的多份交付不完整；请保留每个主题及其数量，不能只保存首份。",
      );
    const later = request.slice((namedEach.index ?? 0) + namedEach[0].length);
    if (
      !/(?:改成|改为|调整为|只要)\s*[1-9]\d*\s*条/u.test(later) &&
      goals.some((goal) => goal.count !== Number(namedEach[2]))
    )
      fail("每份交付数量与本轮要求不一致；请保留全部主题和数量。");
  }
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
  // Ignore separate control/explanation clauses, not the accompanying business amendment.
  request = request
    .split(/[。；;\n]|然后/u)
    .map((sentence) =>
      sentence
        .split(/[，,]/u)
        .filter(
          (part) =>
            !/^\s*(?:请|先|再)?\s*(?:(?:不要|不得|禁止|别|不)\s*(?:执行|开工|开始|生成)|解释|举例|例如|引用)/u.test(
              part,
            ),
        )
        .join("，"),
    )
    .join("\n");
  // These checks reject omissions; they never grant execution or infer new work.
  for (const category of catalog) {
    const names = aliases(category);
    const named = request
      .split(/[。；;，,\n]/u)
      .flatMap((clause) => {
        const alias = names.find((name) => clause.includes(name));
        if (!alias || /不要|不得|禁止/u.test(clause)) return [];
        const suffix = clause.slice(clause.indexOf(alias) + alias.length);
        const count = suffix.match(
          /^\s*(?:测试集)?\s*(?:改成|改为|调整为|还是|只要|做|生成)?\s*([1-9]\d*)\s*条/u,
        )?.[1];
        return count ? [Number(count)] : [];
      })
      .at(-1);
    if (
      named !== undefined &&
      !goals.some((goal) =>
        goal.classifications.some(
          (rule) =>
            rule.allowedValues?.some((value) => names.includes(value)) &&
            rule.quotas?.some(
              (quota) => names.includes(quota.value) && quota.count === named,
            ),
        ),
      )
    )
      fail(
        "本轮要求「" +
          category.value +
          "」" +
          named +
          "条，交付及对应配额尚未同步更新。",
      );
  }
  const replacement = request.match(
    /([^。；;\n]+?)(?:换成|替换为)([^。；;，,\n]+)/u,
  );
  if (
    replacement &&
    !/不要|不得|禁止|别/u.test(replacement[1].replace(/不要了|取消了/gu, ""))
  ) {
    const old = catalog.find((item) =>
      aliases(item).some((name) => replacement[1].includes(name)),
    );
    const next = catalog.find((item) =>
      aliases(item).some((name) => replacement[2].includes(name)),
    );
    const includes = (category: Category) =>
      goals.some((goal) =>
        goal.classifications.some((rule) =>
          rule.allowedValues?.some((value) =>
            aliases(category).includes(value),
          ),
        ),
      );
    if (
      old &&
      next &&
      old.value !== next.value &&
      (includes(old) || !includes(next))
    )
      fail(
        "本轮替换的主题尚未同步到实际交付；更新对应交付的分类、情境和要求后再继续，不只修改标题或文字摘要。",
      );
  }
  for (const clause of request.split(/[。；;\n]/u)) {
    const count = clause.match(
      /(?:各\s*(?:(?:做|生成|建|创建)\s*)?(?:一份)?|每类)\s*([1-9]\d*)\s*条/u,
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
  const quotaRule = original.classifications?.find(
    (rule: Rule) =>
      rule.quotas?.length &&
      rule.quotas.reduce((sum, quota) => sum + quota.count, 0) ===
        original.count &&
      rule.quotas.some(
        (quota) =>
          requestedDeliveryQuota(original, originals, quota.value, request) !==
          undefined,
      ),
  );
  if (quotaRule)
    return quotaRule.quotas.reduce(
      (sum: number, quota: { value: string; count: number }) =>
        sum +
        (requestedDeliveryQuota(original, originals, quota.value, request) ??
          quota.count),
      0,
    );
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

function requestedDeliveryQuota(
  original: any,
  goals: any[],
  value: string,
  request: string,
) {
  const matching = goals.filter((goal) =>
    goal.classifications?.some((rule: Rule) =>
      [
        ...(rule.allowedValues ?? []),
        ...(rule.requiredValues ?? []),
        ...(rule.quotas ?? []).map((q) => q.value),
      ].includes(value),
    ),
  );
  if (matching.length === 1) return requestedQuota(value, request);
  const scoped = request
    .split(/[。；;，,\n]/u)
    .filter((clause) => {
      const named = goals.filter(
        (goal) => goal.name && clause.includes(goal.name),
      );
      return named.length === 1 && named[0].id === original.id;
    })
    .join("，");
  return requestedQuota(value, scoped);
}

function requestedQuota(value: string, request: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return request.split(/[。；;，,\n]/u).flatMap((clause) => {
    if (/不要|不得|禁止|别|解释|举例|例如|比如|引用/u.test(clause)) return [];
    const specific = clause.match(
      new RegExp(
        escaped +
          "(?:类)?\\s*(?:先)?(?:改(?:为|成)?|调整为|设为)\\s*([1-9]\\d*)\\s*条",
        "u",
      ),
    );
    const each =
      clause.includes(value) &&
      clause.match(/(?:各\s*(?:一份)?|每类)\s*([1-9]\d*)\s*条/u);
    const match = specific || each;
    return match ? [Number(match[1])] : [];
  })[0];
}

/** Adding rows/scenes does not authorize a new independent delivery. */
export function deliveryAdditionClause(clause: string) {
  return (
    !/不要|不得|别|禁止/u.test(clause) &&
    /(?:新增|增加|添加|新建|再建|再做|另做|多做|加|多)\s*(?:(?:[一两三四五六七八九十\d]+\s*(?:份|个))[^，。；;\n]{0,40}(?:测试集|集合)|(?:独立的?)?(?:测试集|集合))/u.test(
      clause,
    )
  );
}

/** Omission preserves goals and fields; IDs, not names or array positions, identify updates. */
export function reviseDeliveryGoals(
  current: DeliveryGoal[],
  changes: DeliveryChange[] | undefined,
  userText: string,
  amendCounts = false,
  knownValues: string[] = [],
): DeliveryGoal[] {
  if (changes && (!Array.isArray(changes) || !changes.length))
    fail("交付目标不能为空；省略表示保持，取消已有交付须明确指定该项。");
  const scalarCount =
    !amendCounts && current.length
      ? explicitRequirementCount(userText, current[0].countKind)
      : undefined;
  if (scalarCount && current.length > 1)
    fail(
      "当前有多份交付，单个目标数量的指向不明确；请说明每份数量或整体数量，原方案保持。",
    );
  const goals = current.map((goal) => structuredClone(goal));
  const seen = new Set<string>();
  for (const [changeIndex, change] of (changes ?? []).entries()) {
    try {
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
      const explicitAddition =
        !current.some((goal) => goal.name === change.name) &&
        userText
          .split(/[。；;，,\n]/u)
          .some(
            (clause) =>
              typeof change.name === "string" &&
              clause.includes(change.name) &&
              deliveryAdditionClause(clause),
          );
      if (current.length && !change.id && !explicitAddition)
        fail(
          "更新交付必须使用当前方案中的真实引用，不能按名称覆盖或另建重复交付。",
        );
      const candidate = {
        ...prior,
        ...change,
        id: prior?.id ?? opaqueId("delivery"),
        question:
          change.question === null
            ? undefined
            : (change.question ?? prior?.question),
        boundaryVersion: prior ? prior.boundaryVersion : 1,
        countKind: change.countKind ?? prior?.countKind ?? "new",
      } as DeliveryGoal;
      if (
        candidate.question !== undefined &&
        (typeof candidate.question !== "string" ||
          !candidate.question.trim() ||
          candidate.question.length > 500)
      )
        fail("请说明这份交付缺少的具体业务依据；已明确的交付不要设置问题。");
      if (
        prior?.question &&
        change.question === null &&
        change.instructions === undefined &&
        change.classifications === undefined
      )
        fail(
          "补充依据后请同步保存该交付修正后的判定要求或分类定义，不能只清除待补充提示。",
        );
      if (!positive(candidate.count)) fail("每份交付数量须为1至10000的整数。");
      if (
        !amendCounts &&
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
        !amendCounts &&
        prior &&
        candidate.count !== prior.count &&
        scalarCount?.targetCount !== candidate.count &&
        !changedCount(userText) &&
        !namedCount(userText, prior.name, candidate.count)
      )
        fail(
          "本轮没有明确改变这项交付的数量，不能在参数修正时缩减或改写目标。",
        );
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
      const patches = prior
        ? ruleChanges(
            prior,
            change.classifications,
            userText,
            candidate.count,
            current,
            knownValues,
          )
        : change.classifications;
      const quotasChanged = patches?.some((patch) => {
        const original = prior?.classifications.find(
          (rule) => field(rule) === field(patch),
        );
        return (
          !original ||
          canonicalJson(patch.quotas ?? original.quotas) !==
            canonicalJson(original.quotas)
        );
      });
      const resized = prior
        ? fitCount(
            {
              ...candidate,
              count: prior.count,
              classifications: prior.classifications,
            },
            candidate.count,
            Boolean(quotasChanged),
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
    } catch (error) {
      if (error instanceof RequirementError)
        Object.assign(error, { deliveryIndex: changeIndex });
      throw error;
    }
  }
  const count: { each?: number; overall?: number } | undefined =
    !amendCounts && current.length
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
  if (current.length && changes?.length) {
    const values = [
      ...knownValues,
      ...goals.flatMap((goal) =>
        goal.classifications.flatMap((rule) => rule.allowedValues ?? []),
      ),
    ];
    for (const prior of current)
      for (const original of prior.classifications) {
        const expected = requestedTopicValue(
          userText,
          original,
          prior,
          current,
          values,
        );
        if (!expected || original.allowedValues?.includes(expected)) continue;
        const next = goals.find((goal) => goal.id === prior.id);
        const rule = next?.classifications.find(
          (rule) => field(rule) === field(original),
        );
        if (
          rule?.allowedValues?.length !== 1 ||
          rule.allowedValues[0] !== expected
        )
          fail(
            "主题修改尚未同步到该测试集的分类和生成要求；原方案保持，不能只修改名称。",
          );
      }
  }
  // This validator checks field/quota structure only; document authority is checked by OPT-34.
  for (const goal of goals)
    validateRules({
      targetCount: goal.count,
      classifications: goal.classifications as VerifiedRule[],
    });
  if (!current.length || changes?.length || count) {
    const added = current.length
      ? goals.filter((goal) => !current.some((prior) => prior.id === goal.id))
      : [];
    if (added.length) {
      const clauses = userText.split(/[。；;，,\n]/u);
      validateRequestedShape(
        added,
        clauses.filter(deliveryAdditionClause).join("，"),
      );
      validateRequestedShape(
        goals,
        clauses.filter((clause) => !deliveryAdditionClause(clause)).join("，"),
      );
    } else validateRequestedShape(goals, userText);
  }
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
  const relocatedKeys = new Set<string>();
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
    if (
      (!original.id || repaired.instructions !== undefined) &&
      typeof original.instructions === "string" &&
      original.instructions.trim() &&
      (typeof repaired.instructions !== "string" ||
        repaired.instructions.trim() !== original.instructions.trim())
    )
      fail("参数纠错不能改写原交付的具体要求；业务变更应由用户另行提出。 ");
    for (const scene of Array.isArray(original.scenarios)
      ? original.scenarios
      : [])
      if (
        (!original.id || repaired.scenarios !== undefined) &&
        typeof scene === "string" &&
        scene.trim().length >= 2 &&
        !repaired.scenarios?.some(
          (value: unknown) =>
            typeof value === "string" && value.trim() === scene.trim(),
        )
      )
        fail("参数纠错须保留原交付已有的完整情境，仅补齐缺失或无效情境。");
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
          if (rejectedOutputEnum) relocatedKeys.add(replacement.key);
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
  const outputLabelDirective = (value: string) =>
    value
      .trim()
      .replace(/[，,]\s*作为(?:该|本)(?:测试集)?的?分类标签[。.]?$/u, "")
      .match(
        /^(?:每条(?:记录)?的?)?(?:期望输出|expectedOutput)\s*(?:标签)?\s*(?:固定为|固定值为|填写|填为|[:：=])\s*(.+?)\s*$/iu,
      )?.[1];
  const nextRequirements = Array.isArray(nextInput?.requirements)
    ? nextInput.requirements
    : [];
  if (
    nextRequirements.some((value: unknown) => {
      const directive =
        typeof value === "string" ? outputLabelDirective(value) : undefined;
      return directive && relocatedLabels.has(label(directive));
    })
  )
    fail(
      "该固定期望输出已经校验拒绝，类别已移到Metadata；请同步移除或改写这条单独标签说明，保留类别、定义、配额及其他业务要求。",
    );
  const relocatedRequirement = (value: string) => {
    let normalized = value;
    for (const key of relocatedKeys) {
      const location = `在Metadata的${key}`;
      normalized = normalized
        .replaceAll(location + "字段中", "")
        .replaceAll(location + "中", "");
    }
    return normalized;
  };
  if (
    requirements.some((value: string) => {
      // Only the standalone directive for a server-rejected, intact relocated
      // label may change. Compound clauses and user requirements stay protected.
      const directive = outputLabelDirective(value);
      return (
        !(directive && relocatedLabels.has(label(directive))) &&
        !nextRequirements.some(
          (next: unknown) =>
            typeof next === "string" &&
            (next === value ||
              (relocatedKeys.size > 0 &&
                relocatedRequirement(next) === relocatedRequirement(value))),
        )
      );
    })
  )
    fail("修正参数不能删除原语义要求；本轮有效要求必须保留。");
}

export function generationSteps(goals: DeliveryGoal[]) {
  return goals.map((goal) => ({
    deliveryId: goal.id,
    ...(goal.question ? { question: goal.question } : {}),
    ...(goal.boundaryVersion ? { boundaryVersion: goal.boundaryVersion } : {}),
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

/** Focus is a view; only durable receipts identify the last completed delivery. */
export function currentDeliveryId(plan: Record<string, any> | undefined) {
  return (
    plan?.steps[plan.current]?.deliveryId ??
    plan?.steps.findLast((step: any) => step.deliveryId && step.receipt)
      ?.deliveryId
  );
}

export function deliveryIdForRuns(task: Record<string, any>, runIds: string[]) {
  const ids = new Set(
    (task.executionPlan?.steps ?? [])
      .filter(
        (step: any) => step.deliveryId && runIds.includes(step.receipt?.runId),
      )
      .map((step: any) => step.deliveryId),
  );
  return ids.size === 1 ? ([...ids][0] as string) : undefined;
}

/** Project one goal from the existing plan, without changing its authority or receipts. */
export function taskForDelivery(task: Record<string, any>, id: string) {
  const plan = task.executionPlan;
  const goal = deliveryGoals(plan).find((goal) => goal.id === id);
  if (!goal) return;
  const steps = plan.steps.filter((step: any) => step.deliveryId === id);
  const draftId = steps.findLast((step: any) => step.receipt?.draftId)?.receipt
    .draftId;
  return {
    ...task,
    targetCount: goal.count,
    countKind: goal.countKind,
    classifications: goal.classifications,
    allowedLabels: [],
    target: draftId ? { kind: "draft", id: draftId } : null,
    targetDraftId: draftId ?? null,
    createdDraftId: draftId ?? null,
    executionPlan: {
      ...plan,
      steps,
      current:
        steps.findIndex((step: any) => step.status !== "executed") < 0
          ? steps.length
          : steps.findIndex((step: any) => step.status !== "executed"),
    },
  };
}

/** Only asynchronous work and user confirmations require continuation events. */
export function continuationEventCount(
  plan: Record<string, any> | undefined,
  unfinishedOnly = false,
) {
  return (plan?.steps ?? []).filter(
    (step: any) =>
      (!unfinishedOnly || step.status !== "executed") &&
      ([
        "submit_processing",
        "generate_candidates",
        "refine_candidates",
        "retry_processing",
      ].includes(step.action) ||
        step.action.startsWith("request_")),
  ).length;
}
