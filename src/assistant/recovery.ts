import {
  classifyToolFailure,
  repairRequestAvailable,
  type RepairLimits,
} from "./tool-repair.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import {
  checkpointExecutionBudget,
  executionLimits,
  requestFitsDeadline,
  settleActiveBudget,
  type ActiveBudget,
  type ExecutionBudget,
} from "./budget.js";
import { continuationAllowed } from "./intent.js";
import { planRequirementsKey } from "./plan.js";
import { savedPlanningQuestion } from "./receipts.js";

export type RecoveryDecision = {
  action: "retry_turn" | "continue_plan" | "continue_execution" | null;
  reason: string;
  revision: number;
  validUntil: number | null;
  originTurnId: string | null;
  rootTurnId: string | null;
  mode: "plan" | "execute" | null;
  canExecutePlan: boolean;
};
export type RecoveryFacts = {
  now?: number;
  revision: number;
  canWrite: boolean;
  dependenciesValid: boolean;
  documentsKey?: string;
  legacyDocumentsKey?: string;
  turnCount?: number;
  busy?: boolean;
  phase?: "offer" | "claim" | "request" | "event" | "commit";
  token?: string;
  reservedModelStep?: boolean;
  requestEstimateMs?: number;
  event?: string;
  eventReady?: boolean;
};
export const validExecutionBudget = (b: any) =>
  b &&
  ["modelSteps", "toolCalls", "transportRetries", "activeMs"].every(
    (k) => typeof b[k] === "number" && Number.isFinite(b[k]) && b[k] >= 0,
  );
export function backgroundVersion(
  documents: Record<string, any>[],
  legacy = false,
) {
  return sha256(
    canonicalJson(
      documents
        .map((d) => ({
          id:
            legacy && /^background_[a-f0-9]{24,}$/i.test(d.id)
              ? "o:" + sha256(d.id).slice(0, 16)
              : d.id,
          sha256: d.sha256,
          extractorVersion: d.extractorVersion ?? d.extractor_version,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
}
export function liveExecutionBudget(
  task: Record<string, any>,
  now = Date.now(),
): ExecutionBudget | undefined {
  const b = task.turnBudget as ActiveBudget | undefined;
  if (!task.executionBudget) return undefined;
  return b?.accountingVersion === 2
    ? checkpointExecutionBudget(
        task.executionBudget,
        b,
        settleActiveBudget(b, now).activeMs,
      )
    : task.executionBudget;
}
/** Compact, monotone evidence survives prompt receipt pruning across recovery segments. */
export function recoveryProgressFacts(
  task: Record<string, any>,
  turn: Record<string, any>,
): string[] {
  const inherited =
    task.recoverySegment?.turnId === turn.id
      ? (task.recoverySegment.progressFacts ?? [])
      : [];
  return [
    ...new Set<string>([
      ...inherited,
      ...(turn.tool_results ?? [])
        .filter((r: any) => r.status === "succeeded" && r.name !== "plan_task")
        .map((r: any) =>
          sha256(canonicalJson({ name: r.name, result: r.result })),
        ),
    ]),
  ].sort();
}
export function recoveryProgress(
  task: Record<string, any>,
  turn: Record<string, any>,
) {
  return sha256(
    canonicalJson({
      facts: recoveryProgressFacts(task, turn),
      save: task.requirementSave?.key ?? null,
      steps: (task.executionPlan?.steps ?? [])
        .filter((s: any) => s.status === "executed" || s.status === "waiting")
        .map((s: any) => ({ id: s.id, status: s.status, receipt: s.receipt })),
    }),
  );
}
/** One decision for offers, locked recovery claims and the final request preflight. */
export function recoveryDecision(
  task: Record<string, any>,
  turn: Record<string, any> | undefined,
  facts: RecoveryFacts,
): RecoveryDecision {
  const now = facts.now ?? Date.now(),
    chain =
      task.recoverySegment?.turnId === turn?.id
        ? task.recoverySegment
        : undefined;
  const budget =
    task.turnBudget?.turnId === turn?.id ? task.turnBudget : undefined;
  const use = liveExecutionBudget(task, now),
    limits = executionLimits(use);
  const result: RecoveryDecision = {
    action: null,
    reason: "not_recoverable",
    revision: facts.revision,
    validUntil: null,
    originTurnId: turn?.id ?? null,
    rootTurnId: chain?.rootTurnId ?? turn?.id ?? null,
    mode: null,
    canExecutePlan: false,
  };
  const stop = (reason: string) => ({
    ...result,
    reason,
    canExecutePlan: false,
  });
  if (!facts.canWrite) return stop("permission_denied");
  if (task.executionBudget && !validExecutionBudget(task.executionBudget))
    return stop("budget_evidence_missing");
  if (!facts.dependenciesValid) return stop("context_changed");
  if (
    use &&
    (!validExecutionBudget(use) ||
      Object.entries(limits).some(([k, v]) =>
        facts.phase === "commit" ||
        (k === "modelSteps" &&
          facts.phase === "request" &&
          facts.reservedModelStep)
          ? (use as any)[k] > v
          : (use as any)[k] >= v,
      ))
  )
    return stop("task_budget_exhausted");
  const remaining = limits.activeMs - (use?.activeMs ?? 0);
  if (remaining < (facts.phase === "commit" ? 1 : 10000))
    return stop("insufficient_task_time");
  result.canExecutePlan = Boolean(
    task.stage !== "stopped" &&
    task.executionPlan?.steps?.length &&
    !task.question &&
    !task.requirementProblem &&
    !task.planValidationRequired &&
    !task.executionPlan.needsReview &&
    ![
      "assistant_auto_plan_limit",
      "assistant_session_limit",
      "assistant_auto_limit",
    ].includes(task.error),
  );
  if (!turn) return result;
  if (Number(turn.task_revision) !== facts.revision)
    return stop("revision_changed");
  if (task.stage === "stopped" || task.error === "assistant_stopped")
    return stop("stopped");
  if (
    chain &&
    (chain.revision !== facts.revision ||
      chain.documentsKey !== facts.documentsKey)
  )
    return stop("context_changed");
  const pending =
    task.planningRecovery &&
    (task.planningRecovery.taskRevision === facts.revision || chain)
      ? task.planningRecovery
      : undefined;
  if (
    pending?.documentsKey &&
    pending.documentsKey !== facts.documentsKey &&
    pending.documentsKey !== facts.legacyDocumentsKey
  )
    return stop("background_changed");
  if (pending?.amendment && pending.planKey !== planRequirementsKey(task))
    return stop("requirements_changed");
  const phase = facts.phase ?? "offer";
  if (phase === "event") {
    if ((facts.turnCount ?? 0) >= 100) return stop("session_limit");
    if ((task.autoCount ?? 0) >= (task.autoEventLimit ?? 12))
      return stop("event_limit");
    if (
      !task.goal ||
      ["stopped", "complete", "failed"].includes(task.stage) ||
      !continuationAllowed(task)
    )
      return stop("authorization_missing");
    if (!facts.eventReady) return stop("checkpoint_missing");
  }
  if (phase === "request" || phase === "commit") {
    if (
      turn.status !== "running" ||
      !turn.execution_token ||
      (facts.token && facts.token !== turn.execution_token) ||
      new Date(turn.expires_at).getTime() <= now
    )
      return stop("lease_invalid");
    if (
      !budget ||
      !validExecutionBudget({ ...budget, activeMs: budget.activeMs ?? 0 })
    )
      return stop("budget_evidence_missing");
    if (phase === "commit")
      return budget.deadlineAt > now
        ? {
            ...result,
            action: "retry_turn",
            reason: "commit_allowed",
            validUntil: budget.deadlineAt,
          }
        : stop("segment_expired");
    if (
      !requestFitsDeadline(
        budget.deadlineAt,
        facts.requestEstimateMs ??
          budget.requests?.at(-1)?.timeToHeadersMs ??
          0,
        now,
      )
    )
      return stop("insufficient_request_time");
    if (
      budget.modelSteps > (facts.reservedModelStep ? 10 : 9) ||
      budget.toolCalls >= 12 ||
      budget.transportRetries > 2
    )
      return stop("segment_budget_exhausted");
    return {
      ...result,
      action: "retry_turn",
      reason: "request_allowed",
      validUntil: budget.deadlineAt,
    };
  }
  if (
    facts.busy ||
    (phase !== "claim" && ["queued", "running"].includes(turn.status))
  )
    return stop("turn_running");
  if (
    phase !== "claim" &&
    phase !== "event" &&
    !["failed", "interrupted"].includes(turn.status) &&
    !(turn.status === "succeeded" && task.stage === "yielding")
  )
    return result;
  if (
    !budget ||
    !validExecutionBudget(use) ||
    !Number.isFinite(budget.startedAt) ||
    !Number.isFinite(budget.deadlineAt) ||
    !Number.isFinite(
      budget.activeMs ??
        (use?.lastTurn?.turnId === turn.id &&
        ["failed", "succeeded"].includes(turn.status)
          ? use?.lastTurn?.elapsedMs
          : undefined),
    )
  )
    return stop("budget_evidence_missing");
  if (
    (chain?.attemptsBefore ?? 0) +
      Math.max(
        0,
        Number(turn.execution_attempt ?? 0) -
          (turn.status === "succeeded" ? 1 : 0),
      ) >=
    3
  )
    return stop("attempt_limit");
  if (
    ["assistant_no_progress", "assistant_tool_repair_exhausted"].includes(
      turn.error_code ?? task.error,
    )
  )
    return stop("no_progress");
  const amendmentId = pending?.requestTurnId ?? chain?.amendmentId;
  const identity = amendmentId
    ? sha256(canonicalJson({ requestTurnId: amendmentId }))
    : undefined;
  const repairs = Object.values(task.parameterRepairLimits ?? {}) as any[];
  const status = task.parameterRepairStatus;
  const kind =
    status && (status.amendmentId === amendmentId || status.turnId === turn.id)
      ? classifyToolFailure(status.issues ?? [])
      : "context";
  if (
    pending &&
    (identity
      ? !repairRequestAvailable(
          (task.parameterRepairLimits as RepairLimits) ?? {},
          identity,
          kind,
        )
      : repairs.reduce((n, v) => n + (v.used ?? 0), 0) >= 2)
  )
    return stop("repair_limit");
  const control = task.turnControl;
  const originalMode = chain?.mode ?? control?.mode;
  if (
    !["plan", "execute"].includes(originalMode) ||
    control?.source === "pending"
  )
    return stop("authorization_missing");
  result.mode = originalMode;
  if (
    task.question &&
    !savedPlanningQuestion(task, turn.tool_results ?? [], originalMode)
  )
    return stop("business_input_required");
  if (
    control?.mode === "pause" ||
    (originalMode === "execute" && task.executionPaused && !pending)
  )
    return stop("paused");
  const same =
    Number(turn.execution_attempt) < 3 &&
    budget.modelSteps < 10 &&
    budget.toolCalls < 12 &&
    budget.transportRetries <= 2 &&
    requestFitsDeadline(
      budget.deadlineAt,
      budget.requests?.at(-1)?.timeToHeadersMs ?? 0,
      now,
    );
  if (same && phase !== "event" && turn.status !== "succeeded")
    return {
      ...result,
      action: "retry_turn",
      reason: "same_segment",
      validUntil:
        budget.deadlineAt -
        Math.max(
          10000,
          Math.min(30000, budget.requests?.at(-1)?.timeToHeadersMs ?? 0),
        ),
    };
  const reason =
    budget.deadlineAt <= now ? "segment_expired" : "insufficient_request_time";
  const step = task.executionPlan?.steps?.[task.executionPlan.current];
  const position =
    (phase === "event" && facts.eventReady) ||
    Boolean(
      pending?.requestTurnId && pending.taskRevision === facts.revision,
    ) ||
    Boolean(
      step &&
      step.status !== "executed" &&
      step.id &&
      !task.executionPlan.needsReview,
    );
  const progress =
    (phase === "event" && facts.eventReady) ||
    (turn.tool_results ?? []).some(
      (r: any) =>
        r.status === "succeeded" &&
        (r.name !== "plan_task" || !r.result?.unchanged),
    ) ||
    Boolean(pending?.amendment && task.requirementSave);
  if (!position || !progress) return stop("checkpoint_missing");
  if (chain?.progressKey === recoveryProgress(task, turn))
    return stop("no_progress");
  if (task.question) return stop("business_input_required");
  if (
    (task.autoCount ?? 0) >= (task.autoEventLimit ?? 12) ||
    (facts.turnCount ?? 0) >= 100
  )
    return stop("event_limit");
  if (
    originalMode === "execute" &&
    (task.executionPaused || task.executionPlan?.mode === "plan") &&
    !pending
  )
    return stop("paused");
  return {
    ...result,
    action:
      pending || originalMode === "plan"
        ? "continue_plan"
        : "continue_execution",
    reason,
    validUntil: now + Math.min(80000, remaining),
  };
}
