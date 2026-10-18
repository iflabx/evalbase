import { describe, expect, it } from "vitest";
import {
  planRequirementsKey,
  revisePlan,
  completeDocumentDeliveries,
} from "../../src/assistant/plan.js";
import {
  reviseDeliveryRequirements,
  requirementSummary,
} from "../../src/assistant/requirements.js";
const step = (deliveryId: string, count = 5) => ({
  deliveryId,
  countKind: "new" as const,
  title: "生成",
  action: "generate_candidates",
  input: {
    name: "集合",
    outputCount: count,
    instructions: "语义完整",
    scenarios: ["场景一", "场景二", "场景三"],
    classifications: [],
  },
});
describe("OPT35 existing planning seams", () => {
  it("includes the second delivery and stable identity in the requirements fingerprint", () => {
    const task = {
      executionPlan: { contractVersion: 1, steps: [step("one"), step("two")] },
    };
    expect(
      planRequirementsKey({
        ...task,
        executionPlan: {
          ...task.executionPlan,
          steps: [step("one"), step("two", 3)],
        },
      }),
    ).not.toBe(planRequirementsKey(task));
    expect(
      planRequirementsKey({
        ...task,
        executionPlan: {
          ...task.executionPlan,
          steps: [step("one"), step("another")],
        },
      }),
    ).not.toBe(planRequirementsKey(task));
  });
  it("keeps unchanged receipt facts but never assigns them to another delivery", () => {
    const original = revisePlan(
      undefined,
      { executionMode: "plan", steps: [step("one"), step("two")] },
      1,
      undefined,
      "key",
    )!;
    original.steps[0] = {
      ...original.steps[0],
      status: "executed",
      receipt: { key: "commit-one", runId: "run-one" },
    };
    const retained = revisePlan(
      original,
      { steps: [step("one"), step("two")] },
      2,
      undefined,
      "key",
    )!;
    expect(retained.steps[0].receipt).toEqual(original.steps[0].receipt);
    const moved = revisePlan(
      original,
      { steps: [step("two"), step("one")] },
      2,
      undefined,
      "key",
    )!;
    expect(moved.steps[0].receipt).toBeUndefined();
    expect(moved.steps[0].deliveryId).toBe("two");
    expect(original.steps[0].receipt?.runId).toBe("run-one");
  });
  it("updates count meaning while keeping an unchanged executed receipt", () => {
    const original = revisePlan(
      undefined,
      { executionMode: "plan", steps: [step("one")] },
      1,
      undefined,
      "old",
    )!;
    original.contractVersion = 1;
    original.steps[0] = {
      ...original.steps[0],
      status: "executed",
      receipt: { key: "committed", runId: "run-one" },
    };
    const nextStep = { ...step("one"), countKind: "final" as const };
    const key = planRequirementsKey({
      executionPlan: { contractVersion: 1, steps: [nextStep] },
    });
    const revised = revisePlan(
      original,
      { steps: [nextStep] },
      2,
      undefined,
      key,
    )!;
    expect(revised.steps[0].countKind).toBe("final");
    expect(revised.steps[0].id).toBe(original.steps[0].id);
    expect(revised.steps[0].receipt).toEqual(original.steps[0].receipt);
    expect(revised.steps[0].status).toBe("executed");
    expect(planRequirementsKey({ executionPlan: revised })).toBe(key);
  });
  it("compiles review and adoption under their own delivery identity", () => {
    const steps = completeDocumentDeliveries([step("one"), step("two")]);
    expect(steps.map((s) => s.deliveryId)).toEqual([
      "one",
      "one",
      "one",
      "two",
      "two",
      "two",
    ]);
  });
  it("preserves omitted semantics and rejects unrequested removal or broader fields", () => {
    const current = {
      requirements: ["问题语义完整", "期望输出为标签"],
      allowedFields: ["question"],
      metadataKeys: ["intent"],
    };
    expect(
      reviseDeliveryRequirements(
        current,
        { requirements: ["场景多样"] },
        "增加场景多样性",
      ).requirements,
    ).toEqual(["场景多样", "期望输出为标签", "问题语义完整"].sort());
    expect(() =>
      reviseDeliveryRequirements(
        current,
        { removeRequirements: ["问题语义完整"] },
        "问题改写得自然一点",
      ),
    ).toThrow();
    expect(() =>
      reviseDeliveryRequirements(
        current,
        { allowedFields: ["question", "expectedOutput"] },
        "不允许修改期望输出",
      ),
    ).toThrow();
    expect(
      reviseDeliveryRequirements(
        current,
        {
          removeRequirements: ["期望输出为标签"],
          requirements: ["期望输出写逐题行为"],
        },
        "期望输出改为逐题自然语言",
      ).requirements,
    ).toEqual(["问题语义完整", "期望输出写逐题行为"].sort());
  });
  it("derives each collection summary from the persisted generation contract", () => {
    const summary = requirementSummary({
      executionPlan: {
        contractVersion: 1,
        steps: [step("one"), step("two", 3)],
      },
      overallTargetCount: 8,
    });
    expect(summary).toContain("交付「集合」：新增 5 条");
    expect(summary).toContain("交付「集合」：新增 3 条");
  });
});
