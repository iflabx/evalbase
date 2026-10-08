import { describe, expect, it } from "vitest";
import {
  advancePlan,
  revisePlan,
  type ExecutionPlan,
} from "../../src/assistant/plan.js";

describe("restored execution plan boundaries", () => {
  it("treats an unknown future processing reference as missing, never as a fixed empty ID", () => {
    const plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "按分类选取",
            action: "select_candidates",
            input: { runId: "", groups: [{ count: 2, conditions: [] }] },
          },
        ],
      },
      1,
    );
    expect(plan?.steps[0]?.input).toEqual({
      groups: [{ count: 2, conditions: [] }],
    });
    expect(revisePlan(undefined, { executionMode: "execute" })).toBeUndefined();
  });
  it("restores an asset-page source while still rejecting another real asset", () => {
    const plan: ExecutionPlan = {
      mode: "execute",
      target: { kind: "asset", id: "A" },
      current: 0,
      steps: [
        {
          title: "读取原始资料",
          action: "read_records",
          scope: "all",
          status: "pending",
        },
      ],
    };
    const read = { readCount: 12, matchingTotal: 12, total: 12, offset: 0 };
    expect(
      advancePlan(
        plan,
        "read_records",
        { ...read, source: { kind: "assets", assetIds: ["A"] } },
        "receipt",
      )?.current,
    ).toBe(1);
    expect(
      advancePlan(
        plan,
        "read_records",
        { ...read, source: { kind: "assets", assetIds: ["B"] } },
        "receipt",
      )?.current,
    ).toBe(0);
    const restored = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [{ title: "读取资料", action: "read_records" }],
      },
      1,
      plan.target,
    );
    expect(restored?.steps[0]?.input?.source).toEqual({
      kind: "assets",
      assetIds: ["A"],
    });
    expect(
      revisePlan(restored, { executionMode: "execute" }, 2, {
        kind: "asset",
        id: "B",
      })?.steps[0]?.input?.source,
    ).toEqual({ kind: "assets", assetIds: ["B"] });
  });
  it("does not use another source's receipt to complete a legacy full read", () => {
    const plan: ExecutionPlan = {
      mode: "execute",
      target: { kind: "draft", id: "A" },
      current: 0,
      steps: [
        {
          title: "完整读取当前草稿",
          action: "read_records",
          scope: "all",
          status: "pending",
        },
      ],
    };
    expect(
      advancePlan(
        plan,
        "read_records",
        {
          source: { kind: "draft", id: "B" },
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(0);
    expect(
      advancePlan(
        plan,
        "read_records",
        {
          source: plan.target,
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(1);
    expect(
      advancePlan(
        { ...plan, target: undefined },
        "read_records",
        {
          source: { kind: "draft", id: "B" },
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(0);
  });
  it("keeps committed adoption history without treating a changed destination as completed", () => {
    const input = { runId: "run", target: { kind: "draft", id: "A" } };
    const plan: ExecutionPlan = {
      mode: "execute",
      current: 1,
      requirementsKey: "old",
      steps: [
        {
          title: "采用到A",
          action: "request_processing_apply",
          input,
          status: "executed",
          receipt: { key: "receipt", proposalId: "proposal-A" },
        },
      ],
    };
    const changed = revisePlan(
      plan,
      {
        executionMode: "execute",
        steps: [
          {
            title: "采用到B",
            action: "request_processing_apply",
            input: { ...input, target: { kind: "draft", id: "B" } },
          },
        ],
      },
      2,
      undefined,
      "new",
    );
    expect(changed?.current).toBe(0);
    expect(changed?.steps[0]?.receipt).toBeUndefined();
    expect(plan.steps[0]?.receipt?.proposalId).toBe("proposal-A");
    expect(
      revisePlan(plan, { executionMode: "execute" }, 2, undefined, "new")
        ?.current,
    ).toBe(1);
  });
});
