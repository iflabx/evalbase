import type { Database } from "../db/pool.js";
import { opaqueId } from "../server/support.js";
import { sha256 } from "../package/contract.js";
import { getProcessingRun } from "../processing/store.js";
import { processingRecovery } from "../processing/recovery.js";
import {
  ASSISTANT_SESSION_TURN_LIMIT,
  assistantAccess,
  AssistantError,
  dependenciesAvailable,
  sessionRow,
  recoverProposalReceipt,
  canResumeAssistantTurn,
  type AssistantScope,
} from "./store.js";

/** Task state is independent of the model's bounded conversation history. */
export async function updateTask(
  db: Database,
  turn: Record<string, any>,
  patch: Record<string, unknown>,
) {
  const result = await db.query(
    `UPDATE assistant_session s SET task=s.task||$2::jsonb,title=coalesce($2::jsonb->>'title',s.title),updated_at=now()
    FROM assistant_turn t WHERE t.id=$1 AND t.session_id=s.id AND t.task_revision=s.task_revision
    AND t.execution_token=$3 AND t.status='running' AND t.expires_at>now() RETURNING s.task`,
    [turn.id, JSON.stringify(patch), turn.execution_token],
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
        session.task_revision !== expectedRevision) ||
      ["stopped", "complete", "failed"].includes(session.task.stage)
    ) {
      await client.query("COMMIT");
      return;
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
        "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [sessionId],
      )
    ).rows[0];
    if (!previous || ["queued", "running"].includes(previous.status)) {
      await client.query("COMMIT");
      return;
    }
    const scope = { projectId: session.project_id, actorId: session.actor_id };
    await assistantAccess(client, scope, previous.requires_write);
    await dependenciesAvailable(client, scope, previous.dependencies);
    const turnCount = (
      await client.query("SELECT id FROM assistant_turn WHERE session_id=$1", [
        sessionId,
      ])
    ).rowCount!;
    if (
      Number(session.task.autoCount ?? 0) >= 12 ||
      turnCount >= ASSISTANT_SESSION_TURN_LIMIT
    ) {
      await client.query(
        "UPDATE assistant_session SET task=task||jsonb_build_object('stage','failed','error',$2::text) WHERE id=$1",
        [
          sessionId,
          turnCount >= ASSISTANT_SESSION_TURN_LIMIT
            ? "assistant_session_limit"
            : "assistant_task_limit",
        ],
      );
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,event,status,expires_at,requires_write,dependencies,task_revision)
      VALUES($1,$2,$3,$4,$5,$6,'queued',now()+interval '90 seconds',$7,$8,$9)`,
      [
        opaqueId("turn"),
        sessionId,
        key,
        sha256(key),
        `[${event}] 已有授权任务的实际结果发生变化。读取当前结果并继续原目标；不构成新的用户授权。`,
        event,
        previous.requires_write,
        JSON.stringify(previous.dependencies),
        session.task_revision,
      ],
    );
    await client.query(
      "UPDATE assistant_session SET task=task||jsonb_build_object('stage','checking','autoCount',coalesce((task->>'autoCount')::int,0)+1),updated_at=now() WHERE id=$1",
      [sessionId],
    );
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
    await db.query(`SELECT s.id,s.task_revision,string_agg(r.id||':'||j.status||':'||j.attempt||':'||j.updated_at::text,',' ORDER BY r.id) AS event_key FROM assistant_session s
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
        `SELECT t.*,s.project_id,s.actor_id FROM assistant_turn t JOIN assistant_session s ON s.id=t.session_id
      WHERE t.status='queued' AND t.task_revision=s.task_revision AND NOT(s.actor_id=ANY($1::text[]))
      ORDER BY t.created_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
        [active.map((r) => r.actor_id)],
      )
    ).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    if (Number(row.execution_attempt) >= 3) {
      await client.query(
        "UPDATE assistant_turn SET status='failed',error_code='assistant_executor_limit' WHERE id=$1",
        [row.id],
      );
      await client.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"failed","error":"assistant_executor_limit"}\'::jsonb WHERE id=$1',
        [row.session_id],
      );
      await client.query("COMMIT");
      return;
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
  action: "stop" | "retry" | "delete",
  attempt = 0,
): Promise<{ runId: string | undefined }> {
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
    if (
      session.task?.runId !== observed.task?.runId ||
      JSON.stringify(session.task?.runIds ?? []) !==
        JSON.stringify(observed.task?.runIds ?? [])
    )
      throw new AssistantError(409, "assistant_task_changed");
    if (action === "stop" || action === "delete") {
      if (jobs.length)
        await client.query(
          "UPDATE job SET status='cancel_requested',updated_at=now() WHERE id=ANY($1::text[]) AND status IN('queued','running','retry_wait')",
          [jobs.map((item) => item.id)],
        );
      await client.query(
        'UPDATE assistant_session SET task_revision=task_revision+1,task=task||\'{"stage":"stopped"}\'::jsonb WHERE id=$1',
        [id],
      );
      await client.query(
        "UPDATE assistant_turn SET status='interrupted',execution_token=NULL,error_code='assistant_stopped' WHERE session_id=$1 AND status IN('queued','running')",
        [id],
      );
      await client.query(
        "UPDATE assistant_proposal SET status='invalid' WHERE session_id=$1 AND status='pending'",
        [id],
      );
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
          "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const resumeReply =
        session.task?.recovery?.kind === "model_reply" &&
        ["failed", "interrupted"].includes(turn?.status) &&
        canResumeAssistantTurn(turn, session.task);
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
              "SELECT dependencies FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
              [id],
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
      if (!canResumeAssistantTurn(turn, session.task))
        throw new AssistantError(409, "assistant_retry_unavailable");
      await dependenciesAvailable(client, scope, turn.dependencies);
      await client.query(
        "UPDATE assistant_turn SET status='queued',execution_token=NULL,task_revision=$2,error_code=NULL,resuming=true WHERE id=$1",
        [turn.id, session.task_revision],
      );
      await client.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"inspecting","error":null}\'::jsonb WHERE id=$1',
        [id],
      );
    }
    await client.query("COMMIT");
    return { runId: session.task?.runId };
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
      return controlAssistantTask(db, scope, id, action, attempt + 1);
    }
    throw error;
  } finally {
    client.release();
  }
}
