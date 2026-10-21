import { describe, expect, it } from "vitest";
import {
  classifyToolFailure,
  chargeRepairRequest,
} from "../../src/assistant/tool-repair.js";
import {
  appendObservation,
  turnDiagnostics,
} from "../../src/assistant/diagnostics.js";
import {
  assertDeliveryRepair,
  reviseDeliveryGoals,
} from "../../src/assistant/delivery-plan.js";
const goal = (name: string, count = 2) => ({
  name,
  count,
  countKind: "new" as const,
  instructions: "完整自然的用户问题",
  scenarios: ["用户查询待揽收订单", "用户查询运输中订单", "用户查询延误订单"],
  classifications: [
    {
      field: "metadata" as const,
      key: "intent",
      basis: "user" as const,
      allowedValues: [name],
      quotas: [{ value: name, count }],
    },
  ],
});
describe("OPT43 amendment mechanism", () => {
  it("routes missing business information and minItems to contextual correction", () => {
    for (const keyword of [
      "required",
      "minItems",
      "minLength",
      "enum",
      "additionalProperties",
    ])
      expect(
        classifyToolFailure([{ path: "/deliveries/0/scenarios", keyword }]),
      ).toBe("context");
    expect(classifyToolFailure([{ path: "/count", keyword: "type" }])).toBe(
      "format",
    );
    expect(classifyToolFailure([{ path: "/", keyword: "parse" }])).toBe(
      "truncated",
    );
    expect(
      classifyToolFailure([], "assistant_background_reference_invalid"),
    ).toBe("reference");
  });
  it("shares corrections across tools and kinds, persisting the same amendment limit", () => {
    const limits = {};
    expect(
      chargeRepairRequest(limits, "plan_task", "change-1", "context"),
    ).toBe(true);
    expect(
      chargeRepairRequest(limits, "query_project", "change-1", "truncated"),
    ).toBe(true);
    const persisted = JSON.parse(JSON.stringify(limits));
    expect(
      chargeRepairRequest(persisted, "plan_task", "change-1", "format"),
    ).toBe(false);
    expect(
      chargeRepairRequest(persisted, "plan_task", "change-2", "truncated"),
    ).toBe(true);
    expect(
      chargeRepairRequest(persisted, "plan_task", "change-2", "truncated"),
    ).toBe(false);
  });
  it("derives single-category quotas even when a count patch copies unchanged rules", () => {
    let current = reviseDeliveryGoals(
      [],
      [goal("物流"), goal("地址")],
      "两份方案",
    );
    const before = structuredClone(current);
    current = reviseDeliveryGoals(
      current,
      [
        {
          id: current[0].id,
          count: 3,
          classifications: current[0].classifications,
        },
      ],
      "物流改成3条",
      true,
    );
    expect(current[0].classifications[0].quotas).toEqual([
      { value: "物流", count: 3 },
    ]);
    current = reviseDeliveryGoals(
      current,
      [
        { id: current[0].id, count: 2 },
        { id: current[1].id, count: 1 },
      ],
      "物流2条、地址1条",
      true,
    );
    expect(current.map((g) => g.count)).toEqual([2, 1]);
    expect(current.map((g) => g.scenarios)).toEqual(
      before.map((g) => g.scenarios),
    );
    expect(current[1].classifications[0].quotas).toEqual([
      { value: "地址", count: 1 },
    ]);
    expect(before.map((g) => g.count)).toEqual([2, 2]);
  });
  it("retains the original failure and every attempt while projecting the latest", () => {
    const first = {
      turnId: "turn-1",
      executionAttempt: 1,
      errorCode: "assistant_tool_input_invalid",
      modelSteps: 2,
      attemptRequestAttempts: 2,
      firstFailure: { code: "assistant_tool_input_invalid" },
    };
    let records = appendObservation([], first);
    records = appendObservation(records, {
      turnId: "turn-1",
      executionAttempt: 2,
      finishReason: "stop",
      modelSteps: 3,
    });
    records = appendObservation(records, {
      turnId: "turn-1",
      executionAttempt: 2,
      finishReason: "saved",
      modelSteps: 4,
    });
    expect(records).toHaveLength(2);
    const latest = turnDiagnostics(records, "turn-1")!;
    expect(latest).toMatchObject({
      executionAttempt: 2,
      finishReason: "saved",
      modelSteps: 4,
    });
    expect(latest.attempts).toHaveLength(2);
    expect(latest.attempts[0]).toMatchObject({
      executionAttempt: 1,
      errorCode: "assistant_tool_input_invalid",
      attemptRequestAttempts: 2,
    });
    for (let n = 0; n < 110; n++)
      records = appendObservation(records, {
        turnId: "new-" + n,
        executionAttempt: 1,
        finishReason: "stop",
      });
    expect(records).toHaveLength(100);
    expect(records[0]).toEqual(first);
    expect(records.at(-1)!.turnId).toBe("new-109");
  });
  it("preserves valid new-delivery instructions and scenes while allowing missing scenes to be appended", () => {
    const original = {
      deliveries: [
        { ...goal("物流"), scenarios: ["待揽收订单", "运输中订单"] },
      ],
    };
    const fixed = {
      deliveries: [
        {
          ...original.deliveries[0],
          scenarios: [...original.deliveries[0].scenarios, "延误订单"],
        },
      ],
    };
    expect(() => assertDeliveryRepair(original, fixed)).not.toThrow();
    expect(() =>
      assertDeliveryRepair(original, {
        deliveries: [{ ...fixed.deliveries[0], instructions: "任意客服问题" }],
      }),
    ).toThrow("assistant_requirement_conflict");
    expect(() =>
      assertDeliveryRepair(original, {
        deliveries: [
          {
            ...fixed.deliveries[0],
            scenarios: ["退款申请被拒", "退款金额不足", "退款到账延迟"],
          },
        ],
      }),
    ).toThrow("assistant_requirement_conflict");
  });
});
