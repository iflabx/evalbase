import { it, expect } from "vitest";
import { completeDocumentDeliveries } from "../../src/assistant/plan.js";
import {
  clarifiedRequest,
  explicitlyRequestsExecution,
} from "../../src/assistant/intent.js";
import { processingWorkflowSteps } from "../../src/assistant/processing-preparation.js";
it("B3 re-entry preserves completed generation without inserting an old confirmation", () => {
  const steps: any[] = [
    { title: "生成", action: "generate_candidates", status: "executed" },
    { title: "核对", action: "read_processing", status: "executed" },
    {
      title: "改写",
      action: "refine_candidates",
      status: "pending",
      input: { allSelected: true },
    },
    { title: "核对", action: "read_processing", status: "pending" },
  ];
  expect(completeDocumentDeliveries(steps, true)).toEqual(steps);
});
it("B3 clarification keeps the unfinished original delivery request, not an old complete plan", () => {
  const task = {
    goal: "做查物流和改地址两个测试集，各2条，现在开始。",
    question: "是否开始",
    executionPlan: { steps: [] },
  };
  expect(clarifiedRequest(task, "是，现在开始。")).toContain(task.goal);
  expect(
    clarifiedRequest(
      {
        ...task,
        question: null,
        executionPlan: { steps: [{ action: "generate_candidates" }] },
      },
      "改名为新名字",
    ),
  ).toBe("改名为新名字");
  expect(clarifiedRequest(task, "改成3条")).toBe("改成3条");
  expect(
    clarifiedRequest(
      {
        ...task,
        goal: "两类各2条",
        requirements: ["第一类3条，第二类2条"],
        executionPlan: {
          steps: [{ action: "generate_candidates", input: { outputCount: 3 } }],
        },
        question: "分类放Metadata吗？",
      },
      "是，放Metadata",
    ),
  ).toBe("是，放Metadata");
});
it("B3 a confirmed trim/dedup/rewrite request compiles actual ordered steps only in its authorized range", () => {
  const request =
    "先整理格式，去掉完全重复，再把问法改自然。补充：只去首尾空白，整份文件处理，不保存。";
  const source = { kind: "assets", assetIds: ["a"] };
  const steps = processingWorkflowSteps({
    source,
    request,
    wholeSource: true,
  })!;
  expect(steps.map((s) => s.action)).toEqual([
    "submit_processing",
    "select_candidates",
    "refine_candidates",
    "read_processing",
  ]);
  expect(steps[0].input).toMatchObject({
    source,
    allRecords: true,
    operation: "clean",
    allowedFields: ["question"],
  });
  expect(steps[1].input).toEqual({ deduplicate: true });
  expect(steps.some((s) => s.action.startsWith("request_"))).toBe(false);
  expect(
    processingWorkflowSteps({
      source,
      request: request + "不要把所有问句都改成请问开头。",
      wholeSource: true,
    })![2].input!.instructions,
  ).toContain("不要把所有问句都改成请问开头");
  expect(
    processingWorkflowSteps({ source, request, wholeSource: false }),
  ).toBeUndefined();
  expect(
    processingWorkflowSteps({
      source,
      request: request + "补充：不用去重。",
      wholeSource: true,
    }),
  ).toBeUndefined();
});

it("B3 saved cancellation remains later than the initial goal on an ordinary start", () => {
  const source = { kind: "assets", assetIds: ["a"] };
  const goal = "先整理格式，去掉完全重复，再把问法改自然";
  const requirements = ["只去首尾空白", "不用去重"];
  const request = [goal, ...requirements, "开始处理"].join("\n");
  expect(
    processingWorkflowSteps({ source, request, wholeSource: true }),
  ).toBeUndefined();
});

it("B3 removing a saved operation never borrows it back from the old goal", () => {
  const source = { kind: "assets", assetIds: ["a"] };
  const requirements = ["只去首尾空白", "把问法改自然"];
  expect(
    processingWorkflowSteps({
      source,
      request: requirements.join("，") + "\n开始处理",
      wholeSource: true,
    }),
  ).toBeUndefined();
});

it("an interrupted answer resumes only explicit execution permission", () => {
  expect(
    explicitlyRequestsExecution("期望回答由你拟定，按这个方案开始生成。 "),
  ).toBe(true);
  expect(explicitlyRequestsExecution("只生成2条即可")).toBe(true);
  expect(explicitlyRequestsExecution("先不要生成，只给方案")).toBe(false);
  expect(explicitlyRequestsExecution("生成步骤有哪些？")).toBe(false);
});
