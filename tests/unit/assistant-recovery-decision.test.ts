import {
  createBudgetLedger,
  progressKey,
  repairIdentity,
  grantOffer,
  applyBudgetGrant,
} from "../../src/assistant/budget-ledger.js";
import { describe, expect, it } from "vitest";
import { sha256, canonicalJson } from "../../src/package/contract.js";
import { assistantFailure } from "../../src/assistant/diagnostics.js";
import {
  recoveryDecision,
  recoveryProgress,
  backgroundVersion,
} from "../../src/assistant/recovery.js";
import {
  startActiveBudget,
  settleActiveBudget,
  checkpointExecutionBudget,
  executionLimits,
} from "../../src/assistant/budget.js";
const now = 100000;
import { TIMEOUT_RETRY_REQUEST_MS } from "../../src/assistant/transport.js";
function fixture(remaining = 20000) {
  const turn: any = {
    id: "turn-a",
    status: "failed",
    task_revision: 2,
    execution_attempt: 1,
    user_text: "先保存修改方案",
    tool_results: [
      {
        name: "read_background",
        status: "succeeded",
        result: { sha256: "doc" },
      },
    ],
  };
  const task: any = {
    stage: "failed",
    goal: "业务目标",
    turnControl: {
      turnId: turn.id,
      taskRevision: 2,
      mode: "plan",
      source: "model",
      requiresUpdate: true,
      updateSaved: false,
    },
    planningRecovery: {
      turnId: turn.id,
      requestTurnId: turn.id,
      taskRevision: 2,
      documentsKey: "docs",
    },
    turnBudget: {
      turnId: turn.id,
      startedAt: now - 60000,
      deadlineAt: now + remaining,
      modelSteps: 2,
      toolCalls: 2,
      transportRetries: 0,
      activeMs: 1200,
      accountingVersion: 2,
    },
    executionBudget: {
      modelSteps: 2,
      toolCalls: 2,
      transportRetries: 0,
      activeMs: 1200,
    },
    autoCount: 0,
    autoEventLimit: 12,
  };
  const facts: any = {
    now,
    revision: 2,
    canWrite: true,
    dependenciesValid: true,
    documentsKey: "docs",
    turnCount: 1,
  };
  return { turn, task, facts };
}
describe("OPT44 recovery decision", () => {
  it("a fresh user control request can query a stopped task without authorizing commits", () => {
    const { turn, task, facts } = fixture(80000);
    turn.event = "user";
    turn.status = "running";
    turn.execution_token = "token";
    turn.expires_at = new Date(now + 90000).toISOString();
    task.stage = "stopped";
    task.turnControl = { turnId: turn.id, taskRevision: 2, source: "pending" };
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
      }).reason,
    ).toBe("request_allowed");
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "commit",
        token: "token",
      }).reason,
    ).toBe("stopped");
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
        canWrite: false,
      }).reason,
    ).toBe("permission_denied");
    task.turnControl.turnId = turn.id;
    task.turnControl.mode = "execute";
    task.turnControl.source = "model";
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
      }).reason,
    ).toBe("stopped");
  });
  it("a fresh user control request can query a completed task without authorizing commits", () => {
    const { turn, task, facts } = fixture(80000);
    turn.event = "user";
    turn.status = "running";
    turn.execution_token = "token";
    turn.expires_at = new Date(now + 90000).toISOString();
    task.stage = "complete";
    task.turnControl = { turnId: turn.id, taskRevision: 2, source: "pending" };
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
      }).reason,
    ).toBe("request_allowed");
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "commit",
        token: "token",
      }).reason,
    ).toBe("complete");
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
        canWrite: false,
      }).reason,
    ).toBe("permission_denied");
    task.turnControl.turnId = turn.id;
    task.turnControl.mode = "execute";
    task.turnControl.source = "model";
    expect(
      recoveryDecision(task, turn, {
        ...facts,
        phase: "request",
        token: "token",
      }).reason,
    ).toBe("complete");
  });
  it("uses the same next-attempt estimate after a 50 second timeout and backoff", () => {
    const f = fixture(29500);
    f.turn.status = "running";
    f.turn.execution_token = "token";
    f.turn.expires_at = new Date(now + 60000).toISOString();
    f.task.turnBudget.requests = [{ httpStatus: null, timeToHeadersMs: 50000 }];
    const facts = {
      ...f.facts,
      phase: "request",
      token: "token",
      reservedModelStep: true,
    };
    expect(recoveryDecision(f.task, f.turn, facts).reason).toBe(
      "insufficient_request_time",
    );
    expect(
      recoveryDecision(f.task, f.turn, {
        ...facts,
        requestEstimateMs: TIMEOUT_RETRY_REQUEST_MS,
      }).reason,
    ).toBe("request_allowed");
    expect(
      recoveryDecision(f.task, f.turn, {
        ...facts,
        canWrite: false,
        requestEstimateMs: TIMEOUT_RETRY_REQUEST_MS,
      }).action,
    ).toBeNull();
  });
  it.each([5000, 9999, 10000, 10001])(
    "shares request reserve at %s ms",
    (remaining) => {
      const f = fixture(remaining);
      const d = recoveryDecision(f.task, f.turn, f.facts);
      expect(d.action).toBe(
        remaining >= 10000 ? "retry_turn" : "continue_plan",
      );
      if (remaining < 10000) expect(d.reason).toBe("insufficient_request_time");
    },
  );
  it("does not invent a continuation from expiry alone", () => {
    const f = fixture(-1);
    f.turn.tool_results = [];
    delete f.task.planningRecovery;
    expect(recoveryDecision(f.task, f.turn, f.facts).action).toBeNull();
  });
  it.each([
    "permission",
    "revision",
    "background",
    "repair",
    "attempt",
    "budget",
    "legacy",
    "stopped",
  ])("refuses %s without a new allowance", (kind) => {
    const f = fixture(-1);
    if (kind === "permission") f.facts.canWrite = false;
    if (kind === "revision") f.facts.revision = 3;
    if (kind === "background") f.facts.documentsKey = "changed";
    if (kind === "repair")
      f.task.parameterRepairLimits = {
        plan_task: {
          identity: sha256(canonicalJson({ requestTurnId: "turn-a" })),
          used: 2,
          version: 2,
        },
      };
    if (kind === "attempt") f.turn.execution_attempt = 3;
    if (kind === "budget") f.task.executionBudget.activeMs = 1040000;
    if (kind === "legacy") delete f.task.turnBudget;
    if (kind === "stopped") f.task.stage = "stopped";
    expect(recoveryDecision(f.task, f.turn, f.facts).action).toBeNull();
  });
  it("counts execution intervals once and excludes retry waiting", () => {
    const original = {
      turnId: "turn-a",
      startedAt: 1000,
      deadlineAt: 81000,
      modelSteps: 2,
      toolCalls: 1,
      transportRetries: 0,
      activeMs: 1000,
      accountingVersion: 2,
    };
    let b = startActiveBudget(original, "token", 50000);
    b = settleActiveBudget(b, 51000, true);
    const one = checkpointExecutionBudget(
      {
        modelSteps: 2,
        toolCalls: 1,
        transportRetries: 0,
        activeMs: 1000,
        lastTurn: {
          turnId: "turn-a",
          modelSteps: 2,
          toolCalls: 1,
          transportRetries: 0,
          elapsedMs: 1000,
        },
      },
      b,
      b.activeMs,
    );
    expect(one.activeMs).toBe(2000);
    expect(b.startedAt).toBe(1000);
    expect(b.deadlineAt).toBe(81000);
    expect(settleActiveBudget(b, 70000, true).activeMs).toBe(2000);
    expect(checkpointExecutionBudget(one, b, b.activeMs)).toEqual(one);
  });
  it("does not create another segment without new persistent progress", () => {
    const f = fixture(-1);
    f.task.recoverySegment = {
      turnId: f.turn.id,
      rootTurnId: "root",
      revision: 2,
      documentsKey: "docs",
      mode: "plan",
      progressKey: recoveryProgress(f.task, f.turn),
    };
    expect(recoveryDecision(f.task, f.turn, f.facts)).toMatchObject({
      action: null,
      reason: "no_progress",
    });
  });
  it("keeps timeout observations distinct from requests refused before dispatch", () => {
    expect(
      assistantFailure(
        new DOMException("synthetic", "TimeoutError"),
        "assistant_model_failed",
        undefined,
        true,
      ).category,
    ).toBe("timeout");
    expect(
      assistantFailure(new Error("synthetic"), "assistant_budget_exhausted")
        .category,
    ).toBe("budget_exhausted");
  });

  it("accepts a verifiable legacy snapshot without rewriting its times or spending", () => {
    const f = fixture(20000);
    const docs = [
      {
        id: "background_" + "a".repeat(32),
        sha256: "hash",
        extractorVersion: "v1",
      },
    ];
    f.facts.documentsKey = backgroundVersion(docs);
    f.facts.legacyDocumentsKey = backgroundVersion(docs, true);
    f.task.planningRecovery.documentsKey = f.facts.legacyDocumentsKey;
    f.task.executionBudget.lastTurn = {
      turnId: f.turn.id,
      modelSteps: 2,
      toolCalls: 2,
      transportRetries: 0,
      elapsedMs: 1200,
    };
    delete f.task.turnBudget.activeMs;
    delete f.task.turnBudget.accountingVersion;
    const before = structuredClone(f.task);
    expect(recoveryDecision(f.task, f.turn, f.facts).action).toBe("retry_turn");
    expect(f.task).toEqual(before);
  });
  it.each(["pause", "question"])(
    "does not retry a %s as if it were a provider failure",
    (kind) => {
      const f = fixture();
      if (kind === "pause") f.task.turnControl.mode = "pause";
      else f.task.question = "具体选择哪一种范围？";
      expect(recoveryDecision(f.task, f.turn, f.facts).action).toBeNull();
    },
  );
  it("keeps the shared failure allowance across linked segments", () => {
    const f = fixture();
    f.task.recoverySegment = {
      turnId: f.turn.id,
      rootTurnId: "root",
      revision: 2,
      documentsKey: "docs",
      mode: "plan",
      attemptsBefore: 1,
    };
    f.turn.execution_attempt = 2;
    expect(recoveryDecision(f.task, f.turn, f.facts)).toMatchObject({
      action: null,
      reason: "attempt_limit",
    });
  });
});

describe("frozen limits", () => {
  it("never widens an invalid or smaller persisted allowance", () => {
    expect(
      executionLimits({
        modelSteps: 0,
        toolCalls: 0,
        transportRetries: 0,
        activeMs: 0,
        limits: { activeMs: 15000, modelSteps: NaN, toolCalls: -1 },
      }),
    ).toMatchObject({ activeMs: 15000, modelSteps: 0, toolCalls: 0 });
  });
});

it("commits a previously reserved final step at the cap but refuses a fresh request", () => {
  const f = fixture();
  f.turn.status = "running";
  f.turn.execution_token = "lease";
  f.turn.expires_at = new Date(now + 60000);
  f.task.executionBudget.modelSteps = 130;
  f.task.executionBudget.lastTurn = {
    turnId: f.turn.id,
    modelSteps: 2,
    toolCalls: 2,
    transportRetries: 0,
    elapsedMs: 1200,
  };
  const facts = { ...f.facts, token: "lease" };
  expect(
    recoveryDecision(f.task, f.turn, { ...facts, phase: "commit" }).reason,
  ).toBe("commit_allowed");
  expect(
    recoveryDecision(f.task, f.turn, {
      ...facts,
      phase: "request",
      reservedModelStep: true,
    }).reason,
  ).toBe("request_allowed");
  expect(
    recoveryDecision(f.task, f.turn, { ...facts, phase: "request" }).action,
  ).toBeNull();
});

it("only the exact persisted planning question can settle without new business input", () => {
  const f = fixture();
  f.task.question = "需要多少条？";
  f.turn.tool_results.push({
    name: "plan_task",
    status: "succeeded",
    result: { task: { question: f.task.question } },
  });
  expect(recoveryDecision(f.task, f.turn, f.facts).action).toBe("retry_turn");
  f.task.question = "改为询问适用场景？";
  expect(recoveryDecision(f.task, f.turn, f.facts).reason).toBe(
    "business_input_required",
  );
});

describe("OPT49 shared ledger decisions", () => {
  function current() {
    const f = fixture(-1);
    f.task.taskId = "task";
    f.task.taskContractVersion = 2;
    f.task.budgetLedger = createBudgetLedger("task", "actor", 2, now);
    f.task.turnBudget.progressStart = progressKey(f.task);
    return f;
  }
  it("does not turn read page, ordering or timestamp changes into persistent progress", () => {
    const f = current();
    f.task.recoverySegment = {
      turnId: f.turn.id,
      revision: 2,
      documentsKey: "docs",
      mode: "plan",
      progressKey: progressKey(f.task, f.turn),
    };
    f.turn.tool_results.push({
      name: "read_processing",
      status: "succeeded",
      result: { runId: "same", page: 99, updatedAt: "new" },
    });
    expect(recoveryDecision(f.task, f.turn, f.facts).action).toBeNull();
  });
  it.each(["offer", "event", "claim", "request", "commit"])(
    "refuses exhausted work at %s without a hidden grant",
    (phase) => {
      const f = current();
      f.task.executionBudget.modelSteps = 131;
      f.turn.status =
        phase === "request" || phase === "commit" ? "running" : "failed";
      f.facts = { ...f.facts, phase, eventReady: true };
      expect(recoveryDecision(f.task, f.turn, f.facts)).toMatchObject({
        action: null,
        reason: "task_budget_exhausted",
      });
      expect(f.task.budgetLedger.grants).toHaveLength(1);
    },
  );
  it("keeps completion visible at the exhausted ceiling", () => {
    const f = current();
    f.task.stage = "complete";
    f.task.executionBudget.activeMs = 1040000;
    expect(recoveryDecision(f.task, f.turn, f.facts)).toMatchObject({
      reason: "complete",
      action: null,
      canExecutePlan: false,
    });
  });
  it("does not expose grant offers after background changes or permission revocation", () => {
    const f = current();
    f.task.executionBudget.modelSteps = 130;
    f.facts.documentsKey = "changed";
    expect(
      recoveryDecision(f.task, f.turn, f.facts).grantOffers,
    ).toBeUndefined();
    f.facts.documentsKey = "docs";
    f.facts.canWrite = false;
    expect(
      recoveryDecision(f.task, f.turn, f.facts).grantOffers,
    ).toBeUndefined();
  });
  it("ordinary grants retain repair limits; explicit repair grants link one fresh bounded attempt", () => {
    const f = current();
    const identity = repairIdentity(f.task, f.turn.id);
    f.task.parameterRepairLimits = {
      plan_task: { version: 2, identity, used: 2, truncated: 1 },
    };
    f.task.parameterRepairStatus = { amendmentId: f.turn.id, issues: [] };
    f.task.requirementSave = { key: "saved" };
    expect(recoveryDecision(f.task, f.turn, f.facts).reason).toBe(
      "initial_plan_repair_limit",
    );
    f.task.executionBudget.modelSteps = 130;
    expect(grantOffer(f.task, "actor", 2, "continue", now)).toBeNull();
    const beforeFailure = { ...f.task, parameterRepairLimits: {} };
    const ordinary = grantOffer(beforeFailure, "actor", 2, "continue", now)!;
    const granted = applyBudgetGrant(
      beforeFailure,
      ordinary,
      "actor",
      2,
      "ordinary",
      now,
    );
    granted.parameterRepairLimits = structuredClone(
      f.task.parameterRepairLimits,
    );
    expect(recoveryDecision(granted, f.turn, f.facts).action).toBeNull();
    const repair = grantOffer(f.task, "actor", 2, "repair", now)!;
    const repaired = applyBudgetGrant(
      f.task,
      repair,
      "actor",
      2,
      "repair",
      now,
    );
    expect(recoveryDecision(repaired, f.turn, f.facts).action).toBe(
      "continue_plan",
    );
    expect(repaired.parameterRepairLimits.plan_task.used).toBe(2);
  });
});

it("counts the actual HTTP segment ceiling independently of SDK steps", () => {
  const f = fixture(50000);
  f.task.taskId = "task";
  f.task.budgetLedger = createBudgetLedger("task", "actor", 2, now);
  f.task.turnBudget.requestAttempts = 12;
  f.task.executionBudget.requestAttempts = 12;
  f.turn.status = "running";
  f.turn.execution_token = "token";
  f.turn.expires_at = new Date(now + 60000).toISOString();
  expect(
    recoveryDecision(f.task, f.turn, {
      ...f.facts,
      phase: "request",
      token: "token",
      reservedModelStep: true,
    }),
  ).toMatchObject({ action: null, reason: "segment_budget_exhausted" });
  expect(f.task.turnBudget.modelSteps).toBe(2);
});
