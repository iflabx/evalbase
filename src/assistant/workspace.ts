import { currentDeliveryId } from "./delivery-plan.js";

export type WorkspaceFacts = {
  projectId: string;
  runs: { id: string; status: string; count: number | null }[];
  drafts: { id: string; count: number }[];
  confirmations: {
    id: string;
    status: string;
    summary?: Record<string, any>;
    receipt?: Record<string, any>;
  }[];
};

/** A read-only view of saved goals and domain receipts, never another progress writer. */
export function deliveryProgress(
  task: Record<string, any>,
  facts: WorkspaceFacts,
) {
  const plan = task.executionPlan;
  if (plan?.contractVersion !== 1) return;
  const currentDelivery = currentDeliveryId(plan);
  return plan.steps
    .filter(
      (step: any) => step.action === "generate_candidates" && step.deliveryId,
    )
    .map((goal: any) => {
      const steps = plan.steps.filter(
        (step: any) => step.deliveryId === goal.deliveryId,
      );
      const draftId = steps.findLast((step: any) => step.receipt?.draftId)
        ?.receipt.draftId;
      const runId = steps.findLast((step: any) => step.receipt?.runId)?.receipt
        .runId;
      const run = facts.runs.find((row) => row.id === runId);
      const draft = facts.drafts.find((row) => row.id === draftId);
      const proposalIds = new Set(
        steps
          .filter((step: any) => step.action === "request_processing_apply")
          .map((step: any) => step.receipt?.proposalId)
          .filter(Boolean),
      );
      const confirmations = facts.confirmations.filter((row) =>
        proposalIds.has(row.id),
      );
      const saved = confirmations.filter(
        (row) =>
          row.status === "succeeded" &&
          Boolean(row.receipt?.receipt?.draftId) &&
          row.receipt?.receipt?.draftId === draftId,
      );
      const savedCount = saved.reduce(
        (count, row) => count + Number(row.receipt?.receipt?.adopted ?? 0),
        0,
      );
      const countKind = goal.countKind ?? "new";
      const satisfied =
        (countKind === "final" ? (draft?.count ?? 0) : savedCount) >=
        goal.input.outputCount;
      const fullSave =
        saved.length > 0 &&
        satisfied &&
        saved.every((row) => row.summary?.range !== "partial");
      const active = currentDelivery === goal.deliveryId;
      const status = fullSave
        ? "saved"
        : savedCount > 0
          ? "partially_saved"
          : task.stage === "stopped"
            ? "stopped"
            : active && task.executionPaused && plan.mode !== "plan"
              ? "paused"
              : active && plan.needsReview
                ? "needs_review"
                : (active && task.stage === "failed") ||
                    (run && ["failed", "cancelled"].includes(run.status))
                  ? "failed"
                  : confirmations.some((row) =>
                        ["pending", "executing"].includes(row.status),
                      )
                    ? "awaiting_confirmation"
                    : run &&
                        ["queued", "running", "retry_wait"].includes(run.status)
                      ? "processing"
                      : run?.status === "succeeded"
                        ? "awaiting_review"
                        : plan.mode === "plan"
                          ? "planned"
                          : "pending";
      return {
        id: goal.deliveryId,
        name: goal.input.name,
        count: goal.input.outputCount,
        countKind,
        status,
        generatedCount: run?.count ?? null,
        savedCount,
        confirmed: saved.length > 0,
        ...(run
          ? {
              run: {
                id: run.id,
                status: run.status,
                url: `/projects/${facts.projectId}/processing?run=${run.id}`,
              },
            }
          : {}),
        ...(draft
          ? {
              draft: {
                id: draft.id,
                count: draft.count,
                url: `/projects/${facts.projectId}/test-sets/drafts/${draft.id}`,
              },
            }
          : {}),
      };
    });
}
