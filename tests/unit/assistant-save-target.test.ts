import { describe, expect, it } from "vitest";
import {
  namedSaveTarget,
  requestsProcessingSave,
  savedSaveTarget,
  newDraftSaveTarget,
} from "../../src/assistant/save-target.js";
import { bindPlanProposal } from "../../src/assistant/plan-preparation.js";
import {
  bindTaskInput,
  planRequirementsKey,
} from "../../src/assistant/plan.js";
import {
  refersToWholeSourceCount,
  prepareToolProposal,
  ruleCleanCommand,
} from "../../src/assistant/processing-preparation.js";

describe("processing output save target", () => {
  it("distinguishes saving a clean plan from saving its results", () => {
    expect(requestsProcessingSave("随机选1条，先保存清洗方案")).toBe(false);
    expect(requestsProcessingSave("保存清洗结果到新草稿")).toBe(true);
  });
  const target = { kind: "newDraft", name: "客服清洗结果" };
  it("records an early explicit name even when the model only saves wording", () => {
    const plan = bindPlanProposal(
      { requirements: ["清洗后保存"] },
      {},
      "清洗这2条后保存为新的测试集草稿，名字叫“客服清洗结果”。",
      1,
    );
    expect(plan.saveTarget).toEqual(target);
    expect(
      namedSaveTarget("不要保存为新测试集草稿“取消的名称”"),
    ).toBeUndefined();
    expect(namedSaveTarget("将任务名称改为“会话名”")).toBeUndefined();
    expect(
      namedSaveTarget("不要改其他内容，保存为新草稿“客服清洗结果”"),
    ).toEqual(target);
    expect(namedSaveTarget("不保存为新草稿“取消”")).toBeUndefined();
  });
  it("keeps structured and legacy names independent of chat titles and later scope answers", () => {
    const task = {
      saveTarget: target,
      title: "别的会话名",
      requirements: ["保存为新测试集草稿“旧名称”"],
    };
    expect(newDraftSaveTarget(task)).toEqual(target);
    expect(
      bindPlanProposal(
        { saveTarget: { kind: "newDraft", name: "模型新编的名称" } },
        task,
        "继续。",
        2,
      ).saveTarget,
    ).toEqual(target);
    expect(
      savedSaveTarget({
        title: "新任务",
        requirements: ["保存为新的测试集草稿“客服清洗结果”"],
      }),
    ).toEqual(target);
    expect(
      bindPlanProposal({}, task, "整份资料，就这2条都清洗", 2),
    ).not.toHaveProperty("saveTarget");
    expect(planRequirementsKey(task)).not.toBe(
      planRequirementsKey({
        ...task,
        saveTarget: { kind: "newDraft", name: "新的成果名" },
      }),
    );
  });
  it("normalizes all apply callers to the saved name and refuses a different destination kind", () => {
    const task = { saveTarget: target, runId: "run" };
    const supplied = {
      runId: "run",
      allValid: true,
      target: { kind: "newDraft", name: "新任务" },
    };
    expect(
      bindTaskInput("request_processing_apply", supplied, task).target,
    ).toEqual(target);
    const facts: any = { task, request: "保存", authorizedText: "保存" };
    const prepared = prepareToolProposal(
      "request_processing_apply",
      supplied,
      facts,
    );
    expect(prepared.ok && prepared.input.target).toEqual(target);
    const wrong = prepareToolProposal(
      "request_processing_apply",
      { ...supplied, target: { kind: "asset" } },
      facts,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok)
      expect(wrong.issues.some((i) => i.path === "/target")).toBe(true);
  });
  it("uses a source-based suggested name only when no output name exists", () => {
    expect(
      newDraftSaveTarget({ title: "旧任务", targetName: "资料.jsonl" }),
    ).toEqual({ kind: "newDraft", name: "资料.jsonl·处理结果" });
  });
  it.each([
    ["清洗这2条后保存", 2, true],
    ["清洗这2条后保存", 3, false],
    ["清洗这2条中的1条", 2, false],
    ["不要清洗这2条", 2, false],
    ["清洗2条", 2, false],
    ["处理选中的这2条", 2, false],
  ])(
    "binds a demonstrative count only against its confirmed source: %s",
    (text, count, expected) => {
      expect(refersToWholeSourceCount(String(text), Number(count))).toBe(
        expected,
      );
    },
  );
  it("removes only the absence marker for protected Metadata and keeps real key validation", () => {
    const facts: any = {
      task: { allowedFields: ["question"] },
      request: "其他内容不变",
      authorizedText: "其他内容不变",
    };
    const base = {
      source: { kind: "assets", assetIds: ["asset"] },
      operation: "clean",
      allRecords: true,
      instructions: "",
      allowedFields: ["question"],
    };
    const none = prepareToolProposal(
      "submit_processing",
      { ...base, metadataKeys: ["__none__"] },
      facts,
    );
    expect(none.ok && none.input.metadataKeys).toBeUndefined();
    expect(none.ok).toBe(true);
    const real = prepareToolProposal(
      "submit_processing",
      { ...base, metadataKeys: ["intent"] },
      facts,
    );
    expect(real.ok).toBe(false);
    const enabled = prepareToolProposal(
      "submit_processing",
      {
        ...base,
        operation: "rewrite",
        instructions: "统一指定字段的格式",
        allowedFields: ["metadata"],
        metadataKeys: ["__none__"],
      },
      {
        ...facts,
        request: "改写Metadata的__none__字段",
        authorizedText: "改写Metadata的__none__字段",
        task: { allowedFields: ["metadata"] },
        metadataKeys: ["__none__"],
      },
    );
    expect(enabled.ok, JSON.stringify(enabled)).toBe(true);
    if (enabled.ok) expect(enabled.input.metadataKeys).toEqual(["__none__"]);
  });
  it("compiled processing command ignores model re-expression and requires current requirements", () => {
    const input = {
      source: { kind: "assets", assetIds: ["asset"] },
      recordIds: ["r1", "r2"],
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
      cleanWhitespace: "trim_edges",
    };
    const task: any = {
      target: input.source,
      allowedFields: ["question"],
      saveTarget: target,
    };
    task.executionPlan = {
      mode: "execute",
      current: 0,
      steps: [
        {
          action: "submit_processing",
          input,
          command: { version: 1, preparation: { hash: "fixed" } },
        },
      ],
      requirementsKey: planRequirementsKey(task),
    };
    for (const metadataKeys of [undefined, [], ["__none__"], ["intent"]]) {
      expect(
        bindTaskInput(
          "submit_processing",
          {
            operation: "rewrite",
            source: { kind: "assets", assetIds: ["other"] },
            allRecords: true,
            metadataKeys,
          },
          task,
        ),
      ).toEqual(input);
    }
    task.allowedFields = ["metadata"];
    expect(
      bindTaskInput("plan_task", { requirements: ["新要求"] }, task),
    ).toEqual({ requirements: ["新要求"] });
    expect(bindTaskInput("query_project", { query: "资料" }, task)).toEqual({
      query: "资料",
    });
    expect(() => bindTaskInput("submit_processing", {}, task)).toThrow(
      /assistant_plan_revalidation_required/,
    );
  });
  it.each([
    "只去掉问题前后空格，其他不变，保存为新草稿“结果”",
    "第一份，全部两条，只去掉问题前后的空格，其他不变",
  ])(
    "compiles explicit rule intent without model execution fields: %s",
    (request) => {
      expect(ruleCleanCommand({ task: {}, request })).toEqual({
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
        cleanWhitespace: "trim_edges",
      });
    },
  );
  it.each([
    "整理这些数据",
    "只去掉问题前后空格，再去重",
    "只去掉问题前后空格，并翻译成英文",
    "只去掉问题前后空格，并修改Metadata分类",
    "只去掉问题前后空格，筛选退款记录",
    "不要去掉问题前后空格，其他不变",
    "只去掉问题前后空格，并且删除无效的记录",
    "只去掉问题前后空格，遇到未知符号时标记为待审核",
  ])(
    "does not turn incomplete or compound intent into a rule-only command: %s",
    (request) => {
      expect(ruleCleanCommand({ task: {}, request })).toBeUndefined();
    },
  );
});
