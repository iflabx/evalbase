import { describe, expect, it } from "vitest";
import { reviseRequirements } from "../../src/assistant/requirements.js";
import {
  bindTaskInput,
  availableTaskTools,
  planRequirementsKey,
  revisePlan,
  sourceWithinTask,
} from "../../src/assistant/plan.js";

describe("OPT-22 current task contract", () => {
  it.each(["做3条", "目标数量：3 条", "生成3条问题"])(
    "OPT33 removes the redundant saved count %s when the target changes",
    (countText) => {
      const current = {
        targetCount: 3,
        requirements: [countText, "保留事实", "不添加新信息"],
      };
      expect(reviseRequirements(current, { targetCount: 5 })).toMatchObject({
        targetCount: 5,
        requirements: ["保留事实", "不添加新信息"],
      });
      expect(
        reviseRequirements(current, {
          targetCount: 5,
          requirements: current.requirements,
        }).requirements,
      ).toEqual(["保留事实", "不添加新信息"]);
    },
  );
  it("OPT33 repairs a legacy target caption and preserves ambiguous processing scope until reconciled", () => {
    expect(
      reviseRequirements(
        { targetCount: 5, requirements: ["目标数量3条", "保留事实"] },
        { targetCount: 5 },
      ).requirements,
    ).toEqual(["保留事实"]);
    const current = {
      targetCount: 5,
      requirements: ["本次处理3条记录", "保留事实"],
    };
    expect(() => reviseRequirements(current, { targetCount: 5 })).toThrow(
      "assistant_requirement_conflict",
    );
    expect(
      reviseRequirements(current, {
        targetCount: 5,
        requirements: ["保留事实"],
      }).requirements,
    ).toEqual(["保留事实"]);
    const final = {
      targetCount: 100,
      countKind: "final" as const,
      requirements: ["本次处理3条记录", "其余97条保留", "新增3条问题"],
    };
    expect(
      reviseRequirements(final, { targetCount: 100 }).requirements,
    ).toEqual(final.requirements);
  });
  it("OPT33 preserves quotas, input scope, negation and semantic constraints containing numbers", () => {
    const requirements = [
      "每类至少3条",
      "输入包含3条记录",
      "每题保留3个要点",
      "整体交付3条",
      "不要生成3条",
      "处理3条并保留事实",
    ];
    expect(
      reviseRequirements({ targetCount: 3, requirements }, { targetCount: 5 })
        .requirements,
    ).toEqual(requirements);
    expect(
      reviseRequirements({ requirements: ["本次处理3条记录"] }, {})
        .requirements,
    ).toEqual(["本次处理3条记录"]);
  });

  it("compares real normalized requirements independently of order, duplicates and edge whitespace", () => {
    const task = {
      target: { kind: "draft", id: "D" },
      requirements: ["保留答案", "整理问题"],
      targetCount: 8,
    };
    const before = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          { title: "读取", action: "read_records" },
          { title: "核对", action: "read_processing", input: { runId: "R" } },
        ],
      },
      1,
      task.target,
      planRequirementsKey(task),
    )!;
    before.steps[0] = {
      ...before.steps[0]!,
      status: "executed",
      receipt: { key: "read" },
    };
    before.current = 1;
    const normalized = reviseRequirements(task, {
      requirements: [" 整理问题 ", "保留答案", "保留答案  "],
    });
    expect(planRequirementsKey({ ...task, ...normalized })).toBe(
      before.requirementsKey,
    );
    const after = revisePlan(
      before,
      { executionMode: "execute" },
      2,
      task.target,
      planRequirementsKey({ ...task, ...normalized }),
    )!;
    expect(after.current).toBe(1);
    expect(after.steps[0]?.receipt).toEqual({ key: "read" });
    expect(after.steps[0]?.id).toBe(before.steps[0]?.id);
    expect(
      planRequirementsKey({ ...task, requirements: ["改写答案", "整理问题"] }),
    ).not.toBe(before.requirementsKey);
  });
  it("revalidates changed rules without requiring another mode or steps payload", () => {
    const task = { requirements: ["保留原题"], targetCount: 8 };
    const before = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "处理",
            action: "submit_processing",
            input: { source: { kind: "assets", assetIds: ["A"] } },
          },
          { title: "核对", action: "read_processing", input: { runId: "R" } },
        ],
      },
      1,
      undefined,
      planRequirementsKey(task),
    )!;
    before.steps[0] = {
      ...before.steps[0]!,
      status: "executed",
      receipt: { key: "submit", runId: "R" },
    };
    before.steps[1] = {
      ...before.steps[1]!,
      status: "executed",
      receipt: { key: "review", runId: "R" },
    };
    const after = revisePlan(
      before,
      {},
      2,
      undefined,
      planRequirementsKey({ ...task, targetCount: 4 }),
    )!;
    expect(after.steps[0]?.receipt).toEqual(before.steps[0]?.receipt);
    expect(after.steps[1]?.status).toBe("pending");
    expect(after.requirementsKey).not.toBe(before.requirementsKey);
  });
  it("keeps step order meaningful while titles do not change an operation identity", () => {
    const steps = [
      { title: "查询", action: "query_project", input: { kind: "assets" } },
      {
        title: "读取",
        action: "read_records",
        input: { source: { kind: "assets", assetIds: ["A"] } },
      },
    ];
    const before = revisePlan(
      undefined,
      { executionMode: "execute", steps },
      1,
      undefined,
      "same",
    )!;
    before.steps[0] = {
      ...before.steps[0]!,
      status: "executed",
      receipt: { key: "query" },
    };
    expect(
      revisePlan(
        before,
        { steps: steps.map((s) => ({ ...s, title: "新标题" })) },
        2,
        undefined,
        "same",
      )?.steps[0]?.id,
    ).toBe(before.steps[0]?.id);
    expect(
      revisePlan(before, { steps: [...steps].reverse() }, 2, undefined, "same")
        ?.steps[0]?.id,
    ).not.toBe(before.steps[0]?.id);
  });
  it("binds current fixed facts once without broadening the selected input or protected fields", () => {
    const task = {
      target: { kind: "asset", id: "A" },
      targetCount: 8,
      countKind: "new",
      allowedFields: ["question"],
      processingScope: {
        source: { kind: "assets", assetIds: ["A"] },
        recordIds: ["A:3"],
        hash: "frozen",
      },
      runId: "R",
      targetDraftId: "D",
    };
    const supplied = { operation: "augment", instructions: "同类扩写" };
    expect(bindTaskInput("submit_processing", supplied, task)).toMatchObject({
      ...supplied,
      source: task.processingScope.source,
      allowedFields: ["question"],
      outputCount: 8,
    });
    expect(
      bindTaskInput("submit_processing", supplied, task),
    ).not.toHaveProperty("allRecords");
    expect(supplied).not.toHaveProperty("source");
    expect(
      bindTaskInput("refine_candidates", { instructions: "更口语" }, task),
    ).toMatchObject({ runId: "R", allowedFields: ["question"] });
    expect(bindTaskInput("request_publish", {}, task)).toMatchObject({
      draftId: "D",
    });
    expect(
      bindTaskInput(
        "plan_task",
        { countKind: "final" },
        { target: { kind: "draft", id: "D" } },
      ),
    ).toMatchObject({ targetDraftId: "D" });
    expect(
      bindTaskInput("submit_processing", supplied, {
        ...task,
        countKind: "final",
      }),
    ).not.toHaveProperty("outputCount");
  });
  it("preserves omission and clears only explicit requirements", () => {
    const current = {
      requirements: ["保留答案"],
      targetCount: 8,
      allowedFields: ["question"],
      classifications: [
        { field: "expectedOutput" as const, allowedValues: ["A"] },
      ],
    };
    expect(reviseRequirements(current, { targetCount: 4 })).toMatchObject({
      requirements: ["保留答案"],
      classifications: current.classifications,
    });
    expect(
      reviseRequirements(current, {
        requirements: [],
        targetCount: null,
        classifications: [],
      }),
    ).toMatchObject({
      requirements: [],
      targetCount: null,
      classifications: [],
    });
  });
  it("does not restore an explicitly revoked source from the previous step or selection", () => {
    const source = { kind: "assets", assetIds: ["A"] };
    const before = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [{ title: "处理", action: "submit_processing" }],
      },
      1,
      source,
      "old",
    )!;
    const after = revisePlan(before, {}, 2, null, "changed")!;
    expect(after.steps[0]?.input).not.toHaveProperty("source");
    expect(
      bindTaskInput(
        "submit_processing",
        { operation: "clean", instructions: "" },
        { target: null, executionPlan: after, processingScope: { source } },
      ),
    ).not.toHaveProperty("source");
  });
  it("projects phases from durable facts, keeping reads and correction but never confirmation authority", () => {
    const read = [
      "query_project",
      "read_records",
      "read_background",
      "plan_task",
    ];
    expect(
      availableTaskTools(
        { executionPlan: { mode: "plan", steps: [], current: 0 } },
        true,
      ),
    ).toEqual(read);
    expect(availableTaskTools({}, false)).toEqual([
      "query_project",
      "read_records",
    ]);
    const execute = availableTaskTools(
      {
        executionPlan: {
          mode: "execute",
          current: 0,
          steps: [{ action: "submit_processing", status: "pending" }],
        },
      },
      true,
    );
    expect(execute).toContain("submit_processing");
    expect(execute).toContain("read_background");
    expect(execute).not.toContain("request_publish");
    expect(
      availableTaskTools({ stage: "awaiting_confirmation", runId: "R" }, true),
    ).toEqual([...read, "read_processing"]);
    expect(
      availableTaskTools({ stage: "processing", runId: "R" }, true),
    ).not.toContain("submit_processing");
    expect(
      availableTaskTools({ stage: "awaiting_review", runId: "R" }, true),
    ).toContain("request_processing_apply");
  });
  it("inherits only supported keys and the actual selected run, allowing source subsets but no expansion", () => {
    const task = {
      runId: "latest",
      allowedFields: ["metadata"],
      metadataKeys: ["主题"],
      selectionPreview: { previewId: "P", draftId: "D" },
    };
    expect(
      bindTaskInput(
        "refine_candidates",
        { allSelected: true, instructions: "改主题" },
        task,
        undefined,
        { runId: "selected" },
      ),
    ).toEqual({
      runId: "selected",
      allSelected: true,
      instructions: "改主题",
      allowedFields: ["metadata"],
    });
    expect(
      bindTaskInput(
        "refine_candidates",
        { runId: "explicit" },
        task,
        undefined,
        { runId: "selected" },
      ).runId,
    ).toBe("explicit");
    expect(bindTaskInput("request_selection_apply", {}, task)).toEqual({
      previewId: "P",
      draftId: "D",
    });
    expect(availableTaskTools(task, true)).toContain("request_selection_apply");
    const target = { kind: "assets", assetIds: ["A", "B"] };
    expect(
      sourceWithinTask({ kind: "assets", assetIds: ["B", "A"] }, target),
    ).toBe(true);
    expect(sourceWithinTask({ kind: "assets", assetIds: ["A"] }, target)).toBe(
      true,
    );
    expect(
      sourceWithinTask({ kind: "assets", assetIds: ["A", "C"] }, target),
    ).toBe(false);
  });
});
