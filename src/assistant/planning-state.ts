import { hasNoEffect, unresolvedFailure } from "./receipts.js";
/** Planning facts are separate from unanswered business questions and control receipts. */
export function answeredPlanningQuestion(task: Record<string, any>) {
  const clarification = task.planningClarification;
  return Boolean(
    task.question &&
    clarification?.question === task.question &&
    clarification.answerTurnId &&
    clarification.answer,
  );
}
export function planningRequestFacts(task: Record<string, any>) {
  return {
    ...(task.goal ? { originalRequest: task.goal } : {}),
    supplements: task.supplements ?? [],
    clarificationAnswers: answeredPlanningQuestion(task)
      ? [task.planningClarification.answer]
      : [],
    ...(answeredPlanningQuestion(task)
      ? { answeredQuestion: task.planningClarification }
      : {}),
  };
}
/** Reuse a validated no-effect failure; successful controls are not replacement proposals. */
export function recoverPlanningFailure(receipts: Record<string, any>[]) {
  const receipt = unresolvedFailure(
    receipts.filter(
      (r) =>
        r.name === "plan_task" &&
        (r.status !== "succeeded" ||
          (!r.result?.unchanged &&
            !r.input?.question &&
            (r.input?.steps?.length ||
              r.input?.deliveries?.length ||
              r.result?.task?.executionPlan?.steps?.length))),
    ),
  );
  if (
    !receipt ||
    !hasNoEffect(receipt) ||
    !receipt.input ||
    !receipt.error?.code
  )
    return undefined;
  let proposal = receipt.input;
  if (!Array.isArray(proposal.deliveries) && !Array.isArray(proposal.steps)) {
    for (let i = receipts.indexOf(receipt) - 1; i >= 0; i--) {
      const prior = receipts[i]!;
      if (prior.name !== "plan_task") continue;
      if (
        prior.status === "succeeded" &&
        !prior.result?.unchanged &&
        (prior.input?.deliveries || prior.input?.steps)
      )
        break;
      if (prior.status === "failed" && !hasNoEffect(prior)) break;
      if (
        prior.status === "failed" &&
        (Array.isArray(prior.input?.deliveries) ||
          Array.isArray(prior.input?.steps))
      ) {
        proposal = prior.input;
        break;
      }
    }
  }
  return {
    name: "plan_task",
    kind: "context" as const,
    proposal,
    lastInput: receipt.input,
    reason: receipt.error,
    issues: receipt.error.issues ?? [],
  };
}

/** Only a successful, server-recorded control supplies the original execution mode. */
export function savedPlanningMode(receipts: Record<string, any>[]) {
  const receipt = receipts.find(
    (r) =>
      r.name === "plan_task" &&
      r.status === "succeeded" &&
      r.input?.control &&
      ["plan", "execute"].includes(r.result?.control?.mode),
  );
  return receipt?.result.control.mode as "plan" | "execute" | undefined;
}

export function needsPlanningSubmission(
  task: Record<string, any>,
  decision: { mode: string } | undefined,
  repairing: boolean,
) {
  return Boolean(
    decision &&
    ["plan", "execute"].includes(decision.mode) &&
    (repairing ||
      (answeredPlanningQuestion(task) && !task.executionPlan?.steps?.length)),
  );
}

export function echoesPlanningRequest(
  task: Record<string, any>,
  question: string,
  request: string,
) {
  const normalized = (s: string) => s.replace(/[。？！?!\s]/gu, "");
  return [task.goal, request].some(
    (s) => typeof s === "string" && normalized(s) === normalized(question),
  );
}

export function initialDeliveryRepair(
  task: Record<string, any>,
  hasBackground: boolean,
  correcting: boolean,
) {
  return (
    correcting &&
    hasBackground &&
    !task.target &&
    !task.draftId &&
    !task.runId &&
    !task.executionPlan?.steps?.length
  );
}
