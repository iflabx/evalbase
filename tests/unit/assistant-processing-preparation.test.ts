import { describe, expect, it } from "vitest";
import { bindTaskInput } from "../../src/assistant/plan.js";
import { selectCandidateRun } from "../../src/assistant/candidates.js";
import { hasNoEffect } from "../../src/assistant/receipts.js";
import { selectRecords } from "../../src/selection/index.js";
import type { readProcessingRun } from "../../src/processing/store.js";
const picked = { scope: "task", runId: "run", resultIds: ["r0"] };
const task = { runId: "run", target: { kind: "draft", id: "draft" } };
describe("OPT47 shared processing contracts", () => {
  it("preserves explicit false instead of changing adoption scope", () => {
    const input = bindTaskInput(
      "request_processing_apply",
      { allSelected: false, allValid: true },
      task,
      undefined,
      picked,
    );
    expect(input.allSelected).toBe(false);
    expect(input.allValid).toBe(true);
  });
  it("does not invent a second range mode when all results were explicit", () => {
    const input = bindTaskInput(
      "refine_candidates",
      { allResults: true },
      task,
      undefined,
      picked,
    );
    expect(input).not.toHaveProperty("allSelected");
  });
  it("uses identical trusted selection defaults for read and submit", () => {
    const supplied = { selection: { method: "random", value: 2 } };
    const read = bindTaskInput("read_records", supplied, {
      ...task,
      targetCount: 2,
    });
    const submit = bindTaskInput("submit_processing", supplied, {
      ...task,
      targetCount: 2,
    });
    expect(read.selection).toEqual(submit.selection);
    expect(read.selection).toMatchObject({ conditions: [], mode: "count" });
    expect(
      bindTaskInput(
        "submit_processing",
        { selection: { method: "all", seed: null } },
        task,
      ).selection,
    ).toEqual({ method: "all", conditions: [] });
  });
  it("freezes the seed actually used by the real selection algorithm", () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      id: "r" + i,
      candidateOrigin: { runId: "run", resultId: "r" + i },
      result: {
        question: "q" + i,
        expectedOutput: "e",
        metadata: [],
        sourceId: "r" + i,
      },
    }));
    const data = {
      run: { id: "run", status: "succeeded" },
      records,
      total: records.length,
      allIds: records.map((r) => r.id),
    } as unknown as Awaited<ReturnType<typeof readProcessingRun>>;
    const selection = {
      method: "random",
      mode: "count",
      value: 3,
      conditions: [],
    };
    const scope = selectCandidateRun(data, {
      seed: "single-real-seed",
      selection,
    });
    const expected = selectRecords(
      records.map((r, i) => ({
        ...r.result,
        id: r.id,
        assetId: "run",
        ordinal: i,
      })),
      { ...selection, seed: "single-real-seed" },
    );
    expect(scope.resultIds).toEqual(expected.selected.map((r) => r.id));
    expect(
      selectCandidateRun(data, {
        selection: { ...selection, seed: "single-real-seed" },
      }),
    ).toEqual(scope);
    expect(() =>
      selectCandidateRun(data, {
        seed: "outer",
        selection: { ...selection, seed: "inner" },
      }),
    ).toThrow();
  });
  it.each(["partial", "committed", "unknown"])(
    "cannot release a %s operation because its last error was validation",
    (effect) => {
      expect(
        hasNoEffect({
          name: "generate_candidates",
          status: "failed",
          effect,
          error: { code: "processing_configuration_invalid" },
        }),
      ).toBe(false);
    },
  );
});

import {
  prepareToolProposal,
  sourceScopeRequest,
  wholeSourceAuthorized,
} from "../../src/assistant/processing-preparation.js";
const prepare = (
  name: string,
  input: Record<string, any>,
  extra: Record<string, any> = {},
) =>
  prepareToolProposal(name, input, { task, request: "清洗这些数据", ...extra });
describe("OPT47 conditional preflight", () => {
  it("collects clean quantity, missing range and wrong Metadata keys together", () => {
    const r = prepare(
      "submit_processing",
      {
        source: { kind: "draft", id: "draft" },
        operation: "clean",
        outputCount: 2,
        metadataKeys: ["question"],
        allowedFields: ["metadata"],
      },
      {
        metadataKeys: ["intent"],
        authorizedText: "清洗Metadata",
        task: { ...task, allowedFields: ["metadata"] },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(new Set(r.issues.map((i) => i.path))).toEqual(
        new Set(["/recordIds", "/outputCount", "/metadataKeys/0"]),
      );
  });
  it.each(["read_records", "submit_processing"])(
    "reports all bad selection conditions through %s",
    (name) => {
      const r = prepare(
        name,
        {
          source: { kind: "draft", id: "draft" },
          operation: "clean",
          selection: {
            method: "random",
            value: 101,
            conditions: [{ field: "metadata", operator: "equals" }],
          },
        },
        { request: "抽一些数据" },
      );
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.issues.map((i) => i.path)).toEqual(
          expect.arrayContaining([
            "/selection/mode",
            "/selection/conditions/0/key",
            "/selection/conditions/0/value",
          ]),
        );
    },
  );
  it("rejects each explicit range conflict without rewriting false or silently dropping conditions", () => {
    for (const [name, input] of [
      ["read_records", { selection: { method: "all" }, conditions: [] }],
      [
        "submit_processing",
        { operation: "clean", recordIds: ["r"], allRecords: true },
      ],
      [
        "request_processing_apply",
        { resultIds: ["r"], allValid: true, target: { kind: "asset" } },
      ],
      [
        "refine_candidates",
        { allSelected: false, allResults: true, instructions: "改得自然" },
      ],
    ] as const) {
      const r = prepare(name, input as any, { picked });
      expect(r.ok, name).toBe(false);
    }
  });
  it("validates conditional create and adoption fields before reuse", () => {
    for (const [name, input] of [
      ["create_draft", { name: "existing", testSetId: "set" }],
      [
        "create_draft",
        { testSetId: "set", parentVersionId: "version", purpose: "ignored" },
      ],
      [
        "request_processing_apply",
        { target: { kind: "asset", id: "ignored" }, allValid: true },
      ],
      [
        "request_processing_apply",
        { target: { kind: "draft", name: "ignored" }, allValid: true },
      ],
      ["query_project", { kind: "project", search: "ignored", offset: 1 }],
      ["query_project", { kind: "files", testSetId: "ignored" }],
    ] as const)
      expect(prepare(name, input as any).ok).toBe(false);
  });
  it("keeps real Metadata keys named like top-level fields, while rejecting duplicate normalized keys", () => {
    const good = prepare(
      "submit_processing",
      {
        operation: "rewrite",
        recordIds: ["r"],
        instructions: "改写",
        allowedFields: ["metadata"],
        metadataKeys: ["question"],
      },
      { metadataKeys: ["question"] },
    );
    expect(good.ok).toBe(true);
    const bad = prepare("submit_processing", {
      operation: "rewrite",
      recordIds: ["r"],
      instructions: " ",
      allowedFields: ["metadata"],
      metadataKeys: [" Tag ", "tag"],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(["/instructions", "/metadataKeys"]),
      );
  });
  it("accepts legitimate generate outputCount and exact instruction capacity without augment-only hints", () => {
    const r = prepare("generate_candidates", {
      name: "测试",
      instructions: "a".repeat(8000),
      outputCount: 2,
      scenarios: ["场景"],
    });
    expect(r.ok).toBe(true);
    const bad = prepare("generate_candidates", {
      name: "测试",
      instructions: "a".repeat(8001),
      outputCount: 2,
      scenarios: [" 场景", "场景 "],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(["/instructions", "/scenarios"]),
      );
      expect(bad.issues.some((i) => i.path === "/outputCount")).toBe(false);
    }
  });
});

import { matchesSelection } from "../../src/selection/index.js";
describe("OPT47 selector parity and authorization boundaries", () => {
  it.each(["equals", "contains"])(
    "%s uses the same exact Metadata key and text normalization for selection and refinement",
    (operator) => {
      const rows = [
        {
          id: "1",
          assetId: "a",
          ordinal: 1,
          question: " Q ",
          expectedOutput: " LABEL ",
          metadata: [
            { key: "intent", value: "  A " },
            { key: "other", value: "B" },
          ],
        },
        {
          id: "2",
          assetId: "a",
          ordinal: 2,
          question: "other",
          expectedOutput: "label",
          metadata: [
            { key: "intent", value: "B" },
            { key: "other", value: " A " },
          ],
        },
      ];
      for (const condition of [
        { field: "metadata", key: "intent", operator, value: " a " },
        { field: "expectedOutput", operator, value: " label " },
        { field: "question", operator, value: " q " },
      ]) {
        const selected = selectRecords(rows, {
          method: "all",
          conditions: [condition],
        }).selected.map((r) => r.id);
        expect(
          rows
            .filter((r) => matchesSelection(r, condition as any))
            .map((r) => r.id),
        ).toEqual(selected);
      }
      expect(
        rows
          .filter((r) =>
            matchesSelection(r, {
              field: "metadata",
              key: "intent",
              operator: operator as any,
              value: " a ",
            }),
          )
          .map((r) => r.id),
      ).toEqual(["1"]);
    },
  );
  it("supports unbound future references in a saved plan while demanding them before execution", () => {
    const input = { allTask: true, allValid: true, target: { kind: "draft" } };
    expect(
      prepare("request_processing_apply", input, { partial: true, task: {} })
        .ok,
    ).toBe(true);
    expect(
      prepare("request_processing_apply", input, { partial: false, task: {} })
        .ok,
    ).toBe(false);
  });
  it("keeps default clean deterministic and rejects unrequested semantic edits", () => {
    const r = prepare("submit_processing", {
      operation: "clean",
      recordIds: ["r"],
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.input).toMatchObject({
        instructions: "",
        allowedFields: ["question"],
      });
    for (const input of [
      { operation: "clean", recordIds: ["r"], instructions: "翻译并统一标签" },
      {
        operation: "clean",
        recordIds: ["r"],
        allowedFields: ["expectedOutput", "metadata"],
      },
    ])
      expect(prepare("submit_processing", input).ok).toBe(false);
  });
  it("does not borrow a frozen range from another source and checks explicit source count", () => {
    const old = {
      ...task,
      processingScope: {
        source: { kind: "draft", id: "other" },
        recordIds: ["r"],
      },
    };
    expect(
      prepare(
        "submit_processing",
        { operation: "clean", source: { kind: "draft", id: "draft" } },
        { task: old },
      ).ok,
    ).toBe(false);
    const r = prepare(
      "submit_processing",
      { operation: "clean", allRecords: true },
      { request: "清洗全部2条", sourceCount: 3 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.some((i) => i.keyword === "revision")).toBe(true);
  });
  it.each([0, 10001, 1.5])(
    "count=%s is rejected by all selection entry points",
    (value) => {
      for (const name of [
        "read_records",
        "submit_processing",
        "select_candidates",
        "preview_selection",
      ]) {
        const cfg = { method: "random", mode: "count", value };
        const r = prepare(
          name,
          name === "preview_selection"
            ? cfg
            : { selection: cfg, operation: "clean" },
        );
        expect(r.ok, name).toBe(false);
      }
    },
  );
});

import { recoveryProgressFacts } from "../../src/assistant/recovery.js";
it("OPT47 catalogue ordering/counts are read facts, never new completion receipts", () => {
  const reads = (result: any) => ({
    id: "turn",
    tool_results: [{ name: "query_project", status: "succeeded", result }],
  });
  expect(
    recoveryProgressFacts(
      {},
      reads({ items: [{ id: "a", count: 1 }], offset: 0 }),
    ),
  ).toEqual(
    recoveryProgressFacts(
      {},
      reads({ items: [{ id: "b", count: 5 }], offset: 5 }),
    ),
  );
  expect(
    recoveryProgressFacts(
      {},
      {
        id: "turn",
        tool_results: [
          {
            name: "submit_processing",
            status: "succeeded",
            result: { runId: "real-run" },
          },
        ],
      },
    ),
  ).toHaveLength(1);
});

import { selectCandidateCollection } from "../../src/assistant/candidates.js";
describe("OPT47 review authorization regressions", () => {
  it("does not allow a negated Metadata change", () => {
    const r = prepare(
      "submit_processing",
      { operation: "clean", recordIds: ["r"], allowedFields: ["metadata"] },
      { authorizedText: "不要修改Metadata，只整理问题首尾空白" },
    );
    expect(r.ok).toBe(false);
    for (const request of ["清洗全部记录Metadata不改", "不允许清洗Metadata"])
      expect(
        prepare(
          "submit_processing",
          { operation: "clean", recordIds: ["r"], allowedFields: ["metadata"] },
          { request, authorizedText: request },
        ).ok,
      ).toBe(false);
  });
  it("compiles semantic clean instructions from the actual user directive", () => {
    const r = prepare(
      "submit_processing",
      {
        operation: "clean",
        recordIds: ["r"],
        instructions: "把所有问题翻译成英语",
      },
      { request: "只统一标点", authorizedText: "只统一标点" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.instructions).toBe("只统一标点");
  });
  it("repeats omitted-seed candidate selection with the same frozen IDs and seed", () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      id: "r" + i,
      candidateOrigin: { runId: "run", resultId: "r" + i },
      result: {
        question: "q" + i,
        expectedOutput: "e",
        metadata: [],
        sourceId: "r" + i,
      },
    }));
    const data = {
      run: { id: "run", status: "succeeded" },
      records,
      total: records.length,
      allIds: records.map((r) => r.id),
    } as any;
    const input = {
      selection: { method: "random", mode: "count", value: 3, conditions: [] },
    };
    const first = selectCandidateCollection(data, [data], input);
    const second = selectCandidateCollection(data, [data], input, first);
    expect(second.seed).toBe(first.seed);
    expect(second.originKeys).toEqual(first.originKeys);
  });
});

it.each([
  "不要清洗全部，只处理第一条",
  "保留全部Metadata",
  "保留所有期望输出",
  "清洗所有选中记录",
])("OPT47 does not treat %s as whole-source authorization", (request) => {
  expect(wholeSourceAuthorized(request, "清洗全部记录")).toBe(false);
});
it("OPT47 recognizes affirmative source scope and an authorized plan continuation", () => {
  expect(wholeSourceAuthorized("只清洗全部记录，保留Metadata", " ")).toBe(true);
  expect(wholeSourceAuthorized("执行方案", "清洗全部记录")).toBe(true);
});

import { processingRepairIssues } from "../../src/assistant/processing-preparation.js";
it("OPT47 both repair entrances preserve unrelated valid input while allowing cited fields to change", () => {
  const original = {
    operation: "clean",
    source: { kind: "draft", id: "d" },
    allowedFields: ["metadata"],
    outputCount: 2,
  };
  const issue = {
    tool: "submit_processing",
    operation: "clean",
    path: "/outputCount",
    keyword: "business",
    code: "processing_configuration_invalid",
    message: "bad quantity",
  };
  expect(
    processingRepairIssues(
      "submit_processing",
      original,
      { ...original, outputCount: undefined, allowedFields: ["question"] },
      [issue],
    ).map((i) => i.path),
  ).toEqual(["/allowedFields"]);
  expect(
    processingRepairIssues(
      "submit_processing",
      original,
      { ...original, outputCount: undefined },
      [issue],
    ),
  ).toEqual([]);
  expect(
    processingRepairIssues(
      "create_draft",
      { name: "N", purpose: "P" },
      { name: "N", purpose: "Q" },
    ),
  ).toMatchObject([{ path: "/purpose" }]);
  expect(
    processingRepairIssues(
      "request_processing_apply",
      { target: { kind: "asset", id: "invalid" } },
      { target: { kind: "draft", id: "other" } },
      [{ ...issue, path: "/target/id" }],
    ),
  ).toMatchObject([{ path: "/target/kind" }]);
});

describe("source-bound scope evidence", () => {
  const source = { kind: "assets", assetIds: ["a"] };
  const receipt = (mode: string) => ({
    name: "plan_task",
    status: "succeeded",
    result: { task: { target: source }, control: { mode } },
  });
  it.each(["failed", "query"])(
    "does not grant all records from a %s turn",
    (scenario) => {
      const text = sourceScopeRequest(
        [
          {
            user_text: "清洗全部2条",
            status: scenario === "failed" ? "failed" : "succeeded",
            tool_results: [receipt(scenario === "query" ? "query" : "plan")],
          },
        ],
        source,
      );
      expect(wholeSourceAuthorized("开始清洗", text)).toBe(false);
    },
  );
  it("a successful query cannot erase the saved input count", () => {
    const text = sourceScopeRequest(
      [
        {
          user_text: "清洗全部2条",
          status: "succeeded",
          tool_results: [receipt("plan")],
        },
        {
          user_text: "项目全部文件有哪些？",
          status: "succeeded",
          tool_results: [receipt("query")],
        },
      ],
      source,
    );
    expect(text).toBe("清洗全部2条");
    const result = prepareToolProposal(
      "submit_processing",
      { source, operation: "clean", allRecords: true },
      {
        task: { target: source },
        request: "开始清洗",
        authorizedScopeText: text,
        sourceCount: 3,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.issues.some(
          (i) => i.path === "/recordIds" && i.keyword === "revision",
        ),
      ).toBe(true);
  });
  it("a later partial request revokes an earlier saved whole-source authorization even if its turn failed", () => {
    const text = sourceScopeRequest(
      [
        {
          user_text: "清洗全部2条",
          status: "succeeded",
          tool_results: [receipt("plan")],
        },
        { user_text: "只处理部分记录", status: "failed", tool_results: [] },
      ],
      source,
    );
    expect(wholeSourceAuthorized("开始清洗", text)).toBe(false);
  });
});

it.each([
  "开始清洗，只去掉问题首尾的空格和换行，期望输出和Metadata保持不变。",
  "请开始处理，期望输出保持原样。",
])(
  "OPT50 execution with field clauses keeps previously confirmed whole scope: %s",
  (request) => {
    expect(wholeSourceAuthorized(request, "清洗全部2条记录")).toBe(true);
    expect(wholeSourceAuthorized(request, "只清洗1条")).toBe(false);
    expect(wholeSourceAuthorized(request, "")).toBe(false);
  },
);
it.each([
  "开始清洗，只处理退款类记录。",
  "开始清洗，仅限退款类记录。",
  "开始清洗，排除退款类记录。",
  "开始清洗，只清洗第一条。",
  "开始清洗，只清洗部分记录。",
])("OPT50 subset clause cannot inherit entire-source scope: %s", (request) => {
  expect(wholeSourceAuthorized(request, "清洗全部2条记录")).toBe(false);
});
it.each([
  "仅去除 question 字段首尾的空格和换行；不修改问题内部内容，不修改 expectedOutput 和 metadata。",
  "整理首尾空白，期望输出和Metadata保持不变。",
  "只去掉问题前后的空白。",
])(
  "OPT50 equivalent default clean description compiles without model processing: %s",
  (instructions) => {
    const result = prepare("submit_processing", {
      operation: "clean",
      recordIds: ["r"],
      instructions,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.input).toMatchObject({
        instructions: "",
        allowedFields: ["question"],
      });
  },
);
it.each([
  "只去掉问题首尾的空格。",
  "只去掉问题首尾的换行。",
  "整理首尾空白，删除重复记录。",
  "整理首尾空白，统一分类。",
  "整理首尾空白，同时删除问题中间的空格。",
  "整理首尾空白，补写期望输出。",
])(
  "OPT50 additional clean effects still require user authorization: %s",
  (instructions) => {
    expect(
      prepare("submit_processing", {
        operation: "clean",
        recordIds: ["r"],
        instructions,
      }).ok,
    ).toBe(false);
  },
);

it.each([
  {
    name: "submit_processing",
    status: "failed",
    error: { code: "processing_scope_invalid" },
  },
  {
    name: "submit_processing",
    status: "succeeded",
    result: {
      unchanged: true,
      requiresClarification: true,
      question: "请选择记录范围",
    },
  },
  {
    name: "submit_processing",
    status: "succeeded",
    result: {
      unchanged: true,
      requiresClarification: true,
      clarification: { kind: "scope" },
      question: "请选择记录范围",
    },
  },
])(
  "OPT50 a persisted scope clarification revokes older whole-source authorization across continue: %j",
  (receipt) => {
    const source = { kind: "assets", assetIds: ["a"] };
    const saved = {
      name: "plan_task",
      status: "succeeded",
      result: { task: { target: source }, control: { mode: "execute" } },
    };
    const history = [
      { user_text: "清洗全部2条", status: "succeeded", tool_results: [saved] },
      {
        user_text: "开始清洗，仅限退款类记录",
        status: "succeeded",
        tool_results: [receipt],
      },
      { user_text: "继续", status: "succeeded", tool_results: [saved] },
    ];
    expect(sourceScopeRequest(history, source)).toBe("");
    expect(
      wholeSourceAuthorized("继续", sourceScopeRequest(history, source)),
    ).toBe(false);
    expect(
      sourceScopeRequest(
        [
          ...history,
          {
            user_text: "改回全部2条",
            status: "succeeded",
            tool_results: [saved],
          },
        ],
        source,
      ),
    ).toBe("改回全部2条");
  },
);

describe("OPT50 apply repair preserves adoption scope", () => {
  const base = {
    runId: "run",
    resultIds: ["bad"],
    target: { kind: "newDraft", name: "原草稿" },
  };
  const problems: any[] = [
    {
      path: "/resultIds/0",
      code: "processing_result_invalid",
      keyword: "reference",
    },
  ];
  it("repairs only invalid candidate identities", () => {
    expect(
      processingRepairIssues(
        "request_processing_apply",
        base,
        { ...base, resultIds: ["0:0"] },
        problems,
      ),
    ).toEqual([]);
  });
  it.each([
    { runId: "other", resultIds: ["0:0"] },
    { resultIds: ["0:0", "0:1"] },
    { resultIds: undefined, allValid: true },
    { resultIds: undefined, allTask: true },
    { resultIds: undefined, allSelected: true },
    { resultIds: ["0:0"], target: { kind: "newDraft", name: "另一个" } },
  ])(
    "does not use invalid IDs to authorize another scope or target: %j",
    (change) => {
      expect(
        processingRepairIssues(
          "request_processing_apply",
          base,
          { ...base, ...change },
          problems,
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it("removes a conflicting task flag while preserving valid single-batch IDs", () => {
    const fixed = { ...base, resultIds: ["0:0"] };
    expect(
      processingRepairIssues(
        "request_processing_apply",
        { ...fixed, allTask: true },
        fixed,
        [
          {
            path: "/allTask",
            code: "processing_scope_invalid",
            keyword: "business",
          } as any,
        ],
      ),
    ).toEqual([]);
  });
  it("a missing browser selection cannot silently become all candidates", () => {
    const fixed = { runId: "run", allSelected: true, target: base.target };
    expect(prepare("request_processing_apply", fixed).ok).toBe(false);
  });
});

it("OPT50 valid candidate references survive repair of another ID", () => {
  const base = { runId: "run", resultIds: ["0:0", "bad"] };
  const issues: any[] = [
    {
      path: "/resultIds/1",
      keyword: "reference",
      code: "processing_result_invalid",
    },
  ];
  expect(
    processingRepairIssues(
      "request_processing_apply",
      base,
      { ...base, resultIds: ["0:1", "0:2"] },
      issues,
    ).length,
  ).toBeGreaterThan(0);
  expect(
    processingRepairIssues(
      "request_processing_apply",
      base,
      { ...base, resultIds: ["0:0", "0:1"] },
      issues,
    ),
  ).toEqual([]);
});
it("OPT50 repeated candidate references may deduplicate but never add another result", () => {
  const base = { runId: "run", resultIds: ["0:0", "0:0"] };
  const issues: any[] = [
    {
      path: "/resultIds/1",
      keyword: "duplicate",
      code: "processing_result_invalid",
    },
  ];
  expect(
    processingRepairIssues(
      "request_processing_apply",
      base,
      { ...base, resultIds: ["0:0", "0:1"] },
      issues,
    ).length,
  ).toBeGreaterThan(0);
  expect(
    processingRepairIssues(
      "request_processing_apply",
      base,
      { ...base, resultIds: ["0:0"] },
      issues,
    ),
  ).toEqual([]);
});
