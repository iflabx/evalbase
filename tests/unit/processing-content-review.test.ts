import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
import {
  contentHash,
  reviewRulesHash,
  reviewBackgroundHash,
  retainedContentVerdict,
  applyContentReview as checkContent,
  contentVerdict,
  contentReviewPrompt,
} from "../../src/processing/content-review.js";
import { processingRecovery } from "../../src/processing/recovery.js";
import type {
  ProcessingOptions,
  ProcessingOutput,
} from "../../src/processing/protocol.js";

function applyContentReview(...args: Parameters<typeof checkContent>) {
  const value = args[0] as { reviews?: Record<string, unknown>[] };
  args[0] = {
    ...value,
    reviews: value.reviews?.map((item) => ({
      ...item,
      checks: {
        question: item.verdict,
        category: item.verdict,
        expectedBehavior: item.verdict,
        facts: item.verdict,
      },
    })),
  };
  return checkContent(...args);
}
const options: ProcessingOptions = {
  operation: "rewrite",
  instructions: "保留事实，改成自然问法",
  allowedFields: ["question"],
};
const rows: ProcessingOutput[] = ["a", "b", "c"].map((sourceId) => ({
  sourceId,
  question: `原问题${sourceId}`,
  expectedOutput: "标签",
  metadata: [{ key: "intent", value: "查询" }],
}));
const rules = reviewRulesHash(options, undefined);
const state = () => ({
  version: 1 as const,
  rulesHash: rules,
  initialAttempted: true as const,
  items: [],
});
describe("OPT-31 bounded content review", () => {
  it("does not reuse a pass from the earlier topic-anchored review policy", () => {
    const oldPolicy = {
      ...state(),
      rulesHash: sha256(canonicalJson({ options, background: null })),
      items: [
        {
          sourceId: "a",
          contentHash: contentHash(rows[0]!),
          verdict: "conforms" as const,
          reason: "旧策略未发现问题",
        },
      ],
    };
    expect(contentVerdict(rows[0]!, oldPolicy, rules).verdict).toBe("pending");
  });
  it("rejects array-wrapped check statuses instead of coercing a hidden failure into a pass", () => {
    const result = checkContent(
      {
        reviews: [
          {
            id: "a",
            checks: {
              question: ["conforms"],
              category: ["nonconforms"],
              expectedBehavior: ["conforms"],
              facts: ["conforms"],
            },
            reason: "非法检查类型",
          },
        ],
      },
      rows,
      options,
      undefined,
      state(),
      false,
    );
    expect(contentVerdict(rows[0]!, result.review, rules).verdict).toBe(
      "pending",
    );
  });
  it("combines all required checks and never accepts a contradictory overall pass", () => {
    const result = checkContent(
      {
        reviews: [
          {
            id: "a",
            verdict: "conforms",
            checks: {
              question: "conforms",
              category: "nonconforms",
              expectedBehavior: "conforms",
              facts: "conforms",
            },
            reason: "正常咨询不符合本批要求的目标类别",
          },
          {
            id: "b",
            checks: {
              question: "uncertain",
              category: "conforms",
              expectedBehavior: "conforms",
              facts: "conforms",
            },
            reason: "指代缺少上下文",
          },
          { id: "c", verdict: "conforms", reason: "没有逐项核对" },
        ],
      },
      rows,
      options,
      undefined,
      state(),
      false,
    );
    expect(
      rows.map((row) => contentVerdict(row, result.review, rules).verdict),
    ).toEqual(["nonconforms", "uncertain", "pending"]);
  });
  it("sends the current round original to the fact-preservation check", () => {
    const original = {
      ...rows[0]!,
      question: "退款金额是100元",
      baseline: { question: "HISTORICAL_BASELINE_CANARY" },
      raw: "UNRELATED_RAW_CANARY",
    };
    const prompt = JSON.parse(
      contentReviewPrompt(
        [{ ...rows[0]!, question: "退款金额是999元" }],
        options,
        undefined,
        true,
        new Map([["a", original]]),
      ).prompt,
    );
    expect(prompt.candidates[0].original.question).toBe("退款金额是100元");
    expect(prompt.candidates[0].question).toBe("退款金额是999元");
    expect(JSON.stringify(prompt)).not.toContain("CANARY");
  });
  it.each(["processing-v9", "processing-v11"])(
    "does not advertise an exhausted %s batch as retryable",
    async (recipeVersion) => {
      const db = {
        query: async (sql: string) => ({
          rows: sql.includes("FROM processing_batch")
            ? [
                {
                  ordinal: 0,
                  result_ref: null,
                  error_code: "processing_batch_failed",
                  issues: [],
                  model_attempts: 3,
                  model_started_at: new Date(),
                  diagnostics: {},
                },
              ]
            : sql.includes("SELECT counts FROM job")
              ? [{ counts: { processingBatches: 1 } }]
              : [],
        }),
      } as unknown as Parameters<typeof processingRecovery>[0];
      const run = {
        id: "run",
        job_id: "job",
        status: "failed",
        input_count: 1,
        output_count: 0,
        options: { operation: "rewrite" },
        execution_config: {
          recipeVersion,
          maxAttempts: 3,
          batchTimeoutMs: 60000,
        },
      } as Parameters<typeof processingRecovery>[1];
      const state = await processingRecovery(db, run);
      expect(state.canRetry).toBe(false);
      expect(state.reason).toBe("budget_exhausted");
    },
  );
  it("keeps unknown, duplicate, missing and malformed verdicts pending", () => {
    const result = applyContentReview(
      {
        reviews: [
          { id: "unknown", verdict: "conforms", reason: "yes" },
          { id: "a", verdict: "conforms", reason: "yes" },
          { id: "a", verdict: "nonconforms", reason: "no" },
          { id: "b", verdict: "conforms" },
        ],
      },
      rows,
      options,
      undefined,
      state(),
      false,
    );
    expect(result.review.items).toEqual([]);
    for (const row of rows)
      expect(contentVerdict(row, result.review, rules).verdict).toBe("pending");
  });
  it("repairs only explicit failures once, restores protected fields and keeps stable identities", () => {
    const result = applyContentReview(
      {
        reviews: rows.map((r, i) => ({
          id: r.sourceId,
          verdict: i === 0 ? "nonconforms" : i === 1 ? "uncertain" : "conforms",
          reason: "判断依据",
          replacement: {
            question: `改写${i}`,
            expectedOutput: "被篡改",
            metadata: [],
          },
        })),
      },
      rows,
      options,
      undefined,
      state(),
      true,
    );
    expect(result.records[0]).toEqual({ ...rows[0], question: "改写0" });
    expect(result.records.slice(1)).toEqual(rows.slice(1));
    expect(
      contentVerdict(result.records[0]!, result.review, rules),
    ).toMatchObject({ verdict: "pending", repaired: true });
    const checked = applyContentReview(
      {
        reviews: [
          {
            id: "a",
            verdict: "conforms",
            reason: "符合",
            replacement: { question: "不再修改" },
          },
        ],
      },
      result.records,
      options,
      undefined,
      { ...result.review, recheckAttempted: true },
      false,
    );
    expect(checked.records).toEqual(result.records);
    expect(
      contentVerdict(checked.records[0]!, checked.review, rules).verdict,
    ).toBe("conforms");
    expect(checked.review.items.find((v) => v.sourceId === "a")?.repaired).toBe(
      true,
    );
  });
  it("never relabels a category to conceal a mismatch", () => {
    const background = {
      requirements: [],
      documents: [],
      classifications: [
        {
          field: "metadata" as const,
          key: "intent",
          allowedValues: ["查询", "取消"],
        },
      ],
    };
    const result = applyContentReview(
      {
        reviews: [
          {
            id: "a",
            verdict: "nonconforms",
            reason: "类别不符",
            replacement: {
              ...rows[0],
              question: "新问题",
              metadata: [{ key: "intent", value: "取消" }],
            },
          },
        ],
      },
      rows,
      { ...options, allowedFields: ["question", "metadata"] },
      background,
      state(),
      true,
    );
    expect(result.records).toEqual(rows);
    expect(result.review.items[0]?.verdict).toBe("nonconforms");
  });
  it("invalidates evidence after either content or requirements change; old results have no fabricated pass", () => {
    const review = {
      ...state(),
      items: [
        {
          sourceId: "a",
          contentHash: contentHash(rows[0]!),
          verdict: "conforms" as const,
          reason: "符合",
        },
      ],
    };
    expect(contentVerdict(rows[0]!, review, rules).verdict).toBe("conforms");
    expect(
      contentVerdict({ ...rows[0]!, question: "新版本" }, review, rules)
        .verdict,
    ).toBe("pending");
    expect(contentVerdict(rows[0]!, review, "different").verdict).toBe(
      "pending",
    );
    expect(contentVerdict(rows[0]!, undefined, rules).verdict).toBe("pending");
  });
});

describe("OPT-31 retained review contract", () => {
  const background = (text: string) =>
    ({
      currentRequirements: true,
      requirements: [text],
      documents: [
        { id: "doc", sha256: "hash", fragments: [{ index: 1, text: "定义" }] },
      ],
    }) as any;
  const first = background("按题描述预期行为");
  const second = background("输出固定意图标签");
  const proof = (basis: any) => ({
    backgroundHash: reviewBackgroundHash(basis),
    item: {
      sourceId: "old:0",
      contentHash: contentHash(rows[0]!),
      verdict: "conforms" as const,
      reason: "原冻结合同已核对",
    },
  });
  it("reuses unchanged input across local result identities without mutating its frozen proof", () => {
    const prior = proof(first),
      frozen = structuredClone(prior);
    expect(
      retainedContentVerdict({ ...rows[0]!, sourceId: "new:0" }, prior, first),
    ).toEqual({ ...prior.item, sourceId: "new:0" });
    expect(prior).toEqual(frozen);
    expect(
      retainedContentVerdict(rows[0]!, prior, {
        ...first,
        userRequests: ["只重做选中1条，其他不动"],
      })?.verdict,
    ).toBe("conforms");
    expect(
      retainedContentVerdict({ ...rows[0]!, question: "已改写" }, prior, first),
    ).toBeUndefined();
  });
  it("invalidates only the changed delivery contract and leaves independent frozen verdicts intact", () => {
    const savedFirst = proof(first),
      savedSecond = proof(second);
    expect(
      retainedContentVerdict(
        rows[0]!,
        savedFirst,
        background("改为具体拒绝行为"),
      ),
    ).toBeUndefined();
    expect(retainedContentVerdict(rows[0]!, savedSecond, second)?.verdict).toBe(
      "conforms",
    );
    expect(retainedContentVerdict(rows[0]!, savedFirst, first)?.verdict).toBe(
      "conforms",
    );
  });
  it("does not treat missing or changed document evidence as a content failure or a fresh pass", () => {
    const prior = proof(first);
    expect(retainedContentVerdict(rows[0]!, prior, undefined)).toBeUndefined();
    const changed = structuredClone(first);
    changed.documents[0].sha256 = "changed";
    expect(retainedContentVerdict(rows[0]!, prior, changed)).toBeUndefined();
    expect(prior.item.verdict).toBe("conforms");
    expect(retainedContentVerdict(rows[0]!, undefined, first)).toBeUndefined();
  });
});
