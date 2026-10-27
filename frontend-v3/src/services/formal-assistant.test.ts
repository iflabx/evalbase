import { describe, it, expect } from "vitest";
import {
  submission,
  acceptedDraft,
  openTab,
  visibleMessages,
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
