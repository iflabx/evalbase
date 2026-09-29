import { describe, expect, it } from "vitest";
import { mergeRecordSnapshot } from "./merge-draft";
import type { SharedDraftRecord } from "./drafts";
const row = (input: Partial<SharedDraftRecord> = {}): SharedDraftRecord => ({
  id: "row",
  position: 1,
  caseId: null,
  beforeRevisionId: null,
  question: "原问题",
  expectedOutput: "原输出",
  metadata: [{ key: "a", value: "1" }],
  source: null,
  sourceFileName: null,
  rowRevision: 0,
  questionRevision: 0,
  expectedOutputRevision: 0,
  metadataRevision: 0,
  sourceRevision: 0,
  fieldAttribution: {},
  updatedBy: "admin",
  updatedByName: "管理员",
  updatedAt: "2026-09-29T00:00:00Z",
  ...input,
});
describe("mergeRecordSnapshot", () => {
  it("merges different fields without losing local input", () => {
    const result = mergeRecordSnapshot(
      row(),
      { question: "我的问题", expectedOutput: "原输出", metadata: [{ key: "a", value: "1" }] },
      row({ expectedOutput: "对方输出", expectedOutputRevision: 1 }),
    );
    expect(result.edit).toMatchObject({ question: "我的问题", expectedOutput: "对方输出" });
    expect(result.conflicts).toEqual({});
  });
  it("keeps every conflicting local field and shows each remote value", () => {
    const result = mergeRecordSnapshot(
      row(),
      { question: "我的问题", expectedOutput: "原输出", metadata: [{ key: "a", value: "本地" }] },
      row({
        question: "对方问题",
        questionRevision: 1,
        metadata: [{ key: "a", value: "远端" }],
        metadataRevision: 1,
      }),
    );
    expect(result.edit.question).toBe("我的问题");
    expect(result.edit.metadata).toEqual([{ key: "a", value: "本地" }]);
    expect(Object.keys(result.conflicts)).toEqual(["question", "metadata"]);
    expect(result.conflicts.metadata?.remote).toEqual([{ key: "a", value: "远端" }]);
  });
});
