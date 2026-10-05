import { describe, it, expect } from "vitest";
import { assistantReply } from "../../frontend-v3/src/lib/assistant-reply.js";
describe("assistant plain text presentation", () => {
  it("removes model formatting markers while preserving counts and readable Chinese diagnostics", () => {
    expect(
      assistantReply(
        "## 核对\n共 **100条**，`protectedFieldChanges`：0，outsideLabels：1。\n[查看结果](/internal/id)",
      ),
    ).toBe("核对\n共 100条，受保护字段变化：0，超出类别：1。\n查看结果");
  });
  it("turns small markdown tables into readable lines without creating HTML or model links", () => {
    expect(
      assistantReply(
        "| 类别 | 数量 |\n| --- | --- |\n| 指数分析 | 6 |\n| 指数对比 | 6 |",
      ),
    ).toBe("类别 · 数量\n指数分析 · 6\n指数对比 · 6");
    expect(assistantReply("<script>evil()</script>")).toBe(
      "<script>evil()</script>",
    );
  });
});
