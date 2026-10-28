import { it, expect } from "vitest";
import {
  normalizeToolArguments,
  mergeToolCorrection,
} from "../../src/assistant-rebuild/tool-arguments.js";
import { sessionTools } from "../../src/assistant-rebuild/session-tools.js";
import { sessionFeedback } from "../../src/assistant-rebuild/session-feedback.js";
const schema = sessionTools({} as any, {} as any, true).schemas.get(
  "create_requirements",
)!;
const changes = {
  mode: "plan",
  objective: "保留目标",
  deliveries: [
    {
      patch: {
        name: "三条",
        count: 3,
        operation: "rewrite",
        allowedFields: ["question"],
        instructions: "自然表达",
        saveTarget: { kind: "newDraft", name: "三条" },
      },
    },
  ],
};
it("NESTED recovers a missing root closure without changing text", () => {
  expect(
    normalizeToolArguments(
      schema,
      { expectedRevision: 0, changes: JSON.stringify(changes).slice(0, -1) },
      "create_requirements",
    ).args,
  ).toMatchObject({ changes });
});
it.each([
  "{",
  '{"mode":',
  '{"mode":"pla',
  '{"mode":true',
  '{"count":12',
  '{"mode":"plan",',
  '{"mode":]',
])("NESTED does not guess incomplete values %s", (value) => {
  expect(
    (
      normalizeToolArguments(
        schema,
        { expectedRevision: 0, changes: value },
        "create_requirements",
      ).args as any
    ).changes,
  ).toBe(value);
});
it.each([false, true])(
  "NESTED persisted correction retains missing objective and rejects scope change %s",
  async (change) => {
    const args = {
      expectedRevision: 0,
      changes: JSON.stringify(changes).slice(0, -1),
    };
    const f = sessionFeedback({
      schemas: new Map([["create_requirements", schema]]),
      initialPending: {
        id: "original",
        name: "create_requirements",
        args,
        workingArgs: args,
        paths: [["changes"]],
        attempts: 1,
      },
      guard: async () => {},
      facts: async () => ({}),
      observe: async () => {},
      callModel: (fn) => fn(),
    });
    let executed: any = null;
    const candidate = {
      expectedRevision: 0,
      changes: {
        mode: "plan",
        deliveries: [
          { patch: { ...changes.deliveries[0].patch, count: change ? 4 : 3 } },
        ],
      },
    };
    const promise = f.middleware.wrapToolCall!(
      {
        toolCall: { id: "fixed", name: "create_requirements", args: candidate },
      } as any,
      async (r: any) => {
        executed = r.toolCall.args;
        return {} as any;
      },
    );
    if (change) {
      await expect(promise).rejects.toMatchObject({
        code: "correction_intent_changed",
      });
      expect(executed).toBeNull();
    } else {
      await promise;
      expect(executed.changes.objective).toBe("保留目标");
    }
  },
);

it("NESTED preserves literal instruction text", () => {
  const input = {
    expectedRevision: 0,
    changes: {
      objective: "{待替换}",
      deliveries: [{ patch: { instructions: "[格式] 保留原意" } }],
    },
  };
  const n = normalizeToolArguments(schema, input, "create_requirements");
  expect(n.unrecoverablePaths).toBeUndefined();
  expect(n.args).toMatchObject(input);
});

it.each(['{"objective":"goal"', '{"deliveries":[]', '{"changes":{}'])(
  "NESTED root closure variants %s",
  (text) => {
    const n = normalizeToolArguments(
      schema,
      { expectedRevision: 0, changes: text },
      "create_requirements",
    );
    expect(n.unrecoverablePaths).toBeUndefined();
    expect(typeof (n.args as any).changes).toBe("object");
  },
);
it("NESTED rejects oversized structured strings without guessing", () => {
  const n = normalizeToolArguments(
    schema,
    { expectedRevision: 0, changes: " ".repeat(65537) + "{}" },
    "create_requirements",
  );
  expect(n.unrecoverablePaths).toEqual([["changes"]]);
});
