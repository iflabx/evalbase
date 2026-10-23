import { canonicalJson, sha256 } from "../package/contract.js";
import { EXECUTION_BUDGET_LIMITS } from "./budget.js";
export const SEGMENT_LIMITS = {
  modelSteps: 10,
  toolCalls: 12,
  transportRetries: 2,
  requestAttempts: 12,
  activeMs: 80000,
} as const;
export const BUDGET_DIMENSIONS = [
  "modelSteps",
  "toolCalls",
  "transportRetries",
  "requestAttempts",
  "activeMs",
] as const;
type Dimension = (typeof BUDGET_DIMENSIONS)[number];
export type Limits = Record<Dimension, number>;
export type Usage = Limits;
export type BudgetGrant = {
  id: string;
  actorId: string;
  taskId: string;
  revision: number;
  purpose: "initial" | "continue" | "repair";
  limits: Limits;
  startsAtUse: Usage;
  issuedAt: number;
  expiresAt: number | null;
  offerId?: string;
  keyHash?: string;
  requestHash?: string;
  amendmentId?: string;
  closedAtUse?: Usage;
  closedAt?: number;
};
export type BudgetLedger = {
  version: 1;
  taskId: string;
  actorId: string;
  policy: { initial: Limits; segment: Limits };
  grants: BudgetGrant[];
  activeId: string;
  ceiling?: Partial<Limits>;
  externalClosed?: boolean;
  segments?: Record<string, any>[];
};
const hash = (value: unknown) =>
  sha256(canonicalJson(JSON.parse(JSON.stringify(value))));
export function budgetUsage(task: Record<string, any>): Usage {
  return Object.fromEntries(
    BUDGET_DIMENSIONS.map((k) => [k, Number(task.executionBudget?.[k] ?? 0)]),
  ) as Usage;
}
export function createBudgetLedger(
  taskId: string,
  actorId: string,
  revision: number,
  now = Date.now(),
): BudgetLedger {
  const initial = {
    ...EXECUTION_BUDGET_LIMITS,
    requestAttempts:
      EXECUTION_BUDGET_LIMITS.modelSteps +
      EXECUTION_BUDGET_LIMITS.transportRetries,
  };
  const id = "initial:" + taskId;
  return {
    version: 1,
    taskId,
    actorId,
    policy: { initial, segment: { ...SEGMENT_LIMITS } },
    activeId: id,
    grants: [
      {
        id,
        taskId,
        actorId,
        revision,
        purpose: "initial",
        limits: { ...initial },
        startsAtUse: Object.fromEntries(
          BUDGET_DIMENSIONS.map((k) => [k, 0]),
        ) as Usage,
        issuedAt: now,
        expiresAt: null,
      },
    ],
  };
}
export function segmentLimits(task: Record<string, any>): Limits {
  return Object.fromEntries(
    BUDGET_DIMENSIONS.map((k) => [
      k,
      Math.min(
        SEGMENT_LIMITS[k],
        task.budgetLedger?.policy?.segment?.[k] ?? SEGMENT_LIMITS[k],
      ),
    ]),
  ) as Limits;
}
export function budgetAllowance(task: Record<string, any>, now = Date.now()) {
  const ledger = task.budgetLedger as BudgetLedger | undefined;
  if (ledger?.version !== 1) return null;
  const use = budgetUsage(task),
    active = ledger.grants.find((g) => g.id === ledger.activeId);
  const total = Object.fromEntries(
    BUDGET_DIMENSIONS.map((k) => [
      k,
      ledger.grants.reduce((n, g) => n + g.limits[k], 0),
    ]),
  ) as Limits;
  const limits = Object.fromEntries(
    BUDGET_DIMENSIONS.map((k) => [
      k,
      Math.min(
        total[k],
        active ? active.startsAtUse[k] + active.limits[k] : 0,
        ledger.ceiling?.[k] ?? Infinity,
        task.executionBudget?.limits?.[k] ?? Infinity,
      ),
    ]),
  ) as Limits;
  let reason: string | null = null;
  if (
    ledger.taskId !== task.taskId ||
    !active ||
    BUDGET_DIMENSIONS.some(
      (k) =>
        !Number.isFinite(use[k]) ||
        use[k] < 0 ||
        !Number.isFinite(limits[k]) ||
        limits[k] < 0,
    )
  )
    reason = "budget_evidence_missing";
  else if (ledger.externalClosed) reason = "external_budget_exhausted";
  else if (
    active.purpose !== "initial" &&
    task.turnControl?.taskRevision !== undefined &&
    active.revision !== task.turnControl.taskRevision
  )
    reason = "grant_revision_changed";
  else if (active.expiresAt !== null && active.expiresAt <= now)
    reason = "grant_expired";
  else if (
    BUDGET_DIMENSIONS.some((k) =>
      k === "transportRetries" ? use[k] > limits[k] : use[k] >= limits[k],
    )
  )
    reason = "task_budget_exhausted";
  return {
    reason,
    use,
    limits,
    total,
    remaining: Object.fromEntries(
      BUDGET_DIMENSIONS.map((k) => [k, Math.max(0, limits[k] - use[k])]),
    ) as Limits,
    active,
    ledger,
  };
}
/** Only committed business identities and current contracts are progress; read-page prose is not. */
export function progressFacts(
  task: Record<string, any>,
  turn: Record<string, any> = {},
) {
  const inherited =
    task.recoverySegment && task.recoverySegment.turnId === turn.id
      ? (task.recoverySegment.progressFacts ?? [])
      : [];
  const receiptFacts = (turn.tool_results ?? [])
    .filter(
      (r: any) =>
        r.status === "succeeded" &&
        [
          "create_draft",
          "generate_candidates",
          "submit_processing",
          "refine_candidates",
          "preview_selection",
          "select_candidates",
          "request_processing_apply",
          "request_selection_apply",
          "request_publish",
          "retry_processing",
        ].includes(r.name) &&
        !r.result?.historical,
    )
    .map((r: any) =>
      hash({
        name: r.name,
        receipt: {
          draftId: r.result?.draftId,
          runId: r.result?.runId,
          runIds: r.result?.runIds,
          previewId: r.result?.previewId,
          proposalId: r.result?.proposalId,
          selectedHash: r.result?.selectedHash,
        },
      }),
    );
  const state = [
    task.requirementSave?.key && "save:" + task.requirementSave.key,
    task.processingScope?.hash && "scope:" + task.processingScope.hash,
    ...(task.executionPlan?.steps ?? [])
      .filter((s: any) => ["executed", "waiting"].includes(s.status))
      .map((s: any) =>
        hash({
          id: s.id,
          status: s.status,
          receipt: {
            key: s.receipt?.key,
            runId: s.receipt?.runId,
            draftId: s.receipt?.draftId,
            previewId: s.receipt?.previewId,
            proposalId: s.receipt?.proposalId,
          },
        }),
      ),
  ].filter(Boolean);
  return [...new Set<string>([...inherited, ...state, ...receiptFacts])].sort();
}
export const progressKey = (
  task: Record<string, any>,
  turn: Record<string, any> = {},
) => hash(progressFacts(task, turn));
export function eventAllowance(task: Record<string, any>) {
  return task.budgetLedger?.version === 1
    ? Math.max(
        12,
        (task.executionPlan?.steps?.length ?? 0) * 3 +
          task.budgetLedger.grants.length * 13,
      )
    : (task.autoEventLimit ?? 12);
}
export function repairIdentity(
  task: Record<string, any>,
  requestTurnId: string,
) {
  const grant = (task.budgetLedger?.grants ?? []).findLast(
    (g: BudgetGrant) =>
      g.purpose === "repair" && g.amendmentId === requestTurnId,
  );
  return hash({ requestTurnId, ...(grant ? { repairGrantId: grant.id } : {}) });
}
export function repairAmendment(task: Record<string, any>) {
  return (
    task.planningRecovery?.requestTurnId ??
    task.parameterRepairStatus?.amendmentId
  );
}
export function repairBlocked(task: Record<string, any>) {
  const amendment = repairAmendment(task);
  if (!amendment) return false;
  const identity = repairIdentity(task, amendment);
  const entries = Object.values(task.parameterRepairLimits ?? {}).filter(
    (v: any) => v.identity === identity,
  ) as any[];
  return (
    entries.reduce((n, v) => n + Number(v.used ?? 0), 0) >= 2 ||
    ((task.parameterRepairStatus?.issues ?? []).some(
      (i: any) => i.keyword === "parse",
    ) &&
      entries.reduce((n, v) => n + Number(v.truncated ?? 0), 0) >= 1)
  );
}
export type GrantOffer = {
  id: string;
  taskId: string;
  actorId: string;
  revision: number;
  purpose: "continue" | "repair";
  limits: Limits;
  validUntil: number;
  checkpointKey: string;
  amendmentId?: string;
};
export function grantOffer(
  task: Record<string, any>,
  actorId: string,
  revision: number,
  purpose: "continue" | "repair",
  now = Date.now(),
): GrantOffer | null {
  const allowance = budgetAllowance(task, now);
  if (
    !allowance ||
    allowance.ledger.actorId !== actorId ||
    ["stopped", "complete"].includes(task.stage) ||
    allowance.ledger.externalClosed ||
    allowance.reason === "budget_evidence_missing"
  )
    return null;
  if (purpose === "repair" && !repairBlocked(task)) return null;
  if (purpose === "continue" && (!allowance.reason || repairBlocked(task)))
    return null;
  const limits = Object.fromEntries(
    BUDGET_DIMENSIONS.map((k) => [
      k,
      Math.min(
        segmentLimits(task)[k],
        Math.max(
          0,
          Math.min(
            allowance.ledger.ceiling?.[k] ?? Infinity,
            task.executionBudget?.limits?.[k] ?? Infinity,
          ) - allowance.use[k],
        ),
      ),
    ]),
  ) as Limits;
  if (BUDGET_DIMENSIONS.some((k) => k !== "transportRetries" && limits[k] <= 0))
    return null;
  const value = {
    taskId: task.taskId,
    actorId,
    revision,
    purpose,
    limits,
    validUntil: (Math.floor(now / 300000) + 1) * 300000,
    checkpointKey: hash({
      progress: progressKey(task),
      pending: task.planningRecovery?.requestTurnId,
      position: task.executionPlan?.current,
      turnId: task.turnBudget?.turnId,
    }),
    ...(purpose === "repair" ? { amendmentId: repairAmendment(task) } : {}),
  };
  return { id: "offer:" + hash(value), ...value };
}
export class BudgetGrantError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function applyBudgetGrant(
  task: Record<string, any>,
  offer: GrantOffer,
  actorId: string,
  revision: number,
  key: string,
  now = Date.now(),
): Record<string, any> {
  const ledger = task.budgetLedger as BudgetLedger | undefined;
  if (
    !ledger ||
    ledger.version !== 1 ||
    offer.taskId !== task.taskId ||
    offer.actorId !== actorId ||
    ledger.actorId !== actorId ||
    offer.revision !== revision ||
    ["complete", "stopped"].includes(task.stage)
  )
    throw new BudgetGrantError("assistant_grant_invalid");
  const keyHash = hash(key),
    requestHash = hash({ id: offer.id, purpose: offer.purpose }),
    prior = ledger.grants.find(
      (g) => g.keyHash === keyHash || g.offerId === offer.id,
    );
  if (prior) {
    if (prior.requestHash !== requestHash)
      throw new BudgetGrantError("assistant_grant_conflict");
    return structuredClone(task);
  }
  const actual = grantOffer(task, actorId, revision, offer.purpose, now);
  if (
    !actual ||
    actual.id !== offer.id ||
    canonicalJson(actual) !== canonicalJson(offer) ||
    offer.validUntil <= now
  )
    throw new BudgetGrantError("assistant_grant_expired");
  const result = structuredClone(task),
    next = result.budgetLedger as BudgetLedger,
    use = budgetUsage(task);
  const old = next.grants.find((g) => g.id === next.activeId)!;
  old.closedAtUse ??= use;
  old.closedAt ??= now;
  const id = "grant:" + hash({ taskId: task.taskId, offerId: offer.id });
  next.grants.push({
    id,
    taskId: task.taskId,
    actorId,
    revision,
    purpose: offer.purpose,
    limits: { ...offer.limits },
    startsAtUse: use,
    issuedAt: now,
    expiresAt: now + 900000,
    offerId: offer.id,
    keyHash,
    requestHash,
    ...(offer.amendmentId ? { amendmentId: offer.amendmentId } : {}),
  });
  next.activeId = id;
  if (offer.purpose === "repair")
    for (const [name, value] of Object.entries(
      result.parameterRepairLimits ?? {},
    )) {
      if (!name.startsWith("history:"))
        result.parameterRepairLimits["history:" + name + ":" + hash(value)] =
          structuredClone(value);
    }
  result.budgetPause = null;
  result.grantResume = id;
  return result;
}
export function budgetPresentation(task: Record<string, any>) {
  const a = budgetAllowance(task);
  if (!a) return undefined;
  return {
    version: 1,
    taskId: task.taskId,
    used: a.use,
    authorized: a.total,
    activeRemaining: a.remaining,
    reason: a.reason,
    activeGrantId: a.ledger.activeId,
    segmentLimits: segmentLimits(task),
    grantCount: a.ledger.grants.length,
    grants: a.ledger.grants
      .slice(-5)
      .map(({ keyHash: _k, requestHash: _r, ...g }) => g),
  };
}
