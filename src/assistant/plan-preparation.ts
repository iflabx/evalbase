import { normalizePlanContent } from "./plan-content.js";
import { requestedSceneCount } from "./requirements.js";
import {
  deliveryGoals,
  isDeliveryAddition,
  reviseDeliveryGoals,
} from "./delivery-plan.js";
import { reviseDeliveryRequirements } from "./requirements.js";

export type PreparationIssue = {
  tool: string;
  operation: string;
  path: string;
  keyword: string;
  code: string;
  message: string;
};
export type PreparationResult =
  | {
      ok: true;
      input: Record<string, any>;
      goals?: ReturnType<typeof deliveryGoals>;
      requirements?: Record<string, any>;
    }
  | { ok: false; issues: PreparationIssue[]; question?: string };
const changedRequest = (request: string) =>
  request
    .split(/[，,。；;\n]/u)
    .filter((c) => !/保持|不变|不要|不得|禁止/u.test(c))
    .join("，");
/** Trusted targets come from the current contract and user request, never a rejected proposal's IDs. */
export function amendmentTargets(task: Record<string, any>, request: string) {
  const goals = deliveryGoals(task.executionPlan);
  const changed = changedRequest(request);
  const ordinals = [
    ...changed.matchAll(
      /第(\d+|一|二|两|三|四|五|六|七|八|九|十)(?:份|个测试集)/gu,
    ),
  ].map((m) => {
    const n =
      Number(m[1]) ||
      (
        {
          一: 1,
          二: 2,
          两: 2,
          三: 3,
          四: 4,
          五: 5,
          六: 6,
          七: 7,
          八: 8,
          九: 9,
          十: 10,
        } as Record<string, number>
      )[m[1]!];
    return goals[n - 1];
  });
  if (ordinals.length) {
    if (ordinals.some((g) => g === undefined)) return [];
    const targets = ordinals.filter((g) => g !== undefined);
    return [...new Map(targets.map((g) => [g.id, g])).values()];
  }
  const named = goals.filter((g) => changed.includes(g.name));
  if (named.length) return named;
  const classified = goals.filter((g) =>
    g.classifications.some((r) =>
      r.allowedValues?.some((v) => changed.includes(v)),
    ),
  );
  return classified.length
    ? classified
    : goals.length === 1 || /全部|所有|每份|各份/u.test(changed)
      ? goals
      : [];
}
export function bindPlanProposal(
  value: Record<string, any>,
  task: Record<string, any>,
  request: string,
  revision: number,
) {
  const input = structuredClone(value);
  const goals = deliveryGoals(task.executionPlan);
  if (goals.length) input.baseRevision ??= revision;
  if (!Array.isArray(input.deliveries)) return input;
  const targets = amendmentTargets(task, request);
  input.deliveries = input.deliveries.map((change: any) => {
    if (!change || typeof change !== "object" || Array.isArray(change))
      return change;
    const addition = isDeliveryAddition(goals, change, request);
    if (goals.length && !change.id && !addition) {
      const matching = targets.filter(
        (g) => !change.name || g.name === change.name,
      );
      const target =
        matching.length === 1
          ? matching[0]
          : targets.length === 1
            ? targets[0]
            : undefined;
      if (target) change = { ...change, id: target.id };
    }
    const prior = goals.find((g) => g.id === change.id);
    if (
      prior &&
      change.count === undefined &&
      Array.isArray(change.classifications)
    ) {
      const totals = change.classifications
        .filter((r: any) => Array.isArray(r.quotas) && r.quotas.length)
        .map((r: any) =>
          r.quotas.reduce((n: number, q: any) => n + q.count, 0),
        );
      if (
        totals.length &&
        totals.every(
          (n: number) => Number.isSafeInteger(n) && n > 0 && n === totals[0],
        )
      )
        change = { ...change, count: totals[0] };
    }
    return change;
  });
  return input;
}
/** Missing business identity is a clarification, not a request to invent create fields. */
export function requiredPlanTarget(
  input: Record<string, any>,
  task: Record<string, any>,
  request: string,
) {
  const goals = deliveryGoals(task.executionPlan);
  if (
    goals.length < 2 ||
    !Array.isArray(input.deliveries) ||
    /全部|所有|每份|各份/u.test(changedRequest(request))
  )
    return;
  const index = input.deliveries.findIndex(
    (d: any) =>
      d &&
      typeof d === "object" &&
      !Array.isArray(d) &&
      !d.id &&
      !isDeliveryAddition(goals, d, request),
  );
  if (index < 0) return;
  const question =
    "有多份可能的测试集，请说明要修改哪一份（可用序号）：" +
    goals
      .slice(0, 8)
      .map(
        (g, i) =>
          "第" +
          (i + 1) +
          "份「" +
          g.name.slice(0, 40) +
          "」（" +
          g.count +
          "条）",
      )
      .join("；") +
    (goals.length > 8 ? "；其余见当前方案。" : "。");
  return {
    ok: false as const,
    question,
    issues: [
      {
        tool: "plan_task",
        operation: "amend",
        path: "/deliveries/" + index + "/id",
        keyword: "clarification",
        code: "assistant_plan_target_required",
        message: question,
      },
    ],
  };
}

/** Pure preparation, shared by save, SDK repair and continuation. Resolvers verify existing evidence only. */
export function preparePlanProposal(
  value: Record<string, any>,
  facts: {
    task: Record<string, any>;
    request: string;
    revision: number;
    canUpdate: boolean;
    resolve: (input: Record<string, any>) => Record<string, any>;
    validate: (goal: Record<string, any>) => void;
    knownValues: string[];
  },
): PreparationResult {
  let input: Record<string, any>;
  try {
    input = bindPlanProposal(value, facts.task, facts.request, facts.revision);
    if (
      input.baseRevision !== undefined &&
      input.baseRevision !== facts.revision
    )
      return {
        ok: false,
        issues: [
          {
            tool: "plan_task",
            operation: "amend",
            path: "/baseRevision",
            keyword: "revision",
            code: "assistant_plan_revalidation_required",
            message: "要求已更新，请按当前方案核对本次修改。",
          },
        ],
      };
    const target = requiredPlanTarget(input, facts.task, facts.request);
    if (target) return target;
    const issues: PreparationIssue[] = [];
    const operation = deliveryGoals(facts.task.executionPlan).length
      ? "amend"
      : "create";
    const issue = (path: string, keyword: string, message: string) =>
      issues.push({
        tool: "plan_task",
        operation,
        path,
        keyword,
        code: "assistant_tool_input_invalid",
        message,
      });
    const requirements = input.requirements ?? facts.task.requirements ?? [];
    const steps = input.steps ?? facts.task.executionPlan?.steps ?? [];
    const derivesInstructions =
      steps.some(
        (s: any) =>
          ["submit_processing", "generate_candidates"].includes(s.action) &&
          s.input?.instructions === undefined,
      ) ||
      ["submit_processing", "generate_candidates"].includes(input.nextAction);
    if (
      derivesInstructions &&
      Array.isArray(requirements) &&
      requirements.every((v: any) => typeof v === "string") &&
      requirements.join("\n").length > 8000
    )
      issue(
        "/requirements",
        "capacity",
        "完整要求超过当前执行指令容量；请按交付拆分要求，原方案与全部输入保留。",
      );
    const currentGoals = deliveryGoals(facts.task.executionPlan);
    if (!Array.isArray(input.deliveries) && !currentGoals.length)
      return issues.length ? { ok: false, issues } : { ok: true, input };
    (input.deliveries ?? []).forEach((d: any, i: number) => {
      if (!d || typeof d !== "object" || Array.isArray(d)) return;
      if (
        deliveryGoals(facts.task.executionPlan).length &&
        !d.id &&
        !isDeliveryAddition(currentGoals, d, facts.request)
      )
        issue(
          "/deliveries/" + i + "/id",
          "required",
          "请明确要修改哪份测试集；当前有多份可能目标，原方案保持。",
        );
      if (typeof d.instructions === "string" && !d.instructions.trim())
        issue(
          "/deliveries/" + i + "/instructions",
          "minLength",
          "生成要求不能为空白。",
        );
      if (Array.isArray(d.scenarios)) {
        if (d.scenarios.some((s: any) => typeof s !== "string" || !s.trim()))
          issue(
            "/deliveries/" + i + "/scenarios",
            "minLength",
            "场景必须是完整的非空文字。",
          );
        else if (
          new Set(d.scenarios.map((s: string) => s.trim())).size !==
          d.scenarios.length
        )
          issue(
            "/deliveries/" + i + "/scenarios",
            "uniqueItems",
            "同一交付的场景不能重复。",
          );
        const explicit = requestedSceneCount(facts.request);
        if (explicit !== undefined && d.scenarios.length !== explicit)
          issue(
            "/deliveries/" + i + "/scenarios",
            "count",
            "请保留用户明确指定的场景数量。",
          );
      }
    });
    if (issues.length) return { ok: false, issues };
    if (input.deliveries)
      input.deliveries = input.deliveries.map((d: any) => facts.resolve(d));
    let goals = reviseDeliveryGoals(
      currentGoals,
      input.deliveries,
      facts.request,
      facts.canUpdate,
      facts.knownValues,
    );
    const merged = reviseDeliveryRequirements(
      facts.task,
      input,
      facts.request,
      facts.canUpdate,
    );
    const content = normalizePlanContent(
      goals,
      merged.requirements,
      currentGoals,
    );
    goals = content.goals;
    merged.requirements = content.requirements;
    for (const goal of goals)
      facts.validate({
        ...facts.task,
        ...merged,
        targetCount: goal.count,
        classifications: goal.classifications,
        allowedLabels: [],
      });
    return { ok: true, input, goals, requirements: merged };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    const e = error as Error & {
      code: string;
      hint?: string;
      deliveryIndex?: number;
      issues?: PreparationIssue[];
    };
    return {
      ok: false,
      issues: e.issues ?? [
        {
          tool: "plan_task",
          operation: "prepare",
          path:
            e.deliveryIndex === undefined
              ? "/"
              : "/deliveries/" + e.deliveryIndex,
          keyword: /reference/.test(e.code) ? "reference" : "business",
          code: e.code,
          message: e.hint ?? e.message,
        },
      ],
    };
  }
}
