import { chargeRepairRequest } from "./tool-repair.js";
import {
  applyBudgetGrant,
  BudgetGrantError,
  progressKey,
} from "./budget-ledger.js";
import { taskIdentity } from "./task-boundary.js";
import {
  checkpointExecutionBudget,
  sentRequestCount,
  settleActiveBudget,
  type ActiveBudget,
} from "./budget.js";
import {
  backgroundVersion,
  recoveryProgress,
  recoveryProgressFacts,
  type RecoveryDecision,
} from "./recovery.js";
import type { Database } from "../db/pool.js";
import { opaqueId } from "../server/support.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { getProcessingRun } from "../processing/store.js";
import { processingRecovery } from "../processing/recovery.js";
import { reconcileExecutionConfirmations, hasNoEffect } from "./receipts.js";
import {
  assistantAccess,
  AssistantError,
  dependenciesAvailable,
  sessionRow,
  recoverProposalReceipt,
  assistantRecovery,
  type AssistantScope,
} from "./store.js";

/** Task state is independent of the model's bounded conversation history. */
export async function updateTask(
  db: Pick<Database, "query">,
  turn: Record<string, any>,
  patch: Record<string, unknown>,
  invalidateProposals = false,
) {
  const result = await db.query(
    `WITH changed AS (UPDATE assistant_session s SET task=s.task||$2::jsonb,title=coalesce($2::jsonb->>'title',s.title),updated_at=now()
    FROM assistant_turn t WHERE t.id=$1 AND t.session_id=s.id AND t.task_revision=s.task_revision
    AND t.execution_token=$3 AND t.status='running' AND t.expires_at>now() RETURNING s.id,s.task),
    invalidated AS (UPDATE assistant_proposal SET status='invalid',lease_until=NULL WHERE $4::boolean AND session_id=(SELECT id FROM changed) AND status IN('pending','executing'))
    SELECT task FROM changed`,
    [turn.id, JSON.stringify(patch), turn.execution_token, invalidateProposals],
  );
  if (!result.rowCount) throw new AssistantError(409, "assistant_interrupted");
  return result.rows[0].task;
}

export async function queueContinuation(
  db: Database,
  sessionId: string,
  event: string,
  eventKey: string,
  expectedRevision?: number,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('assistant-concurrency'))",
    );
    const session = (
      await client.query(
        "SELECT * FROM assistant_session WHERE id=$1 FOR UPDATE",
        [sessionId],
      )
    ).rows[0];
    if (
      !session?.task?.goal ||
      (expectedRevision !== undefined &&
        session.task_revision !== expectedRevision)
    ) {
      await client.query("COMMIT");
      return;
    }
    if (
      (
        await client.query(
          "SELECT id FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
          [sessionId],
        )
      ).rowCount
    ) {
      await client.query("COMMIT");
      return;
    }
    const reconciled = await reconcileExecutionConfirmations(client, session);
    if (reconciled !== session.task) {
      await client.query(
        "UPDATE assistant_session SET task=$2::jsonb,updated_at=now() WHERE id=$1 AND task_revision=$3",
        [sessionId, JSON.stringify(reconciled), session.task_revision],
      );
      session.task = reconciled;
    }
    if (
      event === "confirmed" &&
      (
        await client.query(
          "SELECT id FROM assistant_proposal WHERE session_id=$1 AND task_revision=$2 AND status IN('pending','executing')",
          [sessionId, session.task_revision],
        )
      ).rowCount
    ) {
      await client.query("COMMIT");
      return;
    }
    // Reconciliation can finish the final confirmed delivery without allocating work.
    if (session.task.stage === "complete") {
      await client.query("COMMIT");
      return;
    }
    const key = `auto:${session.task_revision}:${eventKey}`;
    if (
      (
        await client.query(
          "SELECT id FROM assistant_turn WHERE session_id=$1 AND operation_key=$2",
          [sessionId, key],
        )
      ).rowCount
    ) {
      await client.query("COMMIT");
      return;
    }
    const previous = (
      await client.query(
        "SELECT * FROM assistant_turn WHERE session_id=$1 AND coalesce(task_id,'legacy:'||session_id)=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [sessionId, taskIdentity(session)],
      )
    ).rows[0];
    if (!previous || ["queued", "running"].includes(previous.status)) {
      await client.query("COMMIT");
      return;
    }
    const scope = { projectId: session.project_id, actorId: session.actor_id };
    await assistantAccess(client, scope, previous.requires_write);
    await dependenciesAvailable(client, scope, previous.dependencies);
    const decision = await assistantRecovery(client, scope, session, previous, {
      phase: "event",
      event,
    });
    if (!decision.action) {
      await client.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            recoveryDecision: decision,
            ...([
              "event_limit",
              "session_limit",
              "task_budget_exhausted",
              "insufficient_task_time",
            ].includes(decision.reason)
              ? {
                  stage: "waiting_input",
                  ...(session.task.budgetLedger
                    ? { budgetPause: decision.reason }
                    : { executionPaused: true }),
                  nextAction: null,
                  error:
                    decision.reason === "event_limit"
                      ? "assistant_auto_limit"
                      : decision.reason === "session_limit"
                        ? "assistant_session_limit"
                        : "assistant_retry_unavailable",
                }
              : {}),
          }),
        ],
      );
      await client.query("COMMIT");
      return;
    }
    await queueRecovery(client, session, previous, decision, event, key);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function collectProcessingEvents(db: Database) {
  const failSession = async (id: string, revision: number, error: unknown) => {
    if (!(error instanceof Error && "code" in error && "status" in error))
      throw error;
    await db.query(
      "UPDATE assistant_session SET task=task||$3::jsonb WHERE id=$1 AND task_revision=$2",
      [
        id,
        revision,
        JSON.stringify({ stage: "failed", error: String(error.code) }),
      ],
    );
  };
  const sessions = (
    await db.query(`SELECT s.id,s.task_revision,string_agg(r.id||':'||j.status||':'||j.attempt,',' ORDER BY r.id) AS event_key FROM assistant_session s
    JOIN processing_run r ON r.id IN(SELECT jsonb_array_elements_text(coalesce(s.task->'runIds',jsonb_build_array(s.task->>'runId')))) JOIN job j ON j.id=r.job_id
    WHERE s.task->>'stage'='processing' AND r.input_ref IS NOT NULL GROUP BY s.id,s.task_revision
    HAVING bool_and(j.status IN('succeeded','failed','cancelled')) LIMIT 30`)
  ).rows;
  const budgetYields = (
    await db.query(
      `SELECT s.id,s.task_revision,s.task->'budgetCheckpoint'->>'turnId' AS turn_id
     FROM assistant_session s JOIN assistant_turn t ON t.id=s.task->'budgetCheckpoint'->>'turnId'
     WHERE s.task->>'stage'='yielding' AND t.status='succeeded'
       AND t.task_revision=s.task_revision LIMIT 30`,
    )
  ).rows;
  for (const session of budgetYields) {
    try {
      await queueContinuation(
        db,
        session.id,
        "budget_yield",
        session.turn_id,
        session.task_revision,
      );
    } catch (error) {
      await failSession(session.id, session.task_revision, error);
    }
  }
  const uncertain = (
    await db.query(
      "SELECT p.id,p.session_id,s.project_id,s.actor_id,s.task_revision FROM assistant_proposal p JOIN assistant_session s ON s.id=p.session_id WHERE p.status IN('pending','executing') AND p.lease_token IS NOT NULL AND (p.lease_until IS NULL OR p.lease_until<=now()) AND p.task_revision=s.task_revision AND s.task->>'stage'<>'failed' LIMIT 30",
    )
  ).rows;
  for (const item of uncertain) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const scope = { projectId: item.project_id, actorId: item.actor_id };
      await sessionRow(client, scope, item.session_id, true);
      const proposal = (
        await client.query(
          "SELECT * FROM assistant_proposal WHERE id=$1 FOR UPDATE",
          [item.id],
        )
      ).rows[0];
      await recoverProposalReceipt(client, scope, proposal);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      await failSession(item.session_id, item.task_revision, error);
    } finally {
      client.release();
    }
  }
  const confirmations = (
    await db.query(
      "SELECT p.id,p.session_id,s.task_revision FROM assistant_proposal p JOIN assistant_session s ON s.id=p.session_id WHERE p.status='succeeded' AND p.task_revision=s.task_revision AND s.task->>'stage'='awaiting_confirmation' ORDER BY p.created_at DESC LIMIT 30",
    )
  ).rows;
  for (const proposal of confirmations) {
    try {
      await queueContinuation(
        db,
        proposal.session_id,
        "confirmed",
        proposal.id,
        proposal.task_revision,
      );
    } catch (error) {
      await failSession(proposal.session_id, proposal.task_revision, error);
    }
  }
  for (const session of sessions) {
    try {
      await queueContinuation(
        db,
        session.id,
        "processing_completed",
        sha256(session.event_key),
        session.task_revision,
      );
    } catch (error) {
      await failSession(session.id, session.task_revision, error);
    }
  }
}

export async function claimAssistantTurn(db: Database) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('assistant-concurrency'))",
    );
    // A crashed executor can resume the same logical turn and its stable domain receipts.
    await client.query(
      "UPDATE assistant_turn t SET status='queued',execution_token=NULL FROM assistant_session s WHERE t.session_id=s.id AND t.task_revision=s.task_revision AND t.status='running' AND t.expires_at<=now()",
    );
    const active = (
      await client.query(
        "SELECT s.actor_id FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id WHERE t.status='running' AND t.expires_at>now()",
      )
    ).rows;
    if (active.length >= 3) {
      await client.query("COMMIT");
      return;
    }
    const row = (
      await client.query(
        `SELECT t.*,s.project_id,s.actor_id,s.task,s.task_revision AS session_revision FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id
      WHERE t.status='queued' AND t.task_revision=s.task_revision AND NOT(s.actor_id=ANY($1::text[]))
      ORDER BY t.created_at,t.id LIMIT 1 FOR UPDATE OF t,s SKIP LOCKED`,
        [active.map((r) => r.actor_id)],
      )
    ).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    if (
      Number(row.execution_attempt) > 0 ||
      row.resuming ||
      row.task.recoverySegment?.turnId === row.id
    ) {
      const session = {
        id: row.session_id,
        task: row.task,
        task_revision: row.session_revision,
      };
      await closeBudget(client, session, row.id);
      const decision = await assistantRecovery(
        client,
        { projectId: row.project_id, actorId: row.actor_id },
        session,
        row,
        { phase: "claim" },
      );
      if (decision.reason === "complete" && row.event !== "user") {
        await client.query(
          "UPDATE assistant_turn SET status='succeeded',execution_token=NULL,error_code=NULL,assistant_text=$2 WHERE id=$1 AND status='queued'",
          [row.id, "本次任务已完成，已保存的结果保留在下方。"],
        );
        await client.query("COMMIT");
        return;
      }
      if (!decision.action || decision.action !== "retry_turn") {
        await client.query(
          "UPDATE assistant_turn SET status='failed',execution_token=NULL,error_code=$2 WHERE id=$1",
          [
            row.id,
            !decision.action
              ? "assistant_retry_unavailable"
              : "assistant_budget_exhausted",
          ],
        );
        if (decision.action)
          await queueRecovery(
            client,
            session,
            { ...row, status: "failed" },
            decision,
          );
        else
          await client.query(
            "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
            [
              row.session_id,
              JSON.stringify({
                stage: "failed",
                error: "assistant_retry_unavailable",
                recoveryDecision: decision,
              }),
            ],
          );
        await client.query("COMMIT");
        return;
      }
    }
    const token = opaqueId("execution");
    await client.query(
      "UPDATE assistant_turn SET status='running',execution_attempt=execution_attempt+1,execution_token=$2,expires_at=now()+interval '90 seconds',error_code=NULL WHERE id=$1",
      [row.id, token],
    );
    await client.query("COMMIT");
    return {
      ...row,
      status: "running",
      execution_attempt: Number(row.execution_attempt) + 1,
      execution_token: token,
      recoveryOrigin:
        row.task.recoverySegment?.turnId === row.id
          ? row.task.recoverySegment
          : undefined,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function controlAssistantTask(
  db: Database,
  scope: AssistantScope,
  id: string,
  action: "stop" | "pause" | "retry" | "delete" | "grant",
  attempt = 0,
  expected?: {
    revision: number;
    action: string;
    offerId?: string;
    purpose?: "continue" | "repair";
    key?: string;
  },
  message?: { key: unknown; text: unknown; taskId: unknown },
): Promise<{
  runId: string | undefined;
  turn?: Record<string, any>;
  replayed?: boolean;
}> {
  if (
    action === "pause" &&
    (!message ||
      typeof message.key !== "string" ||
      !message.key.trim() ||
      message.key.length > 200 ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 4000 ||
      typeof message.taskId !== "string" ||
      !message.taskId ||
      message.taskId.length > 250)
  )
    throw new AssistantError(422, "assistant_message_invalid");
  const controlHash = message
    ? sha256(
        canonicalJson({ action, text: message.text, taskId: message.taskId }),
      )
    : undefined;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('assistant-concurrency'))",
    );
    await assistantAccess(client, scope, action !== "delete");
    // Lock an existing processing job before the session, matching the worker's order.
    // A concurrently linked new run causes a bounded transaction retry rather than a partial stop.
    const observed = await sessionRow(client, scope, id);
    const observedRunIds: string[] =
      observed.task?.runIds ??
      (observed.task?.runId ? [observed.task.runId] : []);
    const jobs =
      observedRunIds.length || action === "delete"
        ? (
            await client.query(
              `SELECT j.*,r.id AS run_id FROM job j JOIN processing_run r ON r.job_id=j.id
             WHERE r.project_id=$2 AND ($3::text IS NULL OR r.actor_id=$4)
             AND (r.id=ANY($1::text[]) OR ($3::text IS NOT NULL AND EXISTS(
               SELECT 1 FROM assistant_background_document b WHERE b.session_id=$3 AND b.id=ANY(r.background_document_ids))))
             ORDER BY j.id FOR UPDATE OF j${action === "delete" ? ",r" : ""}`,
              [
                observedRunIds,
                scope.projectId,
                action === "delete" ? id : null,
                scope.actorId,
              ],
            )
          ).rows
        : [];
    const job = jobs.find((item) => item.run_id === observed.task?.runId);
    const session = await sessionRow(client, scope, id, true);
    if (message) {
      const prior = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 AND operation_key=$2",
          [id, message.key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== controlHash)
          throw new AssistantError(409, "idempotency_conflict");
        await client.query("COMMIT");
        return { runId: session.task?.runId, turn: prior, replayed: true };
      }
      if (taskIdentity(session) !== message.taskId)
        throw new AssistantError(409, "assistant_task_changed");
    }
    if (expected && Number(session.task_revision) !== expected.revision)
      throw new AssistantError(409, "assistant_plan_revalidation_required");
    if (
      session.task?.runId !== observed.task?.runId ||
      JSON.stringify(session.task?.runIds ?? []) !==
        JSON.stringify(observed.task?.runIds ?? [])
    )
      throw new AssistantError(409, "assistant_task_changed");
    let controlTurn: Record<string, any> | undefined;
    if (action === "stop" || action === "pause" || action === "delete") {
      if (session.task?.turnBudget?.turnId)
        await closeBudget(client, session, session.task.turnBudget.turnId);
      if (jobs.length)
        await client.query(
          "UPDATE job SET status='cancel_requested',updated_at=now() WHERE id=ANY($1::text[]) AND status IN('queued','running','retry_wait')",
          [jobs.map((item) => item.id)],
        );
      await client.query(
        "UPDATE assistant_session SET task_revision=task_revision+1,task=task||$2::jsonb,updated_at=now() WHERE id=$1",
        [
          id,
          JSON.stringify(
            action === "pause"
              ? {
                  stage: "waiting_input",
                  executionPaused: true,
                  nextAction: null,
                  error: null,
                  recovery: null,
                }
              : { stage: "stopped" },
          ),
        ],
      );
      await client.query(
        "UPDATE assistant_turn SET status='interrupted',execution_token=NULL,error_code='assistant_stopped' WHERE session_id=$1 AND status IN('queued','running')",
        [id],
      );
      await client.query(
        "UPDATE assistant_proposal SET status='invalid' WHERE session_id=$1 AND status='pending'",
        [id],
      );
      if (action === "pause" && message) {
        controlTurn = (
          await client.query(
            "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,expires_at,task_revision,task_id,requires_write,dependencies) VALUES($1,$2,$3,$4,$5,$6,'succeeded',now(),$7,$8,true,$9) RETURNING *",
            [
              opaqueId("turn"),
              id,
              message.key,
              controlHash,
              message.text,
              "已暂停后续执行，已保存成果保留。在途处理正在停止；继续时会先核对已有结果。",
              Number(session.task_revision) + 1,
              taskIdentity(session),
              JSON.stringify(
                (
                  await client.query(
                    "SELECT dependencies FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
                    [id],
                  )
                ).rows[0]?.dependencies ?? [],
              ),
            ],
          )
        ).rows[0];
        await client.query(
          "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
          [
            id,
            JSON.stringify({
              turnControl: {
                mode: "pause",
                source: "ui",
                turnId: controlTurn!.id,
                taskRevision: Number(session.task_revision) + 1,
                updateSaved: true,
              },
            }),
          ],
        );
      }
      if (action === "delete") {
        await client.query(
          "DELETE FROM assistant_proposal WHERE session_id=$1",
          [id],
        );
        await client.query("DELETE FROM assistant_turn WHERE session_id=$1", [
          id,
        ]);
        // Existing background cleanup removes dependent processing copies, preserving adopted data.
        await client.query(
          "DELETE FROM assistant_background_document WHERE session_id=$1",
          [id],
        );
        await client.query("DELETE FROM assistant_session WHERE id=$1", [id]);
      }
    } else {
      const turn = (
        await client.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 AND coalesce(task_id,'legacy:'||session_id)=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
          [id, taskIdentity(session)],
        )
      ).rows[0];
      if (action === "grant") {
        if (
          !expected?.offerId ||
          !expected.key ||
          !["continue", "repair"].includes(expected.purpose ?? "")
        )
          throw new AssistantError(422, "assistant_request_invalid");
        const prior = session.task.budgetLedger?.grants?.find(
          (g: any) =>
            g.offerId === expected.offerId ||
            g.keyHash === sha256(JSON.stringify(expected.key)),
        );
        if (prior) {
          if (
            prior.offerId !== expected.offerId ||
            prior.purpose !== expected.purpose
          )
            throw new AssistantError(409, "idempotency_conflict");
          await client.query("COMMIT");
          return { runId: session.task.runId };
        }
        if (!turn || ["queued", "running"].includes(turn.status))
          throw new AssistantError(409, "assistant_turn_running");
        await closeBudget(client, session, turn.id);
      }
      const decision = await assistantRecovery(client, scope, session, turn);
      if (action !== "grant" && expected && decision.action !== expected.action)
        throw new AssistantError(
          409,
          "assistant_retry_unavailable",
          decision.reason,
        );
      if (action === "grant") {
        if (!expected?.key || !expected.purpose)
          throw new AssistantError(422, "assistant_request_invalid");
        const offer = decision.grantOffers?.[expected.purpose!];
        if (!offer || offer.id !== expected.offerId)
          throw new AssistantError(
            409,
            "assistant_retry_unavailable",
            decision.reason,
          );
        if (
          (
            await client.query(
              "SELECT id FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
              [id],
            )
          ).rowCount
        )
          throw new AssistantError(409, "assistant_turn_running");
        try {
          session.task = applyBudgetGrant(
            session.task,
            offer,
            scope.actorId,
            session.task_revision,
            expected.key,
          );
        } catch (e) {
          if (e instanceof BudgetGrantError)
            throw new AssistantError(
              409,
              "assistant_retry_unavailable",
              e.code,
            );
          throw e;
        }
        // Close the old segment before allocating the one explicitly authorized segment.
        await client.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
          id,
          session.task,
        ]);
        await closeBudget(client, session, turn.id);
        const allowed = await assistantRecovery(client, scope, session, turn);
        if (!allowed.action)
          throw new AssistantError(
            409,
            "assistant_retry_unavailable",
            allowed.reason,
          );
        await queueRecovery(
          client,
          session,
          turn,
          allowed,
          "budget_grant",
          "grant:" + offer.id,
        );
        await client.query("COMMIT");
        return { runId: session.task.runId };
      }
      const resumeReply =
        session.task?.recovery?.kind === "model_reply" &&
        Boolean(decision.action);
      if (
        session.task?.runId &&
        session.task.stage === "awaiting_review" &&
        (["failed", "cancelled"].includes(session.task.checkedStatus) ||
          (session.task.checkedStatus === "succeeded" &&
            Number(session.task.review?.missingCount) > 0)) &&
        job &&
        !resumeReply
      ) {
        const recoverable = [];
        for (const item of jobs) {
          const run = await getProcessingRun(client, scope, item.run_id);
          if ((await processingRecovery(client, run)).canRetry)
            recoverable.push(item);
        }
        if (!recoverable.length)
          throw new AssistantError(409, "processing_retry_unavailable");
        await dependenciesAvailable(
          client,
          scope,
          (
            await client.query(
              "SELECT dependencies FROM assistant_turn WHERE session_id=$1 AND coalesce(task_id,'legacy:'||session_id)=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
              [id, taskIdentity(session)],
            )
          ).rows[0]?.dependencies ?? [],
        );
        await client.query(
          "UPDATE job SET status='queued',stage='queued',attempt=0,next_run_at=now(),error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=ANY($1::text[])",
          [recoverable.map((item) => item.id)],
        );
        await client.query(
          'UPDATE assistant_session SET task=task||\'{"stage":"processing","error":null,"recovery":null}\'::jsonb WHERE id=$1',
          [id],
        );
        await client.query("COMMIT");
        return {
          runId: session.task.runId,
        };
      }
      await queueRecovery(client, session, turn, decision);
    }
    await client.query("COMMIT");
    return {
      runId: session.task?.runId,
      ...(controlTurn ? { turn: controlTurn } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      ((error instanceof AssistantError &&
        error.code === "assistant_task_changed") ||
        (action === "delete" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "40P01")) &&
      attempt < 2
    ) {
      return controlAssistantTask(
        db,
        scope,
        id,
        action,
        attempt + 1,
        expected,
        message,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Budget-only settlement under the session lock; no domain write or permission grant. */
export async function settleAssistantBudget(
  db: Database,
  turn: Record<string, any>,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const s = (
      await client.query(
        "SELECT s.* FROM assistant_session s JOIN assistant_turn t ON t.session_id=s.id WHERE t.id=$1 AND t.execution_token=$2 AND t.task_revision=s.task_revision FOR UPDATE OF s",
        [turn.id, turn.execution_token],
      )
    ).rows[0];
    if (s) await closeBudget(client, s, turn.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function closeBudget(
  db: Pick<Database, "query">,
  session: Record<string, any>,
  turnId: string,
) {
  const b = session.task?.turnBudget as ActiveBudget | undefined;
  if (b?.turnId !== turnId || b.accountingVersion !== 2) return;
  const turnBudget = settleActiveBudget(b, Date.now(), true);
  if (session.task.budgetLedger?.version === 1) {
    for (const request of turnBudget.requests ?? [])
      if (request.state === "reserved") {
        request.state = "unknown";
        if (request.repair && !request.repairCharged) {
          const r = request.repair;
          chargeRepairRequest(
            (session.task.parameterRepairLimits ??= {}),
            r.name,
            r.identity,
            r.kind,
          );
          request.repairCharged = true;
          if (r.nested) turnBudget.modelSteps++;
        }
      }
    turnBudget.requestAttempts = sentRequestCount(turnBudget.requests ?? []);
  }
  const executionBudget = checkpointExecutionBudget(
    session.task.executionBudget,
    turnBudget,
    turnBudget.activeMs,
  );
  const ledger = session.task.budgetLedger;
  if (ledger?.version === 1) {
    const entry = { ...turnBudget, executionToken: undefined };
    ledger.segments ??= [];
    const index = ledger.segments.findIndex((s: any) => s.turnId === turnId);
    if (index < 0) ledger.segments.push(entry);
    else ledger.segments[index] = entry;
  }
  await db.query(
    "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
    [
      session.id,
      JSON.stringify({
        turnBudget,
        executionBudget,
        ...(ledger
          ? {
              budgetLedger: ledger,
              parameterRepairLimits: session.task.parameterRepairLimits ?? {},
            }
          : {}),
      }),
    ],
  );
  session.task = { ...session.task, turnBudget, executionBudget };
}
/** Called only with the session/global recovery locks already held. */
export async function queueRecovery(
  db: Pick<Database, "query">,
  session: Record<string, any>,
  origin: Record<string, any>,
  decision: RecoveryDecision,
  event = "recovery",
  operationKey?: string,
) {
  if (origin.task_id && origin.task_id !== taskIdentity(session))
    throw new AssistantError(409, "assistant_task_changed");
  if (!decision.action)
    throw new AssistantError(
      409,
      "assistant_retry_unavailable",
      decision.reason,
    );
  if (decision.action === "retry_turn") {
    await db.query(
      "UPDATE assistant_turn SET status='queued',execution_token=NULL,error_code=NULL,resuming=true WHERE id=$1",
      [origin.id],
    );
    await db.query(
      "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
      [
        session.id,
        JSON.stringify({
          stage: "inspecting",
          error: null,
          ...(decision.mode
            ? {
                turnControl: {
                  ...session.task.turnControl,
                  mode: decision.mode,
                },
                ...(decision.mode === "plan" ? { executionPaused: true } : {}),
              }
            : {}),
        }),
      ],
    );
    return { turnId: origin.id, action: decision.action };
  }
  await closeBudget(db, session, origin.id);
  const task = session.task,
    oldBudget = task.turnBudget;
  const prior =
    task.recoverySegment?.turnId === origin.id
      ? task.recoverySegment
      : undefined;
  const id = opaqueId("turn"),
    now = Date.now();
  const rootTurnId = prior?.rootTurnId ?? origin.id;
  const attemptsBefore =
    (prior?.attemptsBefore ?? 0) +
    (["failed", "interrupted"].includes(origin.status)
      ? Number(origin.execution_attempt)
      : Math.max(0, Number(origin.execution_attempt) - 1));
  const key =
    operationKey ?? "recovery:" + session.task_revision + ":" + origin.id;
  const records = origin.tool_results ?? [];
  const step = task.executionPlan?.steps?.[task.executionPlan.current];
  const receipts = records.filter(
    (r: any, index: number) =>
      r.status !== "succeeded" ||
      r.key === step?.operation?.key ||
      r.key === task.requirementSave?.key ||
      (step?.id && r.binding?.stepId === step.id) ||
      records
        .slice(0, index)
        .some(
          (old: any) =>
            old.status === "failed" &&
            old.name === r.name &&
            (old.key === r.key ||
              (hasNoEffect(old) &&
                JSON.stringify(old.binding) === JSON.stringify(r.binding))),
        ),
  );
  const row = (
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,event,status,expires_at,requires_write,dependencies,task_revision,resuming,tool_results) VALUES($1,$2,$3,$4,$5,$10,'queued',now()+interval '90 seconds',$6,$7,$8,true,$9) ON CONFLICT(session_id,operation_key) DO NOTHING RETURNING *",
      [
        id,
        session.id,
        key,
        sha256(key),
        event === "recovery"
          ? origin.user_text
          : `[${event}] 已有授权任务的实际结果发生变化。读取当前结果并继续原目标；不构成新的用户授权。`,
        origin.requires_write,
        JSON.stringify(origin.dependencies),
        session.task_revision,
        JSON.stringify(receipts),
        event,
      ],
    )
  ).rows[0];
  if (row)
    await db.query("UPDATE assistant_turn SET task_id=$2 WHERE id=$1", [
      row.id,
      taskIdentity(session),
    ]);
  if (!row)
    return {
      turnId: (
        await db.query(
          "SELECT id FROM assistant_turn WHERE session_id=$1 AND operation_key=$2",
          [session.id, key],
        )
      ).rows[0].id,
      action: decision.action,
    };
  const documents = (
    await db.query(
      'SELECT id,sha256,extractor_version AS "extractorVersion" FROM assistant_background_document WHERE session_id=$1',
      [session.id],
    )
  ).rows;
  const faultRecovery = ["failed", "interrupted"].includes(origin.status);
  const recoverySegment = {
    turnId: id,
    parentTurnId: origin.id,
    rootTurnId,
    progressKey: recoveryProgress(task, origin),
    progressFacts: recoveryProgressFacts(task, origin),
    ...(task.grantResume ? { grantId: task.grantResume } : {}),
    transportRetriesBefore:
      faultRecovery && !task.budgetLedger
        ? Number(prior?.transportRetriesBefore ?? 0) +
          Number(oldBudget.transportRetries ?? 0)
        : 0,
    amendmentId:
      task.planningRecovery?.requestTurnId ?? prior?.amendmentId ?? origin.id,
    attemptsBefore: task.grantResume ? 0 : attemptsBefore,
    revision: session.task_revision,
    documentsKey: backgroundVersion(documents),
    mode: decision.mode,
  };
  const turnBudget = {
    turnId: id,
    startedAt: now,
    deadlineAt: decision.validUntil,
    modelSteps: 0,
    toolCalls: 0,
    transportRetries: 0,
    activeMs: 0,
    accountingVersion: 2,
    requests: [],
    retryWaits: [],
    ...(task.budgetLedger
      ? { requestAttempts: 0, progressStart: progressKey(task, origin) }
      : {}),
  };
  const control = {
    ...task.turnControl,
    turnId: id,
    taskRevision: session.task_revision,
    source: "continuation",
    mode: decision.mode,
  };
  const history = [
    ...(task.budgetSegments ?? []),
    {
      ...oldBudget,
      requests: undefined,
      retryWaits: undefined,
      parentTurnId: prior?.parentTurnId ?? null,
      rootTurnId,
    },
  ].slice(-100);
  await db.query(
    "UPDATE assistant_session SET task=task||$2::jsonb,updated_at=now() WHERE id=$1",
    [
      session.id,
      JSON.stringify({
        turnBudget,
        grantResume: null,
        budgetSegments: history,
        recoverySegment,
        turnControl: control,
        stage: "inspecting",
        error: null,
        autoCount: Number(task.autoCount ?? 0) + 1,
      }),
    ],
  );
  return { turnId: id, action: decision.action };
}
