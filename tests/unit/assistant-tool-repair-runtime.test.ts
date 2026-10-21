import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { generateText, InvalidToolInputError, jsonSchema, tool } from "ai";
import { argumentRepair } from "../../src/assistant/tool-repair.js";

vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));

const schema = {
  type: "object",
  properties: {
    executionMode: { enum: ["plan"] },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { enum: ["generate_candidates"] },
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              outputCount: { type: "integer" },
            },
            required: ["name", "outputCount"],
          },
        },
        required: ["action", "input"],
      },
    },
  },
  additionalProperties: false,
  required: ["executionMode", "steps"],
};
const plan = () => ({
  executionMode: "plan",
  steps: Array.from({ length: 8 }, (_, i) => ({
    action: "generate_candidates",
    input: { name: `第${i + 1}类`, outputCount: 50 },
  })),
});

function setup(
  original: unknown,
  signal?: AbortSignal,
  contextual: Partial<Parameters<typeof argumentRepair>[0]> = {},
) {
  vi.mocked(generateText).mockReset();
  const validate = new Ajv({ strict: false }).compile(schema);
  const check = vi.fn(async () => true);
  const reserve = vi.fn(async () => true);
  const observed = vi.fn();
  const started = vi.fn();
  const repair = argumentRepair({
    model: {} as any,
    check,
    reserve,
    observed,
    started,
    ...contextual,
  } as any);
  const inputSchema = jsonSchema(schema as any, {
    validate: async (value) =>
      validate(value)
        ? { success: true, value }
        : { success: false, error: new Error("invalid plan") },
  });
  const input = JSON.stringify(original);
  const request = {
    toolCall: {
      type: "tool-call",
      toolName: "plan_task",
      toolCallId: "original-call",
      input,
    },
    tools: { plan_task: tool({ inputSchema }) },
    inputSchema: async () => schema,
    error: new InvalidToolInputError({
      toolName: "plan_task",
      toolInput: input,
      cause: new Error("invalid plan"),
    }),
    messages: [],
    abortSignal: signal,
  };
  return { repair, request, observed, started, check, reserve };
}

describe("parameter repair execution boundary", () => {
  it("returns malformed input to the contextual planner without guessing its business fields", async () => {
    const fixture = setup(plan());
    fixture.request.toolCall.input = '{"steps":';
    expect(await fixture.repair(fixture.request as any)).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.observed).toHaveBeenCalledWith(
      "plan_task",
      "context_required",
    );
    expect(fixture.started).toHaveBeenCalledWith("plan_task", {
      scope: "call",
      issues: [{ path: "/", keyword: "parse" }],
    });
  });
  it.each(["required", "additionalProperties"])(
    "records the field path for %s without recording values",
    async (keyword) => {
      const invalid = plan() as any;
      if (keyword === "required") delete invalid.steps[3].input.name;
      else
        invalid.steps[3].input.privateField =
          "private value must not be recorded";
      const controller = new AbortController();
      const fixture = setup(invalid, controller.signal);
      vi.mocked(generateText).mockImplementation(async () => {
        controller.abort(new DOMException("deadline", "TimeoutError"));
        throw controller.signal.reason;
      });
      if (["required", "additionalProperties"].includes(keyword)) {
        expect(await fixture.repair(fixture.request as any)).toBeNull();
        expect(generateText).not.toHaveBeenCalled();
        expect(fixture.reserve).not.toHaveBeenCalled();
        expect(fixture.observed).toHaveBeenCalledWith(
          "plan_task",
          "context_required",
        );
      } else {
        await expect(
          fixture.repair(fixture.request as any),
        ).rejects.toMatchObject({ name: "TimeoutError" });
      }
      expect(fixture.started).toHaveBeenCalledWith(
        "plan_task",
        expect.objectContaining({
          issues: expect.arrayContaining([
            {
              path:
                "/steps/3/input/" +
                (keyword === "required" ? "name" : "privateField"),
              keyword,
            },
          ]),
        }),
      );
      expect(JSON.stringify(fixture.started.mock.calls)).not.toContain(
        "private value",
      );
    },
  );

  it("accepts lossless normalization without a model request and preserves all eight deliveries", async () => {
    const valid = plan();
    const fixture = setup({ ...valid, steps: JSON.stringify(valid.steps) });
    const result = await fixture.repair(fixture.request as any);
    expect(JSON.parse(result!.input)).toEqual(valid);
    expect(generateText).not.toHaveBeenCalled();
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.observed).toHaveBeenCalledWith("plan_task", "repaired");
  });

  it("rechecks access before returning a locally normalized call", async () => {
    const valid = plan();
    const fixture = setup({ ...valid, steps: JSON.stringify(valid.steps) });
    fixture.check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await fixture.repair(fixture.request as any)).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("records a repair timeout before throwing and exposes only safe validation metadata", async () => {
    const invalid = plan() as any;
    invalid.steps[3].input.name = ["甲", "乙"];
    const controller = new AbortController();
    const fixture = setup(invalid, controller.signal);
    vi.mocked(generateText).mockImplementation(async () => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      throw controller.signal.reason;
    });
    await expect(fixture.repair(fixture.request as any)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fixture.observed).toHaveBeenCalledWith("plan_task", "interrupted");
    expect(fixture.started).toHaveBeenCalledWith(
      "plan_task",
      expect.objectContaining({
        scope: "step",
        stepIndex: 3,
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "/steps/3/input/name",
            keyword: "type",
          }),
        ]),
      }),
    );
    expect(JSON.stringify(fixture.started.mock.calls)).not.toContain("甲");
  });

  it("sends only the invalid step to the repair model and rejects semantic changes", async () => {
    const invalid = plan() as any;
    invalid.steps[3].input.name = ["甲", "乙"];
    const fixture = setup(invalid);
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [
        {
          toolName: "plan_task",
          input: {
            steps: [
              {
                action: "generate_candidates",
                input: { name: "甲", outputCount: 51 },
              },
            ],
          },
        },
      ],
    } as any);
    expect(await fixture.repair(fixture.request as any)).toBeNull();
    expect(generateText).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(generateText).mock.calls) {
      const prompt = JSON.parse(String(request.prompt));
      expect(prompt.normalizedInput.steps).toHaveLength(1);
      expect(prompt.normalizedInput.executionMode).toBeUndefined();
      expect(String(request.prompt)).not.toContain("第1类");
      expect(String(request.prompt)).not.toContain("第8类");
    }
  });
  it("OPT43 contextual correction changes one invalid delivery and preserves the other seven", async () => {
    const deliverySchema = {
      type: "object",
      properties: {
        deliveries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              count: { type: "integer" },
              scenarios: {
                type: "array",
                minItems: 3,
                items: { type: "string" },
              },
            },
            required: ["id", "count"],
            additionalProperties: false,
          },
        },
      },
      required: ["deliveries"],
      additionalProperties: false,
    };
    const original = {
      deliveries: Array.from({ length: 8 }, (_, i) => ({
        id: "delivery-" + i,
        count: 50,
        scenarios: ["场景一", "场景二", "场景三"],
      })),
    };
    original.deliveries[3].scenarios = ["场景一", "场景二"];
    const context = vi.fn(async () => ({
      savedScenarios: ["场景一", "场景二", "场景三"],
    }));
    const fixture = setup(original, undefined, {
      context,
      accept: async () => true,
    });
    const validate = new Ajv({ strict: false }).compile(deliverySchema);
    fixture.request.inputSchema = async () => deliverySchema as any;
    fixture.request.tools.plan_task = tool({
      inputSchema: jsonSchema(deliverySchema as any, {
        validate: async (value) =>
          validate(value)
            ? { success: true, value }
            : { success: false, error: new Error("invalid") },
      }),
    });
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [
        {
          toolName: "plan_task",
          input: { deliveries: [{ id: "delivery-3", count: 50 }] },
        },
      ],
    } as any);
    const fixed = await fixture.repair(fixture.request as any);
    expect(JSON.parse(fixed!.input)).toEqual({
      deliveries: original.deliveries.map((g, i) =>
        i === 3 ? { id: "delivery-3", count: 50 } : g,
      ),
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(
      String(vi.mocked(generateText).mock.calls[0][0].prompt),
    );
    expect(prompt.repairClass).toBe("context");
    expect(prompt.original.deliveries).toHaveLength(1);
    expect(prompt.original.deliveries[0].id).toBe("delivery-3");
    expect(fixture.reserve).toHaveBeenCalledWith("plan_task", "context");
    expect(fixture.started).toHaveBeenCalledWith(
      "plan_task",
      expect.objectContaining({ scope: "delivery", deliveryIndex: 3 }),
    );
  });
  it("OPT43 gives unparsable input one compact correction and never executes it", async () => {
    const fixture = setup(plan(), undefined, {
      context: async () => ({ request: "保存八类各50条方案，不执行" }),
      accept: async () => true,
    });
    fixture.request.toolCall.input = '{"steps":';
    vi.mocked(generateText).mockResolvedValue({
      toolCalls: [{ toolName: "plan_task", input: plan() }],
    } as any);
    const fixed = await fixture.repair(fixture.request as any);
    expect(JSON.parse(fixed!.input)).toEqual(plan());
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(fixture.reserve).toHaveBeenCalledWith("plan_task", "truncated");
  });
});
