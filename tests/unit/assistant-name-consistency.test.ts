import { describe, expect, it } from "vitest";
import {
  deliveryProgress,
  readWorkspaceFacts,
  type WorkspaceFacts,
} from "../../src/assistant/workspace.js";
import { progressMessage } from "../../src/assistant/feedback.js";
import { taskPresentation } from "../../src/assistant/store.js";
import { currentTaskFacts } from "../../src/assistant/context.js";
const task = () => ({
  stage: "complete",
  title: "原会话名称",
  goal: "两份交付",
  target: null,
  targetName: "已取消交付",
  runId: "cancelled-run",
  targetDraftId: "cancelled-draft",
  executionPlan: {
    contractVersion: 1,
    mode: "execute",
    current: 3,
    steps: [
      {
        action: "generate_candidates",
        deliveryId: "one",
        status: "executed",
        input: { name: "原目标", outputCount: 2 },
        receipt: { runId: "run", draftId: "original" },
      },
      { action: "read_processing", deliveryId: "one", status: "executed" },
      {
        action: "request_processing_apply",
        deliveryId: "one",
        status: "executed",
        input: { target: { kind: "newDraft", name: "另存名称" } },
        receipt: { proposalId: "save", draftId: "saved", runId: "run" },
      },
    ],
  },
});
const facts = (): WorkspaceFacts => ({
  projectId: "p",
  runs: [{ id: "run", status: "succeeded", count: 2 }],
  drafts: [
    { id: "original", name: "原目标", count: 0 },
    { id: "saved", name: "实际保存名", count: 2 },
  ],
  confirmations: [
    {
      id: "save",
      runId: "run",
      status: "succeeded",
      receipt: { receipt: { draftId: "saved", adopted: 2 } },
    },
  ],
});
describe("current names and authoritative object links", () => {
  it("collects the existing save destination even with an older receipt draft", async () => {
    const t = task();
    t.executionPlan.steps[2].input = {
      target: { kind: "draft", id: "destination" },
    } as any;
    const calls: { sql: string; values: any[] }[] = [];
    const db = {
      query: async (sql: string, values: any[]) => {
        calls.push({ sql, values });
        return {
          rows: sql.includes("FROM collaborative_draft d")
            ? [{ id: "destination", name: "已有草稿", count: 0 }]
            : [],
        };
      },
    };
    const f = await readWorkspaceFacts(
      db as any,
      { projectId: "p", actorId: "owner" },
      { id: "s", task: t },
    );
    const draftQuery = calls.find((c) =>
      c.sql.includes("FROM collaborative_draft d"),
    )!;
    expect(draftQuery.values).toEqual([
      "p",
      expect.arrayContaining(["original", "saved", "destination"]),
    ]);
    expect(draftQuery.sql).toContain("d.name");
    expect(f!.drafts[0].name).toBe("已有草稿");
  });
  it("uses the saved draft name and id without rewriting the original goal", () => {
    const t = task(),
      before = structuredClone(t);
    expect(deliveryProgress(t, facts())![0]).toMatchObject({
      name: "原目标",
      savedCount: 2,
      draft: {
        id: "saved",
        name: "实际保存名",
        url: "/projects/p/test-sets/drafts/saved",
      },
    });
    expect(t).toEqual(before);
  });
  it("removes the cancelled current-object label while retaining historical run and session title", () => {
    const t = task(),
      before = structuredClone(t);
    const p = taskPresentation(t, undefined, facts())!;
    expect(p.targetName).toBeUndefined();
    expect(p.currentDeliveryName).toBe("原目标");
    expect(p.candidateHistory).toBe(true);
    expect(p.runId).toBe("cancelled-run");
    expect(p.title).toBe("原会话名称");
    expect(currentTaskFacts(t).targetName).toBeUndefined();
    expect(t).toEqual(before);
  });
  it("does not call a retained delivery run historical", () => {
    const t = { ...task(), runId: "run" };
    expect(taskPresentation(t)!.candidateHistory).toBe(false);
  });
  it("shows pending save-as name without inventing a created draft link", () => {
    const f = facts();
    f.confirmations = [
      {
        id: "save",
        runId: "run",
        status: "pending",
        target: { kind: "newDraft", name: "待另存" },
      },
    ];
    const t = task();
    t.executionPlan.steps[2].receipt = { proposalId: "save" } as any;
    const d = deliveryProgress(t, f)![0];
    expect(d.pendingSaveName).toBe("待另存");
    expect(d.savedCount).toBe(0);
    expect(d.draft?.id).toBe("original");
  });
  it.each(["failed", "rejected", "invalid", "expired"])(
    "does not present %s save-as as current destination",
    (status) => {
      const f = facts();
      f.confirmations = [
        {
          id: "save",
          runId: "run",
          status,
          target: { kind: "newDraft", name: "失效名称" },
        },
      ];
      expect(deliveryProgress(task(), f)![0].pendingSaveName).toBeUndefined();
    },
  );
  it("uses an existing destination current name instead of a proposal snapshot", () => {
    const f = facts();
    f.confirmations = [
      {
        id: "save",
        runId: "run",
        status: "pending",
        target: { kind: "draft", id: "saved", name: "旧名字" },
      },
    ];
    expect(deliveryProgress(task(), f)![0].pendingSaveName).toBe("实际保存名");
  });
  it("uses actual save destination in progress feedback", () => {
    expect(progressMessage(task(), facts())).toContain("已保存至实际保存名");
  });
  it("does not attach another draft name or link to an unavailable saved object", () => {
    const f = facts();
    f.drafts = f.drafts.filter((d) => d.id !== "saved");
    const d = deliveryProgress(task(), f)![0];
    expect(d.draft).toBeUndefined();
    expect(d.savedCount).toBe(2);
  });
  it("does not borrow a different delivery save receipt", () => {
    const f = facts();
    f.confirmations = [
      {
        id: "other",
        runId: "other-run",
        status: "succeeded",
        receipt: { receipt: { draftId: "saved", adopted: 2 } },
      },
    ];
    expect(deliveryProgress(task(), f)![0].savedCount).toBe(0);
  });
});
