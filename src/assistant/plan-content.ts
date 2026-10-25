import { canonicalJson } from "../package/contract.js";
import { RequirementError } from "./requirements.js";
import type { DeliveryGoal } from "./delivery-plan.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Counts have one owner. Remove only bound output-quantity spans, never business numbers. */
export function planContentText(
  text: string,
  goals: DeliveryGoal[],
  prior: DeliveryGoal[] = [],
) {
  const contracts = [...goals, ...prior];
  const totals = new Set(contracts.map((g) => g.count));
  if (goals.length) totals.add(goals.reduce((n, g) => n + g.count, 0));
  if (prior.length) totals.add(prior.reduce((n, g) => n + g.count, 0));
  const labels = new Map<string, Set<number>>();
  for (const g of contracts)
    for (const rule of g.classifications)
      for (const q of rule.quotas ?? []) {
        const counts = labels.get(q.value) ?? new Set<number>();
        counts.add(q.count);
        labels.set(q.value, counts);
      }
  const reject = () => {
    throw new RequirementError(
      "assistant_plan_content_conflict",
      "数量文字与当前交付无法一致绑定；请仅修正受影响的数量表达，保留全部内容条件、输入范围及其他交付，不让用户填写参数。",
    );
  };
  return text
    .split(/([。；;，,\n])/u)
    .map((part) => {
      if (/^[。；;，,\n]$/u.test(part)) return part;
      // Protect only the exact input/per-item quantity span; check the rest of the clause.
      const protectedSpans: string[] = [];
      if (part.includes("\0")) reject();
      const number = "(?:[0-9]+|[零〇一二两三四五六七八九十百千万]+)";
      let value = part.replace(
        new RegExp(
          "(?:每(?:条|题|个问题)(?:包含|提供|保留|生成|输出|列出|附带|应有|需有|有)?|(?:输入(?:范围|记录|数据)|参考(?:记录|数据)|原始(?:记录|数据))(?:共|为|有|数量为)?)\\s*" +
            number +
            "\\s*条",
          "gu",
        ),
        (span) => {
          protectedSpans.push(span);
          return "\0" + (protectedSpans.length - 1) + "\0";
        },
      );
      for (const [label, counts] of [...labels].sort(
        (a, b) => b[0].length - a[0].length,
      )) {
        const name = escape(label);
        value = value.replace(
          new RegExp(
            '([0-9]+)\\s*条(?:为|是|属于)\\s*[“"「]?' + name + '[”"」]?',
            "gu",
          ),
          (_m, n) => {
            if (!counts.has(Number(n))) reject();
            return label;
          },
        );
        value = value.replace(
          new RegExp(
            "(" + name + '[”"」]?\\s*(?:为|共|：|:)?\\s*)([0-9]+)\\s*条',
            "gu",
          ),
          (_m, p, n) => {
            if (!counts.has(Number(n))) reject();
            return p;
          },
        );
      }
      value = value.replace(
        /(?:并)?(?:分别)?(?:每类|每种|各类|各)(?:为|共)?\s*([0-9]+)\s*条/gu,
        (_m, n, offset) => {
          const perDelivery =
            goals.length > 1 &&
            goals.every((g) => g.count === Number(n)) &&
            /[0-9一二三四五六七八九十两]+\s*(?:份|个)\s*(?:独立)?(?:测试集|交付|草稿)/u.test(
              part.slice(0, offset),
            );
          if (perDelivery) return "";
          const matching = contracts.some((g) => {
            const qs = g.classifications.flatMap((r) => r.quotas ?? []);
            return qs.length > 0 && qs.every((q) => q.count === Number(n));
          });
          if (!matching) reject();
          return "";
        },
      );
      const outputObject = (suffix: string) =>
        !suffix.trim() ||
        /^\s*(?:即可|就行了?|就好|就够了?|便可|就可以了?|吧)[！!？?。]*\s*$/u.test(
          suffix,
        ) ||
        /^\s*(?:(?:自然|完整|新的|新增|独立|可用|不同|意图)(?:的)?[、\s]*)*(?:问题|测试题|题目|测试数据|数据|记录)/u.test(
          suffix,
        );
      value = value.replace(
        /((?:生成|设计|创建|制作|准备|做|出|新增|扩写|扩充)(?:共|总共)?)\s*([0-9]+)\s*条/gu,
        (_m, verb, n, offset) => {
          if (!outputObject(value.slice(offset + _m.length))) return _m;
          if (!totals.has(Number(n))) reject();
          return verb;
        },
      );
      value = value.replace(
        /(?:总计|合计|总共|共|最终总数|目标(?:数量|条数)?)(?:为|是|：|:)?\s*([0-9]+)\s*条/gu,
        (_m, n, offset) => {
          if (!outputObject(value.slice(offset + _m.length))) return _m;
          if (!totals.has(Number(n))) reject();
          return "";
        },
      );
      // Reject an unbound output quantity; unrelated business quantities remain literal.
      if (
        new RegExp(
          number +
            "\\s*条(?:自然|完整|新的|新增)?(?:问题|测试题|题目|测试数据|记录)",
          "u",
        ).test(value)
      )
        reject();
      return value.replace(
        /\0([0-9]+)\0/gu,
        (_m, i) => protectedSpans[Number(i)]!,
      );
    })
    .join("")
    .replace(/^[\s，,；;。]+|[\s，,；;]+$/gu, "")
    .replace(/[，,；;](?=[。；;，,])/gu, "")
    .trim();
}

export function normalizePlanContent(
  goals: DeliveryGoal[],
  requirements: string[],
  prior: DeliveryGoal[] = [],
) {
  return {
    goals: goals.map((goal) => ({
      ...goal,
      instructions: planContentText(
        goal.instructions,
        [goal],
        prior.filter((p) => p.id === goal.id),
      ),
    })),
    requirements: [
      ...new Set(
        requirements
          .map((text) => planContentText(text, goals, prior))
          .filter(Boolean),
      ),
    ],
  };
}

/** A matching hash proves identity, not semantic consistency. Check legacy plans before use. */
export function assertPlanContent(
  goals: DeliveryGoal[],
  requirements: string[],
) {
  const normalized = normalizePlanContent(goals, requirements);
  if (
    canonicalJson(normalized.goals) !== canonicalJson(goals) ||
    canonicalJson(normalized.requirements) !==
      canonicalJson([...new Set(requirements)])
  )
    throw new RequirementError(
      "assistant_plan_revalidation_required",
      "当前方案含重复数量说明，需要先按当前数量重新核对并保存；现有成果保留。",
    );
}
