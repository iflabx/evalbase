import { canonicalJson } from "../package/contract.js";
import type { Database } from "../db/pool.js";
import { settleExecutionPlan } from "./plan.js";
import { readTools } from "./intent.js";
// These failures occur before a domain commit (or roll its transaction back).
// Unknown failures keep the operation binding until a real receipt is reconciled.
const validationWithoutEffect = new Set([
  "assistant_tool_input_invalid",
  "assistant_plan_clarification_unnecessary",
  "processing_scope_invalid",
  "processing_configuration_invalid",
  "processing_capacity_exceeded",
  "test_set_capacity_exceeded",
  "assistant_document_range",
  "assistant_background_required",
  "assistant_delivery_pending",
  "assistant_background_not_read",
  "assistant_background_rule_mismatch",
  "assistant_background_reference_invalid",
  "assistant_requirement_conflict",
  "assistant_candidate_selection_invalid",
  "assistant_plan_count_conflict",
  "assistant_plan_content_conflict",
  "model_connection_unavailable",
]);
export const processingProposalValidationWithoutEffect = new Set([
  "processing_result_invalid",
  "assistant_candidate_review_incomplete",
]);
export function hasNoEffect(record: Record<string, any>) {
  if (["partial", "committed", "unknown"].includes(record.effect)) return false;
  return (
    record.effect === "none" ||
    (record.status === "failed" &&
      (validationWithoutEffect.has(record.error?.code) ||
        // A plan reference check can save control state, but performs no domain command.
        (record.name === "plan_task" &&
          record.error?.code === "assistant_context_unavailable") ||
        // Candidate lookup 404s precede the shared refinement transaction commit;
        // its post-commit dependency checks use a different error code.
        (record.name === "refine_candidates" &&
          record.error?.code === "processing_not_found") ||
        (["request_processing_apply", "request_publish"].includes(
          record.name,
        ) &&
          processingProposalValidationWithoutEffect.has(record.error?.code))))
  );
}
/** A correction may supersede a proven no-effect wrong proposal for the same draft/revision. */
export function resolvedProposalFailures(
  records: Record<string, any>[],
  name: string,
  input: Record<string, any>,
  binding: Record<string, any>,
) {
  return name === "request_processing_apply"
    ? records
        .filter(
          (r) =>
            r.name === "request_publish" &&
            r.status === "failed" &&
            hasNoEffect(r) &&
            r.input?.draftId === input.target?.id &&
            canonicalJson(r.binding ?? null) === canonicalJson(binding ?? null),
        )
        .map((r) => r.key)
    : [];
}
export function unresolvedFailure(records: Record<string, any>[]) {
  return records.findLast(
    (record, index) =>
      record.status === "failed" &&
      !records
        .slice(index + 1)
        .some(
          (later) =>
            (later.name === record.name ||
              (hasNoEffect(record) && later.resolves?.includes(record.key))) &&
            later.status === "succeeded" &&
            (later.key === record.key ||
              (hasNoEffect(record) &&
                canonicalJson(record.binding ?? null) ===
                  canonicalJson(later.binding ?? null))),
        ),
  );
}

/** A saved clarification may finish from its receipt, never by guessing a new answer. */
export function savedPlanningQuestion(
  task: Record<string, any>,
  records: Record<string, any>[],
  mode: string | undefined,
) {
  const latest = records.findLast((item) => item.name === "plan_task");
  return Boolean(
    latest?.status === "succeeded" &&
    !latest.result?.unchanged &&
    task.question &&
    latest.result?.task?.question === task.question &&
    !["query", "pause"].includes(mode ?? "query") &&
    !unresolvedFailure(records) &&
    records.every((r) => r.name === "plan_task" || readTools.includes(r.name)),
  );
}

/** Reconcile committed confirmations only; this never invokes tools or grants another turn. */
export async function reconcileExecutionConfirmations(
  db: Pick<Database, "query">,
  session: {
    id: string;
    project_id: string;
    actor_id: string;
    task_revision: number;
    task: Record<string, any>;
  },
) {
  let task = session.task;
  const plan = task.executionPlan;
  if (
    (!plan?.steps?.length ||
      plan.steps.every((step: any) => step.status === "executed")) &&
    task.runId &&
    !task.executionPaused &&
    !task.question &&
    task.checkedStatus === "succeeded"
  ) {
    const saved = (
      await db.query(
        "SELECT id FROM assistant_proposal WHERE session_id=$1 AND project_id=$2 AND actor_id=$3 AND task_revision=$4 AND action='processing' AND status='succeeded' AND receipt IS NOT NULL AND parameters->>'runId'=$5 AND summary->>'range'='task'",
        [
          session.id,
          session.project_id,
          session.actor_id,
          session.task_revision,
          task.runId,
        ],
      )
    ).rows[0];
    if (
      saved &&
      !task.requirementProblem &&
      !task.planValidationRequired &&
      !(task.turnControl?.requiresUpdate && !task.turnControl.updateSaved)
    ) {
      const latest = (
        await db.query(
          "SELECT tool_results FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [session.id],
        )
      ).rows[0];
      if (!unresolvedFailure(latest?.tool_results ?? []))
        return {
          ...task,
          stage: "complete",
          nextAction: null,
          error: null,
          recovery: null,
        };
    }
  }
  if (
    plan?.contractVersion !== 1 ||
    plan.mode !== "execute" ||
    plan.needsReview ||
    task.stage === "stopped"
  )
    return task;
  const steps = plan.steps.filter((step: any) =>
    step.action.startsWith("request_"),
  );
  const ids = steps
    .map((step: any) => step.receipt?.proposalId)
    .filter(Boolean);
  if (!ids.length) return task;
  const facts = (
    await db.query(
      "SELECT id,status,summary,receipt,task_revision FROM assistant_proposal WHERE session_id=$1 AND project_id=$2 AND actor_id=$3 AND id=ANY($4::text[])",
      [session.id, session.project_id, session.actor_id, ids],
    )
  ).rows;
  const validReceipt = (step: any, fact: any) => {
    if (!fact || fact.status !== "succeeded" || !fact.receipt) return false;
    if (step.action !== "request_processing_apply") return true;
    const saved = fact.receipt.receipt ?? fact.receipt;
    const goal = plan.steps.find(
      (item: any) =>
        item.deliveryId === step.deliveryId &&
        item.action === "generate_candidates",
    );
    const expectedDraft = step.receipt?.draftId ?? goal?.receipt?.draftId;
    return Boolean(
      saved?.draftId &&
      (!expectedDraft || saved.draftId === expectedDraft) &&
      (!goal ||
        goal.countKind === "final" ||
        fact.summary?.range === "partial" ||
        Number(saved.adopted) >= goal.input.outputCount),
    );
  };
  const waiting = plan.steps[plan.current];
  if (waiting?.status === "waiting" && waiting.action.startsWith("request_")) {
    const fact = facts.find(
      (row) =>
        row.id === waiting.receipt?.proposalId &&
        row.task_revision === session.task_revision &&
        validReceipt(waiting, row),
    );
    if (fact) {
      const settled = settleExecutionPlan(
        task,
        "confirmed",
        fact,
        waiting.receipt.key,
        session.task_revision,
      );
      if (settled.executionPlan !== task.executionPlan)
        task = { ...task, ...settled };
    }
  }
  const current = task.executionPlan;
  const complete =
    !task.executionPaused &&
    !task.question &&
    !current.steps.some((step: any) => step.question) &&
    current.steps.length > 0 &&
    current.steps.every((step: any) => step.status === "executed") &&
    current.steps.at(-1).action.startsWith("request_") &&
    steps.length === ids.length &&
    facts.length === ids.length &&
    facts.every(
      (row) =>
        row.status === "succeeded" &&
        row.receipt &&
        row.summary?.range !== "partial",
    ) &&
    steps.every((step: any) =>
      validReceipt(
        step,
        facts.find((row) => row.id === step.receipt?.proposalId),
      ),
    );
  if (complete && task.stage !== "complete") {
    const latest = (
      await db.query(
        "SELECT tool_results FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [session.id],
      )
    ).rows[0];
    if (!unresolvedFailure(latest?.tool_results ?? []))
      task = {
        ...task,
        stage: "complete",
        nextAction: null,
        error: null,
        recovery: null,
      };
  }
  return task;
}
