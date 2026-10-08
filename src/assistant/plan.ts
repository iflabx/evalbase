import { canonicalJson, sha256 } from "../package/contract.js";
import { opaqueId } from "../server/support.js";

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
  target?: Record<string, any>;
};

/** Asset-page context and processing sources refer to the same real asset. */
export function planSource(source: Record<string, any> | undefined) {
  return source?.kind === "asset"
    ? { kind: "assets", assetIds: [source.id] }
    : source;
}

export function planRequirementsKey(task: Record<string, any>) {
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
          .filter((field) => task[field] !== undefined)
          .map((field) => [field, task[field]]),
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
  target?: Record<string, any>,
  requirementsKey?: string,
): ExecutionPlan | undefined {
  if (!input.executionMode && !input.steps) return previous;
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
        target
          ? { ...step.input, source: planSource(target) }
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
        canonicalJson(prior?.input ?? null) ===
          canonicalJson(parameters ?? null);
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
        canonicalJson(prior.input ?? null) ===
          canonicalJson(parameters ?? null);
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
