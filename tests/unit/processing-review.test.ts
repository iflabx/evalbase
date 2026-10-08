import { describe, expect, it } from "vitest";
import { reviewCandidates } from "../../src/processing/review.js";
import type { readProcessingRun } from "../../src/processing/store.js";

type Page = Awaited<ReturnType<typeof readProcessingRun>>;
const candidates = () =>
  ({
    run: {
      id: "run",
      status: "succeeded",
      inputCount: 3,
      options: {
        operation: "augment",
        outputCount: 3,
        allowedFields: ["question", "expectedOutput", "metadata"],
      },
    },
    total: 3,
    issues: [],
    records: ["A.1a", "A.1a", "A.2a"].map((value, i) => ({
      id: `0:${i}`,
      original: null,
      result: {
        question: `问题 ${i + 1}`,
        expectedOutput: "正常回答",
        metadata: [{ key: "风险类别", value }],
      },
    })),
  }) as unknown as Page;

describe("full candidate review", () => {
  it("accepts equivalent Metadata permission keys with different casing", () => {
    const data = candidates();
    data.run.options.metadataKeys = ["CATEGORY"];
    data.records.forEach((row) => {
      row.original = {
        ...row.result,
        id: row.id,
        metadata: [{ key: "Category", value: "old" }],
      };
      row.result.metadata = [{ key: "Category", value: "new" }];
    });
    const review = reviewCandidates(data, { metadataKeys: ["category"] });
    expect(review.protectedFieldChanges).toBe(0);
    expect(review.complete).toBe(true);
  });
  it("rechecks retained results against the newly protected fields and metadata keys", () => {
    const data = candidates();
    data.run.options.operation = "rewrite";
    data.records.forEach((row) => {
      row.original = {
        ...row.result,
        id: row.id,
        question: "原始问题",
        metadata: [],
      };
    });
    expect(reviewCandidates(data).protectedFieldChanges).toBe(0);
    const protectedQuestion = reviewCandidates(data, {
      allowedFields: ["metadata"],
    });
    expect(protectedQuestion.protectedFieldChanges).toBe(3);
    expect(protectedQuestion.complete).toBe(false);
    const protectedKeys = reviewCandidates(data, {
      allowedFields: ["question", "metadata"],
      metadataKeys: [],
    });
    expect(protectedKeys.protectedFieldChanges).toBe(3);
    expect(protectedKeys.complete).toBe(false);
  });
  it("reports a missing required category even when every present value is allowed", () => {
    const review = reviewCandidates(candidates(), {
      targetCount: 3,
      classifications: [
        {
          field: "metadata",
          key: "风险类别",
          allowedValues: ["A.1a", "A.2a", "A.3a"],
          requiredValues: ["A.1a", "A.2a", "A.3a"],
        },
      ],
    });
    expect(review.countSatisfied).toBe(true);
    expect(review.classifications[0]?.missingCategories).toEqual(["A.3a"]);
    expect(review.classifications[0]?.satisfied).toBe(false);
    expect(review.complete).toBe(false);
  });
  it("clears a final count goal while still checking actual run completeness", () => {
    const page = candidates();
    const base = {
      id: "base",
      question: "已有问题",
      expectedOutput: "正常回答",
      metadata: [],
    };
    const final = {
      records: [
        base,
        ...page.records.map((row) => ({ ...row.result, id: row.id })),
      ],
      baseCount: 1,
      remainingCount: 3,
      revision: 1,
    };
    const goal = { targetCount: null, countKind: "final" as const };
    const review = reviewCandidates(page, goal, [page], final);
    expect(review.expectedCount).toBeNull();
    expect(review.total).toBe(4);
    expect(review.countSatisfied).toBe(true);
    expect(review.complete).toBe(true);
    page.total = 2;
    page.records.pop();
    final.records.pop();
    expect(reviewCandidates(page, goal, [page], final).complete).toBe(false);
  });
  it("reports real metadata categories and failed quotas despite a satisfied total", () => {
    const review = reviewCandidates(candidates(), {
      targetCount: 3,
      classifications: [
        {
          field: "metadata",
          key: "风险类别",
          allowedValues: ["A.1a", "A.2a"],
          quotas: [
            { value: "A.1a", count: 1 },
            { value: "A.2a", count: 2 },
          ],
        },
      ],
    });
    expect(review.countSatisfied).toBe(true);
    expect(review.classifications).toEqual([
      {
        field: "metadata",
        key: "风险类别",
        missing: 0,
        outsideValues: 0,
        values: [
          { value: "A.1a", count: 2 },
          { value: "A.2a", count: 1 },
        ],
        additionalValues: 0,
        quotaDifferences: [
          { value: "A.1a", expected: 1, actual: 2 },
          { value: "A.2a", expected: 2, actual: 1 },
        ],
        satisfied: false,
      },
    ]);
    expect(review.complete).toBe(false);
    expect(review.semanticReview).toBe("required");
  });

  it("does not call empty or duplicate candidates complete", () => {
    const page = candidates();
    page.records[1]!.result = structuredClone(page.records[0]!.result);
    page.records[2]!.result.question = " ";
    const review = reviewCandidates(page);
    expect(review.duplicates).toBe(1);
    expect(review.emptyQuestions).toBe(1);
    expect(review.complete).toBe(false);
  });

  it("counts absent, ambiguous and invalid metadata values without inventing a category", () => {
    const page = candidates();
    page.records[0]!.result.metadata = [];
    page.records[1]!.result.metadata = [
      { key: "风险类别", value: "A.1a" },
      { key: "风险类别", value: "A.2a" },
    ];
    page.records[2]!.result.metadata = [{ key: "风险类别", value: "invalid" }];
    const review = reviewCandidates(page, {
      classifications: [
        { field: "metadata", key: "风险类别", allowedValues: ["A.1a", "A.2a"] },
      ],
    });
    expect(review.classifications[0]).toMatchObject({
      missing: 2,
      outsideValues: 1,
      satisfied: false,
    });
    expect(review.complete).toBe(false);
  });

  it("accepts matching expected-output quotas without claiming semantic approval", () => {
    const review = reviewCandidates(candidates(), {
      classifications: [
        { field: "expectedOutput", quotas: [{ value: "正常回答", count: 3 }] },
      ],
    });
    expect(review.classifications[0]?.satisfied).toBe(true);
    expect(review.complete).toBe(true);
    expect(review.semanticReview).toBe("required");
  });

  it("counts arbitrary expected-output labels as data", () => {
    const page = candidates();
    page.records.forEach((row) => {
      row.result.expectedOutput = "__proto__";
    });
    expect(reviewCandidates(page).labels).toEqual([
      { label: "__proto__", count: 3 },
    ]);
  });
});
