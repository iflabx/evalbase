/** Existing task authorization defaults, shared by compatibility and formal hosts. */
export const EXECUTION_BUDGET_LIMITS = {
  modelSteps: 130,
  toolCalls: 156,
  transportRetries: 26,
  activeMs: 13 * 80000,
} as const;
