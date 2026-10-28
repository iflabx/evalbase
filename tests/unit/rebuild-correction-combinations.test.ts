import { describe, it, expect } from "vitest";
import { sessionFeedback } from "../../src/assistant-rebuild/session-feedback.js";
import { sessionTools } from "../../src/assistant-rebuild/session-tools.js";
import { workspaceTools } from "../../src/assistant-rebuild/workspace-tools.js";
import { normalizeToolArguments } from "../../src/assistant-rebuild/tool-arguments.js";
import { AIMessage } from "@langchain/core/messages";
const source = {
  kind: "assets",
  assetIds: ["asset-a"],
  recordIds: ["record-1", "record-2", "record-3"],
};
const patch = {
  name: "  三条整理版  ",
  operation: "clean",
  count: 3,
  source,
  allowedFields: ["question"],
  instructions: "",
  saveTarget: { kind: "newDraft", name: "三条整理版" },
};
const base = () => ({
  expectedRevision: 0,
  changes: {
    mode: "plan",
    objective: "保留原目标",
    deliveries: [{ patch: structuredClone(patch) }],
  },
});
function rig(initialPending?: any) {
  const registry = sessionTools({} as any, {} as any, true),
    work = workspaceTools({} as any, {} as any, {} as any, {} as any, true, {
      processing: async () => {},
      confirmation: async () => {},
    });
  let saved = initialPending;
  const events: any[] = [];
  return {
    get saved() {
      return saved;
    },
    events,
    boundary: sessionFeedback({
      schemas: new Map([...registry.schemas, ...work.schemas]),
      readOnlyTools: new Set([
        ...(registry.readOnly ?? []),
        ...(work.readOnly ?? []),
      ]),
      initialPending,
      savePending: async (p) => {
        saved = p;
      },
      guard: async () => {},
      facts: async () => ({}),
      observe: async (kind, detail) => {
        events.push({ kind, detail });
      },
      callModel: (f) => f(),
    }),
  };
}
async function call(
  r: ReturnType<typeof rig>,
  name: string,
  args: any,
  handler = async (req: any) => req.toolCall.args,
) {
  return r.boundary.middleware.wrapToolCall!(
    { toolCall: { id: "call-" + r.events.length, name, args } } as any,
    handler as any,
  );
}
describe("R04 canonical correction combinations", () => {
  it("canonicalizes captured flat deliveries with encoded source and preserves every business value", () => {
    const registry = sessionTools({} as any, {} as any, true),
      flat = base() as any;
    flat.changes.deliveries = [{ ...patch, source: JSON.stringify(source) }];
    const result = normalizeToolArguments(
      registry.schemas.get("update_requirements")!,
      flat,
      "update_requirements",
    );
    expect(
      registry.schemas.get("update_requirements")!.parse(result.args),
    ).toEqual({
      ...base(),
      changes: {
        ...base().changes,
        deliveries: [{ patch: { ...patch, name: "三条整理版" } }],
      },
    });
  });
  it("refuses conflicting flat and wrapped values", async () => {
    const r = rig(),
      args = base() as any;
    args.changes.deliveries[0].count = 99;
    await expect(call(r, "update_requirements", args)).rejects.toMatchObject({
      code: "tool_argument_shape_conflict",
    });
  });
  it("repairs unknown fields while retaining omitted objective, source and save target", async () => {
    const r = rig(),
      args = { ...base(), steps: [] };
    await call(r, "update_requirements", args);
    const fixed = (await call(r, "update_requirements", {
      expectedRevision: 0,
      changes: { deliveries: [{ patch: { count: 3 } }] },
    })) as any;
    expect(fixed.changes.objective).toBe("保留原目标");
    expect(fixed.changes.deliveries[0].patch.source).toEqual(source);
    expect(fixed.changes.deliveries[0].patch.saveTarget).toEqual(
      patch.saveTarget,
    );
    expect(fixed).not.toHaveProperty("steps");
    expect(r.saved).toBeUndefined();
  });
  it.each(["count", "source", "saveTarget"])(
    "rejects explicit changes to protected %s during repair",
    async (field) => {
      const r = rig();
      await call(r, "update_requirements", { ...base(), steps: [] });
      const candidate = base() as any;
      candidate.changes.deliveries[0].patch[field] =
        field === "count"
          ? 4
          : field === "source"
            ? null
            : { kind: "newDraft", name: "其他目标" };
      await expect(
        call(r, "update_requirements", candidate),
      ).rejects.toMatchObject({ code: "correction_intent_changed" });
    },
  );
  it("does not overwrite omitted original paging with schema defaults during repair", async () => {
    const r = rig();
    await call(r, "read_records", { source, offset: 5, limit: 3, extra: true });
    expect(await call(r, "read_records", { source })).toEqual({
      source,
      offset: 5,
      limit: 3,
    });
  });
  it("canonicalizes a partial nested target using the retained discriminator", async () => {
    const r = rig();
    await call(r, "update_requirements", { ...base(), extra: true });
    const fixed = (await call(r, "update_requirements", {
      expectedRevision: 0,
      changes: {
        deliveries: [{ patch: { saveTarget: { name: "  三条整理版  " } } }],
      },
    })) as any;
    expect(fixed.changes.deliveries[0].patch.saveTarget).toEqual(
      patch.saveTarget,
    );
  });
  it("keeps submitted delivery identities without guessing new array positions", async () => {
    const first = base() as any;
    first.changes.deliveries = [
      { deliveryId: "a", patch: { count: 3 } },
      { deliveryId: "b", patch: { count: 2 } },
    ];
    const r = rig();
    await call(r, "update_requirements", { ...first, extra: true });
    const fixed = (await call(r, "update_requirements", {
      expectedRevision: 0,
      changes: { deliveries: [{ deliveryId: "b", patch: { count: 2 } }] },
    })) as any;
    expect(fixed.changes.deliveries).toEqual(first.changes.deliveries);
    const bad = rig();
    await call(bad, "update_requirements", { ...base(), extra: true });
    await expect(
      call(bad, "update_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [] },
      }),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
  });
  it("refuses a changed repair schema on restored state", async () => {
    const r = rig();
    await call(r, "read_records", { source, extra: true });
    const restored = rig({ ...r.saved, schemaHash: "not-the-current-schema" });
    await expect(
      call(restored, "read_records", { source }),
    ).rejects.toMatchObject({ code: "correction_contract_changed" });
  });
  it("keeps successful partial repairs as the working version across reload", async () => {
    const r = rig();
    await call(r, "read_records", { source, extraA: true, extraB: true });
    await call(r, "read_records", { source, extraB: true });
    expect(r.saved.workingArgs).not.toHaveProperty("extraA");
    expect(r.saved.workingArgs).toHaveProperty("extraB");
    const restored = rig(r.saved);
    const fixed = await call(restored, "read_records", { source });
    expect(fixed).toEqual({ source, offset: 0, limit: 20 });
  });
  it("checks exact integer text before any numeric rounding", () => {
    const registry = sessionTools({} as any, {} as any, true),
      schema = registry.schemas.get("read_records")!;
    for (const value of ["3.0000000000000000001", "10000.0000000000000001"]) {
      const normalized = normalizeToolArguments(schema, {
        source,
        limit: value,
      });
      expect((normalized.args as any).limit).toBe(value);
      expect(schema.safeParse(normalized.args).success).toBe(false);
    }
    for (const value of ["3", "3.0", "3e0", "30e-1"]) {
      expect(
        (normalizeToolArguments(schema, { source, limit: value }).args as any)
          .limit,
      ).toBe(3);
    }
  });
  it("rejects duplicate tool IDs before dispatching any invocation", async () => {
    const r = rig();
    await expect(
      (r.boundary.middleware.afterModel as any).hook(
        {
          messages: [
            new AIMessage({
              id: "duplicate-response",
              content: "",
              tool_calls: [
                { id: "same", name: "update_requirements", args: base() },
                { id: "same", name: "update_requirements", args: base() },
              ],
            }),
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "tool_call_identity_conflict" });
    expect(r.events.some((e) => e.kind === "tool_call")).toBe(false);
  });
  it("handles a truncated read-only progress call by declared capability", async () => {
    const r = rig({
      id: "old",
      name: "read_task_progress",
      args: null,
      paths: [],
      attempts: 1,
      unparsed: true,
    });
    expect(await call(r, "read_task_progress", {})).toEqual({});
  });
  it("preflights a multi-tool response before any handler can run", async () => {
    const r = rig();
    const decision = await (r.boundary.middleware.afterModel as any).hook(
      {
        messages: [
          new AIMessage({
            id: "ai-unique",
            content: "",
            tool_calls: [
              { id: "a", name: "read_project", args: {} },
              { id: "b", name: "list_sources", args: { kind: "assets" } },
            ],
          }),
        ],
      } as any,
      {} as any,
    );
    expect(decision?.jumpTo).toBe("model");
    expect(r.events.some((e) => e.kind === "tool_call")).toBe(false);
  });
  it("returns structured domain conflicts without forcing a parameter repair loop", async () => {
    const r = rig();
    await expect(
      call(r, "update_requirements", base(), async () => {
        throw {
          code: "assistant_plan_count_conflict",
          status: 422,
          hint: "配额合计4条，目标3条",
        };
      }),
    ).rejects.toMatchObject({
      code: "assistant_plan_count_conflict",
      hint: "配额合计4条，目标3条",
    });
    expect(r.saved).toMatchObject({
      kind: "requirements",
      blockedReason: "assistant_plan_count_conflict",
      args: expect.objectContaining({ expectedRevision: 0 }),
    });
    expect(r.events.some((e) => e.kind === "parameter_feedback")).toBe(false);
  });
});
