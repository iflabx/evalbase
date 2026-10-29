import { describe, it, expect } from "vitest";
import { z } from "zod";
import { normalizeToolArguments } from "../../src/assistant-rebuild/tool-arguments.js";
import { sourceSchema } from "../../src/assistant-rebuild/session-contract.js";
import { sessionFeedback } from "../../src/assistant-rebuild/session-feedback.js";
const schema = z
  .object({
    source: sourceSchema,
    limit: z.number().int(),
    text: z.string().optional(),
  })
  .strict();
const source = { kind: "assets", assetIds: ["asset-a"] };
describe("formal argument representation boundary", () => {
  it("decodes declared structures and preserves literal text, malformed and oversized values", () => {
    const args = {
      source: JSON.stringify(source),
      limit: 3,
      text: '{"literal":true}',
    };
    expect(normalizeToolArguments(schema, args)).toEqual({
      args: { ...args, source },
      paths: [["source"]],
    });
    for (const value of [
      "{",
      "null",
      '"text"',
      " ".repeat(65536) + JSON.stringify(source),
    ])
      expect(
        normalizeToolArguments(schema, { source: value, limit: 3 }).paths,
      ).toEqual([]);
    const arrays = z.object({ ids: z.array(z.string()) });
    expect(normalizeToolArguments(arrays, { ids: '["a","b"]' }).args).toEqual({
      ids: ["a", "b"],
    });
  });
  it("recovers persisted encoded arguments, ignores key order and rejects added record scope", async () => {
    const pending = {
      id: "original",
      name: "read_records",
      args: { source: JSON.stringify(source), limit: 3 },
      paths: [["source"]],
      attempts: 1,
    };
    const observed: any[] = [];
    const create = () =>
      sessionFeedback({
        schemas: new Map([["read_records", schema]]),
        initialPending: pending,
        guard: async () => {},
        facts: async () => ({}),
        observe: async (kind, detail) => {
          observed.push({ kind, detail });
        },
        callModel: (fn) => fn(),
      });
    let executed = 0;
    await create().middleware.wrapToolCall!(
      {
        toolCall: {
          id: "fixed",
          name: "read_records",
          args: { source: { assetIds: ["asset-a"], kind: "assets" }, limit: 3 },
        },
      } as any,
      async () => {
        executed++;
        return {} as any;
      },
    );
    expect(executed).toBe(1);
    await expect(
      create().middleware.wrapToolCall!(
        {
          toolCall: {
            id: "changed",
            name: "read_records",
            args: { source: { ...source, recordIds: ["asset-a"] }, limit: 3 },
          },
        } as any,
        async () => {
          executed++;
          return {} as any;
        },
      ),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect(executed).toBe(1);
    expect(
      observed.find((e) => e.kind === "correction_rejected").detail.reason,
    ).toBe("protected_arguments_changed");
  });
});

it("keeps discriminator branch defaults confined to the selected save target", () => {
  const schema = z.object({
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("newDraft"),
          name: z.string(),
          purpose: z.string().default(""),
        })
        .strict(),
      z
        .object({
          kind: z.literal("draft"),
          id: z.string(),
          expectedRevision: z.number().int(),
        })
        .strict(),
      z.object({ kind: z.literal("asset") }).strict(),
    ]),
  });
  for (const target of [
    { kind: "draft", id: "draft1", expectedRevision: 2 },
    { kind: "asset" },
  ]) {
    const normalized = normalizeToolArguments(schema, { target });
    expect(normalized.args).toEqual({ target });
    expect(schema.safeParse(normalized.args).success).toBe(true);
  }
  expect(
    normalizeToolArguments(schema, {
      target: { kind: "newDraft", name: "new" },
    }).args,
  ).toEqual({ target: { kind: "newDraft", name: "new", purpose: "" } });
});
