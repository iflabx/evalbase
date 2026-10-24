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
  return receipt && hasNoEffect(receipt) && receipt.input && receipt.error?.code
    ? {
        name: "plan_task",
        kind: "context" as const,
        proposal: receipt.input,
        reason: receipt.error,
        issues: receipt.error.issues ?? [],
      }
    : undefined;
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
