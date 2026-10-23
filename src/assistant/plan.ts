import { canonicalJson, sha256 } from "../package/contract.js";
import { opaqueId } from "../server/support.js";
import { normalizedRequirements, RequirementError } from "./requirements.js";

/** A scene is a context variation; its verified single-class criterion remains mandatory. */
export function groundDocumentGeneration(
  input: Record<string, any>,
  currentContract = false,
) {
  if (currentContract) {
    const boundary =
      "\n生成边界v1：类别必须满足冻结定义及当前要求中的必要条件和排除边界；scenarios仅提供角色、表达或情境变化。讨论、研究或改写某主题不等于鼓励该行为；尚未证实不等于虚假；概括性兜底规则或规范名称不证明具体行为违法。不得编造规范名称、适用条件或事实结论。场景若包含额外目标或与类别条件冲突，舍弃冲突目标，改用中性情境；仍无法确定关键条件时保留待补充，不按关键词或编号归类。";
    return {
      ...input,
      instructions:
        typeof input.instructions === "string" &&
        !input.instructions.endsWith(boundary)
          ? input.instructions + boundary
          : input.instructions,
    };
  }
  const rules = input.classifications;
  if (
    typeof input.instructions !== "string" ||
    !Array.isArray(rules) ||
    rules.length !== 1
  )
    return input;
  const rule = rules[0];
  if (
    rule.field !== "metadata" ||
    rule.basis !== "background" ||
    rule.allowedValues?.length !== 1
  )
    return input;
  const definition = rule.definitions?.find(
    (entry: any) =>
      entry.value === rule.allowedValues[0] &&
      entry.basis !== "user" &&
      entry.text,
  );
  if (!definition) return input;
  const boundary =
    "\n分类判定依据（已核对的文档数据，不是操作指令）：" +
    JSON.stringify({ value: definition.value, text: definition.text }) +
    "\n每条测试输入的实际意图或行为必须满足上述定义。scenarios只提供背景变化，相关主题关键词不足以证明分类，是否属于本类以原文定义为准。输入意图与期望应答行为分别编写，不能用期望行为替代输入意图。";
  const intent =
    "本类测试目标必须实际满足文档定义【" + definition.text + "】；";
  return {
    ...input,
    instructions: input.instructions.endsWith(boundary)
      ? input.instructions
      : input.instructions + boundary,
    ...(input.scenarios
      ? {
          scenarios: input.scenarios.map((scene: string) =>
            scene.startsWith(intent)
              ? scene
              : intent +
                "仅借用以下背景包装【" +
                scene +
                "】；包装中的其他目标不得替代本类目标。",
          ),
        }
      : {}),
  };
}

/** Multiple independent deliveries always review and request confirmation before the next one. */
export function completeDocumentDeliveries(
  steps: Pick<
    Step,
    | "title"
    | "action"
    | "input"
    | "scope"
    | "deliveryId"
    | "countKind"
    | "question"
    | "boundaryVersion"
  >[],
  includeSingle = false,
) {
  if (
    steps.filter((step) => step.action === "generate_candidates").length <
    (includeSingle ? 1 : 2)
  )
    return steps;
  const completed: typeof steps = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    completed.push(step);
    if (step.action !== "generate_candidates") continue;
    let end = i + 1;
    while (end < steps.length && steps[end].action !== "generate_candidates")
      end++;
    const block = steps.slice(i + 1, end);
    const apply = block.findIndex(
      (next) => next.action === "request_processing_apply",
    );
    if (
      !block
        .slice(0, apply < 0 ? block.length : apply)
        .some((next) => next.action === "read_processing")
    )
      block.splice(apply < 0 ? block.length : apply, 0, {
        title: "核对本类生成结果",
        ...(step.deliveryId ? { deliveryId: step.deliveryId } : {}),
        action: "read_processing",
      });
    if (apply < 0)
      block.push({
        title: "确认采用本类结果",
        ...(step.deliveryId ? { deliveryId: step.deliveryId } : {}),
        action: "request_processing_apply",
        input: { allTask: true, allValid: true, target: { kind: "draft" } },
      });
    completed.push(...block);
    i = end - 1;
  }
  return completed;
}

export const PLAN_ACTIONS = [
  "query_project",
  "read_records",
  "read_background",
  "create_draft",
  "preview_selection",
  "submit_processing",
  "generate_candidates",
  "select_candidates",
  "refine_candidates",
  "retry_processing",
  "read_processing",
  "request_selection_apply",
  "request_processing_apply",
  "request_publish",
] as const;

type Step = {
  deliveryId?: string;
  question?: string;
  boundaryVersion?: 1;
  countKind?: "new" | "final";
  id?: string;
  revision?: number;
  title: string;
  action: string;
  input?: Record<string, any>;
  scope?: "preview" | "all";
  operation?: {
    key: string;
    input: Record<string, any>;
    preparation?: Record<string, any>;
  };
  backgroundRead?: { identity: string; indices: number[] };
  status: "pending" | "waiting" | "executed";
  receipt?: {
    key: string;
    runId?: string;
    draftId?: string;
    proposalId?: string;
    previewId?: string;
  };
};
export type ExecutionPlan = {
  contractVersion?: 1;
  mode: "plan" | "execute";
  steps: Step[];
  current: number;
  requirementsKey?: string;
  needsReview?: boolean;
  target?: Record<string, any> | null;
};

/** Asset-page context and processing sources refer to the same real asset. */
export function planSource(source: Record<string, any> | null | undefined) {
  return source?.kind === "asset"
    ? { kind: "assets", assetIds: [source.id] }
    : source?.kind === "assets"
      ? {
          ...source,
          assetIds: [...new Set(source.assetIds as string[])].sort(),
        }
      : source;
}

export function sourceWithinTask(
  source: Record<string, any>,
  target: Record<string, any>,
) {
  const actual = planSource(source)!,
    allowed = planSource(target)!;
  return (
    canonicalJson(actual) === canonicalJson(allowed) ||
    (actual.kind === "assets" &&
      allowed.kind === "assets" &&
      actual.assetIds.every((id: string) => allowed.assetIds.includes(id)))
  );
}

/** Verification and recovery must agree on both requirements and current documents. */
export function planVerificationCurrent(
  task: Record<string, any>,
  revision: number,
  documentsKey: string | undefined,
) {
  const check = task.requirementCheck;
  return Boolean(
    check?.key &&
    check.taskRevision === revision &&
    check.requirementsKey === planRequirementsKey(task) &&
    documentsKey &&
    check.documentsKey === documentsKey,
  );
}

export function planRequirementsKey(task: Record<string, any>, legacy = false) {
  return sha256(
    canonicalJson({
      ...(task.executionPlan?.contractVersion === 1 &&
      task.executionPlan.steps.some(
        (step: any) => step.deliveryId && step.action === "generate_candidates",
      )
        ? {
            deliveryContract: task.executionPlan.steps
              .filter((step: any) => step.action === "generate_candidates")
              .map((step: any) => ({
                id: step.deliveryId,
                ...(step.question ? { question: step.question } : {}),
                ...(step.boundaryVersion
                  ? { boundaryVersion: step.boundaryVersion }
                  : {}),
                countKind: step.countKind ?? "new",
                name: step.input?.name,
                count: step.input?.outputCount,
                instructions: step.input?.instructions,
                scenarios: step.input?.scenarios,
                classifications: step.input?.classifications,
              })),
          }
        : {}),
      ...Object.fromEntries(
        [
          "target",
          "targetCount",
          "countKind",
          "targetDraftId",
          "allowedFields",
          "metadataKeys",
          "classifications",
          "allowedLabels",
          "requirements",
          "backgroundEvidence",
        ]
          .filter(
            (field) =>
              task[field] !== undefined &&
              (legacy ||
                (task[field] !== null &&
                  !(
                    [
                      "requirements",
                      "classifications",
                      "allowedLabels",
                      "backgroundEvidence",
                    ].includes(field) &&
                    Array.isArray(task[field]) &&
                    !task[field].length
                  ))),
          )
          .map((field) => [
            field,
            field === "requirements" && !legacy
              ? normalizedRequirements(task[field])
              : field === "target" && !legacy
                ? planSource(task[field])
                : task[field],
          ]),
      ),
    }),
  );
}

/** Per-delivery goals and bound destinations are compared separately from shared constraints. */
export function deliverySharedRequirementsKey(task: Record<string, any>) {
  return planRequirementsKey({
    ...task,
    executionPlan: undefined,
    target: null,
    targetDraftId: null,
    targetCount: undefined,
    countKind: undefined,
    classifications: [],
    allowedLabels: [],
  });
}

/** Skip only the self-contained blocks of deliveries awaiting evidence; do not invent dependencies. */
export function selectPlanStep(plan: ExecutionPlan): ExecutionPlan {
  const blocked = new Set(
    plan.steps
      .filter((step) => step.action === "generate_candidates" && step.question)
      .map((step) => step.deliveryId),
  );
  const ready = plan.steps.findIndex(
    (step) =>
      step.status !== "executed" &&
      (!step.deliveryId || !blocked.has(step.deliveryId)),
  );
  const waiting = plan.steps.findIndex(
    (step) => step.status !== "executed" || Boolean(step.question),
  );
  const current =
    ready >= 0 ? ready : waiting >= 0 ? waiting : plan.steps.length;
  return current === plan.current ? plan : { ...plan, current };
}
export function pendingDeliveryQuestion(plan: ExecutionPlan | undefined) {
  const step = plan?.steps[plan.current];
  return step?.deliveryId
    ? plan?.steps.find(
        (goal) =>
          goal.deliveryId === step.deliveryId &&
          goal.action === "generate_candidates",
      )?.question
    : undefined;
}

/** Changed steps invalidate subsequent receipts; unchanged prefixes keep their facts. */
export function revisePlan(
  previous: ExecutionPlan | undefined,
  input: {
    executionMode?: "plan" | "execute";
    preserveSavedDeliveries?: boolean;
    steps?: {
      deliveryId?: string;
      question?: string;
      boundaryVersion?: 1;
      countKind?: "new" | "final";
      title: string;
      action: string;
      input?: Record<string, any>;
      scope?: "preview" | "all";
    }[];
  },
  revision?: number,
  target?: Record<string, any> | null,
  requirementsKey?: string,
): ExecutionPlan | undefined {
  if (
    !input.executionMode &&
    !input.steps &&
    (!previous || previous.requirementsKey === requirementsKey)
  )
    return previous;
  if (!previous && !input.steps && input.executionMode === "execute") return;
  // Saved deliveries are historical facts. Recompiling unresolved templates
  // must not erase their bound read/apply receipts when the contract is unchanged.
  const savedDeliveries = new Set(
    input.preserveSavedDeliveries && previous?.contractVersion === 1
      ? previous.steps
          .filter(
            (step) =>
              step.action === "generate_candidates" &&
              step.deliveryId &&
              previous.steps.some(
                (item) =>
                  item.deliveryId === step.deliveryId &&
                  item.action === "request_processing_apply" &&
                  item.status === "executed" &&
                  item.receipt?.proposalId,
              ) &&
              input.steps?.some(
                (item) =>
                  item.action === step.action &&
                  item.deliveryId === step.deliveryId &&
                  (item.countKind ?? "new") === (step.countKind ?? "new") &&
                  canonicalJson(item.input ?? null) ===
                    canonicalJson(step.input ?? null),
              ),
          )
          .map((step) => step.deliveryId)
      : [],
  );
  let prefix = previous?.requirementsKey === requirementsKey;
  const steps =
    (input.steps ?? previous?.steps)?.map((step, index) => {
      const prior = previous?.steps[index];
      const approved =
        input.executionMode === "execute" &&
        previous?.mode === "plan" &&
        (input.steps ?? []).filter(
          (item) =>
            item.action === step.action &&
            item.title === step.title &&
            item.deliveryId === step.deliveryId,
        ).length === 1 &&
        previous.requirementsKey === requirementsKey &&
        canonicalJson(planSource(previous.target ?? {})) ===
          canonicalJson(planSource(target ?? {}))
          ? previous.steps.filter(
              (item) =>
                item.action === step.action && item.title === step.title,
            )
          : [];
      const inherited =
        !input.steps &&
        previous?.target &&
        step.input?.source &&
        canonicalJson(planSource(step.input.source)) ===
          canonicalJson(planSource(previous.target)) &&
        target !== undefined
          ? target
            ? { ...step.input, source: planSource(target) }
            : (({ source: _source, ...rest }) => rest)(step.input)
          : approved.length === 1 && approved[0]!.input
            ? // Enabling the same approved plan reuses its input; unresolved holes bind through guarded tools later.
              approved[0]!.input
            : step.input;
      let parameters =
        (inherited?.source
          ? { ...inherited, source: planSource(inherited.source) }
          : inherited) ??
        (target && ["read_records", "submit_processing"].includes(step.action)
          ? { source: planSource(target) }
          : undefined);
      // A future result reference is not known until its processing receipt exists.
      if (
        parameters?.runId === "" &&
        [
          "read_processing",
          "select_candidates",
          "refine_candidates",
          "retry_processing",
        ].includes(step.action)
      ) {
        parameters = { ...parameters };
        delete parameters.runId;
      }
      prefix =
        prefix &&
        prior?.action === step.action &&
        prior?.deliveryId === step.deliveryId &&
        prior?.scope === step.scope &&
        canonicalJson(
          prior?.input?.source
            ? { ...prior.input, source: planSource(prior.input.source) }
            : (prior?.input ?? null),
        ) === canonicalJson(parameters ?? null);
      // A committed adoption/publication is an immutable fact, not a new eligibility claim.
      // Later adoption/publication still rechecks the current goal against actual content.
      const committed =
        prior?.action === step.action &&
        prior?.deliveryId === step.deliveryId &&
        prior.status === "executed" &&
        ((prior.action.startsWith("request_") && prior.receipt?.proposalId) ||
          (prior.action === "create_draft" && prior.receipt?.draftId) ||
          ([
            "submit_processing",
            "generate_candidates",
            "refine_candidates",
            "retry_processing",
          ].includes(prior.action) &&
            prior.receipt?.runId)) &&
        canonicalJson(
          prior.input?.source
            ? { ...prior.input, source: planSource(prior.input.source) }
            : (prior.input ?? null),
        ) === canonicalJson(parameters ?? null);
      const saved =
        prior?.status === "executed" &&
        prior.action === step.action &&
        prior.deliveryId === step.deliveryId &&
        savedDeliveries.has(step.deliveryId);
      return prefix || committed || saved
        ? {
            ...prior!,
            title: step.title,
            question: step.question,
            boundaryVersion: step.boundaryVersion,
            revision,
            ...(step.deliveryId ? { deliveryId: step.deliveryId } : {}),
            ...(step.countKind ? { countKind: step.countKind } : {}),
          }
        : {
            title: step.title,
            question: step.question,
            boundaryVersion: step.boundaryVersion,
            action: step.action,
            ...(step.deliveryId ? { deliveryId: step.deliveryId } : {}),
            ...(step.countKind ? { countKind: step.countKind } : {}),
            scope: step.scope,
            id: opaqueId("step"),
            revision,
            input: parameters,
            status: "pending" as const,
          };
    }) ??
    previous?.steps ??
    [];
  return selectPlanStep({
    ...(previous?.contractVersion
      ? { contractVersion: previous.contractVersion }
      : {}),
    mode: input.executionMode ?? previous?.mode ?? "plan",
    target,
    requirementsKey,
    needsReview: false,
    steps,
    current:
      steps.findIndex((step) => step.status !== "executed") < 0
        ? steps.length
        : steps.findIndex((step) => step.status !== "executed"),
  });
}

/** A model tool receipt is evidence of execution, not evidence of semantic quality. */
export function advancePlan(
  plan: ExecutionPlan | undefined,
  action: string,
  value: Record<string, any>,
  key: string,
  revision?: number,
  input?: Record<string, any>,
): ExecutionPlan | undefined {
  if (!plan || plan.mode !== "execute" || plan.needsReview) return plan;
  const step = plan.steps[plan.current];
  if (!step) return plan;
  if (step.revision !== undefined && step.revision !== revision) return plan;
  const expectedInput =
    plan.contractVersion === 1 && step.deliveryId
      ? resolvedStepInput(plan)
      : step.input;
  if (
    action === step.action &&
    expectedInput &&
    input &&
    Object.entries(expectedInput).some(
      ([field, expected]) =>
        !(
          action === "read_background" &&
          step.scope === "all" &&
          ["from", "limit"].includes(field)
        ) &&
        canonicalJson(field === "source" ? planSource(expected) : expected) !==
          canonicalJson(
            (field === "source" ? planSource(input[field]) : input[field]) ??
              null,
          ),
    )
  )
    return plan;
  if (
    action === step.action &&
    action === "read_background" &&
    step.scope === "all"
  ) {
    if ((step.input?.query ?? null) !== (input?.query ?? null)) return plan;
    const identity = canonicalJson({
      documentId: value.id,
      sha256: value.sha256 ?? null,
      query: input?.query ?? null,
    });
    const indices = [
      ...new Set([
        ...(step.backgroundRead?.identity === identity
          ? step.backgroundRead.indices
          : []),
        ...(value.fragments ?? []).map(
          (fragment: { index: number }) => fragment.index,
        ),
      ]),
    ];
    const total = value.matchCount ?? value.fragmentCount;
    if (
      !Number.isInteger(total) ||
      total < 1 ||
      indices.length !== total ||
      value.nextFrom !== null
    )
      return {
        ...plan,
        steps: plan.steps.map((item, index) =>
          index === plan.current
            ? { ...item, backgroundRead: { identity, indices } }
            : item,
        ),
      };
  }
  if (
    action === "read_records" &&
    step.scope === "all" &&
    (value.offset !== 0 ||
      value.readCount !== value.matchingTotal ||
      canonicalJson(step.input?.conditions ?? []) !==
        canonicalJson(input?.conditions ?? []) ||
      (!step.input?.conditions?.length &&
        !step.input?.selection &&
        value.readCount !== value.total))
  )
    return plan;
  if (["read_records", "submit_processing"].includes(action)) {
    const source = value.source ?? input?.source;
    const expected = step.input?.source ?? plan.target;
    if (
      !expected ||
      !source ||
      canonicalJson(planSource(source)) !== canonicalJson(planSource(expected))
    )
      return plan;
  }
  const processing = [
    "submit_processing",
    "generate_candidates",
    "refine_candidates",
    "retry_processing",
  ].includes(step.action);
  const completedRun =
    processing &&
    step.status === "waiting" &&
    action === "read_processing" &&
    value.runId === step.receipt?.runId &&
    ((value.status === "succeeded" &&
      value.partial === false &&
      value.missingCount === 0) ||
      (value.executionComplete === true &&
        value.missingCount === 0 &&
        value.review?.emptyQuestions === 0 &&
        value.review?.formatIssueCount === 0 &&
        value.review?.outsideLabels === 0 &&
        value.review?.protectedFieldChanges === 0 &&
        (plan.steps[plan.current + 1]?.action === "read_processing" ||
          (plan.steps[plan.current + 1]?.action === "select_candidates" &&
            plan.steps[plan.current + 1]?.input?.deduplicate === true))));
  const confirmation = step.action.startsWith("request_");
  const confirmed =
    confirmation &&
    step.status === "waiting" &&
    action === "confirmed" &&
    value.id === step.receipt?.proposalId &&
    value.status === "succeeded" &&
    value.receipt;
  if (step.action !== action && !completedRun && !confirmed) return plan;
  if (step.status === "waiting" && !completedRun && !confirmed) return plan;
  const waiting =
    (processing || (confirmation && !value.alreadyAdopted)) &&
    !completedRun &&
    !confirmed;
  return selectPlanStep({
    ...plan,
    current: waiting ? plan.current : plan.current + 1,
    steps: plan.steps.map((item, index) =>
      index === plan.current
        ? {
            ...item,
            status: waiting ? "waiting" : "executed",
            receipt:
              completedRun || confirmed
                ? {
                    ...item.receipt!,
                    ...(confirmed &&
                    (value.receipt.receipt?.draftId ?? value.receipt.draftId)
                      ? {
                          draftId:
                            value.receipt.receipt?.draftId ??
                            value.receipt.draftId,
                        }
                      : {}),
                  }
                : {
                    key,
                    ...(value.runId ? { runId: value.runId } : {}),
                    ...(value.draftId ? { draftId: value.draftId } : {}),
                    ...(value.previewId ? { previewId: value.previewId } : {}),
                    ...(confirmation && value.id
                      ? { proposalId: value.id }
                      : {}),
                  },
          }
        : item,
    ),
  });
}

export function pendingPlanAction(
  plan: ExecutionPlan | undefined,
): string | undefined {
  if (plan?.mode !== "execute") return;
  if (plan.needsReview || pendingDeliveryQuestion(plan)) return;
  const step = plan.steps[plan.current];
  return step?.status === "pending" ? step.action : undefined;
}

/** The executor and domain receipt callbacks project the same persisted step facts. */
export function settleExecutionPlan(
  task: Record<string, any>,
  action: string,
  value: Record<string, any>,
  key: string,
  revision?: number,
  input?: Record<string, any>,
) {
  const previous: ExecutionPlan | undefined = task.executionPlan;
  const plan = advancePlan(
    previous && !previous.target && task.target
      ? { ...previous, target: task.target }
      : previous,
    action,
    value,
    key,
    revision,
    input,
  );
  const question = task.question || pendingDeliveryQuestion(plan);
  return {
    executionPlan: plan,
    ...(question ? { question, stage: "waiting_input" } : {}),
    nextAction:
      !question && !task.executionPaused
        ? (pendingPlanAction(plan) ?? null)
        : null,
  };
}

/** Bind dependencies only to committed receipts in this plan, never to a session's latest object. */
export function resolvedStepInput(
  plan: ExecutionPlan | undefined,
  supplied?: Record<string, any>,
) {
  const step = plan?.steps[plan.current];
  const input = {
    ...(step?.operation?.input ?? step?.input ?? {}),
    ...(supplied ?? {}),
  };
  if (!plan || !step) return input;
  const delivery = plan.contractVersion === 1 && step.deliveryId;
  const receipts = plan.steps
    .slice(0, plan.current)
    .filter(
      (prior) =>
        prior.status !== "pending" &&
        (!delivery || prior.deliveryId === delivery),
    )
    .reverse();
  if (step.action === "request_selection_apply") {
    // A preview belongs to exactly one draft; do not combine independent latest receipts.
    const preview = receipts.find(
      (prior) =>
        prior.status === "executed" &&
        prior.receipt?.previewId &&
        prior.receipt.draftId &&
        (!input.previewId || input.previewId === prior.receipt.previewId) &&
        (!input.draftId || input.draftId === prior.receipt.draftId),
    )?.receipt;
    if (preview) {
      input.draftId ??= preview.draftId;
      input.previewId ??= preview.previewId;
    }
    return input;
  }
  const fields =
    step.action === "preview_selection" || step.action === "request_publish"
      ? ["draftId"]
      : step.action === "request_selection_apply"
        ? ["draftId", "previewId"]
        : [
              "read_processing",
              "select_candidates",
              "refine_candidates",
              "retry_processing",
              "request_processing_apply",
            ].includes(step.action)
          ? ["runId"]
          : [];
  for (const field of fields) {
    if (input[field]) continue;
    const receipt = receipts.find(
      (prior) => prior.receipt?.[field as keyof NonNullable<Step["receipt"]>],
    );
    const value =
      receipt?.receipt?.[field as keyof NonNullable<Step["receipt"]>];
    if (value) input[field] = value;
    else if (!delivery && field === "draftId" && plan.target?.kind === "draft")
      input[field] = plan.target.id;
  }
  if (delivery && step.action === "request_processing_apply") {
    const draftId = receipts.find((prior) => prior.receipt?.draftId)?.receipt
      ?.draftId;
    if (draftId && (!input.target || input.target.kind === "draft"))
      input.target = {
        ...(input.target ?? { kind: "draft" }),
        id: input.target?.id ?? draftId,
      };
  }
  return input;
}

export function missingStepDependency(plan: ExecutionPlan) {
  const step = plan.steps[plan.current];
  if (!step || plan.mode !== "execute") return;
  const input = resolvedStepInput(plan);
  const fields =
    step.action === "preview_selection" || step.action === "request_publish"
      ? ["draftId"]
      : step.action === "request_selection_apply"
        ? ["draftId", "previewId"]
        : [
              "read_processing",
              "select_candidates",
              "refine_candidates",
              "retry_processing",
              "request_processing_apply",
            ].includes(step.action)
          ? ["runId"]
          : [];
  return fields.find((field) => !input[field]);
}

/** Model omissions reuse current facts; explicit changes still pass the same domain guards. */
export function selectionParameters(
  supplied: Record<string, any>,
  targetCount: unknown,
) {
  const selection: Record<string, any> = {
    ...supplied,
    conditions: supplied.conditions === undefined ? [] : supplied.conditions,
  };
  if (
    selection.method === "random" &&
    selection.mode === undefined &&
    Number.isInteger(targetCount) &&
    selection.value === targetCount
  )
    selection.mode = "count";
  // Legacy nonrandom selections recorded seed:null; it has no algorithmic meaning.
  if (selection.method === "all" && selection.seed === null)
    delete selection.seed;
  return selection;
}

export function bindTaskInput(
  name: string,
  supplied: Record<string, any>,
  task: Record<string, any>,
  pageObject?: Record<string, any>,
  selection?: Record<string, any> | null,
) {
  const plan = task.executionPlan;
  const delivery =
    plan?.contractVersion === 1 &&
    plan.steps[plan.current]?.action === name &&
    plan.steps[plan.current]?.deliveryId;
  const input =
    plan?.steps[plan.current]?.action === name
      ? resolvedStepInput(plan, supplied)
      : { ...supplied };
  if (
    input.selection &&
    ["read_records", "submit_processing", "select_candidates"].includes(name)
  ) {
    input.selection = selectionParameters(input.selection, task.targetCount);
  }
  const target = Object.hasOwn(task, "target") ? task.target : pageObject;
  if (
    name === "submit_processing" &&
    !input.source &&
    target !== null &&
    task.processingScope?.source &&
    (!target || sourceWithinTask(task.processingScope.source, target))
  )
    input.source = task.processingScope.source;
  if (["read_records", "submit_processing"].includes(name) && target)
    input.source ??= planSource(target);
  if (
    [
      "read_processing",
      "select_candidates",
      "refine_candidates",
      "retry_processing",
      "request_processing_apply",
    ].includes(name) &&
    !delivery
  )
    input.runId ??=
      name === "refine_candidates" &&
      (selection?.runId || selection?.groups?.[0]?.runId)
        ? (selection.runId ?? selection.groups[0].runId)
        : task.runId;
  const draftId = !delivery
    ? (task.targetDraftId ??
      (target?.kind === "draft" ? target.id : task.createdDraftId))
    : undefined;
  if (["preview_selection", "request_publish"].includes(name))
    input.draftId ??= draftId;
  if (name === "request_processing_apply" && draftId) {
    input.target ??= { kind: "draft", id: draftId };
    if (input.target.kind === "draft")
      input.target = { ...input.target, id: input.target.id ?? draftId };
  }
  if (name === "request_processing_apply") {
    if (
      selection?.scope === "task" &&
      input.resultIds === undefined &&
      input.allSelected === undefined &&
      input.allValid === undefined &&
      input.allTask === undefined
    )
      input.allSelected = true;
    else if (
      input.allValid === true &&
      input.allTask === undefined &&
      input.resultIds === undefined
    )
      input.allTask = true;
  }
  if (
    name === "refine_candidates" &&
    selection?.scope === "task" &&
    input.resultIds === undefined &&
    input.where === undefined &&
    input.allSelected === undefined &&
    input.allResults === undefined
  )
    input.allSelected = true;
  if (
    ["submit_processing", "generate_candidates"].includes(name) &&
    input.instructions === undefined
  ) {
    const requirements = normalizedRequirements(task.requirements ?? []).join(
      "\n",
    );
    if (input.operation === "clean") input.instructions = "";
    else if (requirements) {
      if (requirements.length > 8000)
        throw new RequirementError(
          "assistant_context_capacity",
          "有效要求已完整保留，但本次执行指令超过8000字符容量。请按交付或步骤拆分本轮处理；未提交任务，也未截断约束。",
        );
      input.instructions = requirements;
    }
  }
  if (["submit_processing", "refine_candidates"].includes(name)) {
    input.allowedFields ??= task.allowedFields ?? ["question"];
    if (
      name === "submit_processing" &&
      input.allowedFields.includes("metadata") &&
      task.metadataKeys
    )
      input.metadataKeys ??= task.metadataKeys;
    if (
      name === "submit_processing" &&
      input.operation === "augment" &&
      task.countKind !== "final"
    )
      input.outputCount ??= task.targetCount ?? undefined;
  }
  if (name === "generate_candidates") input.outputCount ??= task.targetCount;
  if (name === "plan_task" && input.countKind === "final")
    input.targetDraftId ??=
      task.targetDraftId ?? (target?.kind === "draft" ? target.id : undefined);
  if (name === "request_selection_apply" && task.selectionPreview) {
    input.previewId ??= task.selectionPreview.previewId;
    input.draftId ??= task.selectionPreview.draftId;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

/** Check explicit quantities in a planning request; never guess missing quantities. */
export function documentPlanCountHint(
  request: string,
  steps: { action: string; input?: Record<string, any> }[],
) {
  const generations = steps.filter(
    (step) => step.action === "generate_candidates",
  );
  if (!generations.length) return;
  const multiple = request.match(
    /((?<![.\da-z])\d+|两|[一二三四五六七八九十])\s*(?:个|种)?[^，。；;\n\d]{0,8}(?:小类|类别|分类|意图|测试集|类)[，,、\s]*(?:每类|各)[^\d，。；;\n]{0,8}(\d+)\s*条/iu,
  );
  const singles = [
    ...request.matchAll(/(?:设计|生成|规划|拟|做)\s*(\d+)\s*条/gu),
  ];
  const single =
    new Set(singles.map((match) => match[1])).size === 1
      ? singles[0]
      : undefined;
  if (!multiple && /(?:各|每类|每种)[^\d，。；;\n]{0,8}\d+\s*条/u.test(request))
    return;
  const deliveries = multiple
    ? multiple[1] === "两"
      ? 2
      : Number(multiple[1]) || "一二三四五六七八九十".indexOf(multiple[1]) + 1
    : undefined;
  const perDelivery = Number(multiple?.[2] ?? single?.[1]);
  if (
    !Number.isSafeInteger(perDelivery) ||
    perDelivery < 1 ||
    !generations.every((step) => Number.isInteger(step.input?.outputCount))
  )
    return;
  const expected = (deliveries ?? 1) * perDelivery;
  const actual = generations.reduce(
    (sum, step) => sum + step.input!.outputCount,
    0,
  );
  if (
    actual !== expected ||
    (deliveries &&
      !/(?:合并|同一个测试集|一个测试集包含)/u.test(request) &&
      (generations.length !== deliveries ||
        generations.some((step) => step.input!.outputCount !== perDelivery)))
  )
    return (
      "原用户明确要求" +
      (deliveries ? deliveries + "份各" : "") +
      perDelivery +
      "条，合计" +
      expected +
      "条；当前方案仅列" +
      generations.length +
      "份、合计" +
      actual +
      "条。请补齐所有交付的generate_candidates步骤及各自数量、分类、场景，保留完整原目标，不只保存第一类，不改成小样本。"
    );
}

/** Projection is a convenience, not an authorization boundary. Reads and correction stay available. */
export function availableTaskTools(
  task: Record<string, any>,
  write: boolean,
): string[] {
  if (!write) return ["query_project", "read_records"];
  const reads = [
    "query_project",
    "read_records",
    "read_background",
    "plan_task",
  ];
  if (task.runId) reads.push("read_processing");
  if (
    task.executionPaused ||
    task.executionPlan?.mode === "plan" ||
    task.question ||
    ["processing", "awaiting_confirmation"].includes(task.stage)
  )
    return reads;
  if (task.executionPlan?.needsReview || task.planValidationRequired)
    return reads;
  const action = pendingPlanAction(task.executionPlan) ?? task.nextAction;
  if (action && !["any", "none", "plan_task"].includes(action))
    return [...new Set([...reads, action])];
  if (task.runId && task.stage === "awaiting_review")
    return [
      ...reads,
      "select_candidates",
      "refine_candidates",
      "retry_processing",
      "request_processing_apply",
      "request_publish",
    ];
  return [
    ...reads,
    "create_draft",
    "preview_selection",
    "submit_processing",
    "generate_candidates",
    ...(task.selectionPreview ? ["request_selection_apply"] : []),
    ...(task.target?.kind === "draft" || task.createdDraftId
      ? ["request_publish"]
      : []),
  ];
}
