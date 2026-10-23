import { effectiveOperationInput } from "../../src/assistant/operation-input.js";
import { describe, it, expect } from "vitest";
import {
  createBudgetLedger,
  segmentLimits,
  budgetAllowance,
  grantOffer,
  applyBudgetGrant,
  repairIdentity,
  progressFacts,
  progressKey,
} from "../../src/assistant/budget-ledger.js";
const scope = { taskId: "task-a", actorId: "owner", revision: 2 };
const fixture = () =>
  ({
    taskId: scope.taskId,
    goal: "完成未完成的草稿",
    stage: "yielding",
    budgetLedger: createBudgetLedger(scope.taskId, scope.actorId, 2, 1000),
    executionBudget: {
      modelSteps: 130,
      toolCalls: 5,
      transportRetries: 0,
      requestAttempts: 130,
      activeMs: 100,
    },
    executionPlan: {
      current: 1,
      steps: [
        { id: "s1", status: "executed", receipt: { draftId: "d1" } },
        {
          id: "s2",
          action: "create_draft",
          status: "pending",
          input: { name: "待完成" },
        },
      ],
    },
    turnControl: { mode: "execute", source: "model" },
  }) as any;
describe("OPT49 authoritative allowance and progress", () => {
  it("freezes the original default policy without converting legacy records", () => {
    expect(
      budgetAllowance({ executionBudget: { modelSteps: 130 } }, 1000),
    ).toBeNull();
    const t = fixture();
    expect(segmentLimits(t)).toMatchObject({
      modelSteps: 10,
      toolCalls: 12,
      transportRetries: 2,
      activeMs: 80000,
    });
    expect(t.budgetLedger.grants[0].limits).toMatchObject({
      modelSteps: 130,
      toolCalls: 156,
      transportRetries: 26,
      activeMs: 1040000,
    });
  });
  it("requires a current explicit grant, keeps old usage and caps the extra active allowance", () => {
    const t = fixture(),
      before = structuredClone(t),
      offer = grantOffer(t, scope.actorId, 2, "continue", 1000)!;
    expect(offer.limits.modelSteps).toBe(10);
    const next = applyBudgetGrant(
      t,
      offer,
      scope.actorId,
      2,
      "request-a",
      1001,
    );
    expect(t).toEqual(before);
    expect(next.executionBudget).toEqual(t.executionBudget);
    expect(next.budgetLedger.grants[0].limits).toEqual(
      t.budgetLedger.grants[0].limits,
    );
    expect(budgetAllowance(next, 1001)).toMatchObject({ reason: null });
    next.executionBudget.modelSteps += 10;
    expect(budgetAllowance(next, 1002)?.reason).toBe("task_budget_exhausted");
  });
  it("rejects unknown, expired and stale offers and never grants stopped or legacy tasks", () => {
    const t = fixture(),
      offer = grantOffer(t, scope.actorId, 2, "continue", 1000)!;
    for (const [actor, revision, now] of [
      ["other", 2, 1001],
      ["owner", 3, 1001],
      ["owner", 2, offer.validUntil + 1],
    ] as const)
      expect(() =>
        applyBudgetGrant(t, offer, actor, revision, "key", now),
      ).toThrow();
    expect(
      grantOffer({ ...t, stage: "stopped" }, "owner", 2, "continue", 1000),
    ).toBeNull();
    expect(
      grantOffer({ taskId: "legacy" }, "owner", 2, "continue", 1000),
    ).toBeNull();
  });
  it("deduplicates a repeated offer and refuses a changed request under the same key", () => {
    const t = fixture(),
      offer = grantOffer(t, "owner", 2, "continue", 1000)!;
    const a = applyBudgetGrant(t, offer, "owner", 2, "key", 1001),
      b = applyBudgetGrant(a, offer, "owner", 2, "key", 1002);
    expect(b.budgetLedger.grants).toHaveLength(2);
    expect(() =>
      applyBudgetGrant(
        a,
        { ...offer, purpose: "repair" },
        "owner",
        2,
        "key",
        1002,
      ),
    ).toThrow();
  });
  it("only explicit repair grants establish a linked new repair identity without erasing old counters", () => {
    const t = fixture();
    t.planningRecovery = { requestTurnId: "amend-a" };
    t.parameterRepairLimits = {
      plan_task: {
        identity: repairIdentity(t, "amend-a"),
        used: 2,
        truncated: 1,
        version: 2,
      },
    };
    expect(grantOffer(t, "owner", 2, "continue", 1000)).toBeNull();
    const beforeFailure = { ...t, parameterRepairLimits: {} };
    const normal = applyBudgetGrant(
      beforeFailure,
      grantOffer(beforeFailure, "owner", 2, "continue", 1000)!,
      "owner",
      2,
      "normal",
      1001,
    );
    normal.parameterRepairLimits = structuredClone(t.parameterRepairLimits);
    expect(repairIdentity(normal, "amend-a")).toBe(
      repairIdentity(t, "amend-a"),
    );
    const repair = applyBudgetGrant(
      t,
      grantOffer(t, "owner", 2, "repair", 1000)!,
      "owner",
      2,
      "repair",
      1001,
    );
    expect(repairIdentity(repair, "amend-a")).not.toBe(
      repairIdentity(t, "amend-a"),
    );
    expect(Object.values(repair.parameterRepairLimits)).toContainEqual(
      t.parameterRepairLimits.plan_task,
    );
  });
  it("query pagination, timestamps and repeated receipts do not manufacture progress", () => {
    const t = fixture(),
      query = (page: number) => ({
        id: "turn",
        tool_results: [
          {
            name: "query_project",
            status: "succeeded",
            result: { page, updatedAt: page },
          },
          {
            name: "read_processing",
            status: "succeeded",
            result: { total: page },
          },
        ],
      });
    expect(progressKey(t, query(1))).toBe(progressKey(t, query(2)));
    const a = progressFacts(t, {
      id: "t",
      tool_results: [
        {
          name: "create_draft",
          status: "succeeded",
          result: { draftId: "d", updatedAt: 1 },
        },
      ],
    });
    const b = progressFacts(t, {
      id: "t",
      tool_results: [
        {
          name: "create_draft",
          status: "succeeded",
          result: { draftId: "d", updatedAt: 2 },
        },
      ],
    });
    expect(a).toEqual(b);
    expect(
      progressKey({ ...t, requirementSave: { key: "new-save" } }, query(1)),
    ).not.toBe(progressKey(t, query(1)));
  });
  it("the active grant never bypasses hard or external ceilings", () => {
    const t = fixture();
    t.budgetLedger.ceiling = { modelSteps: 130 };
    expect(grantOffer(t, "owner", 2, "continue", 1000)).toBeNull();
    t.budgetLedger.externalClosed = true;
    expect(budgetAllowance(t, 1000)?.reason).toBe("external_budget_exhausted");
  });
});

describe("effective operation inputs", () => {
  it("records the seed actually passed to selection and reuses it in subsequent segments", () => {
    const input = {
      selection: { method: "random", mode: "count", value: 2, conditions: [] },
    };
    const first = effectiveOperationInput(
      "select_candidates",
      input,
      undefined,
      true,
    );
    expect(first.seed).toBe(first.selection.seed);
    const operation = { parameterContractVersion: 1, input: first };
    const same = effectiveOperationInput(
      "select_candidates",
      input,
      operation,
      true,
    );
    expect(same).toEqual(first);
    expect(input.selection).not.toHaveProperty("seed");
    const changed = effectiveOperationInput(
      "select_candidates",
      { ...input, selection: { ...input.selection, value: 3 } },
      operation,
      true,
    );
    expect(changed).not.toEqual(first);
  });
  it("does not replace explicit seeds or silently normalize a legacy frozen receipt", () => {
    const input = {
      selection: { method: "random", mode: "count", value: 2, conditions: [] },
    };
    const old = { input: { selection: { method: "random", value: 2 } } };
    expect(effectiveOperationInput("submit_processing", input, old, true)).toBe(
      input,
    );
    const fresh = effectiveOperationInput(
      "select_candidates",
      {
        ...input,
        seed: "explicit",
        selection: { ...input.selection, seed: "different" },
      },
      undefined,
      true,
    );
    expect(fresh.seed).toBe("explicit");
    expect(fresh.selection.seed).toBe("different");
  });
});

it("does not grant beyond a smaller frozen administrator ceiling", () => {
  const task: any = {
    taskId: "bounded",
    stage: "failed",
    executionBudget: {
      modelSteps: 2,
      toolCalls: 0,
      transportRetries: 0,
      requestAttempts: 2,
      activeMs: 1,
      limits: { modelSteps: 2 },
    },
    budgetLedger: createBudgetLedger("bounded", "actor", 1),
  };
  expect(budgetAllowance(task)?.reason).toBe("task_budget_exhausted");
  expect(grantOffer(task, "actor", 1, "continue")).toBeNull();
});
