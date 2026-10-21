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
};

export type ExecutionBudget = {
  modelSteps: number;
  toolCalls: number;
  transportRetries: number;
  activeMs: number;
  lastTurn?: TurnCounters & { elapsedMs: number };
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
    lastTurn: observed,
  };
}

export function executionBudgetExhausted(budget: ExecutionBudget) {
  return (
    Object.keys(
      EXECUTION_BUDGET_LIMITS,
    ) as (keyof typeof EXECUTION_BUDGET_LIMITS)[]
  ).some((key) => budget[key] >= EXECUTION_BUDGET_LIMITS[key]);
}

/** Leave time to finish/checkpoint a slow turn instead of starting a doomed retry. */
export function requestFitsDeadline(
  deadlineAt: number,
  previousRequestMs = 0,
  now = Date.now(),
) {
  return deadlineAt - now >= Math.max(5000, Math.min(30000, previousRequestMs));
}
