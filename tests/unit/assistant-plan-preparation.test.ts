import { describe, it, expect } from "vitest";
import {
  bindPlanProposal,
  preparePlanProposal,
} from "../../src/assistant/plan-preparation.js";
import { preparePlanAmendment } from "../../src/assistant/plan-request.js";
import {
  reviseDeliveryGoals,
  generationSteps,
} from "../../src/assistant/delivery-plan.js";
const goal = (name: string) => ({
  name,
  count: 2,
  instructions: "自然完整的问题与逐题期望",
  scenarios: ["咨询进度", "异常情况", "信息不足"],
  classifications: [
    {
      field: "metadata" as const,
      key: "intent",
      basis: "user" as const,
      allowedValues: [name],
      quotas: [{ value: name, count: 2 }],
    },
  ],
});
function fixture(names = ["物流", "地址"]) {
  const goals = reviseDeliveryGoals([], names.map(goal), "先给方案");
  return {
    goals,
    task: {
      executionPlan: {
        contractVersion: 1,
        mode: "plan",
        current: 0,
        steps: generationSteps(goals),
      },
      requirements: ["自然完整"],
      allowedFields: ["question"],
      metadataKeys: ["intent"],
    },
  };
}
const prepare = (value: any, task: any, request: string) =>
  preparePlanProposal(value, {
    task,
    request,
    revision: 4,
    canUpdate: true,
    resolve: (x) => x,
    validate: () => {},
    knownValues: [],
  });
describe("OPT46 completion pure preparation contract", () => {
  it("only binds a unique trusted target and derives the whole count", () => {
    const { task, goals } = fixture(["物流"]);
    const r = prepare(
      {
        deliveries: [
          {
            classifications: [
              {
                ...goals[0].classifications[0],
                quotas: [{ value: "物流", count: 3 }],
              },
            ],
          },
        ],
      },
      task,
      "物流改为3条",
    );
    expect(r.ok).toBe(true);
    expect(
      bindPlanProposal({ requirements: ["保留"] }, task, "补充要求", 4)
        .baseRevision,
    ).toBe(4);
    if (r.ok) {
      expect(r.input.baseRevision).toBe(4);
      expect(r.input.deliveries[0]).toMatchObject({
        id: goals[0].id,
        count: 3,
      });
      expect(r.goals![0].count).toBe(3);
    }
  });
  it("does not select a first ambiguous delivery or repair an unknown ID by guessing", () => {
    const { task, goals } = fixture(["同名", "同名"]);
    expect(
      bindPlanProposal(
        { deliveries: [{ count: 3 }] },
        task,
        "第二份改3条，其他不变",
        4,
      ).deliveries[0].id,
    ).toBe(goals[1].id);
    expect(
      prepare({ deliveries: [{ count: 3 }] }, task, "这份改为3条"),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "/deliveries/0/id" })],
    });
    expect(
      prepare(
        { deliveries: [{ id: "unknown", count: 3 }] },
        task,
        "同名改为3条",
      ).ok,
    ).toBe(false);
  });
  it("requires real update IDs in ordinary as well as truncated model contracts", () => {
    const { task } = fixture(["物流"]);
    const properties = {
      deliveries: {
        type: "array",
        items: {
          properties: { id: { type: "string" }, count: { type: "integer" } },
          if: { required: ["id"] },
          else: { required: ["name"] },
        },
      },
    };
    for (const truncated of [false, true])
      expect(
        preparePlanAmendment(task, properties, "物流改3条", 4, truncated)!
          .properties.deliveries.items.required,
      ).toEqual(["id"]);
  });
  it("preserves explicit false, unknown fields and future references for the actual validator", () => {
    const { task } = fixture(["物流"]);
    const input = {
      deliveries: [{ count: 3, remove: false, unknown: false }],
      steps: [{ action: "read_processing", input: {} }],
    };
    const bound = bindPlanProposal(input, task, "物流改3条", 4);
    expect(bound.deliveries[0].remove).toBe(false);
    expect(bound.deliveries[0].unknown).toBe(false);
    expect(bound.steps).toEqual(input.steps);
    expect(input.deliveries[0]).not.toHaveProperty("id");
  });
  it("returns all known blank, duplicate and capacity field problems without truncating values", () => {
    const { task, goals } = fixture(["物流"]);
    const input = {
      steps: [{ action: "submit_processing", input: { operation: "rewrite" } }],
      requirements: Array.from(
        { length: 20 },
        (_, i) => String(i).padStart(2, "0") + "a".repeat(998),
      ),
      deliveries: [
        { id: goals[0].id, instructions: " ", scenarios: ["场景", "场景"] },
      ],
    };
    const r = prepare(input, task, "修改要求");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok)
      expect(r.issues.map((x) => x.path)).toEqual([
        "/requirements",
        "/deliveries/0/instructions",
        "/deliveries/0/scenarios",
      ]);
    expect(input.requirements).toHaveLength(20);
  });
  it("keeps a full valid requirements list when the delivery has its own bounded instructions", () => {
    const { task, goals } = fixture(["物流"]);
    const r = prepare(
      {
        requirements: Array.from(
          { length: 20 },
          (_, i) => String(i).padStart(2, "0") + "a".repeat(998),
        ),
        deliveries: [{ id: goals[0].id, count: 3 }],
      },
      task,
      "物流改成3条",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requirements!.requirements).toHaveLength(20);
  });
  it("retains saved one-scene contracts on later quantity-only changes", () => {
    const goals = reviseDeliveryGoals(
      [],
      [{ ...goal("物流"), scenarios: ["查询进度"] }],
      "只用1个场景",
    );
    const task = {
      executionPlan: { contractVersion: 1, steps: generationSteps(goals) },
    };
    const r = prepare(
      { deliveries: [{ id: goals[0].id, count: 3 }] },
      task,
      "物流改成3条，场景保持",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goals![0].scenarios).toEqual(["查询进度"]);
  });
});

it("OPT46 completion does not turn a negated single-scene request into a limit", () => {
  const input = {
    deliveries: [
      { ...goal("新增"), scenarios: ["咨询进度", "异常情况", "信息不足"] },
    ],
  };
  const created = prepare(
    input,
    { requirements: [] },
    "做两条，不要只用1个场景",
  );
  expect(created.ok).toBe(true);
});

it("OPT46 completion never drops an out-of-range ordinal from the requested targets", () => {
  const { task } = fixture(["同名", "同名"]);
  const input = { deliveries: [{ count: 3 }] };
  const request = "第2份和第3份各改3条";
  expect(
    bindPlanProposal(input, task, request, 4).deliveries[0],
  ).not.toHaveProperty("id");
  expect(prepare(input, task, request)).toMatchObject({
    ok: false,
    question: expect.any(String),
  });
  expect(prepare(input, task, "这份改3条，其余全部不变")).toMatchObject({
    ok: false,
    question: expect.any(String),
  });
});
