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
  title: string;
  action: string;
  status: "pending" | "waiting" | "executed";
  receipt?: {
    key: string;
    runId?: string;
    draftId?: string;
    proposalId?: string;
  };
};
export type ExecutionPlan = {
  mode: "plan" | "execute";
  steps: Step[];
  current: number;
};

/** Changed steps invalidate subsequent receipts; unchanged prefixes keep their facts. */
export function revisePlan(
  previous: ExecutionPlan | undefined,
  input: {
    executionMode?: "plan" | "execute";
    steps?: { title: string; action: string }[];
  },
): ExecutionPlan | undefined {
  if (!input.executionMode && !input.steps) return previous;
  let prefix = true;
  const steps =
    input.steps?.map((step, index) => {
      const prior = previous?.steps[index];
      prefix =
        prefix && prior?.title === step.title && prior?.action === step.action;
      return prefix ? prior! : { ...step, status: "pending" as const };
    }) ??
    previous?.steps ??
    [];
  return {
    mode: input.executionMode ?? previous?.mode ?? "plan",
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
): ExecutionPlan | undefined {
  if (!plan || plan.mode !== "execute") return plan;
  const step = plan.steps[plan.current];
  if (!step) return plan;
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
    value.status === "succeeded";
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
    ((processing && value.status !== "succeeded") ||
      (confirmation && !value.alreadyAdopted)) &&
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
                ? item.receipt!
                : {
                    key,
                    ...(value.runId ? { runId: value.runId } : {}),
                    ...(value.draftId ? { draftId: value.draftId } : {}),
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
  const step = plan.steps[plan.current];
  return step?.status === "pending" ? step.action : undefined;
}
