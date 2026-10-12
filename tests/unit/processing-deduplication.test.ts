import { describe, expect, it } from "vitest";
import { contentKey, deduplicate } from "../../src/processing/deduplication.js";
import { processingReviewPage } from "../../src/processing/presentation.js";

const a = {
  id: "0:0",
  question: "Q",
  expectedOutput: "A",
  metadata: [
    { key: "b", value: "" },
    { key: "a", value: "1" },
  ],
};
describe("exact processing content", () => {
  it("ignores identity and metadata order, preserving values and punctuation", () => {
    expect(contentKey(a)).toBe(
      contentKey({ ...a, metadata: [...a.metadata].reverse() }),
    );
    expect(contentKey(a)).not.toBe(contentKey({ ...a, question: "q" }));
    expect(contentKey(a)).not.toBe(
      contentKey({ ...a, metadata: [{ key: "a", value: "1" }] }),
    );
  });
  it("keeps the first full-scope record and distinguishes question collisions", () => {
    const rows = [
      a,
      { ...a, id: "1:0" },
      { ...a, id: "2:0", expectedOutput: "B" },
    ];
    expect(deduplicate(rows)).toEqual({
      keptIds: ["0:0", "2:0"],
      excludedIds: ["1:0"],
      duplicateIds: ["0:0", "1:0"],
      questionCollisionIds: ["0:0", "1:0", "2:0"],
    });
  });
  it("gives known existing content priority without treating changed output as duplicate", () => {
    expect(
      deduplicate([a, { ...a, id: "1:0", expectedOutput: "B" }], [a]),
    ).toMatchObject({ keptIds: ["1:0"], excludedIds: ["0:0"] });
  });
  it("keeps the full-task usable count stable when searching hides a duplicate pair", () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `0:${i}`,
      result: {
        expectedOutput: a.expectedOutput,
        metadata: a.metadata,
        question: i === 99 ? "Q0" : `Q${i}`,
      },
    }));
    const data = {
      run: { options: { operation: "augment", outputCount: 100 } },
      records,
      issues: [],
    } as unknown as Parameters<typeof processingReviewPage>[0];
    const all = processingReviewPage(data, { view: "all" }),
      searched = processingReviewPage(data, { view: "all", search: "Q50" });
    expect(all.usableCount).toBe(99);
    expect(all.stats.duplicates).toBe(2);
    expect(searched.usableCount).toBe(99);
    expect(searched.stats.duplicates).toBe(0);
    expect(searched.total).toBe(1);
  });
});
