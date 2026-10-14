import { describe, expect, it } from "vitest";
import {
  conversationHistory,
  currentTaskFacts,
  toolResultSummary,
} from "../../src/assistant/context.js";
import { canonicalJson } from "../../src/package/contract.js";
import { advancePlan, type ExecutionPlan } from "../../src/assistant/plan.js";

describe("OPT-23 bounded current facts", () => {
  it("bounds historical prose and serializes optional user rules without undefined values", () => {
    const facts = currentTaskFacts({
      supplements: Array.from({ length: 6 }, () => "历史原话".repeat(4000)),
      classifications: [
        {
          field: "metadata",
          key: "类别",
          basis: "user",
          allowedValues: ["甲"],
        },
      ],
      requirements: ["当前有效要求"],
    });
    expect(() => canonicalJson(facts)).not.toThrow();
    expect(facts.requirements).toEqual(["当前有效要求"]);
    expect(Buffer.byteLength(canonicalJson(facts))).toBeLessThan(20000);
  });
  it("retains completion metadata for large read receipts and recovery", () => {
    const source = { kind: "draft", id: "draft" },
      read = toolResultSummary(
        "read_records",
        { source },
        { source, offset: 0, total: 15, matchingTotal: 15, readCount: 15 },
      ),
      plan: ExecutionPlan = {
        mode: "execute",
        current: 0,
        target: source,
        steps: [
          {
            title: "全量读取",
            action: "read_records",
            scope: "all",
            status: "pending",
            input: { source },
          },
        ],
      };
    expect(
      advancePlan(plan, "read_records", read, "read", undefined, { source })!
        .current,
    ).toBe(1);
    const waiting: ExecutionPlan = {
        mode: "execute",
        current: 0,
        steps: [
          {
            title: "处理",
            action: "submit_processing",
            status: "waiting",
            receipt: { key: "submitted", runId: "run" },
          },
        ],
      },
      result = toolResultSummary(
        "read_processing",
        { runId: "run" },
        { runId: "run", status: "succeeded", partial: false, missingCount: 0 },
      );
    expect(
      advancePlan(waiting, "read_processing", result, "done")!.current,
    ).toBe(1);
  });
  it("keeps current constraints and fixed identities without serializing record arrays", () => {
    const task = {
      goal: "原始要求",
      requirements: ["保留答案"],
      target: { kind: "assets", assetIds: ["asset"] },
      allowedFields: ["metadata"],
      metadataKeys: ["risk"],
      targetCount: 2,
      stage: "awaiting_review",
      supplements: ["撤销旧要求"],
      processingScope: {
        source: { kind: "assets", assetIds: ["asset"] },
        recordIds: Array.from({ length: 10000 }, (_, i) => String(i)),
        hash: "frozen",
        configuration: { method: "random", value: 2 },
      },
      selectedCandidates: { runId: "run", resultIds: ["0:0", "0:1"] },
    };
    const facts = currentTaskFacts(task);
    expect(facts).toMatchObject({
      requirements: ["保留答案"],
      allowedFields: ["metadata"],
      metadataKeys: ["risk"],
      targetCount: 2,
      processingScope: { count: 10000, hash: "frozen" },
      candidateSelection: {
        runId: "run",
        selectedCount: 2,
        useAllSelected: true,
      },
    });
    expect(facts.processingScope.recordIds).toBeUndefined();
    expect(facts.selectedCandidates).toBeUndefined();
    expect(JSON.stringify(facts).length).toBeLessThan(3000);
  });
  it("keeps a bounded reread reference and paired protocol for large results", () => {
    const row = {
      user_text: "查看",
      assistant_text: "已查看",
      tool_results: [
        {
          key: "receipt",
          name: "read_records",
          status: "succeeded",
          input: { source: { kind: "draft", id: "draft" }, offset: 0 },
          result: {
            total: 100,
            matchingTotal: 100,
            readCount: 10,
            nextOffset: 10,
            records: Array.from({ length: 10 }, () => ({
              question: "长正文".repeat(3000),
            })),
          },
        },
      ],
    };
    const messages = conversationHistory([row], (value) => value);
    const calls = messages.filter(
      (m) => m.role === "assistant" && Array.isArray(m.content),
    );
    const results = messages.filter((m) => m.role === "tool");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0].content as any)[0]).toMatchObject({
      toolCallId: "receipt",
      output: {
        value: {
          total: 100,
          nextOffset: 10,
          historySummary: true,
          readAgain: {
            tool: "read_records",
            input: { source: { kind: "draft", id: "draft" } },
          },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(6000);
  });
  it("never silently truncates effective requirements", () => {
    expect(() =>
      currentTaskFacts({ requirements: ["必须保留的要求".repeat(10000)] }),
    ).toThrow("assistant_context_capacity");
  });
});
