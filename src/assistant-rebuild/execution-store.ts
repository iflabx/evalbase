import {
  assistantEnabled,
  guardAssistantMode,
} from "../operations/assistant-mode.js";
import { accountOperations } from "../management/accounts.js";
import { recycleOperations } from "../management/recycle.js";
import { managementSnapshot } from "../management/snapshot.js";
import { explicitProcessingRoundRequest } from "./control-intent.js";
import { acceptTask } from "../processing/tasks.js";
import { compatibleProcessingOperations } from "./processing-context.js";
import {
  assertSaveTargetResolved,
  saveTargetAmendment,
} from "./save-target-amendment.js";
import { BusinessError } from "../operations/errors.js";
import {
  explicitResumeRequest,
  resumeIntent,
  requestedSaveName,
} from "./control-intent.js";
import { draftOperations } from "../drafts/operations.js";
import { applySelectionPreview } from "../selection/store.js";
import { withOperationScope } from "../operations/commit.js";
import {
  FORMAL_RUNTIME_VERSION,
  executionReadiness,
} from "./session-contract.js";
import {
  assertInstructionsCurrent,
  deliveryExecution,
} from "./session-contract.js";
import { cleanRecords } from "../processing/protocol.js";
import { validateDeliveryResults } from "./session-contract.js";
import {
  validateProcessingRequirements,
  validateRules,
  normalizedRequirements,
} from "../processing/requirements.js";
import { restoreSuspended } from "./suspension.js";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { EXECUTION_BUDGET_LIMITS } from "../operations/execution-limits.js";
import {
  SessionStore,
  SessionError,
  type SessionScope,
  type TurnProof,
} from "./session-store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { acceptProcessingResults } from "../processing/accept.js";
import { operationScope } from "../operations/commit.js";
import type { ModelAttempt, ModelOutcome } from "./session-host.js";
const id = (prefix: string) => prefix + "_" + randomUUID();
type Query = Pick<Database, "query">;
export type RuntimePolicy = {
  requestMs: number;
  leaseMs: number;
  graphSteps: number;
};
export const runtimePolicy: RuntimePolicy = {
  requestMs: 180000,
  leaseMs: 10000,
  graphSteps: 30,
};
export class ExecutionStore {
  readonly sessions: SessionStore;
  constructor(
    readonly db: Database,
    readonly policy: RuntimePolicy = runtimePolicy,
    readonly now = () => Date.now(),
  ) {
    this.sessions = new SessionStore(db);
  }
  private async transaction<T>(
    scope: SessionScope,
    sessionId: string,
    work: (db: Query, s: any) => Promise<T>,
  ) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await this.sessions.access(scope, false, c, true);
      const s = (
        await c.query(
          "SELECT * FROM assistant_runtime_session WHERE id=$1 AND project_id=$2 AND actor_id=$3 FOR UPDATE",
          [sessionId, scope.projectId, scope.actorId],
        )
      ).rows[0];
      if (!s || s.deleted_at)
        throw new SessionError("conversation_not_found", 404);
      if (s.invalidated_at) throw new SessionError("context_deleted");
      if (s.runtime_version !== FORMAL_RUNTIME_VERSION)
        throw new SessionError("runtime_version_not_supported");
      const value = await work(c, s);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async ensure(db: Query, scope: SessionScope, sessionId: string) {
    const limit =
      EXECUTION_BUDGET_LIMITS.modelSteps +
      EXECUTION_BUDGET_LIMITS.transportRetries;
    const added = await db.query(
      "INSERT INTO assistant_runtime_execution(session_id,request_limit,active_limit_ms) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING session_id",
      [sessionId, limit, EXECUTION_BUDGET_LIMITS.activeMs],
    );
    if (added.rowCount)
      await db.query(
        "INSERT INTO assistant_runtime_grant(id,session_id,actor_id,requests,active_ms) VALUES($1,$2,$3,$4,$5)",
        [
          "initial:" + sessionId,
          sessionId,
          scope.actorId,
          limit,
          EXECUTION_BUDGET_LIMITS.activeMs,
        ],
      );
  }
  async pending() {
    if (!(await assistantEnabled(this.db))) return [];
    return (
      await this.db.query<{
        id: string;
        session_id: string;
        project_id: string;
        actor_id: string;
      }>(
        "SELECT t.id,t.session_id,s.project_id,s.actor_id FROM assistant_runtime_turn t JOIN assistant_runtime_session s ON s.id=t.session_id LEFT JOIN assistant_runtime_execution e ON e.session_id=s.id WHERE s.runtime_version=$1 AND s.deleted_at IS NULL AND s.invalidated_at IS NULL AND (t.status='pending' OR t.status='running' AND e.lease_until<=now()) ORDER BY t.created_at LIMIT 10",
        [FORMAL_RUNTIME_VERSION],
      )
    ).rows;
  }
  async claim(scope: SessionScope, sessionId: string, turnId: string) {
    await this.sessions.get(scope, sessionId);
    return this.transaction(scope, sessionId, async (c, s) => {
      await guardAssistantMode(c);
      await this.ensure(c, scope, sessionId);
      const task = (
        await c.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      const turn = (
        await c.query(
          "SELECT * FROM assistant_runtime_turn WHERE id=$1 AND session_id=$2 FOR UPDATE",
          [turnId, sessionId],
        )
      ).rows[0];
      if (
        !turn ||
        !(
          turn.status === "pending" ||
          (turn.status === "running" &&
            task.turn_id === turnId &&
            new Date(task.lease_until).getTime() <= this.now())
        )
      )
        throw new SessionError("turn_not_pending");
      if (
        (task.status === "paused" ||
          (task.status === "failed" &&
            task.feedback?.kind === "requirements")) &&
        task.turn_id !== turnId &&
        !task.suspended
      ) {
        await c.query(
          "UPDATE assistant_runtime_execution SET suspended=$2 WHERE session_id=$1",
          [
            sessionId,
            JSON.stringify({
              turnId: task.turn_id,
              requirementsRevision: s.requirements_revision,
              reason: task.reason,
              feedback: task.feedback,
              noProgress: task.no_progress,
              seen: task.seen,
              progressRevision: task.progress_revision,
              progressVersion: task.progress_version,
            }),
          ],
        );
      }
      // In-flight requests from a dead owner are consumed and remain unknown; never refund them.
      const unknown = (
        await c.query(
          "SELECT id,started_at FROM assistant_runtime_request WHERE turn_id=$1 AND ended_at IS NULL",
          [turnId],
        )
      ).rows;
      for (const r of unknown)
        await this.finishRequest(c, r.id, {
          id: r.id,
          status: null,
          usage: null,
          error: "request_outcome_unknown",
        });
      const token = id("runner");
      await c.query(
        "UPDATE assistant_runtime_turn SET status='running',runner_token=$2,error_code=NULL WHERE id=$1",
        [turnId, token],
      );
      await c.query(
        "UPDATE assistant_runtime_execution SET feedback=CASE WHEN turn_id=$2 THEN feedback ELSE NULL END,resume_requested=CASE WHEN turn_id=$2 THEN resume_requested ELSE false END,turn_id=$2,status='running',reason=NULL,lease_until=$3,updated_at=now() WHERE session_id=$1",
        [sessionId, turnId, new Date(this.now() + this.policy.leaseMs)],
      );
      await c.query(
        "UPDATE assistant_runtime_session SET status='busy' WHERE id=$1",
        [sessionId],
      );
      return { ...scope, sessionId, turnId, token };
    });
  }
  async guard(proof: TurnProof, db: Query = this.db, lock = false) {
    await this.sessions.guard(proof, false, db, lock);
    const task = (
      await db.query(
        "SELECT * FROM assistant_runtime_execution WHERE session_id=$1" +
          (lock ? " FOR UPDATE" : ""),
        [proof.sessionId],
      )
    ).rows[0];
    if (
      !task ||
      task.turn_id !== proof.turnId ||
      task.status !== "running" ||
      new Date(task.lease_until).getTime() <= this.now()
    )
      throw new SessionError("runtime_interrupted");
    return task;
  }
  async processingGuard(proof: TurnProof, db: Query = this.db, lock = false) {
    const task = await this.guard(proof, db, lock);
    await assertSaveTargetResolved(db, proof.sessionId);
    if (
      task.feedback?.kind === "requirements" ||
      task.suspended?.feedback?.kind === "requirements"
    )
      throw new SessionError("requirements_amendment_pending", 422);
    return task;
  }
  async renew(proof: TurnProof) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await this.guard(proof, c, true);
      await c.query(
        "UPDATE assistant_runtime_execution SET lease_until=$2 WHERE session_id=$1",
        [proof.sessionId, new Date(this.now() + this.policy.leaseMs)],
      );
      await c.query("COMMIT");
      return true;
    } catch {
      await c.query("ROLLBACK");
      return false;
    } finally {
      c.release();
    }
  }
  async reserve(proof: TurnProof, a: ModelAttempt) {
    return this.transaction(proof, proof.sessionId, async (c) => {
      const task = await this.guard(proof, c, true);
      if (
        task.requests >= task.request_limit ||
        Number(task.active_ms) >= Number(task.active_limit_ms)
      )
        throw new SessionError("task_budget_exhausted");
      let admittedMs = Math.min(
        this.policy.requestMs,
        Number(task.active_limit_ms) - Number(task.active_ms),
      );
      if (task.activity_id) {
        const cap = (
          await c.query(
            "SELECT * FROM assistant_runtime_activity WHERE id=$1 FOR UPDATE",
            [task.activity_id],
          )
        ).rows[0];
        if (
          !cap ||
          cap.closed_at ||
          cap.requests >= cap.request_limit ||
          (cap.started_at &&
            this.now() - new Date(cap.started_at).getTime() >=
              Number(cap.max_ms))
        )
          throw new SessionError("activity_budget_exhausted");
        admittedMs = Math.min(admittedMs, Number(cap.max_ms));
        if (cap.started_at)
          admittedMs = Math.min(
            admittedMs,
            Number(cap.max_ms) -
              (this.now() - new Date(cap.started_at).getTime()),
          );
        await c.query(
          "UPDATE assistant_runtime_activity SET requests=requests+1,started_at=coalesce(started_at,$2) WHERE id=$1",
          [task.activity_id, new Date(this.now())],
        );
      }
      await c.query(
        "UPDATE assistant_runtime_execution SET requests=requests+1 WHERE session_id=$1",
        [proof.sessionId],
      );
      await c.query(
        "INSERT INTO assistant_runtime_request(id,session_id,turn_id,runner_token,purpose,correction_of,request_hash,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          a.id,
          proof.sessionId,
          proof.turnId,
          proof.token,
          a.purpose,
          a.correctionOf,
          a.requestHash,
          new Date(this.now()),
        ],
      );
      return Math.max(1, Math.floor(admittedMs));
    });
  }
  private async finishRequest(
    c: Query,
    requestId: string,
    result: ModelOutcome,
  ) {
    const owner = (
      await c.query(
        "SELECT session_id FROM assistant_runtime_request WHERE id=$1",
        [requestId],
      )
    ).rows[0];
    if (!owner) return;
    await c.query(
      "SELECT session_id FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
      [owner.session_id],
    );
    const row = (
      await c.query(
        "SELECT * FROM assistant_runtime_request WHERE id=$1 FOR UPDATE",
        [requestId],
      )
    ).rows[0];
    if (!row) return;
    const elapsed = Math.min(
      this.policy.requestMs,
      Math.max(0, this.now() - new Date(row.started_at).getTime()),
    );
    const provisional = [
      "interrupted_outcome_unknown",
      "request_outcome_unknown",
    ];
    const refine =
      !!row.ended_at &&
      provisional.includes(row.error_code) &&
      !provisional.includes(result.error ?? "");
    if (!row.ended_at || refine) {
      if (refine)
        await c.query(
          "INSERT INTO assistant_runtime_event(session_id,turn_id,kind,operation_key,detail) VALUES($1,$2,'request_outcome_reconciled',$3,$4) ON CONFLICT DO NOTHING",
          [
            row.session_id,
            row.turn_id,
            "request-outcome:" + requestId,
            JSON.stringify({
              requestId,
              priorEndedAt: row.ended_at,
              priorError: row.error_code,
              priorElapsedMs: Number(row.elapsed_ms),
            }),
          ],
        );
      await c.query(
        "UPDATE assistant_runtime_request SET ended_at=$2,status=$3,usage=$4,error_code=$5,elapsed_ms=$6 WHERE id=$1",
        [
          requestId,
          new Date(this.now()),
          result.status,
          JSON.stringify(result.usage),
          result.error,
          elapsed,
        ],
      );
      await c.query(
        row.purpose === "worker"
          ? "UPDATE assistant_runtime_execution SET worker_ms=worker_ms+$2 WHERE session_id=$1"
          : "UPDATE assistant_runtime_execution SET active_ms=active_ms+$2 WHERE session_id=$1",
        [
          row.session_id,
          Math.max(0, elapsed - (row.ended_at ? Number(row.elapsed_ms) : 0)),
        ],
      );
    }
  }
  async outcome(result: ModelOutcome) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await this.finishRequest(c, result.id, result);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async yield(
    proof: TurnProof,
    status: "paused" | "waiting" | "confirmation",
    reason: string | null = null,
  ) {
    return this.transaction(proof, proof.sessionId, async (c) => {
      await this.guard(proof, c, true);
      await c.query(
        "UPDATE assistant_runtime_turn SET status=$2,runner_token=NULL,error_code=$3 WHERE id=$1",
        [proof.turnId, status, reason],
      );
      await c.query(
        "UPDATE assistant_runtime_execution SET status=$2,reason=$3,lease_until=NULL WHERE session_id=$1",
        [proof.sessionId, status, reason],
      );
      await c.query(
        "UPDATE assistant_runtime_session SET status=$2 WHERE id=$1",
        [proof.sessionId, status],
      );
    });
  }
  async stopped(
    scope: SessionScope,
    sessionId: string,
    reason = "user_paused",
  ) {
    await this.transaction(scope, sessionId, (c) =>
      this.pause(c, scope, sessionId, reason),
    );
  }
  /** Operator-only retirement of execution envelopes, including revoked owners/older contracts. No checkpoint interpretation. */
  async quiesce(sessionId: string) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const s = (
        await c.query(
          "SELECT project_id,actor_id FROM assistant_runtime_session WHERE id=$1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (!s) throw new SessionError("conversation_not_found", 404);
      await this.pause(
        c,
        { projectId: s.project_id, actorId: s.actor_id },
        sessionId,
        "runtime_disabled",
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  private async pause(
    c: Query,
    scope: SessionScope,
    sessionId: string,
    reason: string,
  ) {
    await this.ensure(c, scope, sessionId);
    const t = (
      await c.query(
        "SELECT * FROM assistant_runtime_turn WHERE session_id=$1 AND status IN('pending','running','waiting','confirmation') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [sessionId],
      )
    ).rows[0];
    if (t) {
      await this.sessions.event(
        {
          ...scope,
          sessionId,
          turnId: t.id,
          token: t.runner_token ?? "control",
        },
        "execution_paused",
        { reason, previousStatus: t.status, at: this.now() },
        c,
      );
      await c.query(
        "UPDATE assistant_runtime_turn SET status='paused',runner_token=NULL,error_code=$2 WHERE id=$1",
        [t.id, reason],
      );
      const pending = (
        await c.query(
          "SELECT id FROM assistant_runtime_request WHERE turn_id=$1 AND ended_at IS NULL",
          [t.id],
        )
      ).rows;
      for (const r of pending)
        await this.finishRequest(c, r.id, {
          id: r.id,
          status: null,
          usage: null,
          error: "interrupted_outcome_unknown",
        });
      await c.query(
        "UPDATE assistant_runtime_execution SET turn_id=$2,status='paused',reason=$3,lease_until=NULL,resume_suspended=false,resume_requested=false WHERE session_id=$1",
        [sessionId, t.id, reason],
      );
      await c.query(
        "UPDATE assistant_runtime_session SET status='paused' WHERE id=$1",
        [sessionId],
      );
    }
    await c.query(
      "UPDATE assistant_runtime_confirmation SET status='expired' WHERE session_id=$1 AND status='pending'",
      [sessionId],
    );
  }

  async blocked(sessionId: string) {
    const task = (
      await this.db.query(
        "SELECT * FROM assistant_runtime_execution WHERE session_id=$1",
        [sessionId],
      )
    ).rows[0];
    if (!task) return null;
    if (task.activity_id) {
      const cap = (
        await this.db.query(
          "SELECT * FROM assistant_runtime_activity WHERE id=$1",
          [task.activity_id],
        )
      ).rows[0];
      if (
        !cap ||
        cap.closed_at ||
        cap.requests >= cap.request_limit ||
        (cap.started_at &&
          this.now() - new Date(cap.started_at).getTime() >= Number(cap.max_ms))
      )
        return "activity_budget_exhausted";
    }
    if (
      task.requests >= task.request_limit ||
      Number(task.active_ms) >= Number(task.active_limit_ms)
    )
      return "task_budget_exhausted";
    return null;
  }

  /** Resolve the same delivery by processing dependencies, never by the current chat turn.
   * Immutable requirements events also support operations written before this resolver. */
  async processingOperations(session: any, db: Query = this.db) {
    return compatibleProcessingOperations(db, session);
  }

  async pendingDeliveries(scope: SessionScope, session: any) {
    const ops = await this.processingOperations(session),
      pending = [];
    for (const delivery of session.requirements.deliveries.filter(
      (d: any) => d.status === "active",
    )) {
      const op = ops.find((o: any) =>
        o.operation_key.startsWith("processing:" + delivery.id + ":"),
      );
      let saved = false;
      if (op)
        for (const a of (
          await this.db.query(
            "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND kind='adopt' AND run_id=$2",
            [session.id, op.run_id],
          )
        ).rows)
          if (await this.receipt(scope, session.id, a.id)) saved = true;
      if (!saved)
        pending.push({
          deliveryId: delivery.id,
          runId: op?.run_id,
          status: op?.job_status,
        });
    }
    return pending;
  }
  async beginProcessingRound(proof: TurnProof, taskId: string) {
    return this.transaction(proof, proof.sessionId, async (c) => {
      const current = await this.guard(proof, c, true),
        input = await this.sessions.guard(proof, true, c, true);
      if (!explicitProcessingRoundRequest(input.text))
        throw new SessionError("processing_round_authorization_required");
      const task = (
        await c.query(
          "SELECT t.id,j.status FROM processing_task t JOIN processing_run r ON r.id=t.latest_run_id JOIN job j ON j.id=r.job_id WHERE t.id=$1 AND t.project_id=$2 FOR SHARE OF t",
          [taskId, proof.projectId],
        )
      ).rows[0];
      if (!task || !["succeeded", "failed", "cancelled"].includes(task.status))
        throw new SessionError("processing_still_running");
      await assertSaveTargetResolved(c, proof.sessionId);
      await c.query(
        "UPDATE assistant_runtime_confirmation SET status='expired' WHERE session_id=$1 AND action='adopt' AND status='pending'",
        [proof.sessionId],
      );
      if (current.suspended)
        await c.query(
          "UPDATE assistant_runtime_execution SET suspended=NULL,resume_suspended=false,resume_requested=false WHERE session_id=$1",
          [proof.sessionId],
        );
    });
  }
  async processingForExecution(proof: TurnProof, session: any) {
    const task = await this.processingGuard(proof);
    if (task.suspended) throw new SessionError("task_paused");
    const candidates = await this.processingOperations(session);
    const op =
      candidates.find(
        (r: any) =>
          r.turn_id === proof.turnId &&
          !["succeeded", "cancelled"].includes(r.job_status),
      ) ??
      candidates.find((r: any) => r.turn_id === proof.turnId) ??
      candidates[0];
    if (!op) throw new SessionError("processing_not_submitted", 422);
    const input = await this.sessions.guard(proof);
    if (
      op.turn_id !== proof.turnId &&
      !task.resume_requested &&
      !explicitResumeRequest(input.text)
    )
      throw new SessionError("processing_resume_required", 409);
    return op;
  }
  async processingCompatible(session: any, op: any, db: Query = this.db) {
    const bound = session.requirements.deliveries.find(
      (d: any) =>
        op.operation_key.startsWith("processing:" + d.id + ":") ||
        op.payload?.deliveryId === d.id,
    );
    if (bound?.status === "cancelled") return false;
    return (
      session.requirements_revision === op.requirements_revision ||
      (op.kind === "processing" &&
        (await this.processingOperations(session, db)).some(
          (r) => r.id === op.id,
        ))
    );
  }

  async expiredConfirmationRecovery(
    db: Query,
    scope: SessionScope,
    session: any,
    task: any,
  ) {
    if (task?.status !== "confirmation") return false;
    const cards = (
      await db.query(
        "SELECT * FROM assistant_runtime_confirmation WHERE session_id=$1 AND requirements_revision=$2 AND action='adopt' ORDER BY expires_at DESC",
        [session.id, session.requirements_revision],
      )
    ).rows;
    const operations = await this.processingOperations(session, db);
    for (const op of operations) {
      if (op.job_status !== "succeeded" || op.turn_id !== task.turn_id)
        continue;
      const card = cards.find((c: any) => c.payload?.runId === op.run_id);
      if (
        card &&
        (await this.receipt(scope, session.id, card.operation_id, db))
      )
        continue;
      if (
        card &&
        (card.status === "expired" ||
          (card.status === "pending" &&
            new Date(card.expires_at).getTime() <= this.now()))
      )
        return true;
    }
    return false;
  }
  async completedRecovery(
    db: Query,
    scope: SessionScope,
    session: any,
    task: any,
  ) {
    if (task?.status !== "completed") return false;
    const rows = await this.processingOperations(session, db);
    for (const op of rows) {
      if (["failed", "cancelled"].includes(op.job_status)) continue;
      const saves = (
        await db.query(
          "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND kind='adopt' AND run_id=$2",
          [session.id, op.run_id],
        )
      ).rows;
      let saved = false;
      for (const save of saves)
        if (await this.receipt(scope, session.id, save.id, db)) saved = true;
      if (!saved) return true;
    }
    return false;
  }
  async resume(scope: SessionScope, sessionId: string) {
    await guardAssistantMode(this.db);
    await this.sessions.get(scope, sessionId);
    const blocked = await this.blocked(sessionId);
    if (blocked) throw new SessionError(blocked);
    return this.transaction(scope, sessionId, async (c, s) => {
      await guardAssistantMode(c);
      await assertSaveTargetResolved(c, sessionId);
      const task = (
        await c.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (task?.suspended) {
        await restoreSuspended(c, sessionId, s.requirements_revision);
        Object.assign(
          task,
          (
            await c.query(
              "SELECT * FROM assistant_runtime_execution WHERE session_id=$1",
              [sessionId],
            )
          ).rows[0],
        );
      }
      if (task?.status === "completed") {
        await this.sessions.access(scope, true, c);
        const unresolved = await this.completedRecovery(c, scope, s, task);
        if (!unresolved) throw new SessionError("task_not_paused");
      } else if (
        !(await this.expiredConfirmationRecovery(c, scope, s, task)) &&
        (!task || !["paused", "failed"].includes(task.status))
      )
        throw new SessionError("task_not_paused");
      await this.assertActivityAvailable(c, task);
      if (
        task.no_progress >= 3 &&
        task.progress_revision === s.requirements_revision
      )
        throw new SessionError("no_progress");
      if (
        task.requests >= task.request_limit ||
        Number(task.active_ms) >= Number(task.active_limit_ms)
      )
        throw new SessionError("task_budget_exhausted");
      if (
        (
          await c.query(
            "SELECT 1 FROM assistant_runtime_turn WHERE session_id=$1 AND id<>$2 AND status IN('pending','running','waiting','confirmation')",
            [sessionId, task.turn_id],
          )
        ).rowCount
      )
        throw new SessionError("conversation_busy");
      await c.query(
        "UPDATE assistant_runtime_turn SET status='pending',runner_token=NULL,error_code=NULL,finished_at=NULL WHERE id=$1 AND status IN('paused','failed','succeeded','confirmation')",
        [task.turn_id],
      );
      await c.query(
        "UPDATE assistant_runtime_execution SET status='pending',reason=NULL,resume_requested=true WHERE session_id=$1",
        [sessionId],
      );
      await c.query(
        "UPDATE assistant_runtime_session SET status='busy' WHERE id=$1",
        [sessionId],
      );
      return task.turn_id;
    });
  }
  async requestResume(proof: TurnProof) {
    const blocked = await this.blocked(proof.sessionId);
    if (blocked) throw new SessionError(blocked);
    return this.transaction(proof, proof.sessionId, async (c, s) => {
      const task = await this.processingGuard(proof, c, true);
      const input = await this.sessions.guard(proof, true, c, true);
      const intent = resumeIntent(input.text);
      if (intent === "none")
        throw new SessionError("resume_authorization_required", 409);
      const targetName = requestedSaveName(input.text);
      const active = s.requirements.deliveries.filter(
        (d: any) => d.status === "active",
      );
      if (
        (intent === "amend-and-continue" && !targetName) ||
        (targetName &&
          (active.length !== 1 || active[0].saveTarget?.name !== targetName))
      )
        throw new BusinessError(
          409,
          "requirements_amendment_pending",
          "本次指定的保存名称尚未生效，任务保持暂停，未按旧目标继续",
        );
      await this.assertActivityAvailable(c, task);
      if (
        task.requests >= task.request_limit ||
        Number(task.active_ms) >= Number(task.active_limit_ms)
      )
        throw new SessionError("task_budget_exhausted");
      if (
        !task.suspended ||
        task.suspended.requirementsRevision !== s.requirements_revision
      )
        throw new SessionError("task_not_paused");
      if (task.suspended.noProgress >= 3) throw new SessionError("no_progress");
      await c.query(
        "UPDATE assistant_runtime_execution SET resume_suspended=true WHERE session_id=$1",
        [proof.sessionId],
      );
      const receipt = {
        queued: true,
        turnId: task.suspended.turnId,
        requirementsRevision: s.requirements_revision,
      };
      if (!task.resume_suspended)
        await this.sessions.event(proof, "resume_queued", receipt, c);
      return receipt;
    });
  }
  async observe(proof: TurnProof, kind: string, detail: any) {
    if (!["tool_result", "tool_error", "segment_empty"].includes(kind)) return;
    await this.transaction(proof, proof.sessionId, async (c, s) => {
      const t = await this.guard(proof, c, true);
      let seen: string[] = t.seen,
        misses = t.no_progress;
      if (t.progress_revision !== s.requirements_revision) {
        seen = [];
        misses = 0;
      }
      let result = detail.result;
      if (result && typeof result.content === "string") {
        try {
          result = JSON.parse(result.content);
        } catch {
          result = result.content;
        }
      }
      if (detail.name === "read_task_progress")
        result = {
          businessStatus: result?.businessStatus,
          readiness: result?.executionReadiness,
          results: result?.results
            ?.filter((r: any) => r.isCurrent)
            .map((r: any) => ({
              runId: r.run_id,
              status: r.status,
              count: r.output_count,
            })),
          confirmations: result?.confirmations?.map((c: any) => ({
            id: c.id,
            status: c.status,
          })),
          receipts: result?.receipts,
        };
      const rows =
        detail.name === "read_records"
          ? result?.records
          : detail.name === "list_sources"
            ? result?.items
            : undefined;
      const facts = Array.isArray(rows) ? rows : [result ?? null];
      const fingerprints = facts.map((fact: unknown) =>
        sha256(
          canonicalJson(
            JSON.parse(
              JSON.stringify({
                name: detail.name,
                source: detail.args?.source
                  ? {
                      kind: detail.args.source.kind,
                      id:
                        detail.args.source.kind === "assets"
                          ? null
                          : (detail.args.source.id ?? null),
                    }
                  : null,
                fact,
              }),
            ),
          ),
        ),
      );
      const advances =
        kind === "tool_result" &&
        !(
          ["create_requirements", "update_requirements"].includes(
            detail.name,
          ) && result?.unchanged === true
        ) &&
        fingerprints.some((f: string) => !seen.includes(f));
      if (advances) {
        seen = [...new Set([...seen, ...fingerprints])];
        misses = 0;
      } else misses++;
      await c.query(
        "UPDATE assistant_runtime_execution SET no_progress=$2,seen=$3,progress_revision=$4,progress_version=progress_version+$5 WHERE session_id=$1",
        [
          proof.sessionId,
          misses,
          JSON.stringify(seen),
          s.requirements_revision,
          advances ? 1 : 0,
        ],
      );
    });
    const t = (
      await this.db.query(
        "SELECT no_progress FROM assistant_runtime_execution WHERE session_id=$1",
        [proof.sessionId],
      )
    ).rows[0];
    if (t.no_progress >= 3) throw new SessionError("no_progress");
  }
  async operation(
    proof: TurnProof,
    key: string,
    kind: string,
    payload: unknown,
  ) {
    const hash = sha256(canonicalJson(payload));
    return this.transaction(proof, proof.sessionId, async (c, s) => {
      const prior = (
        await c.query(
          "SELECT * FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key=$2",
          [proof.sessionId, key],
        )
      ).rows[0];
      const equivalent =
        !prior && kind === "adopt"
          ? (
              await c.query(
                "SELECT * FROM assistant_runtime_operation WHERE session_id=$1 AND kind='adopt' AND requirements_revision=$2 AND request_hash=$3 ORDER BY id LIMIT 1",
                [proof.sessionId, s.requirements_revision, hash],
              )
            ).rows[0]
          : null;
      if (equivalent) return equivalent;
      if (prior) {
        if (prior.kind !== kind || prior.request_hash !== hash)
          throw new SessionError("operation_payload_conflict");
        return prior;
      }
      await this.guard(proof, c, true);
      const runId =
        kind === "adopt" ? (payload as { runId?: string })?.runId : null;
      if (
        kind === "adopt" &&
        (!runId ||
          !(
            await c.query(
              "SELECT id FROM processing_run WHERE id=$1 AND project_id=$2",
              [runId, proof.projectId],
            )
          ).rowCount)
      )
        throw new SessionError("processing_run_not_found", 404);
      const created = (
        await c.query(
          "INSERT INTO assistant_runtime_operation(id,session_id,turn_id,operation_key,kind,requirements_revision,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            id("operation"),
            proof.sessionId,
            proof.turnId,
            key,
            kind,
            s.requirements_revision,
            hash,
            JSON.stringify(payload),
          ],
        )
      ).rows[0];
      if (runId) {
        await c.query(
          "UPDATE assistant_runtime_operation SET run_id=$2 WHERE id=$1",
          [created.id, runId],
        );
        created.run_id = runId;
      }
      return created;
    });
  }
  async admitRows(
    proof: TurnProof,
    operationId: string,
    rows: number,
    db?: Query,
  ) {
    const admit = async (c: Query) => {
      const task = await this.guard(proof, c, true);
      const op = (
        await c.query(
          "SELECT rows_admitted FROM assistant_runtime_operation WHERE id=$1 AND session_id=$2 FOR UPDATE",
          [operationId, proof.sessionId],
        )
      ).rows[0];
      if (!op) throw new SessionError("operation_not_found", 404);
      if (op.rows_admitted) return;
      if (task.activity_id) {
        const cap = (
          await c.query(
            "SELECT * FROM assistant_runtime_activity WHERE id=$1 FOR UPDATE",
            [task.activity_id],
          )
        ).rows[0];
        if (
          !cap ||
          cap.closed_at ||
          (cap.row_limit !== null && cap.rows_used + rows > cap.row_limit)
        )
          throw new SessionError("activity_budget_exhausted");
        await c.query(
          "UPDATE assistant_runtime_activity SET rows_used=rows_used+$2 WHERE id=$1",
          [task.activity_id, rows],
        );
      }
      await c.query(
        "UPDATE assistant_runtime_operation SET rows_admitted=true WHERE id=$1",
        [operationId],
      );
    };
    return db ? admit(db) : this.transaction(proof, proof.sessionId, admit);
  }
  async receipt(
    scope: SessionScope,
    sessionId: string,
    operationId: string,
    db: Query = this.db,
  ) {
    await this.sessions.access(scope, false, db);
    const op = (
      await db.query(
        "SELECT o.* FROM assistant_runtime_operation o JOIN assistant_runtime_session s ON s.id=o.session_id WHERE o.id=$1 AND s.id=$2 AND s.project_id=$3 AND s.actor_id=$4",
        [operationId, sessionId, scope.projectId, scope.actorId],
      )
    ).rows[0];
    if (!op) throw new SessionError("operation_not_found", 404);
    if (op.kind === "adopt")
      return (
        (
          await db.query(
            "SELECT receipt FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [scope.projectId, scope.actorId, operationId],
          )
        ).rows[0]?.receipt ?? op.receipt
      );
    if (op.kind === "publish") {
      const row = (
        await db.query(
          `SELECT v.id,v.version_label,v.test_set_id,v.item_count FROM upload_idempotency i
       JOIN test_set_version v ON (i.operation='sparse_version_publish' AND v.id=i.asset_id) OR (i.operation='solo_test_set_publish' AND v.test_set_id=i.asset_id AND v.sequence=1)
       WHERE i.project_id=$1 AND i.actor_id=$2 AND i.idempotency_key=$3 AND i.status='committed'`,
          [
            scope.projectId,
            scope.actorId,
            `draft:${op.payload.draftId}:${op.payload.revision}`,
          ],
        )
      ).rows[0];
      if (row)
        return {
          draftId: op.payload.draftId,
          versionId: row.id,
          testSetId: row.test_set_id,
          label: row.version_label,
          recordCount: Number(row.item_count),
          action: "publish",
        };
    }
    if (op.kind === "selection") {
      const row = (
        await db.query(
          "SELECT receipt,apply_digest FROM selection_preview WHERE id=$1 AND project_id=$2 AND draft_id=$3",
          [op.payload.previewId, scope.projectId, op.payload.draftId],
        )
      ).rows[0];
      if (
        row?.receipt &&
        row.apply_digest ===
          sha256(canonicalJson([...op.payload.selectedIds].sort()))
      )
        return { ...row.receipt, action: "selection" };
    }
    return op.receipt;
  }
  operationScope(proof: TurnProof, operation: any, confirmationId?: string) {
    const fixed = { ...proof },
      op = structuredClone(operation);
    return operationScope(
      { projectId: proof.projectId, actorId: proof.actorId },
      {
        receipt: async (db, result) => {
          if (result === undefined) {
            return (
              await db.query(
                "SELECT receipt FROM assistant_runtime_operation WHERE id=$1 AND session_id=$2",
                [op.id, fixed.sessionId],
              )
            ).rows[0]?.receipt;
          }
          await db.query(
            "UPDATE assistant_runtime_operation SET receipt=$2 WHERE id=$1 AND session_id=$3",
            [op.id, JSON.stringify(result), fixed.sessionId],
          );
          return result;
        },
        origin: "runtime",
        sessionId: proof.sessionId,
        guard: async (db, action) => {
          if (action === "cancel" || action === "account")
            await this.guard(fixed, db, true);
          else await this.processingGuard(fixed, db, true);
          const s = await this.sessions.get(fixed, fixed.sessionId, db);
          if (!(await this.processingCompatible(s, op, db)))
            throw new SessionError("requirements_revision_conflict");
          if (
            action &&
            action !== "cancel" &&
            !(action === "account" && op.kind === "account_mutation") &&
            ![
              "processing",
              "processing_control",
              "processing_mutation",
            ].includes(op.kind)
          ) {
            const c = (
              await db.query(
                "SELECT * FROM assistant_runtime_confirmation WHERE id=$1 AND operation_id=$2 AND session_id=$3 AND actor_id=$4 AND status='executing' AND expires_at>$5 AND requirements_revision=$6 FOR SHARE",
                [
                  confirmationId,
                  op.id,
                  fixed.sessionId,
                  fixed.actorId,
                  new Date(this.now()),
                  s.requirements_revision,
                ],
              )
            ).rows[0];
            if (
              !c ||
              c.action !== op.kind ||
              canonicalJson(c.payload) !== canonicalJson(op.payload)
            )
              throw new SessionError("confirmation_expired");
          }
        },
        link: async (db, runId) => {
          await this.guard(fixed, db, true);
          const run = (
            await db.query(
              "SELECT options,input_count FROM processing_run WHERE id=$1 AND project_id=$2",
              [runId, fixed.projectId],
            )
          ).rows[0];
          if (
            run?.options.operation === "clean" &&
            !run.options.instructions.trim()
          )
            await this.admitRows(fixed, op.id, Number(run.input_count), db);
          const changed = await db.query(
            "UPDATE assistant_runtime_operation SET run_id=$2 WHERE id=$1 AND session_id=$3 AND (run_id IS NULL OR run_id=$2) RETURNING id",
            [op.id, runId, fixed.sessionId],
          );
          if (!changed.rowCount)
            throw new SessionError("operation_payload_conflict");
        },
        background: async (db, request) => {
          await this.processingGuard(fixed, db);
          const session = await this.sessions.get(fixed, fixed.sessionId, db);
          if (!(await this.processingCompatible(session, op, db)))
            throw new SessionError("requirements_revision_conflict");
          const delivery = session.requirements.deliveries.find(
            (d) =>
              d.status === "active" &&
              op.operation_key.startsWith("processing:" + d.id + ":"),
          );
          if (
            !delivery &&
            !op.payload.taskId &&
            session.requirements.deliveries.length
          )
            throw new SessionError("delivery_not_found", 404);
          if (delivery) {
            assertInstructionsCurrent(delivery);
            if (
              delivery.operation !== request.options.operation ||
              (["clean", "rewrite"].includes(delivery.operation!)
                ? delivery.count !== request.records.length
                : delivery.count !== request.options.outputCount) ||
              (delivery.operation === "generate"
                ? request.source.kind !== "background"
                : canonicalJson(
                    delivery.source
                      ? {
                          ...delivery.source,
                          recordIds: [
                            ...(delivery.source.recordIds ?? []),
                          ].sort(),
                          ...(delivery.source.kind === "assets"
                            ? { assetIds: [...delivery.source.assetIds].sort() }
                            : {}),
                        }
                      : null,
                  ) !==
                  canonicalJson({
                    ...request.source,
                    recordIds: [...request.source.recordIds].sort(),
                  })) ||
              canonicalJson(delivery.allowedFields) !==
                canonicalJson(request.options.allowedFields) ||
              (delivery.instructions ?? "") !== request.options.instructions ||
              canonicalJson(
                (delivery.allowedFields?.includes("metadata")
                  ? delivery.metadataKeys
                  : undefined) ?? null,
              ) !== canonicalJson(request.options.metadataKeys ?? null)
            )
              throw new SessionError("operation_payload_conflict");
            validateProcessingRequirements(
              {
                targetCount: delivery.count,
                allowedFields: delivery.allowedFields,
                metadataKeys: delivery.metadataKeys,
                classifications: delivery.classifications,
              },
              request.options,
              request.records,
              [],
              true,
            );
          }
          if (
            delivery &&
            request.options.operation === "clean" &&
            !request.options.instructions.trim()
          ) {
            const prospective = cleanRecords(
              request.records,
              request.options,
            ).records.map((r) => ({ ...r, id: r.sourceId }));
            validateDeliveryResults(delivery, prospective, request.options);
          }
          return {
            contentReviewPolicy: "manual-v1",
            currentRequirements: true,
            requirements: normalizedRequirements([
              ...(delivery ? [deliveryExecution(delivery).summary] : []),
              session.requirements.objective,
              request.options.instructions,
            ]),
            ...(delivery?.classifications
              ? {
                  classifications: validateRules({
                    targetCount: delivery.count,
                    classifications: delivery.classifications,
                  }),
                }
              : {}),
            documents: (
              await db.query(
                "SELECT id,name,object_ref,extracted FROM assistant_runtime_attachment WHERE session_id=$1 AND removed_at IS NULL ORDER BY created_at,id",
                [fixed.sessionId],
              )
            ).rows.map((row: any) => ({
              id: row.id,
              fileName: row.name,
              sha256: row.object_ref.split("/").at(-1),
              extractorVersion: row.extracted.extractorVersion,
              fragments: row.extracted.fragments,
            })),
          };
        },
        results: async (db, runIds) => {
          if (op.payload.taskId) {
            const valid = await db.query(
              "SELECT id FROM processing_run WHERE project_id=$1 AND task_id=$2 AND id=ANY($3::text[])",
              [fixed.projectId, op.payload.taskId, runIds],
            );
            if (valid.rowCount !== new Set(runIds).size)
              throw new SessionError("processing_result_scope_changed");
          } else if (!op.run_id || runIds.some((r) => r !== op.run_id))
            throw new SessionError("processing_result_scope_changed");
          await this.guard(fixed, db, true);
        },
      },
    );
  }
  async prepare(proof: TurnProof, operation: any) {
    return this.transaction(proof, proof.sessionId, async (c, s) => {
      await this.guard(proof, c, true);
      await assertSaveTargetResolved(c, proof.sessionId);
      const op = (
        await c.query(
          "SELECT * FROM assistant_runtime_operation WHERE id=$1 AND session_id=$2",
          [operation.id, proof.sessionId],
        )
      ).rows[0];
      if (!op || op.requirements_revision !== s.requirements_revision)
        throw new SessionError("requirements_revision_conflict");
      const prior = (
        await c.query(
          "SELECT * FROM assistant_runtime_confirmation WHERE operation_id=$1 ORDER BY expires_at DESC LIMIT 1",
          [op.id],
        )
      ).rows[0];
      if (
        prior &&
        prior.status === "pending" &&
        new Date(prior.expires_at).getTime() > this.now()
      )
        return prior;
      if (prior && prior.status === "committed") return prior;
      if (prior)
        await c.query(
          "UPDATE assistant_runtime_confirmation SET status='expired' WHERE id=$1 AND status='pending'",
          [prior.id],
        );
      if (
        ["publish", "selection", "remove_record", "discard_draft"].includes(
          op.kind,
        )
      )
        await c.query(
          `UPDATE assistant_runtime_confirmation c SET status='expired' FROM assistant_runtime_operation other WHERE c.operation_id=other.id AND c.session_id=$1 AND c.status='pending' AND c.action=$2 AND other.payload->>'draftId'=$3 AND other.id<>$4`,
          [proof.sessionId, op.kind, op.payload.draftId, op.id],
        );
      return (
        await c.query(
          "INSERT INTO assistant_runtime_confirmation(id,session_id,actor_id,operation_id,action,payload,requirements_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            id("confirmation"),
            proof.sessionId,
            proof.actorId,
            op.id,
            op.kind,
            JSON.stringify(op.payload),
            s.requirements_revision,
            new Date(this.now() + 300000),
          ],
        )
      ).rows[0];
    });
  }
  async assertActivityAvailable(db: Query, task: any) {
    if (!task?.activity_id) return;
    const cap = (
      await db.query(
        "SELECT * FROM assistant_runtime_activity WHERE id=$1 FOR UPDATE",
        [task.activity_id],
      )
    ).rows[0];
    if (
      !cap ||
      cap.closed_at ||
      cap.requests >= cap.request_limit ||
      (Number(cap.row_limit) > 0 && cap.rows_used >= cap.row_limit) ||
      (cap.started_at &&
        this.now() - new Date(cap.started_at).getTime() >= Number(cap.max_ms))
    )
      throw new SessionError("activity_budget_exhausted");
  }
  async offer(scope: SessionScope, sessionId: string) {
    return this.transaction(scope, sessionId, async (c, s) => {
      await this.sessions.access(scope, true, c);
      const t = (
        await c.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (
        !t ||
        t.status !== "paused" ||
        !["task_budget_exhausted", "model_request_timeout"].includes(t.reason)
      )
        throw new SessionError("budget_offer_unavailable");
      await this.assertActivityAvailable(c, t);
      const current = (
        await c.query(
          "SELECT * FROM assistant_runtime_confirmation WHERE session_id=$1 AND action='budget' AND status='pending' AND requirements_revision=$2 AND expires_at>$3",
          [sessionId, s.requirements_revision, new Date(this.now())],
        )
      ).rows[0];
      if (current) return current;
      return (
        await c.query(
          "INSERT INTO assistant_runtime_confirmation(id,session_id,actor_id,action,payload,requirements_revision,expires_at) VALUES($1,$2,$3,'budget',$4,$5,$6) RETURNING *",
          [
            id("offer"),
            sessionId,
            scope.actorId,
            JSON.stringify({
              requests: 12,
              activeMs: 80000,
              atRequests: t.requests,
              atActiveMs: t.active_ms,
            }),
            s.requirements_revision,
            new Date(this.now() + 300000),
          ],
        )
      ).rows[0];
    });
  }
  async approve(
    scope: SessionScope,
    sessionId: string,
    confirmationId: string,
    artifacts: ArtifactRepository,
  ) {
    const claim = await this.transaction(scope, sessionId, async (c, s) => {
      await this.sessions.access(scope, true, c);
      const card = (
        await c.query(
          "SELECT * FROM assistant_runtime_confirmation WHERE id=$1 AND session_id=$2 AND actor_id=$3 FOR UPDATE",
          [confirmationId, sessionId, scope.actorId],
        )
      ).rows[0];
      if (!card) throw new SessionError("confirmation_not_found", 404);
      const prior = card.operation_id
        ? await this.receipt(scope, sessionId, card.operation_id, c)
        : card.receipt;
      if (prior) return { receipt: prior, replayed: true };
      await guardAssistantMode(c);
      if (
        !["pending", "executing"].includes(card.status) ||
        new Date(card.expires_at).getTime() <= this.now() ||
        card.requirements_revision !== s.requirements_revision
      )
        throw new SessionError("confirmation_expired");
      if (card.action !== "budget")
        await assertSaveTargetResolved(c, sessionId);
      if (card.action === "budget") {
        const task = (
          await c.query(
            "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
            [sessionId],
          )
        ).rows[0];
        await this.assertActivityAvailable(c, task);
        if (
          task.requests !== card.payload.atRequests ||
          task.active_ms !== card.payload.atActiveMs ||
          task.status !== "paused"
        )
          throw new SessionError("budget_offer_changed");
        await c.query(
          "UPDATE assistant_runtime_execution SET request_limit=request_limit+$2,active_limit_ms=active_limit_ms+$3,reason=NULL WHERE session_id=$1",
          [sessionId, card.payload.requests, card.payload.activeMs],
        );
        await c.query(
          "INSERT INTO assistant_runtime_grant(id,session_id,actor_id,requests,active_ms) VALUES($1,$2,$3,$4,$5)",
          [
            card.id,
            sessionId,
            scope.actorId,
            card.payload.requests,
            card.payload.activeMs,
          ],
        );
        const receipt = {
          grantId: card.id,
          addedRequests: card.payload.requests,
          addedActiveMs: card.payload.activeMs,
        };
        await c.query(
          "UPDATE assistant_runtime_confirmation SET status='committed',receipt=$2 WHERE id=$1",
          [card.id, JSON.stringify(receipt)],
        );
        return { receipt, replayed: false };
      }
      if (card.status === "executing")
        return { pending: true, operationId: card.operation_id };
      if (
        ![
          "adopt",
          "management",
          "publish",
          "selection",
          "remove_record",
          "discard_draft",
        ].includes(card.action)
      )
        throw new SessionError("action_not_connected", 422);
      const task = (
        await c.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (card.action === "management")
        await this.assertActivityAvailable(c, task);
      if (task.status !== "confirmation")
        throw new SessionError("confirmation_expired");
      const op = (
        await c.query("SELECT * FROM assistant_runtime_operation WHERE id=$1", [
          card.operation_id,
        ])
      ).rows[0];
      const token = id("runner"),
        proof = { ...scope, sessionId, turnId: task.turn_id, token };
      await c.query(
        "UPDATE assistant_runtime_confirmation SET status='executing' WHERE id=$1",
        [card.id],
      );
      await c.query(
        "UPDATE assistant_runtime_turn SET status='running',runner_token=$2 WHERE id=$1",
        [task.turn_id, token],
      );
      await c.query(
        "UPDATE assistant_runtime_execution SET status='running',lease_until=$2 WHERE session_id=$1",
        [sessionId, new Date(this.now() + this.policy.leaseMs)],
      );
      return { card, op, proof };
    });
    if (!claim.proof) return claim;
    const { card, op, proof } = claim;
    let receipt: any;
    const heartbeat = setInterval(
      () => {
        void this.renew(proof);
      },
      Math.max(20, this.policy.leaseMs / 4),
    );
    heartbeat.unref();
    try {
      if (op.kind === "management") {
        const scoped = this.operationScope(proof, op, card.id);
        const check = async (c: any) => {
          const current = await managementSnapshot(
            c,
            scoped,
            op.payload.command,
            op.payload.input,
            true,
          );
          if (current.hash !== op.payload.snapshot)
            throw new SessionError("management_target_changed");
        };
        const a = accountOperations(this.db, () => new Date(), check),
          r = recycleOperations(this.db, check);
        const service: any = ["trashSet", "trashBranch", "restore"].includes(
          op.payload.command,
        )
          ? r
          : a;
        const allowed = [
          "invite",
          "revokeInvitation",
          "changeRole",
          "removeMember",
          "trashSet",
          "trashBranch",
          "restore",
        ];
        if (!allowed.includes(op.payload.command))
          throw new SessionError("management_command_invalid", 422);
        receipt = await service[op.payload.command](scoped, op.payload.input);
      } else if (op.kind === "adopt") {
        const result = op.payload.taskId
          ? await acceptTask(
              this.db,
              artifacts,
              this.operationScope(proof, op, card.id),
              op.payload.taskId,
              op.id,
              op.payload.input,
            )
          : await acceptProcessingResults(
              this.db,
              artifacts,
              this.operationScope(proof, op, card.id),
              op.payload.runId,
              op.id,
              op.payload.input,
            );
        receipt = result.receipt;
      } else {
        const scope = this.operationScope(proof, op, card.id),
          domain = draftOperations(this.db, artifacts),
          payload = op.payload;
        const result: any = await withOperationScope(scope, async () => {
          if (op.kind === "publish")
            return domain.publishDraft(
              { ...scope, draftId: payload.draftId },
              { revision: payload.revision },
            );
          if (op.kind === "selection")
            return applySelectionPreview(
              this.db,
              { ...scope, draftId: payload.draftId },
              payload.previewId,
              {
                selectedIds: payload.selectedIds,
                expectedRevision: payload.expectedRevision,
              },
            );
          if (op.kind === "remove_record")
            return domain.removeRecord(
              {
                ...scope,
                draftId: payload.draftId,
                recordId: payload.recordId,
              },
              { expectedRowRevision: payload.expectedRowRevision },
            );
          return domain.discard(
            { ...scope, draftId: payload.draftId },
            { expectedRevision: payload.revision },
          );
        });
        receipt =
          op.kind === "publish"
            ? {
                draftId: payload.draftId,
                versionId: result.version.id,
                testSetId: result.testSet.id,
                label: result.version.label,
                recordCount: result.version.recordCount,
                action: op.kind,
              }
            : { ...result, draftId: payload.draftId, action: op.kind };
      }
    } catch (error) {
      receipt = await this.receipt(scope, sessionId, op.id);
      if (!receipt) {
        await this.db.query(
          "UPDATE assistant_runtime_confirmation SET status='expired' WHERE id=$1 AND status='executing'",
          [card.id],
        );
        await this.yield(proof, "paused", "confirmation_failed").catch(
          () => undefined,
        );
        clearInterval(heartbeat);
        throw error;
      }
    }
    clearInterval(heartbeat);
    // Deleting a referenced object can intentionally invalidate this very session; its business receipt is still committed.
    const lifecycle = await this.sessions.get(scope, sessionId);
    if (lifecycle.invalidated_at) return { receipt, replayed: false };
    // This cache may be lost; processing_acceptance remains the transactionally committed authority.
    await this.transaction(scope, sessionId, async (c) => {
      await c.query(
        "UPDATE assistant_runtime_confirmation SET status='committed',receipt=$2 WHERE id=$1",
        [card.id, JSON.stringify(receipt)],
      );
      await c.query(
        "UPDATE assistant_runtime_operation SET receipt=$2 WHERE id=$1",
        [op.id, JSON.stringify(receipt)],
      );
      // Stop wins scheduling; it cannot undo a receipt already committed by the business transaction.
      const advanced = await c.query(
        "UPDATE assistant_runtime_turn SET status='pending',runner_token=NULL WHERE id=$1 AND status='running' AND runner_token=$2",
        [proof.turnId, proof.token],
      );
      if (advanced.rowCount)
        await c.query(
          "UPDATE assistant_runtime_execution SET status='pending',lease_until=NULL WHERE session_id=$1 AND status='running' AND turn_id=$2",
          [sessionId, proof.turnId],
        );
    });
    return { receipt, replayed: false };
  }
  async reject(scope: SessionScope, sessionId: string, confirmationId: string) {
    await this.transaction(scope, sessionId, async (c) => {
      const changed = await c.query(
        "UPDATE assistant_runtime_confirmation SET status='rejected' WHERE id=$1 AND session_id=$2 AND actor_id=$3 AND status='pending' RETURNING id",
        [confirmationId, sessionId, scope.actorId],
      );
      if (!changed.rowCount) throw new SessionError("confirmation_expired");
    });
    await this.stopped(scope, sessionId);
  }

  async recoverConfirmations() {
    const rows = (
      await this.db.query(
        "SELECT c.id,c.session_id,s.project_id,s.actor_id FROM assistant_runtime_confirmation c JOIN assistant_runtime_execution e ON e.session_id=c.session_id JOIN assistant_runtime_session s ON s.id=c.session_id WHERE s.runtime_version=$1 AND s.deleted_at IS NULL AND s.invalidated_at IS NULL AND c.status='executing' AND (e.lease_until IS NULL OR e.lease_until<=now()) LIMIT 50",
        [FORMAL_RUNTIME_VERSION],
      )
    ).rows;
    for (const row of rows)
      await this.transaction(
        { projectId: row.project_id, actorId: row.actor_id },
        row.session_id,
        async (c, s) => {
          const task = (
            await c.query(
              "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
              [row.session_id],
            )
          ).rows[0];
          if (new Date(task.lease_until).getTime() > this.now()) return;
          const card = (
            await c.query(
              "SELECT * FROM assistant_runtime_confirmation WHERE id=$1 AND status='executing' FOR UPDATE",
              [row.id],
            )
          ).rows[0];
          if (!card) return;
          const receipt = await this.receipt(
            { projectId: row.project_id, actorId: row.actor_id },
            row.session_id,
            card.operation_id,
            c,
          );
          const valid =
            task.status !== "paused" &&
            card.requirements_revision === s.requirements_revision &&
            new Date(card.expires_at).getTime() > this.now();
          await c.query(
            "UPDATE assistant_runtime_confirmation SET status=$2,receipt=$3 WHERE id=$1",
            [
              card.id,
              receipt ? "committed" : valid ? "pending" : "expired",
              receipt ? JSON.stringify(receipt) : null,
            ],
          );
          const status =
            task.status === "paused"
              ? "paused"
              : receipt
                ? "pending"
                : valid
                  ? "confirmation"
                  : "paused";
          await c.query(
            "UPDATE assistant_runtime_turn SET status=$2,runner_token=NULL WHERE id=$1 AND status='running'",
            [task.turn_id, status],
          );
          await c.query(
            "UPDATE assistant_runtime_execution SET status=$2,lease_until=NULL WHERE session_id=$1",
            [row.session_id, status],
          );
          await c.query(
            "UPDATE assistant_runtime_session SET status=$2 WHERE id=$1",
            [row.session_id, status === "pending" ? "busy" : status],
          );
        },
      ).catch(() => undefined);
  }

  async wake() {
    if (!(await assistantEnabled(this.db))) return;
    // Reconcile durable business terminal states. No model polling and no event-sequence progress heuristic.
    const waiting = (
      await this.db.query(
        "SELECT e.session_id,e.turn_id,s.project_id,s.actor_id FROM assistant_runtime_execution e JOIN assistant_runtime_session s ON s.id=e.session_id WHERE s.runtime_version=$1 AND s.deleted_at IS NULL AND s.invalidated_at IS NULL AND e.status='waiting' LIMIT 50",
        [FORMAL_RUNTIME_VERSION],
      )
    ).rows;
    for (const w of waiting)
      await this.transaction(
        { projectId: w.project_id, actorId: w.actor_id },
        w.session_id,
        async (c, s) => {
          const t = (
            await c.query(
              "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
              [w.session_id],
            )
          ).rows[0];
          if (t.status !== "waiting") return;
          const refs = (
            await c.query(
              "SELECT o.id,o.requirements_revision,j.status FROM assistant_runtime_operation o JOIN processing_run r ON r.id=o.run_id JOIN job j ON j.id=r.job_id WHERE o.session_id=$1 AND o.turn_id=$2 AND o.kind='processing'",
              [w.session_id, t.turn_id],
            )
          ).rows;
          if (
            !refs.length ||
            refs.some(
              (r) => !["succeeded", "failed", "cancelled"].includes(r.status),
            )
          )
            return;
          const compatible = new Set(
            (await this.processingOperations(s, c)).map((o) => o.id),
          );
          if (refs.some((r) => !compatible.has(r.id))) {
            await c.query(
              "UPDATE assistant_runtime_execution SET status='paused',reason='requirements_revision_conflict' WHERE session_id=$1",
              [w.session_id],
            );
            await c.query(
              "UPDATE assistant_runtime_turn SET status='paused' WHERE id=$1",
              [t.turn_id],
            );
            return;
          }
          await c.query(
            "UPDATE assistant_runtime_turn SET status='pending' WHERE id=$1 AND status='waiting'",
            [t.turn_id],
          );
          await c.query(
            "UPDATE assistant_runtime_execution SET status='pending',progress_version=progress_version+1,no_progress=0 WHERE session_id=$1",
            [w.session_id],
          );
        },
      ).catch(() => undefined);
  }
  async projection(scope: SessionScope, sessionId: string) {
    await this.sessions.get(scope, sessionId);
    const task =
      (
        await this.db.query(
          "SELECT turn_id,suspended->>'turnId' AS suspended_turn_id,status,reason,requests,request_limit,worker_requests,worker_ms,active_ms,active_limit_ms,no_progress,progress_version,activity_id,coalesce(feedback->>'kind'='requirements',false) OR coalesce(suspended->'feedback'->>'kind'='requirements',false) AS amendment_pending FROM assistant_runtime_execution WHERE session_id=$1",
          [sessionId],
        )
      ).rows[0] ?? null;
    const pendingSaveTarget = await saveTargetAmendment(this.db, sessionId);
    if (task && pendingSaveTarget) task.amendment_pending = true;
    const current = await this.sessions.get(scope, sessionId);
    const currentRuns = new Set(
      (await this.processingOperations(current)).map((o) => o.run_id),
    );
    const cards = (
      await this.db.query(
        "SELECT c.id,c.operation_id,c.action,c.payload,c.requirements_revision,c.status,c.expires_at,c.receipt,o.turn_id FROM assistant_runtime_confirmation c LEFT JOIN assistant_runtime_operation o ON o.id=c.operation_id WHERE c.session_id=$1 ORDER BY c.expires_at DESC",
        [sessionId],
      )
    ).rows;
    for (const card of cards) {
      if (card.status !== "pending" || !card.payload?.draftId) continue;
      const draft = (
        await this.db.query(
          "SELECT revision,status FROM collaborative_draft WHERE id=$1 AND project_id=$2",
          [card.payload.draftId, scope.projectId],
        )
      ).rows[0];
      if (
        !draft ||
        draft.status !== "editing" ||
        Number(draft.revision) !== card.payload.revision
      )
        card.status = "expired";
      if (card.status === "pending" && card.action === "selection") {
        const selected = (
          await this.db.query(
            "SELECT configuration,creator_id FROM selection_preview WHERE id=$1 AND draft_id=$2",
            [card.payload.previewId, card.payload.draftId],
          )
        ).rows[0];
        const latest = selected
          ? (
              await this.db.query(
                "SELECT configuration FROM selection_preview WHERE draft_id=$1 AND creator_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
                [card.payload.draftId, selected.creator_id],
              )
            ).rows[0]
          : null;
        if (
          !selected ||
          !latest ||
          canonicalJson(selected.configuration) !==
            canonicalJson(latest.configuration)
        )
          card.status = "expired";
      }
    }
    const receipts = [];
    // Enrich immutable operation receipts for presentation without rewriting history.
    const resolvedReceipts = await Promise.all(
      cards.map((c) =>
        c.operation_id
          ? this.receipt(scope, sessionId, c.operation_id)
          : Promise.resolve(c.receipt),
      ),
    );
    const draftIds = [
      ...new Set(resolvedReceipts.map((r) => r?.draftId).filter(Boolean)),
    ];
    const drafts = draftIds.length
      ? (
          await this.db.query(
            "SELECT d.id,d.name,d.status,(SELECT count(*)::int FROM collaborative_draft_record r WHERE r.draft_id=d.id AND NOT r.deleted) AS record_count FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id LEFT JOIN test_set_version pv ON pv.id=d.parent_version_id LEFT JOIN test_set_version pub ON pub.id=d.published_version_id WHERE d.project_id=$1 AND d.id=ANY($2::text[]) AND d.status IN ('editing','published') AND (ts.id IS NULL OR ts.status='available') AND (pv.id IS NULL OR pv.status='published') AND (d.status<>'published' OR pub.status='published')",
            [scope.projectId, draftIds],
          )
        ).rows
      : [];

    const keys = new Set<string>();
    for (const [index, card] of cards.entries()) {
      const receipt = resolvedReceipts[index];
      if (receipt) {
        card.status = "committed";
        card.receipt = receipt;
        const key = String(
          receipt.acceptanceId ?? receipt.grantId ?? card.operation_id,
        );
        if (!keys.has(key)) {
          keys.add(key);
          const draft = drafts.find((d) => d.id === receipt.draftId);
          receipts.push({
            ...receipt,
            ...(receipt.draftId
              ? {
                  savedDraftName:
                    card.payload?.input?.target?.name ??
                    card.payload?.draftName ??
                    null,
                  draftName: draft?.name ?? null,
                  draftStatus: draft?.status ?? "unavailable",
                  draftRecordCount: draft ? Number(draft.record_count) : null,
                }
              : {}),
            executionTurnId: card.turn_id,
            isCurrent:
              (card.action === "adopt"
                ? currentRuns.has(card.payload?.runId)
                : card.turn_id ===
                  (task?.suspended_turn_id ?? task?.turn_id)) &&
              card.requirements_revision === current.requirements_revision,
          });
        }
      } else if (
        card.status === "pending" &&
        (new Date(card.expires_at).getTime() <= this.now() ||
          card.requirements_revision !==
            (await this.sessions.get(scope, sessionId)).requirements_revision)
      )
        card.status = "expired";
    }
    const results = (
      await this.db.query(
        "SELECT DISTINCT ON (r.id) o.id,o.run_id,o.turn_id,o.requirements_revision,r.round_number,r.id=t.latest_run_id AS is_latest,j.status,(SELECT coalesce(sum(b.output_count),0)::int FROM processing_batch b WHERE b.run_id=r.id) AS output_count FROM assistant_runtime_operation o JOIN processing_run r ON r.id=o.run_id JOIN job j ON j.id=r.job_id JOIN processing_task t ON t.id=r.task_id WHERE o.session_id=$1 AND o.kind='processing' ORDER BY r.id,o.id",
        [sessionId],
      )
    ).rows.map((r) => ({
      ...r,
      isLatest: r.is_latest,
      isCurrent: currentRuns.has(r.run_id),
    }));
    return {
      execution: task,
      pendingSaveTarget: pendingSaveTarget
        ? {
            name: pendingSaveTarget.name,
            deliveryId: pendingSaveTarget.deliveryId,
            message:
              "保存名称尚未修改，任务保持暂停。可完成或明确撤销这项改名要求。",
          }
        : null,
      canRenewConfirmation: await this.expiredConfirmationRecovery(
        this.db,
        scope,
        current,
        task,
      ),
      canResumeCompleted: await this.completedRecovery(
        this.db,
        scope,
        current,
        task,
      ),
      executionReadiness: executionReadiness(
        current.requirements,
        !!task?.amendment_pending,
      ),
      confirmations: cards,
      receipts,
      results,
      businessStatus: receipts.some((r) => r.isCurrent && r.versionId)
        ? "published"
        : receipts.some((r) => r.isCurrent && r.acceptanceId)
          ? "saved"
          : cards.some(
                (c) =>
                  [
                    "adopt",
                    "publish",
                    "selection",
                    "remove_record",
                    "discard_draft",
                  ].includes(c.action) &&
                  c.status === "pending" &&
                  new Date(c.expires_at).getTime() > this.now() &&
                  (c.action !== "adopt" || currentRuns.has(c.payload?.runId)) &&
                  c.requirements_revision === current.requirements_revision,
              )
            ? "confirmation"
            : results.some((r) => r.isCurrent && r.status === "succeeded")
              ? "generated"
              : "not_saved",
    };
  }
  async reserveWorker(
    runId: string,
    requestId: string,
    hash: string,
    cost?: { rows: number; generated?: number },
  ) {
    const op = (
      await this.db.query(
        "SELECT o.*,s.project_id,s.actor_id FROM assistant_runtime_operation o JOIN assistant_runtime_session s ON s.id=o.session_id JOIN assistant_runtime_execution e ON e.session_id=s.id JOIN processing_run owned_run ON owned_run.id=o.run_id JOIN job owned_job ON owned_job.id=owned_run.job_id WHERE o.run_id=$1 AND o.kind='processing' AND owned_job.payload->>'executionOrigin' IS DISTINCT FROM 'manual' ORDER BY (e.turn_id=o.turn_id) DESC LIMIT 1",
        [runId],
      )
    ).rows[0];
    if (!op) return false;
    return this.transaction(
      { projectId: op.project_id, actorId: op.actor_id },
      op.session_id,
      async (c, s) => {
        await guardAssistantMode(c);
        await this.sessions.access(
          { projectId: op.project_id, actorId: op.actor_id },
          true,
          c,
        );
        const task = (
          await c.query(
            "SELECT * FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
            [op.session_id],
          )
        ).rows[0];
        if (
          !["running", "waiting"].includes(task.status) ||
          task.suspended ||
          task.turn_id !== op.turn_id ||
          !(await this.processingCompatible(s, op, c))
        )
          throw new SessionError("runtime_interrupted");
        if (!cost || !Number.isSafeInteger(cost.rows) || cost.rows < 0)
          throw new SessionError("worker_cost_missing");
        const inputCount = cost.rows;
        const generated = cost.generated ?? 0;
        if (!Number.isSafeInteger(generated) || generated < 0)
          throw new SessionError("worker_cost_missing");
        let admittedMs = this.policy.requestMs;
        if (task.activity_id) {
          const cap = (
            await c.query(
              "SELECT * FROM assistant_runtime_activity WHERE id=$1 FOR UPDATE",
              [task.activity_id],
            )
          ).rows[0];
          if (
            !cap ||
            cap.closed_at ||
            cap.requests >= cap.request_limit ||
            (cap.row_limit !== null &&
              cap.rows_used + inputCount > cap.row_limit) ||
            (cap.generated_limit !== null &&
              cap.generated_used + generated > cap.generated_limit) ||
            (cap.started_at &&
              this.now() - new Date(cap.started_at).getTime() >=
                Number(cap.max_ms))
          )
            throw new SessionError("activity_budget_exhausted");
          admittedMs = Math.min(
            admittedMs,
            Number(cap.max_ms) -
              (cap.started_at
                ? this.now() - new Date(cap.started_at).getTime()
                : 0),
          );
          await c.query(
            "UPDATE assistant_runtime_activity SET requests=requests+1,rows_used=rows_used+$3,generated_used=generated_used+$4,started_at=coalesce(started_at,$2) WHERE id=$1",
            [cap.id, new Date(this.now()), inputCount, generated],
          );
        }
        await c.query(
          "UPDATE assistant_runtime_execution SET worker_requests=worker_requests+1 WHERE session_id=$1",
          [op.session_id],
        );
        await c.query(
          "INSERT INTO assistant_runtime_request(id,session_id,turn_id,runner_token,purpose,request_hash,started_at) VALUES($1,$2,$3,$4,'worker',$5,$6)",
          [
            requestId,
            op.session_id,
            op.turn_id,
            "worker:" + runId,
            hash,
            new Date(this.now()),
          ],
        );
        return Math.max(1, Math.floor(admittedMs));
      },
    );
  }
}
