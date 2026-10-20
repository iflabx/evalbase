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

describe("OPT41 evidence policy", () => {
  const background: any = {
    contentReviewPolicy: "evidence-v1",
    requirements: ["完整自然的问题，核对类别和事实"],
    documents: [
      {
        id: "doc",
        fileName: "意图规范",
        sha256: "fixed",
        extractorVersion: "text-v1",
        fragments: [
          { index: 1, text: "查询意图：询问订单状态，不含取消请求。" },
        ],
      },
    ],
  };
  const row = {
    sourceId: "r",
    question: "我的订单现在是什么状态？",
    expectedOutput: "查询",
    metadata: [],
  };
  const opts: any = {
    operation: "generate",
    instructions: "生成查询意图",
    outputCount: 1,
    allowedFields: ["question", "expectedOutput", "metadata"],
    scenarios: ["不能作为判定依据"],
  };
  const initial = () => ({
    version: 2 as const,
    policy: "evidence-v1" as const,
    rulesHash: reviewRulesHash(opts, background),
    initialAttempted: true as const,
    items: [],
  });
  const reply = () => ({
    reviews: [
      {
        id: "r",
        checks: Object.fromEntries(
          ["question", "category", "expectedBehavior", "facts"].map((key) => [
            key,
            {
              verdict: "conforms",
              reason: "问题明确询问订单状态",
              quote: row.question,
              ...(key === "expectedBehavior" ? { outputQuote: "查询" } : {}),
              ...(key === "category"
                ? {
                    references: [
                      {
                        documentId: "doc",
                        fragmentIndex: 1,
                        quote: "询问订单状态",
                      },
                    ],
                  }
                : {}),
              ...(key === "facts" ? { basis: "no_assertion" } : {}),
            },
          ]),
        ),
      },
    ],
  });
  it("requires located evidence for every check and does not accept four unsupported passes", () => {
    const result = checkContent(
      {
        reviews: [
          {
            id: "r",
            checks: {
              question: "conforms",
              category: "conforms",
              expectedBehavior: "conforms",
              facts: "conforms",
            },
            reason: "全部符合",
          },
        ],
      },
      [row],
      opts,
      background,
      initial(),
      false,
    );
    expect(
      contentVerdict(row, result.review, initial().rulesHash).verdict,
    ).toBe("pending");
  });
  it("preserves valid quotes and rejects invented or ungranted evidence without inventing a failure", () => {
    const value: any = reply();
    value.reviews[0].checks.category.references[0].analysis =
      "PRIVATE_REASONING_CANARY";
    const good = checkContent(value, [row], opts, background, initial(), false);
    expect(contentVerdict(row, good.review, initial().rulesHash)).toMatchObject(
      { verdict: "conforms", checks: { category: { quote: row.question } } },
    );
    expect(JSON.stringify(good.review)).not.toContain(
      "PRIVATE_REASONING_CANARY",
    );
    value.reviews[0].checks.category.references[0].documentId = "other-session";
    expect(
      contentVerdict(
        row,
        checkContent(value, [row], opts, background, initial(), false).review,
        initial().rulesHash,
      ).verdict,
    ).toBe("pending");
    value.reviews[0].checks.category.references[0].documentId = "doc";
    value.reviews[0].checks.question.quote = "伪造原句";
    expect(
      contentVerdict(
        row,
        checkContent(value, [row], opts, background, initial(), false).review,
        initial().rulesHash,
      ).verdict,
    ).toBe("pending");
  });
  it("distinguishes unsupported new assertions from an explicit hypothetical or no assertion", () => {
    const value: any = reply();
    value.reviews[0].checks.facts.basis = "assertion";
    expect(
      contentVerdict(
        row,
        checkContent(value, [row], opts, background, initial(), false).review,
        initial().rulesHash,
      ).verdict,
    ).toBe("uncertain");
    value.reviews[0].checks.facts.basis = "hypothetical";
    expect(
      contentVerdict(
        row,
        checkContent(value, [row], opts, background, initial(), false).review,
        initial().rulesHash,
      ).verdict,
    ).toBe("conforms");
  });
  it("does not use generation quotas or scenarios as review evidence and bounds prior question hints", () => {
    const prompt = contentReviewPrompt(
      [row],
      opts,
      background,
      true,
      undefined,
      Array.from({ length: 200 }, (_, i) => ({
        ...row,
        question: "其他问题" + i + "长".repeat(200),
      })),
    );
    const body = JSON.parse(prompt.prompt);
    expect(body.options?.scenarios).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("不能作为判定依据");
    expect(body.questionContext.sampledQuestions.length).toBeLessThanOrEqual(
      20,
    );
    expect(body.questionContext.exhaustive).toBe(false);
    expect(body.questionContext.totalAuthorizedQuestions).toBe(200);
    expect(
      Buffer.byteLength(prompt.system + prompt.prompt),
    ).toBeLessThanOrEqual(40000);
  });
  it("stages a valid replacement and keeps the original until a successful recheck", () => {
    const value: any = reply();
    value.reviews[0].checks.question.verdict = "nonconforms";
    value.reviews[0].replacement = {
      ...row,
      question: "请问我的订单处理到哪一步了？",
    };
    delete value.reviews[0].replacement.sourceId;
    const result = checkContent(
      value,
      [row],
      opts,
      background,
      initial(),
      true,
    );
    expect(result.records).toEqual([row]);
    expect(result.review.items[0]).toMatchObject({
      verdict: "nonconforms",
      repairStatus: "proposed",
      proposal: { question: "请问我的订单处理到哪一步了？" },
    });
  });
  it("keeps old frozen hashes and policies readable without a global upgrade", () => {
    const old = { requirements: [], documents: [] };
    expect(reviewRulesHash(opts, old)).toBe(
      sha256(
        canonicalJson({
          policy: "content-intent-v2",
          options: opts,
          background: old,
        }),
      ),
    );
    const legacy = { ...background };
    delete legacy.contentReviewPolicy;
    expect(reviewRulesHash(opts, background)).not.toBe(
      reviewRulesHash(opts, legacy),
    );
  });
});

it("OPT41 locates current-round original quotes and rejects duplicate identities or a missing check", () => {
  const row = {
    sourceId: "r",
    question: "订单A17的900元退款什么时候到账？",
    expectedOutput: "查询",
    metadata: [],
  };
  const original = { ...row, question: "订单A17，退款100元，何时到账" };
  const opts: any = {
    operation: "rewrite",
    instructions: "保留金额",
    allowedFields: ["question"],
  };
  const background: any = {
    contentReviewPolicy: "evidence-v1",
    requirements: [],
    documents: [],
  };
  const state: any = {
    version: 2,
    policy: "evidence-v1",
    rulesHash: reviewRulesHash(opts, background),
    initialAttempted: true,
    items: [],
  };
  const checks: any = Object.fromEntries(
    ["question", "category", "expectedBehavior", "facts"].map((key) => [
      key,
      {
        verdict: key === "facts" ? "nonconforms" : "conforms",
        reason: "当前金额与原输入不符",
        quote: row.question,
        ...(key === "expectedBehavior" ? { outputQuote: "查询" } : {}),
        ...(key === "facts"
          ? { basis: "preservation", originalQuote: "退款100元" }
          : {}),
      },
    ]),
  );
  const item = { id: "r", checks };
  const originals = new Map([["r", original]]);
  expect(
    checkContent(
      { reviews: [item] },
      [row],
      opts,
      background,
      state,
      false,
      originals,
    ).review.items[0]?.verdict,
  ).toBe("nonconforms");
  checks.facts.originalQuote = "退款999元";
  expect(
    checkContent(
      { reviews: [item] },
      [row],
      opts,
      background,
      state,
      false,
      originals,
    ).review.items[0]?.verdict,
  ).toBe("pending");
  expect(
    checkContent(
      { reviews: [item, item] },
      [row],
      opts,
      background,
      state,
      false,
      originals,
    ).review.items,
  ).toEqual([]);
  delete checks.facts;
  expect(
    checkContent(
      { reviews: [item] },
      [row],
      opts,
      background,
      state,
      false,
      originals,
    ).review.items,
  ).toEqual([]);
});

it("OPT41 uses unambiguous questionQuote and never treats an answer or label as question evidence", () => {
  const row = {
    sourceId: "q",
    question: "请帮我取消这笔订单。",
    expectedOutput: "取消",
    metadata: [],
  };
  const background: any = {
    contentReviewPolicy: "evidence-v1",
    requirements: [],
    documents: [],
  };
  const options: any = {
    operation: "generate",
    instructions: "取消意图",
    outputCount: 1,
    allowedFields: ["question", "expectedOutput", "metadata"],
  };
  const state: any = {
    version: 2,
    policy: "evidence-v1",
    rulesHash: reviewRulesHash(options, background),
    initialAttempted: true,
    items: [],
  };
  const checks: any = Object.fromEntries(
    ["question", "category", "expectedBehavior", "facts"].map((key) => [
      key,
      {
        verdict: "conforms",
        reason: "明确请求取消订单",
        questionQuote: row.question,
        ...(key === "expectedBehavior" ? { outputQuote: "取消" } : {}),
        ...(key === "facts" ? { basis: "no_assertion" } : {}),
      },
    ]),
  );
  expect(
    checkContent(
      { reviews: [{ id: "q", checks }] },
      [row],
      options,
      background,
      state,
      false,
    ).review.items[0]?.verdict,
  ).toBe("conforms");
  checks.category.questionQuote = "不存在的类别标签";
  expect(
    checkContent(
      { reviews: [{ id: "q", checks }] },
      [row],
      options,
      background,
      state,
      false,
    ).review.items[0]?.verdict,
  ).toBe("pending");
});
