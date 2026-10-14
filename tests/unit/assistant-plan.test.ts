import { describe, expect, it } from "vitest";
import {
  advancePlan,
  revisePlan,
  planRequirementsKey,
  resolvedStepInput,
  missingStepDependency,
  selectionParameters,
  type ExecutionPlan,
} from "../../src/assistant/plan.js";

describe("restored execution plan boundaries", () => {
  it("keeps approved parameters when enabling a plan with unchanged step titles", () => {
    expect(
      selectionParameters({ method: "random", value: 4, conditions: null }, 4)
        .conditions,
    ).toBeNull();
    const target = { kind: "draft", id: "source" };
    const steps = [
      {
        title: "清理空白",
        action: "submit_processing",
        input: {
          source: target,
          operation: "clean",
          allRecords: true,
          instructions: "仅整理首尾空白",
          allowedFields: ["question"],
        },
      },
    ];
    const prior = revisePlan(
      undefined,
      { executionMode: "plan", steps },
      1,
      target,
      "same",
    )!;
    const executing = revisePlan(
      prior,
      {
        executionMode: "execute",
        steps: [{ title: "清理空白", action: "submit_processing" }],
      },
      2,
      target,
      "same",
    )!;
    expect(resolvedStepInput(executing)).toEqual({
      ...steps[0].input,
      source: target,
    });
    const withRead = revisePlan(
      undefined,
      {
        executionMode: "plan",
        steps: [{ title: "读取资料", action: "read_records" }, ...steps],
      },
      1,
      target,
      "same",
    )!;
    expect(
      resolvedStepInput(
        revisePlan(
          withRead,
          {
            executionMode: "execute",
            steps: [
              { title: "清理空白", action: "submit_processing", input: {} },
            ],
          },
          2,
          target,
          "same",
        )!,
      ),
    ).toEqual(steps[0].input);
    const duplicated = revisePlan(
      withRead,
      {
        executionMode: "execute",
        steps: [
          { title: "清理空白", action: "submit_processing", input: {} },
          { title: "清理空白", action: "submit_processing", input: {} },
        ],
      },
      2,
      target,
      "same",
    )!;
    expect(duplicated.steps.every((step) => !step.input?.operation)).toBe(true);
    const changed = revisePlan(
      prior,
      {
        executionMode: "execute",
        steps: [{ title: "新规则", action: "submit_processing" }],
      },
      2,
      target,
      "changed",
    )!;
    expect(resolvedStepInput(changed).instructions).toBeUndefined();
  });
  it("binds a preview and its draft as a pair and carries a confirmed new draft forward", () => {
    const plan: ExecutionPlan = {
      mode: "execute",
      current: 3,
      steps: [
        {
          title: "创建D1",
          action: "create_draft",
          status: "executed",
          receipt: { key: "c1", draftId: "D1" },
        },
        {
          title: "预览D1",
          action: "preview_selection",
          status: "executed",
          receipt: { key: "p1", draftId: "D1", previewId: "P1" },
        },
        {
          title: "创建D2",
          action: "create_draft",
          status: "executed",
          receipt: { key: "c2", draftId: "D2" },
        },
        {
          title: "采用预览",
          action: "request_selection_apply",
          status: "pending",
        },
      ],
    };
    expect(resolvedStepInput(plan)).toEqual({ draftId: "D1", previewId: "P1" });
    expect(resolvedStepInput(plan, { draftId: "D2" })).toEqual({
      draftId: "D2",
    });
    const adoption: ExecutionPlan = {
      mode: "execute",
      current: 0,
      steps: [
        {
          title: "采用到新草稿",
          action: "request_processing_apply",
          status: "waiting",
          receipt: { key: "apply", proposalId: "card" },
        },
        { title: "发布草稿", action: "request_publish", status: "pending" },
      ],
    };
    const confirmed = advancePlan(
      adoption,
      "confirmed",
      {
        id: "card",
        status: "succeeded",
        receipt: { receipt: { draftId: "actual" } },
      },
      "confirm",
    )!;
    expect(resolvedStepInput(confirmed)).toEqual({ draftId: "actual" });
  });
  it("binds current dependencies to the matching prior receipts and leaves future holes open", () => {
    let plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          { title: "创建", action: "create_draft" },
          {
            title: "预览",
            action: "preview_selection",
            input: { assetIds: ["A"] },
          },
        ],
      },
      1,
    )!;
    expect(missingStepDependency(plan)).toBeUndefined();
    plan = advancePlan(
      plan,
      "create_draft",
      { draftId: "actual" },
      "receipt",
      1,
    )!;
    expect(resolvedStepInput(plan)).toEqual({
      assetIds: ["A"],
      draftId: "actual",
    });
    expect(missingStepDependency(plan)).toBeUndefined();
    expect(
      missingStepDependency({
        ...plan,
        current: 0,
        steps: [
          { title: "错误首步", action: "preview_selection", status: "pending" },
        ],
      }),
    ).toBe("draftId");
  });
  it("preserves committed processing facts when the selected background basis changes", () => {
    const task = {
      requirements: ["依据附件分类"],
      backgroundEvidence: [
        { documentId: "A", sha256: "hash-A", fragmentIndex: 1 },
      ],
    };
    const key = planRequirementsKey(task);
    const before: ExecutionPlan = {
      mode: "execute",
      current: 1,
      requirementsKey: key,
      steps: [
        {
          title: "分类",
          action: "submit_processing",
          status: "executed",
          input: { source: { kind: "assets", assetIds: ["asset"] } },
          receipt: { key: "receipt", runId: "old" },
        },
      ],
    };
    const changed = planRequirementsKey({
      ...task,
      backgroundEvidence: [
        { documentId: "B", sha256: "hash-B", fragmentIndex: 1 },
      ],
    });
    expect(changed).not.toBe(key);
    expect(
      revisePlan(before, { executionMode: "execute" }, 2, undefined, changed)
        ?.current,
    ).toBe(1);
    expect(before.steps[0]?.receipt?.runId).toBe("old");
  });
  it("finishes a full background read only after every page in the declared range", () => {
    let plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "读取完整定义",
            action: "read_background",
            scope: "all",
            input: { documentId: "doc" },
          },
        ],
      },
      1,
    );
    plan = advancePlan(
      plan,
      "read_background",
      {
        id: "doc",
        fragmentCount: 4,
        fragments: [{ index: 1 }, { index: 2 }],
        nextFrom: 3,
      },
      "page1",
      1,
      { documentId: "doc", from: 1 },
    );
    expect(plan?.current).toBe(0);
    const narrowed = advancePlan(
      plan,
      "read_background",
      {
        id: "doc",
        matchCount: 1,
        fragmentCount: 4,
        fragments: [{ index: 4 }],
        nextFrom: null,
      },
      "search",
      1,
      { documentId: "doc", query: "A.5" },
    );
    expect(narrowed?.current).toBe(0);
    const wrong = advancePlan(
      plan,
      "read_background",
      {
        id: "other",
        fragmentCount: 4,
        fragments: [{ index: 3 }, { index: 4 }],
        nextFrom: null,
      },
      "wrong",
      1,
      { documentId: "other", from: 3 },
    );
    expect(wrong?.current).toBe(0);
    const gap = advancePlan(
      plan,
      "read_background",
      {
        id: "doc",
        fragmentCount: 4,
        fragments: [{ index: 4 }],
        nextFrom: null,
      },
      "gap",
      1,
      { documentId: "doc", from: 4 },
    );
    expect(gap?.current).toBe(0);
    plan = advancePlan(
      plan,
      "read_background",
      {
        id: "doc",
        fragmentCount: 4,
        fragments: [{ index: 3 }, { index: 4 }],
        nextFrom: null,
      },
      "page2",
      1,
      { documentId: "doc", from: 3 },
    );
    expect(plan?.current).toBe(1);
  });
  it("treats an unknown future processing reference as missing, never as a fixed empty ID", () => {
    const plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "按分类选取",
            action: "select_candidates",
            input: { runId: "", groups: [{ count: 2, conditions: [] }] },
          },
        ],
      },
      1,
    );
    expect(plan?.steps[0]?.input).toEqual({
      groups: [{ count: 2, conditions: [] }],
    });
    expect(revisePlan(undefined, { executionMode: "execute" })).toBeUndefined();
  });
  it("restores an asset-page source while still rejecting another real asset", () => {
    const plan: ExecutionPlan = {
      mode: "execute",
      target: { kind: "asset", id: "A" },
      current: 0,
      steps: [
        {
          title: "读取原始资料",
          action: "read_records",
          scope: "all",
          status: "pending",
        },
      ],
    };
    const read = { readCount: 12, matchingTotal: 12, total: 12, offset: 0 };
    expect(
      advancePlan(
        plan,
        "read_records",
        { ...read, source: { kind: "assets", assetIds: ["A"] } },
        "receipt",
      )?.current,
    ).toBe(1);
    expect(
      advancePlan(
        plan,
        "read_records",
        { ...read, source: { kind: "assets", assetIds: ["B"] } },
        "receipt",
      )?.current,
    ).toBe(0);
    const restored = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [{ title: "读取资料", action: "read_records" }],
      },
      1,
      plan.target,
    );
    expect(restored?.steps[0]?.input?.source).toEqual({
      kind: "assets",
      assetIds: ["A"],
    });
    expect(
      revisePlan(restored, { executionMode: "execute" }, 2, {
        kind: "asset",
        id: "B",
      })?.steps[0]?.input?.source,
    ).toEqual({ kind: "assets", assetIds: ["B"] });
  });
  it("does not use another source's receipt to complete a legacy full read", () => {
    const plan: ExecutionPlan = {
      mode: "execute",
      target: { kind: "draft", id: "A" },
      current: 0,
      steps: [
        {
          title: "完整读取当前草稿",
          action: "read_records",
          scope: "all",
          status: "pending",
        },
      ],
    };
    expect(
      advancePlan(
        plan,
        "read_records",
        {
          source: { kind: "draft", id: "B" },
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(0);
    expect(
      advancePlan(
        plan,
        "read_records",
        {
          source: plan.target,
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(1);
    expect(
      advancePlan(
        { ...plan, target: undefined },
        "read_records",
        {
          source: { kind: "draft", id: "B" },
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        },
        "receipt",
      )?.current,
    ).toBe(0);
  });
  it("keeps committed adoption history without treating a changed destination as completed", () => {
    const input = { runId: "run", target: { kind: "draft", id: "A" } };
    const plan: ExecutionPlan = {
      mode: "execute",
      current: 1,
      requirementsKey: "old",
      steps: [
        {
          title: "采用到A",
          action: "request_processing_apply",
          input,
          status: "executed",
          receipt: { key: "receipt", proposalId: "proposal-A" },
        },
      ],
    };
    const changed = revisePlan(
      plan,
      {
        executionMode: "execute",
        steps: [
          {
            title: "采用到B",
            action: "request_processing_apply",
            input: { ...input, target: { kind: "draft", id: "B" } },
          },
        ],
      },
      2,
      undefined,
      "new",
    );
    expect(changed?.current).toBe(0);
    expect(changed?.steps[0]?.receipt).toBeUndefined();
    expect(plan.steps[0]?.receipt?.proposalId).toBe("proposal-A");
    expect(
      revisePlan(plan, { executionMode: "execute" }, 2, undefined, "new")
        ?.current,
    ).toBe(1);
  });
});
