import { describe, it, expect } from "vitest";
import { assistantFeedback } from "../../src/assistant/feedback.js";
const ctx = { revision: 3, hasBackground: false };
describe("OPT45 persistent feedback", () => {
  it("keeps the exact saved background question, including existing-material alternatives", () => {
    const question = "请上传背景文档，或使用已有原始资料进行扩充。";
    expect(
      assistantFeedback({ question, stage: "waiting_input" }, ctx),
    ).toMatchObject({
      kind: "input",
      message: question,
      action: "background",
      planReady: false,
    });
  });
  it("never treats an oral saved claim as a receipt", () => {
    expect(
      assistantFeedback(
        {
          stage: "failed",
          turnControl: { requiresUpdate: true, updateSaved: false },
        },
        ctx,
      ),
    ).toMatchObject({
      kind: "amendment",
      requirementsSaved: false,
      planReady: false,
    });
  });
  it("keeps a current saved plan visible when its summary fails", () => {
    const t = {
      stage: "failed",
      error: "assistant_model_failed",
      requirementSave: { taskRevision: 3, key: "actual" },
      executionPlan: { mode: "plan", steps: [{ action: "create_draft" }] },
    };
    expect(assistantFeedback(t, { ...ctx, summaryFailed: true })).toMatchObject(
      { kind: "plan", requirementsSaved: true, summaryFailed: true },
    );
    expect(
      assistantFeedback(t, { ...ctx, summaryFailed: true }).message,
    ).toContain("总结未完成");
  });
  it("does not mistake an older revision receipt for this amendment", () => {
    expect(
      assistantFeedback(
        {
          stage: "failed",
          planValidationRequired: true,
          requirementSave: { taskRevision: 2, key: "old" },
          executionPlan: { mode: "plan", steps: [{}] },
        },
        ctx,
      ),
    ).toMatchObject({
      kind: "amendment",
      requirementsSaved: false,
      planReady: false,
    });
  });
  it.each(["processing", "awaiting_confirmation", "complete"])(
    "uses real %s facts ahead of an old recovery notice",
    (stage) => {
      const f = assistantFeedback(
        { stage, recovery: { message: "旧暂停" } },
        ctx,
      );
      expect(f.kind).toBe(stage);
      expect(f.message).not.toContain("旧暂停");
    },
  );
  it("does not present a zero-result failed run as completed generation", () => {
    expect(
      assistantFeedback(
        {
          stage: "awaiting_review",
          checkedStatus: "failed",
          review: { total: 0 },
        },
        ctx,
      ),
    ).toMatchObject({ kind: "failed", planReady: false });
  });
});

describe("OPT45 review regressions", () => {
  it.each([
    "已生成2条，请确认采用",
    "方案已保存，请执行",
    "submit_processing 需要 allSelected 参数",
    "请提供 documentIds 和 outputCount 后再继续",
    "请使用 generate_candidates 工具",
  ])("does not trust model clarification %s", (question) => {
    const f = assistantFeedback({ question }, ctx);
    expect(f.message).toBe("请补充本次处理的具体要求，已有资料和成果保留。");
    expect(f.requirementsSaved).toBe(false);
  });
  it("shows the concrete validated business choice ahead of a saved plan", () => {
    expect(
      assistantFeedback(
        {
          requirementProblem: "分类配额共4条，与目标3条不一致，请确认数量。",
          requirementProblemKind: "business",
          requirementSave: { taskRevision: 3, key: "actual" },
          executionPlan: { mode: "plan", steps: [{}] },
        },
        ctx,
      ),
    ).toMatchObject({
      kind: "input",
      planReady: false,
      message: "分类配额共4条，与目标3条不一致，请确认数量。",
    });
  });
  it.each(["task_budget_exhausted", "no_progress"])(
    "keeps saved receipt and stopping reason %s",
    (recoveryReason) => {
      const f = assistantFeedback(
        {
          requirementSave: { taskRevision: 3, key: "actual" },
          executionPlan: { mode: "plan", steps: [{}] },
        },
        { ...ctx, recoveryReason },
      );
      expect(f).toMatchObject({
        kind: "blocked",
        requirementsSaved: true,
        planReady: false,
      });
      expect(f.message).toContain("方案已保存；");
      expect(f.message).toMatch(/限额|未取得新进展/);
    },
  );
  it.each(["publish", "processing"])(
    "does not invent the save destination for %s confirmation",
    (action) => {
      const f = assistantFeedback(
        { stage: "awaiting_confirmation", action },
        ctx,
      );
      expect(f.message).toBe("操作已准备好，请核对下方确认卡片。");
    },
  );
});

describe("OPT46 completion pending blockers", () => {
  it.each([
    "task_budget_exhausted",
    "permission_denied",
    "revision_changed",
    "background_changed",
    "context_changed",
    "repair_limit",
  ])("retains pending facts and the actual blocker %s", (reason) => {
    const f = assistantFeedback(
      {
        planValidationRequired: true,
        question: "请选择分类",
        requirementSave: { key: "old", taskRevision: 2 },
      },
      { ...ctx, recoveryReason: reason },
    );
    expect(f.kind).toBe(reason === "repair_limit" ? "amendment" : "blocked");
    expect(f.message).not.toContain("继续完成修改后再执行");
    expect(f.message).not.toBe("请选择分类");
    expect(f.requirementsSaved).toBe(false);
  });
});
