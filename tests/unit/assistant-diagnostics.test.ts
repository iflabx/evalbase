import { describe, expect, it } from "vitest";
import { assistantFailure } from "../../src/assistant/diagnostics.js";
import { taskPresentation } from "../../src/assistant/store.js";

describe("assistant diagnostic metadata", () => {
  it("OPT-26 treats untyped historical hints as diagnostics and retains typed business feedback", () => {
    expect(
      taskPresentation({
        title: "旧任务",
        requirementProblem: "old internal hint",
      })!.requirementProblemKind,
    ).toBe("diagnostic");
    expect(
      taskPresentation({
        title: "业务冲突",
        requirementProblem: "数量冲突",
        requirementProblemKind: "business",
      })!.requirementProblemKind,
    ).toBe("business");
  });
  it.each([
    ["assistant_no_progress", "application", "workflow_stalled"],
    ["assistant_budget_exhausted", "budget", "budget_exhausted"],
    ["assistant_task_not_executed", "application", "workflow_incomplete"],
    ["model_connection_unavailable", "model", "provider_rejected"],
    ["assistant_operation_failed", "application", "internal_error"],
    ["assistant_context_changed", "business", "conflict"],
    ["assistant_scope_invalid", "tool", "parameter_invalid"],
    ["assistant_forbidden", "business", "permission_or_source"],
  ])("classifies %s without storing error text", (code, layer, category) => {
    const diagnostic = assistantFailure(new Error("private-canary"), code);
    expect(diagnostic).toMatchObject({ layer, category });
    expect(JSON.stringify(diagnostic)).not.toContain("private-canary");
  });

  it("classifies bounded output separately from configuration and handles error causes", () => {
    const error = new Error("private-response", {
      cause: Object.assign(new Error("private-body"), {
        code: "model_response_too_large",
      }),
    });
    expect(assistantFailure(error, "assistant_model_failed")).toMatchObject({
      layer: "model",
      category: "output_protocol",
    });
    expect(
      JSON.stringify(assistantFailure(error, "assistant_model_failed")),
    ).not.toContain("private-");
    expect(
      assistantFailure(new Error("unknown-internal"), "assistant_model_failed")
        .layer,
    ).toBe("application");
    expect(
      assistantFailure(
        Object.assign(new Error("invalid application prompt"), {
          name: "AI_InvalidPromptError",
        }),
        "assistant_model_failed",
      ).layer,
    ).toBe("application");
  });

  it("does not recommend replaying an operation with an uncertain effect", () => {
    expect(
      assistantFailure({}, "assistant_scope_invalid", { effect: "unknown" })
        .nextAction,
    ).toContain("先核对真实操作回执");
  });

  it("requires provider origin before classifying transport failures", () => {
    const network = Object.assign(new Error("private-db"), {
      code: "ECONNRESET",
    });
    const timeout = Object.assign(new Error("private-db"), {
      name: "TimeoutError",
    });
    for (const error of [network, timeout]) {
      expect(assistantFailure(error, "assistant_model_failed").layer).toBe(
        "application",
      );
      expect(
        assistantFailure(error, "assistant_model_failed", undefined, true)
          .layer,
      ).toBe("model");
    }
    expect(
      assistantFailure({ statusCode: 503 }, "assistant_model_failed"),
    ).toMatchObject({ layer: "application", httpStatus: null });
  });
  it("OPT-26 keeps parameter repair with the assistant and identifies unavailable sources", () => {
    const invalid = assistantFailure({}, "assistant_tool_input_invalid", {
      effect: "none",
    });
    expect(invalid.nextAction).not.toContain("具体字段");
    expect(invalid.nextAction).toContain("重试");
    expect(assistantFailure({}, "assistant_reference_invalid").category).toBe(
      "permission_or_source",
    );
    expect(
      assistantFailure({}, "assistant_context_unavailable").nextAction,
    ).not.toContain("新建会话");
  });
  it.each(["assistant_background_capacity", "assistant_budget_exhausted"])(
    "OPT38 preserves the actionable evidence-capacity cause for %s",
    (code) => {
      const result = assistantFailure(new Error("private-document"), code, {
        effect: "none",
        error: { code: "assistant_background_capacity" },
      });
      expect(result).toMatchObject({
        layer: "business",
        category: "background_capacity",
      });
      expect(result.reason).toContain("文档依据");
      expect(result.nextAction).toContain("收拢相关章节");
      expect(JSON.stringify(result)).not.toContain("private-document");
    },
  );
});
