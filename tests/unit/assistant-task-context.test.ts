import { describe, it, expect } from "vitest";
import { taskBoundaryIntent } from "../../src/assistant/task-boundary.js";
import { bindTaskInput } from "../../src/assistant/plan.js";
import { projectModelRequest } from "../../src/assistant/request-context.js";
describe("OPT48 task and request boundaries", () => {
  it("accepts only explicit affirmative switching, never quoted/negated controls", () => {
    expect(taskBoundaryIntent("另开一个任务，创建退款测试集")).toBe("new");
    for (const text of [
      "不要另开任务，继续",
      "他说“另开一个任务”，什么意思",
      "继续",
      "改成3+2",
      "把名字改为新任务",
    ])
      expect(taskBoundaryIntent(text)).not.toBe("new");
  });
  it("bounds the whole payload while preserving facts, pending request and schemas", () => {
    const body: any = {
      messages: [
        { role: "system", content: "系统规则" },
        { role: "user", content: "旧失败".repeat(40000) },
        {
          role: "assistant",
          content:
            "当前持久事实：" +
            JSON.stringify({ requirements: ["约束".repeat(1000)] }),
        },
        { role: "user", content: "改为3+2，先不执行" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "plan_task", parameters: { type: "object" } },
        },
      ],
      max_tokens: 4096,
    };
    const projected = projectModelRequest(body, 24000);
    expect(
      Buffer.byteLength(JSON.stringify(projected)) + 4096,
    ).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(projected)).toContain("改为3+2");
    expect(JSON.stringify(projected)).toContain("约束".repeat(1000));
    expect(projected.tools).toEqual(body.tools);
  });
  it("rejects necessary facts exceeding capacity instead of truncating rules", () => {
    expect(() =>
      projectModelRequest(
        {
          messages: [
            { role: "system", content: "规则" },
            {
              role: "assistant",
              content: "当前持久事实：" + "约束".repeat(12000),
            },
            { role: "user", content: "继续" },
          ],
          max_tokens: 4096,
        },
        16000,
      ),
    ).toThrow("assistant_context_capacity");
  });
  it.each([9, 20])(
    "keeps all %i requirements and refuses an oversized derived execution parameter",
    (count) => {
      const task = {
        requirements: Array.from({ length: count }, (_, i) =>
          String(i).padEnd(1000, "x"),
        ),
      };
      const original = structuredClone(task);
      expect(() =>
        bindTaskInput("submit_processing", { operation: "rewrite" }, task),
      ).toThrow("assistant_context_capacity");
      expect(task).toEqual(original);
      expect(
        bindTaskInput(
          "submit_processing",
          { operation: "rewrite", instructions: "本轮明确限定的处理要求" },
          task,
        ).instructions,
      ).toBe("本轮明确限定的处理要求");
    },
  );
  it("keeps the last two exchanges when older optional history is dropped", () => {
    const recent = [1, 2, 3].map((n) => ({
      role: "assistant",
      content: "近期交流（只作指代证据）：方案" + n,
    }));
    const body = {
      messages: [
        { role: "system", content: "系统规则" },
        { role: "user", content: "旧信息".repeat(40000) },
        ...recent,
        { role: "assistant", content: "当前持久事实：当前生效合同" },
        { role: "user", content: "按你刚才说的第二种" },
      ],
      max_tokens: 1024,
    };
    const compact = JSON.stringify(projectModelRequest(body, 10000));
    expect(compact).not.toContain("指代证据）：方案1");
    expect(compact).toContain("指代证据）：方案2");
    expect(compact).toContain("指代证据）：方案3");
    expect(compact).toContain("当前生效合同");
  });
});
