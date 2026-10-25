import { requestedDeliveryShape } from "../../src/assistant/delivery-plan.js";
import { describe, it, expect } from "vitest";
import { deliveryRequest } from "../../src/assistant/delivery-request.js";
import { reconcileExecutionConfirmations } from "../../src/assistant/receipts.js";
import { assistantFailure } from "../../src/assistant/diagnostics.js";
const goals = [
  { id: "a", name: "查物流测试集" },
  { id: "b", name: "改地址测试集" },
];
describe("B4c cancellation and confirmation contract", () => {
  it.each([
    "第二个改地址测试集不要了，保留已经保存的查物流测试集，其他先不做。",
    "第二份不要了，第一份保留。",
    "取消改地址测试集，保留查物流测试集。",
  ])("resolves ordinary cancellation %s", (request) => {
    expect(
      deliveryRequest(goals, request)
        .filter((c) => c.operation === "remove")
        .flatMap((c) => c.targets.map((g) => g.id)),
    ).toEqual(["b"]);
  });
  it.each([
    "不要取消第二份",
    "第二份不取消",
    "不用取消第二份",
    "不删除第二份",
    "无需取消第二份",
    "第二份先不做",
    "能不能取消第二份？",
    "如果取消第二份",
    "删除第三份",
    "取消第一份改地址测试集",
  ])("does not authorize %s", (request) => {
    expect(
      deliveryRequest(goals, request)
        .filter((c) => c.operation === "remove")
        .flatMap((c) => c.targets),
    ).toEqual([]);
  });
  it.each(["第二个改地址测试集不要了", "第12个测试集不要了", "第二份保留"])(
    "ordinal is not collection count: %s",
    (text) => expect(requestedDeliveryShape(text).count).toBeUndefined(),
  );
  const fixture = () => {
    const run = "r";
    const draft = "new";
    const proposal = {
      id: "p",
      status: "succeeded",
      task_revision: 3,
      summary: { range: "task" },
      parameters: { runId: run, target: { kind: "newDraft", name: "新名称" } },
      receipt: { receipt: { runId: run, draftId: draft, adopted: 2 } },
    };
    const task = {
      stage: "awaiting_confirmation",
      checkedStatus: "succeeded",
      runId: run,
      executionPlan: {
        contractVersion: 1,
        mode: "execute",
        current: 1,
        needsReview: false,
        steps: [
          {
            id: "g",
            deliveryId: "d",
            action: "generate_candidates",
            status: "executed",
            input: { outputCount: 2 },
            receipt: { runId: run, draftId: "old" },
          },
          {
            id: "s",
            deliveryId: "d",
            action: "request_processing_apply",
            status: "waiting",
            revision: 3,
            input: { runId: run, target: { kind: "newDraft", name: "新名称" } },
            receipt: { key: "k", proposalId: "p" },
          },
        ],
      },
    };
    const session = {
      id: "s",
      project_id: "project",
      actor_id: "user",
      task_revision: 3,
      task,
    };
    const db = {
      query: async (sql: string) => ({
        rows: sql.includes("assistant_proposal")
          ? [proposal]
          : [{ tool_results: [] }],
        rowCount: 1,
      }),
    };
    return { session, proposal, db };
  };
  it("settles new-draft save without using the generation draft", async () => {
    const f = fixture();
    const t = await reconcileExecutionConfirmations(f.db as any, f.session);
    expect(t.stage).toBe("complete");
    expect(t.executionPlan.steps.at(-1).receipt.draftId).toBe("new");
  });
  it.each(["run", "target", "revision", "count", "status"])(
    "rejects mismatching confirmation %s",
    async (kind) => {
      const f = fixture();
      if (kind === "run") f.proposal.parameters.runId = "other";
      if (kind === "target") f.proposal.parameters.target.name = "other";
      if (kind === "revision") f.proposal.task_revision = 2;
      if (kind === "count") f.proposal.receipt.receipt.adopted = 1;
      if (kind === "status") f.proposal.status = "pending";
      const t = await reconcileExecutionConfirmations(f.db as any, f.session);
      expect(t.stage).toBe("awaiting_confirmation");
    },
  );
  it("settlement diagnostics do not blame permission", () => {
    expect(
      assistantFailure({ hint: "complete" }, "assistant_retry_unavailable")
        .category,
    ).toBe("completion_settlement");
  });
});
