import { describe, expect, it } from "vitest";
import {
  checkpointExecutionBudget,
  EXECUTION_BUDGET_LIMITS,
  executionBudgetExhausted,
} from "../../src/assistant/budget.js";

const turn = {
  turnId: "turn-a",
  modelSteps: 4,
  toolCalls: 6,
  transportRetries: 1,
};

describe("OPT36 execution budget", () => {
  it("starts legacy tasks at zero and charges repeated checkpoints only once", () => {
    const first = checkpointExecutionBudget(undefined, turn, 1200);
    expect(first).toMatchObject({
      modelSteps: 4,
      toolCalls: 6,
      transportRetries: 1,
      activeMs: 1200,
    });
    expect(checkpointExecutionBudget(first, turn, 1200)).toEqual(first);
    const increased = checkpointExecutionBudget(
      first,
      { ...turn, modelSteps: 5, toolCalls: 8 },
      1500,
    );
    expect(increased).toMatchObject({
      modelSteps: 5,
      toolCalls: 8,
      transportRetries: 1,
      activeMs: 1500,
    });
  });

  it("preserves cumulative use across continuation turns without charging background waiting", () => {
    const first = checkpointExecutionBudget(undefined, turn, 1200);
    const next = checkpointExecutionBudget(
      first,
      {
        ...turn,
        turnId: "turn-b",
        modelSteps: 0,
        toolCalls: 2,
        transportRetries: 0,
      },
      20,
    );
    expect(next).toMatchObject({
      modelSteps: 4,
      toolCalls: 8,
      transportRetries: 1,
      activeMs: 1220,
    });
  });

  it("cannot refund counters or elapsed time when the same turn is reclaimed", () => {
    const first = checkpointExecutionBudget(undefined, turn, 1200);
    const reclaimed = checkpointExecutionBudget(
      first,
      { ...turn, modelSteps: 1, toolCalls: 2, transportRetries: 0 },
      100,
    );
    expect(reclaimed).toEqual(first);
    const continued = checkpointExecutionBudget(
      reclaimed,
      { ...turn, modelSteps: 5, toolCalls: 7, transportRetries: 2 },
      1400,
    );
    expect(continued).toMatchObject({
      modelSteps: 5,
      toolCalls: 7,
      transportRetries: 2,
      activeMs: 1400,
    });
  });

  it("stops at each cumulative threshold without replacing smaller per-turn limits", () => {
    const zero = {
      modelSteps: 0,
      toolCalls: 0,
      transportRetries: 0,
      activeMs: 0,
    };
    for (const [key, limit] of Object.entries(EXECUTION_BUDGET_LIMITS)) {
      expect(executionBudgetExhausted({ ...zero, [key]: limit - 1 })).toBe(
        false,
      );
      expect(executionBudgetExhausted({ ...zero, [key]: limit })).toBe(true);
      expect(executionBudgetExhausted({ ...zero, [key]: limit + 1 })).toBe(
        true,
      );
    }
    let cumulative = zero;
    for (let i = 0; i < 13; i++) {
      cumulative = checkpointExecutionBudget(
        cumulative,
        {
          turnId: `turn-${i}`,
          modelSteps: 10,
          toolCalls: 12,
          transportRetries: 2,
        },
        80000,
      );
    }
    expect(cumulative).toMatchObject(EXECUTION_BUDGET_LIMITS);
    expect(executionBudgetExhausted(cumulative)).toBe(true);
  });
});
