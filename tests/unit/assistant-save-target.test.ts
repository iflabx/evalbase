import { describe, expect, it } from "vitest";
import {
  namedSaveTarget,
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
} from "../../src/assistant/processing-preparation.js";

describe("processing output save target", () => {
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
});
