import { pendingPlanningAmendment } from "../../src/assistant/recovery.js";
import { bindTaskInput } from "../../src/assistant/plan.js";
import { wholeSourceAuthorized } from "../../src/assistant/processing-preparation.js";
import { describe, expect, it } from "vitest";
import {
  answeredPlanningQuestion,
  planningRequestFacts,
  recoverPlanningFailure,
  savedPlanningMode,
  needsPlanningSubmission,
  echoesPlanningRequest,
  initialDeliveryRepair,
} from "../../src/assistant/planning-state.js";
import { currentTaskFacts } from "../../src/assistant/context.js";
import { turnNeedsWork } from "../../src/assistant/intent.js";
const question = "是否按这个方案保存？";
const task = {
  goal: "清理首尾空白、整条记录去重，再改自然，先给方案",
  title: "资料整理",
  requirements: [],
  supplements: ["整条记录相同才去重"],
  question,
  executionPlan: { steps: [] },
  planningClarification: {
    question,
    askedTurnId: "ask",
    answerTurnId: "answer",
    answer: "对，先保存方案",
  },
};
describe("B3v5 complete planning state", () => {
  it("initial delivery correction uses creation or specific question; existing candidates and sources keep their contract", () => {
    expect(initialDeliveryRepair({}, true, true)).toBe(true);
    for (const task of [
      { target: { kind: "assets" } },
      { runId: "run" },
      { executionPlan: { steps: [{}] } },
    ])
      expect(initialDeliveryRepair(task, true, true)).toBe(false);
    expect(initialDeliveryRepair({}, true, false)).toBe(false);
  });
  it("an original request echo is not a business clarification", () => {
    expect(echoesPlanningRequest(task, task.goal + "？", task.goal)).toBe(true);
    expect(
      echoesPlanningRequest(task, "只去掉问题相同还是整条相同？", task.goal),
    ).toBe(false);
  });
  it("a legacy initial question checkpoint preserves the root identity without a plan key", () => {
    const t = {
      originTurnId: "root",
      goal: "两份各2条",
      planningRecovery: {
        requestTurnId: "root",
        documentsKey: "docs",
        evidenceKey: "e",
      },
    };
    expect(pendingPlanningAmendment(t, "docs", "e")?.requestTurnId).toBe(
      "root",
    );
    expect(pendingPlanningAmendment(t, "changed", "e")).toBeUndefined();
    expect(
      pendingPlanningAmendment(
        { ...t, planningRecovery: { requestTurnId: "root" } },
        "new-docs",
        "new-evidence",
      ),
    ).toBeUndefined();
    expect(
      pendingPlanningAmendment({ ...t, originTurnId: "other" }, "docs", "e"),
    ).toBeUndefined();
  });
  it("answered state never bypasses the current control or hijacks query and pause", () => {
    for (const decision of [undefined, { mode: "query" }, { mode: "pause" }])
      expect(needsPlanningSubmission(task, decision, true)).toBe(false);
    expect(needsPlanningSubmission(task, { mode: "plan" }, false)).toBe(true);
  });
  it("failed execute proposals cannot upgrade a successful plan authorization", () => {
    expect(
      savedPlanningMode([
        {
          name: "plan_task",
          status: "failed",
          input: { control: { mode: "execute" } },
        },
        {
          name: "plan_task",
          status: "succeeded",
          input: { control: { mode: "plan" } },
          result: { control: { mode: "plan" } },
        },
      ]),
    ).toBe("plan");
    expect(
      savedPlanningMode([
        {
          name: "plan_task",
          status: "failed",
          input: { control: { mode: "execute" } },
        },
      ]),
    ).toBeUndefined();
  });
  it("an explicit fixed selection replaces inherited all-results defaults without hiding explicit mixed ranges", () => {
    const t = {
      executionPlan: {
        current: 0,
        steps: [
          {
            action: "request_processing_apply",
            input: { allTask: true, allValid: true },
          },
        ],
      },
    };
    expect(
      bindTaskInput("request_processing_apply", { allSelected: true }, t),
    ).toEqual({ allSelected: true, runId: undefined });
    expect(
      bindTaskInput(
        "request_processing_apply",
        { allSelected: true, allValid: true },
        t,
      ),
    ).toMatchObject({ allSelected: true, allValid: true });
  });
  it("answered details reuse only a bound whole-source grant; an explicit subset still wins", () => {
    expect(
      wholeSourceAuthorized("整条记录相同才去重", "整份处理", false, true),
    ).toBe(true);
    expect(wholeSourceAuthorized("只处理前2条", "整份处理", false, true)).toBe(
      false,
    );
    expect(wholeSourceAuthorized("整条记录相同才去重", "", false, true)).toBe(
      false,
    );
  });
  it("an answered question does not suppress unfinished planning", () => {
    expect(answeredPlanningQuestion(task)).toBe(true);
    expect(
      turnNeedsWork(
        {
          mode: "plan",
          source: "model",
          turnId: "answer",
          taskRevision: 2,
          requiresUpdate: true,
          updateSaved: false,
        },
        task,
        [],
      ),
    ).toBe(true);
    expect(currentTaskFacts(task).question).toBeUndefined();
    expect(currentTaskFacts(task).objective).toBe(task.goal);
    expect(planningRequestFacts(task).supplements).toContain(
      "整条记录相同才去重",
    );
  });
  it("unanswered and changed questions still stop planning", () => {
    expect(
      answeredPlanningQuestion({ ...task, planningClarification: null }),
    ).toBe(false);
    expect(
      answeredPlanningQuestion({ ...task, question: "只处理前两条吗？" }),
    ).toBe(false);
  });
  it("recovers only the original no-effect plan failure, never a control or unknown write", () => {
    const failed = {
      name: "plan_task",
      status: "failed",
      effect: "none",
      input: { deliveries: [{ name: "一份" }] },
      error: {
        code: "assistant_requirement_conflict",
        hint: "需要两份",
        issues: [{ path: "/", keyword: "business" }],
      },
    };
    expect(
      recoverPlanningFailure([
        failed,
        {
          name: "plan_task",
          status: "succeeded",
          input: { control: { mode: "pause" } },
        },
      ]),
    ).toMatchObject({
      proposal: failed.input,
      reason: failed.error,
      issues: failed.error.issues,
    });
    expect(
      recoverPlanningFailure([{ ...failed, effect: "unknown" }]),
    ).toBeUndefined();
    expect(
      recoverPlanningFailure([
        failed,
        { ...failed, key: "later", effect: "unknown" },
      ]),
    ).toBeUndefined();
  });
});

it("B3v8 recovery separates the last malformed input from the preceding business proposal", () => {
  const business = {
    name: "plan_task",
    status: "failed",
    effect: "none",
    input: { deliveries: [{ name: "第一份", count: 2 }] },
    error: {
      code: "assistant_requirement_conflict",
      issues: [{ path: "/deliveries", keyword: "minItems" }],
    },
  };
  const wrapper = {
    name: "plan_task",
    status: "failed",
    effect: "none",
    input: { error: "[unsupported]" },
    error: {
      code: "assistant_tool_input_invalid",
      issues: [{ path: "/error", keyword: "additionalProperties" }],
    },
  };
  expect(
    recoverPlanningFailure([
      business,
      wrapper,
      {
        name: "plan_task",
        status: "succeeded",
        result: { unchanged: true },
        input: { control: { mode: "pause" } },
      },
    ]),
  ).toMatchObject({
    proposal: business.input,
    lastInput: wrapper.input,
    reason: wrapper.error,
    issues: wrapper.error.issues,
  });
  expect(
    recoverPlanningFailure([
      business,
      { ...business, status: "succeeded", result: { unchanged: false } },
      wrapper,
    ])?.proposal,
  ).toEqual(wrapper.input);
});
