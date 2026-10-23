export const EXECUTION_BUDGET_LIMITS = {
  modelSteps: 130,
  toolCalls: 156,
  transportRetries: 26,
  activeMs: 13 * 80000,
} as const;

type TurnCounters = {
  turnId: string;
  modelSteps: number;
  toolCalls: number;
  transportRetries: number;
  requestAttempts?: number;
};

export type ExecutionBudget = {
  modelSteps: number;
  toolCalls: number;
  transportRetries: number;
  activeMs: number;
  requestAttempts?: number;
  lastTurn?: TurnCounters & { elapsedMs: number };
  limits?: Partial<Record<keyof typeof EXECUTION_BUDGET_LIMITS, number>>;
};

const count = (value = 0) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** elapsedMs is this turn's cumulative active time, measured from its original start. */
export function checkpointExecutionBudget(
  previous: ExecutionBudget | null | undefined,
  turn: TurnCounters,
  elapsedMs: number,
): ExecutionBudget {
  const prior =
    previous?.lastTurn?.turnId === turn.turnId ? previous.lastTurn : undefined;
  const observed = {
    turnId: turn.turnId,
    modelSteps: Math.max(count(prior?.modelSteps), count(turn.modelSteps)),
    toolCalls: Math.max(count(prior?.toolCalls), count(turn.toolCalls)),
    transportRetries: Math.max(
      count(prior?.transportRetries),
      count(turn.transportRetries),
    ),
    elapsedMs: Math.max(count(prior?.elapsedMs), count(elapsedMs)),
    ...(turn.requestAttempts !== undefined
      ? {
          requestAttempts: Math.max(
            count(prior?.requestAttempts),
            count(turn.requestAttempts),
          ),
        }
      : {}),
  };
  return {
    modelSteps:
      count(previous?.modelSteps) +
      observed.modelSteps -
      count(prior?.modelSteps),
    toolCalls:
      count(previous?.toolCalls) + observed.toolCalls - count(prior?.toolCalls),
    transportRetries:
      count(previous?.transportRetries) +
      observed.transportRetries -
      count(prior?.transportRetries),
    activeMs:
      count(previous?.activeMs) + observed.elapsedMs - count(prior?.elapsedMs),
    ...(observed.requestAttempts !== undefined
      ? {
          requestAttempts:
            count(previous?.requestAttempts) +
            observed.requestAttempts -
            count(prior?.requestAttempts),
        }
      : {}),
    ...((previous as any)?.limits ? { limits: (previous as any).limits } : {}),
    lastTurn: observed,
  };
}

export function executionBudgetExhausted(budget: ExecutionBudget) {
  return (
    Object.keys(
      EXECUTION_BUDGET_LIMITS,
    ) as (keyof typeof EXECUTION_BUDGET_LIMITS)[]
  ).some((key) => budget[key] >= executionLimits(budget)[key]);
}

/** Leave time to finish/checkpoint a slow turn instead of starting a doomed retry. */
export const MODEL_RECOVERY_RESERVE_MS = 10000;

export function requestFitsDeadline(
  deadlineAt: number,
  previousRequestMs = 0,
  now = Date.now(),
) {
  return (
    deadlineAt - now >=
    Math.max(MODEL_RECOVERY_RESERVE_MS, Math.min(30000, previousRequestMs))
  );
}

export type ActiveBudget = {
  progressStart?: string;
  turnId: string;
  startedAt: number;
  deadlineAt: number;
  modelSteps: number;
  toolCalls: number;
  transportRetries: number;
  accountingVersion?: number;
  activeMs?: number;
  attemptStartedAt?: number | null;
  attemptBaseMs?: number;
  attemptToken?: string | null;
  requestAttempts?: number;
  requests?: {
    timeToHeadersMs: number;
    httpStatus: number | null;
    state?: string;
    [key: string]: any;
  }[];
};
type ActiveInterval = {
  accountingVersion: number;
  activeMs: number;
  attemptBaseMs: number;
  attemptStartedAt: number | null;
  attemptToken: string | null;
};
/** A retry opens a new active interval; its original deadline never moves. */
export function startActiveBudget<T extends ActiveBudget>(
  budget: T,
  token: string,
  now = Date.now(),
): T & ActiveInterval {
  return {
    ...budget,
    accountingVersion: 2,
    activeMs: count(budget.activeMs),
    attemptBaseMs: count(budget.activeMs),
    attemptStartedAt: now,
    attemptToken: token,
  };
}
export function settleActiveBudget<T extends ActiveBudget>(
  budget: T,
  now = Date.now(),
  close = false,
): T & ActiveInterval {
  const activeMs =
    budget.attemptStartedAt == null
      ? count(budget.activeMs)
      : Math.max(
          count(budget.activeMs),
          count(budget.attemptBaseMs) +
            Math.max(
              0,
              Math.min(now, budget.deadlineAt) - budget.attemptStartedAt,
            ),
        );
  return {
    ...budget,
    accountingVersion: budget.accountingVersion ?? 2,
    activeMs,
    attemptStartedAt: close ? null : (budget.attemptStartedAt ?? null),
    attemptToken: close ? null : (budget.attemptToken ?? null),
    attemptBaseMs: close ? activeMs : count(budget.attemptBaseMs),
  };
}
export function executionLimits(budget: ExecutionBudget | undefined | null) {
  const frozen = budget?.limits;
  return Object.fromEntries(
    Object.entries(EXECUTION_BUDGET_LIMITS).map(([key, limit]) => {
      const value = frozen?.[key as keyof typeof EXECUTION_BUDGET_LIMITS];
      return [
        key,
        value === undefined
          ? limit
          : Number.isFinite(value) && value >= 0
            ? Math.min(value, limit)
            : 0,
      ];
    }),
  ) as Record<keyof typeof EXECUTION_BUDGET_LIMITS, number>;
}

/** Reservations are not sends; an unresolved send is charged conservatively. */
export function sentRequestCount(requests: readonly { state?: string }[]) {
  return requests.filter(
    (r) => r.state !== "reserved" && r.state !== "not_sent",
  ).length;
}
