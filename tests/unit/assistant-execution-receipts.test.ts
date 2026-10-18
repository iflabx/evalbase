import { describe, expect, it } from "vitest";
import {
  hasNoEffect,
  unresolvedFailure,
} from "../../src/assistant/receipts.js";
const binding = { revision: 1, stepId: "one", deliveryId: "a" };
const failure = {
  name: "generate_candidates",
  key: "validation-one",
  status: "failed",
  effect: "none",
  binding,
  error: { code: "assistant_tool_input_invalid" },
};
const success = {
  name: "generate_candidates",
  key: "committed-one",
  status: "succeeded",
  binding,
  result: { runId: "run-one" },
};
describe("OPT36 receipt failure resolution", () => {
  it("OPT37 releases only a failed candidate lookup while retaining unknown domain outcomes", () => {
    const lookup = {
      name: "refine_candidates",
      status: "failed",
      error: { code: "processing_not_found" },
    };
    expect(hasNoEffect(lookup)).toBe(true);
    for (const name of ["submit_processing", "generate_candidates"])
      expect(hasNoEffect({ ...lookup, name })).toBe(false);
    for (const status of ["started", "succeeded"])
      expect(hasNoEffect({ ...lookup, status })).toBe(false);
    for (const code of [
      "assistant_operation_unknown",
      "assistant_context_unavailable",
      "assistant_interrupted",
    ])
      expect(hasNoEffect({ ...lookup, error: { code } })).toBe(false);
  });
  it("resolves a corrected attempt only within its original step and revision without erasing history", () => {
    const records = [failure, success];
    expect(unresolvedFailure(records)).toBeUndefined();
    expect(records[0]).toBe(failure);
  });
  it("does not let a different delivery or revision hide the failure", () => {
    for (const other of [
      { ...binding, stepId: "two", deliveryId: "b" },
      { ...binding, revision: 2 },
    ])
      expect(unresolvedFailure([failure, { ...success, binding: other }])).toBe(
        failure,
      );
  });
  it("requires the same domain key for an unknown write", () => {
    const unknown = {
      ...failure,
      effect: undefined,
      error: { code: "assistant_operation_unknown" },
    };
    expect(unresolvedFailure([unknown, success])).toBe(unknown);
    expect(
      unresolvedFailure([unknown, { ...success, key: unknown.key }]),
    ).toBeUndefined();
  });
  it("retains another action's failure and a new unsaved requirement", () => {
    const plan = { ...failure, name: "plan_task", key: "plan-failed" };
    expect(unresolvedFailure([failure, plan, success])).toBe(plan);
  });
  it("preserves recorded legacy no-effect semantics without promoting unknown outcomes", () => {
    const old = { ...failure, binding: undefined };
    expect(
      unresolvedFailure([old, { ...success, binding: undefined }]),
    ).toBeUndefined();
    expect(
      unresolvedFailure([
        { ...old, effect: undefined, error: { code: "unknown_failure" } },
        { ...success, binding: undefined },
      ]),
    ).toBeDefined();
  });
});
