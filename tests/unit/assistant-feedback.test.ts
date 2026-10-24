import { describe, it, expect } from "vitest";
import {
  assistantFeedback,
  progressMessage,
} from "../../src/assistant/feedback.js";
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

describe("StatusFix grounded progress", () => {
  const workspace = {
    projectId: "p",
    runs: [],
    drafts: [],
    confirmations: [{ id: "old", status: "invalid", runId: "r" }],
  };
  it("never advertises an invalid confirmation from historical model text", () => {
    const m = progressMessage(
      { stage: "stopped" },
      workspace,
      { canExecutePlan: false, reason: "permission_denied" },
      "等待你确认",
    );
    expect(m).toContain("任务已停止");
    expect(m).toContain("确认已失效");
    expect(m).not.toContain("等待你确认");
    expect(m).not.toContain("继续后将重新核对");
  });
  it("requires recovery eligibility before offering to rebuild confirmation", () => {
    expect(
      progressMessage({ stage: "stopped" }, workspace, {
        canExecutePlan: true,
        reason: "ready",
      }),
    ).toContain("继续后将重新核对");
  });
  it("keeps unknown submission outcome distinct from unsaved data", () => {
    const m = progressMessage(
      {},
      {
        ...workspace,
        confirmations: [{ id: "x", runId: "r", status: "executing" }],
      },
    );
    expect(m).toContain("提交正在核对");
    expect(m).not.toContain("尚未采用");
  });
  it("a newer usable card supersedes the invalid history for the same run", () => {
    const m = progressMessage(
      {},
      {
        ...workspace,
        confirmations: [
          { id: "new", runId: "r", status: "pending" },
          ...workspace.confirmations,
        ],
      },
    );
    expect(m).toContain("当前确认可用");
    expect(m).not.toContain("旧确认已失效");
  });
  it("the page feedback consumes the same expired-card facts", () => {
    const f = assistantFeedback(
      { stage: "awaiting_confirmation" },
      {
        ...ctx,
        workspace: {
          ...workspace,
          confirmations: [{ id: "old", runId: "r", status: "expired" }],
        },
      },
    );
    expect(f.kind).toBe("awaiting_review");
    expect(f.message).toContain("确认已失效");
    expect(f.message).not.toContain("操作已准备好");
  });
  it("progress facts do not replace a pending business clarification", () => {
    const f = assistantFeedback(
      { stage: "waiting_input", question: "要哪一类？" },
      { ...ctx, workspace },
    );
    expect(f.message).toBe("要哪一类？");
  });
  it("a committed legacy publication supersedes its invalid older card", () => {
    const message = progressMessage(
      { stage: "complete" },
      {
        ...workspace,
        confirmations: [
          {
            id: "new",
            operationKey: "publish:d",
            action: "publish",
            status: "succeeded",
            receipt: { version: { id: "v1", label: "v1" } },
          },
          { id: "old", operationKey: "publish:d", status: "invalid" },
        ],
      },
      undefined,
      "当前目标已完成，已保存成果可在工作区查看。",
    );
    expect(message).toContain("已发布");
    expect(message).not.toContain("确认已失效");
  });
});
