import { canonicalJson, sha256 } from "../package/contract.js";
import { opaqueId } from "../server/support.js";
import { normalizedRequirements } from "./requirements.js";

export const PLAN_ACTIONS = [
  "query_project",
  "read_records",
  "read_background",
  "create_draft",
  "preview_selection",
  "submit_processing",
  "select_candidates",
  "refine_candidates",
  "retry_processing",
  "read_processing",
  "request_selection_apply",
  "request_processing_apply",
  "request_publish",
] as const;

type Step = {
  id?: string;
  revision?: number;
  title: string;
  action: string;
  input?: Record<string, any>;
  scope?: "preview" | "all";
  operation?: { key: string; input: Record<string, any> };
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

export function planRequirementsKey(task: Record<string, any>, legacy = false) {
  return sha256(
    canonicalJson(
      Object.fromEntries(
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
    ),
  );
}

/** Changed steps invalidate subsequent receipts; unchanged prefixes keep their facts. */
export function revisePlan(
  previous: ExecutionPlan | undefined,
  input: {
    executionMode?: "plan" | "execute";
    steps?: {
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
  let prefix = previous?.requirementsKey === requirementsKey;
  const steps =
    (input.steps ?? previous?.steps)?.map((step, index) => {
      const prior = previous?.steps[index];
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
        prior.status === "executed" &&
        ((prior.action.startsWith("request_") && prior.receipt?.proposalId) ||
          (prior.action === "create_draft" && prior.receipt?.draftId) ||
          ([
            "submit_processing",
            "refine_candidates",
            "retry_processing",
          ].includes(prior.action) &&
            prior.receipt?.runId)) &&
        canonicalJson(
          prior.input?.source
            ? { ...prior.input, source: planSource(prior.input.source) }
            : (prior.input ?? null),
        ) === canonicalJson(parameters ?? null);
      return prefix || committed
        ? { ...prior!, title: step.title, revision }
        : {
            title: step.title,
            action: step.action,
            scope: step.scope,
            id: opaqueId("step"),
            revision,
            input: parameters,
            status: "pending" as const,
          };
    }) ??
    previous?.steps ??
    [];
  return {
    mode: input.executionMode ?? previous?.mode ?? "plan",
    target,
    requirementsKey,
    needsReview: false,
    steps,
    current:
      steps.findIndex((step) => step.status !== "executed") < 0
        ? steps.length
        : steps.findIndex((step) => step.status !== "executed"),
  };
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
  if (
    action === step.action &&
    step.input &&
    input &&
    Object.entries(step.input).some(
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
    "refine_candidates",
    "retry_processing",
  ].includes(step.action);
  const completedRun =
    processing &&
    step.status === "waiting" &&
    action === "read_processing" &&
    value.runId === step.receipt?.runId &&
    value.status === "succeeded" &&
    value.partial === false &&
    value.missingCount === 0;
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
  return {
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
  };
}

export function pendingPlanAction(
  plan: ExecutionPlan | undefined,
): string | undefined {
  if (plan?.mode !== "execute") return;
  if (plan.needsReview) return;
  const step = plan.steps[plan.current];
  return step?.status === "pending" ? step.action : undefined;
}

/** Bind dependencies only to committed receipts in this plan, never to a session's latest object. */
export function resolvedStepInput(
  plan: ExecutionPlan | undefined,
  supplied?: Record<string, any>,
) {
  const step = plan?.steps[plan.current];
  const input = { ...(step?.input ?? {}), ...(supplied ?? {}) };
  if (!plan || !step) return input;
  if (step.action === "request_selection_apply") {
    // A preview belongs to exactly one draft; do not combine independent latest receipts.
    const preview = plan.steps
      .slice(0, plan.current)
      .reverse()
      .find(
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
    const receipt = plan.steps
      .slice(0, plan.current)
      .reverse()
      .find(
        (prior) =>
          prior.status !== "pending" &&
          prior.receipt?.[field as keyof NonNullable<Step["receipt"]>],
      );
    const value =
      receipt?.receipt?.[field as keyof NonNullable<Step["receipt"]>];
    if (value) input[field] = value;
    else if (field === "draftId" && plan.target?.kind === "draft")
      input[field] = plan.target.id;
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
export function bindTaskInput(
  name: string,
  supplied: Record<string, any>,
  task: Record<string, any>,
  pageObject?: Record<string, any>,
  selection?: Record<string, any> | null,
) {
  const plan = task.executionPlan;
  const input =
    plan?.steps[plan.current]?.action === name
      ? resolvedStepInput(plan, supplied)
      : { ...supplied };
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
    ].includes(name)
  )
    input.runId ??=
      name === "refine_candidates" &&
      (selection?.runId || selection?.groups?.[0]?.runId)
        ? (selection.runId ?? selection.groups[0].runId)
        : task.runId;
  const draftId =
    task.targetDraftId ??
    (target?.kind === "draft" ? target.id : task.createdDraftId);
  if (["preview_selection", "request_publish"].includes(name))
    input.draftId ??= draftId;
  if (name === "request_processing_apply" && draftId) {
    input.target ??= { kind: "draft", id: draftId };
    if (input.target.kind === "draft") input.target.id ??= draftId;
  }
  if (name === "request_processing_apply") {
    if (selection?.scope === "task" && input.resultIds === undefined)
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
    input.where === undefined
  )
    input.allSelected = true;
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
    ...(task.selectionPreview ? ["request_selection_apply"] : []),
    ...(task.target?.kind === "draft" || task.createdDraftId
      ? ["request_publish"]
      : []),
  ];
}
