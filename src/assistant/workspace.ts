import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { currentDeliveryId } from "./delivery-plan.js";

export type WorkspaceFacts = {
  projectId: string;
  runs: { id: string; status: string; count: number | null }[];
  drafts: { id: string; name?: string; count: number }[];
  confirmations: {
    id: string;
    status: string;
    runId?: string;
    target?: { kind: string; id?: string; name?: string };
    operationKey?: string;
    action?: string;
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
      const confirmations = facts.confirmations.filter(
        (row) =>
          proposalIds.has(row.id) || Boolean(runId && row.runId === runId),
      );
      const confirmation =
        confirmations.find((row) =>
          ["pending", "executing"].includes(row.status),
        ) ?? confirmations[0];
      const saved = confirmations.filter(
        (row, index) =>
          !confirmations
            .slice(0, index)
            .some(
              (prior) =>
                prior.status === "succeeded" &&
                canonicalJson(prior.receipt) === canonicalJson(row.receipt),
            ) &&
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
      const fullSave = saved.length > 0 && satisfied;
      const active = currentDelivery === goal.deliveryId;
      const status = goal.question
        ? "waiting_input"
        : fullSave
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
                          ["queued", "running", "retry_wait"].includes(
                            run.status,
                          )
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
        ...(goal.question ? { question: goal.question } : {}),
        status,
        generatedCount: run?.count ?? null,
        savedCount,
        confirmed: saved.length > 0,
        confirmationStatus: confirmation?.status ?? "none",
        ...(["pending", "executing"].includes(confirmation?.status ?? "")
          ? {
              pendingSaveName:
                confirmation?.target?.kind === "newDraft"
                  ? confirmation.target.name
                  : facts.drafts.find(
                      (row) => row.id === confirmation?.target?.id,
                    )?.name,
            }
          : {}),
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
                name: draft.name,
                count: draft.count,
                url: `/projects/${facts.projectId}/test-sets/drafts/${draft.id}`,
              },
            }
          : {}),
      };
    });
}

/** Presentation only: committed receipts survive later revisions; pending cards do not. */
export function confirmationStatus(
  proposal: Record<string, any>,
  session: Record<string, any>,
  now = Date.now(),
) {
  if (proposal.status === "succeeded" && !proposal.receipt) return "unverified";
  if (proposal.status !== "pending") return proposal.status;
  if (
    session.task?.stage === "stopped" ||
    proposal.task_revision !== session.task_revision
  )
    return "invalid";
  if (new Date(proposal.expires_at).getTime() <= now) return "expired";
  return "pending";
}

export async function readWorkspaceFacts(
  db: Pick<Database, "query">,
  scope: { projectId: string; actorId: string },
  session: Record<string, any>,
): Promise<WorkspaceFacts | undefined> {
  const planSteps = session.task?.executionPlan?.steps ?? [];
  const refs = (field: string) => [
    ...new Set(
      planSteps
        .flatMap((step: any) => [
          step.receipt?.[field],
          ...(field === "draftId"
            ? [
                step.input?.draftId,
                step.input?.target?.kind === "draft"
                  ? step.input.target.id
                  : undefined,
              ]
            : []),
        ])
        .filter(Boolean),
    ),
  ];
  return planSteps.length > 0
    ? await Promise.all([
        db.query(
          `SELECT r.id,coalesce(lj.status,j.status) AS status,
          t.latest_run_id,t.applied_run_id,t.applied_hash,
          CASE WHEN t.id IS NOT NULL THEN jsonb_array_length(t.current_refs)
          ELSE coalesce((SELECT sum(b.output_count)::int FROM processing_batch b WHERE b.run_id=r.id AND b.result_ref IS NOT NULL),0) END AS count,
          coalesce((SELECT jsonb_agg(jsonb_build_object('result_ref',b.result_ref,'result_indices',b.result_indices,'issues',b.issues) ORDER BY b.ordinal) FROM processing_batch b WHERE b.run_id=latest.id),'[]'::jsonb) AS batches
         FROM processing_run r JOIN job j ON j.id=r.job_id
         LEFT JOIN processing_task t ON t.id=r.task_id
         LEFT JOIN processing_run latest ON latest.id=t.latest_run_id
         LEFT JOIN job lj ON lj.id=latest.job_id
         WHERE r.project_id=$1 AND r.actor_id=$2 AND r.id=ANY($3::text[])`,
          [scope.projectId, scope.actorId, refs("runId")],
        ),
        db.query(
          `SELECT d.id,d.name,(SELECT count(*)::int FROM collaborative_draft_record r WHERE r.draft_id=d.id AND NOT r.deleted) AS count
         FROM collaborative_draft d WHERE d.project_id=$1 AND d.id=ANY($2::text[])`,
          [scope.projectId, refs("draftId")],
        ),
        db.query(
          `SELECT p.id,p.action,p.status,p.summary,p.receipt,p.task_revision,p.expires_at,p.parameters->'target' AS target,p.parameters->>'runId' AS "runId",p.parameters->>'draftId' AS "draftId"
          FROM assistant_proposal p JOIN assistant_turn t ON t.id=p.turn_id
          WHERE p.session_id=$1 AND p.project_id=$2 AND p.actor_id=$3
          AND coalesce(t.task_id,'legacy:'||t.session_id)=$6
          AND (p.id=ANY($4::text[]) OR p.parameters->>'runId'=ANY($5::text[]) OR p.parameters->>'draftId'=ANY($7::text[]))
          ORDER BY p.created_at DESC,p.id DESC`,
          [
            session.id,
            scope.projectId,
            scope.actorId,
            refs("proposalId"),
            refs("runId"),
            session.task?.taskId ?? "legacy:" + session.id,
            refs("draftId"),
          ],
        ),
      ]).then(([runs, drafts, confirmations]) => ({
        projectId: scope.projectId,
        runs: runs.rows.map((run) => ({
          id: run.id,
          status: run.status,
          count:
            !run.latest_run_id ||
            (run.applied_run_id === run.latest_run_id &&
              run.applied_hash ===
                sha256(
                  canonicalJson({ status: run.status, batches: run.batches }),
                ))
              ? run.count
              : null,
        })),
        drafts: drafts.rows,
        confirmations: confirmations.rows.map((p) => ({
          ...p,
          operationKey: p.action + ":" + (p.runId ?? p.draftId ?? p.id),
          status: confirmationStatus(p, session),
        })),
      }))
    : undefined;
}
