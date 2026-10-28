import { describe, it, expect } from "vitest";
import {
  submission,
  acceptedDraft,
  openTab,
  visibleMessages,
  mergeMessages,
  mergeSnapshot,
  type Snapshot,
} from "./formal-assistant";
describe("formal assistant state boundaries", () => {
  it("an uncertain retry retains the same id, revision, source revision and body", () => {
    const e = submission(
      7,
      "整理前三条",
      ["attachment_1"],
      { kind: "assets", assetIds: ["asset_1"], recordIds: ["1", "2", "3"] },
      "a".repeat(64),
    );
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    expect(e.contextRevision).toBe("a".repeat(64));
  });
  it("a late acceptance never erases more recent input", () => {
    const e = submission(1, "旧输入", []);
    expect(acceptedDraft("下一条新输入", e)).toBe("下一条新输入");
    expect(acceptedDraft("旧输入", e)).toBe("");
  });
  it("opening an existing result updates one tab instead of duplicating it", () => {
    const first = { id: "draft_1", kind: "draft" as const, name: "旧名称" };
    const tabs = openTab([first], { ...first, name: "新名称" });
    expect(tabs).toEqual([{ ...first, name: "新名称" }]);
    expect(openTab(tabs, { id: "attachment_1", kind: "document", name: "说明.md" })).toHaveLength(
      2,
    );
  });
  it("keeps one stable assistant identity across reconnect and final persistence", () => {
    const partial = {
      messages: [],
      workspace: { streams: [{ id: "request1", turnId: "turn1", text: "正在读取" }] },
    } as unknown as Snapshot;
    const before = visibleMessages(partial);
    const done = {
      ...partial,
      messages: [{ id: "51", turn_id: "turn1", role: "assistant" as const, content: "读取完成" }],
    };
    const after = visibleMessages(done);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.content).toBe("读取完成");
  });
});

describe("BATCH1 long history", () => {
  const msg = (id: number | string, role: "user" | "assistant" = "user") => ({
    id: String(id),
    turn_id: "t" + id,
    role,
    content: "message" + id,
  });
  it("retains the middle row as the latest 100 window slides, including loaded history", () => {
    const old = {
      session: { id: "s" },
      messages: Array.from({ length: 200 }, (_, i) => msg(i + 1)),
    } as Snapshot;
    const next = { ...old, messages: Array.from({ length: 100 }, (_, i) => msg(i + 102)) };
    const merged = mergeSnapshot(old, next);
    expect(merged.messages).toHaveLength(201);
    expect(merged.messages[100]!.id).toBe("101");
    expect(mergeSnapshot(merged, next).messages).toEqual(merged.messages);
  });
  it("preserves precision, ordering, late history, session boundaries and final stream replacement", () => {
    expect(
      mergeMessages([msg("9007199254740993")], [msg("9007199254740992")]).map((m) => m.id),
    ).toEqual(["9007199254740992", "9007199254740993"]);
    const snapshot = {
      session: { id: "s" },
      messages: [msg(2)],
      workspace: { streams: [{ turnId: "t1", text: "old" }] },
    } as Snapshot;
    const loaded = mergeSnapshot(snapshot, { ...snapshot, messages: [msg(1, "assistant")] });
    expect(visibleMessages(loaded)).toHaveLength(2);
    expect(visibleMessages(loaded)[0]!.content).toBe("message1");
    expect(
      mergeSnapshot(loaded, { ...snapshot, session: { ...snapshot.session, id: "other" } })
        .messages,
    ).toHaveLength(1);
  });
});
