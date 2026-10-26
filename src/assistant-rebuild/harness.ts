import {
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  StateBackend,
} from "deepagents";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

export function createHarness(options: {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  checkpointer?: BaseCheckpointSaver;
  guard?: () => Promise<void>;
  observe?: (kind: string, detail: unknown) => Promise<void>;
  summaryTokens?: number;
  complete?: () => Promise<string | null>;
  middleware?: AgentMiddleware[];
}) {
  const allowed = new Set(options.tools.map((t) => t.name));
  const backend = new StateBackend();
  const boundary = createMiddleware({
    name: "EvalBaseBusinessBoundary",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async () => {
        const completed = await options.complete?.();
        if (completed)
          return { messages: [new AIMessage(completed)], jumpTo: "end" };
      },
    },
    wrapModelCall: async (request, handler) => {
      await options.guard?.();
      let failures = 0;
      for (const message of [...request.messages].reverse()) {
        if (message.additional_kwargs?.evalbaseParameterError === true) {
          failures++;
          continue;
        }
        if (message.getType() === "tool") {
          if ("status" in message && message.status === "error") {
            failures++;
            continue;
          }
          break;
        }
        if (message.getType() === "human") break;
      }
      if (failures >= 3) throw new Error("parameter_correction_exhausted");
      const completed = request.messages
        .filter(
          (m) =>
            m.getType() === "tool" && !("status" in m && m.status === "error"),
        )
        .slice(-3);
      if (
        completed.length === 3 &&
        completed.every(
          (m) =>
            JSON.stringify(m.content) === JSON.stringify(completed[0].content),
        )
      )
        throw new Error("no_progress");
      const tools = request.tools.filter(
        (t) => "name" in t && allowed.has(String(t.name)),
      );
      await options.observe?.(
        "visible_tools",
        tools.map((t) => ("name" in t ? t.name : "")),
      );
      return handler({ ...request, tools });
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state) => {
        const last = state.messages.at(-1);
        if (!(last instanceof AIMessage)) return;
        const invalid = last.invalid_tool_calls ?? [];
        const writes = (last.tool_calls ?? []).filter((t) =>
          [
            "set_requirements",
            "submit_processing",
            "prepare_adoption",
          ].includes(t.name),
        );
        if (!invalid.length && writes.length <= 1) return;
        if (!last.id) throw new Error("tool_response_identity_missing");
        const detail = {
          invalid: invalid.map((t) => ({
            name: t.name,
            args: t.args,
            error: t.error,
          })),
          multipleMutations: writes.length > 1,
        };
        await options.observe?.("invalid_tool_arguments", detail);
        return {
          messages: [
            new AIMessage({
              id: last.id,
              content: "工具参数未通过检查，尚未执行。",
              tool_calls: [],
            }),
            new HumanMessage({
              content:
                "上一次工具调用未执行。请遵守当前工具Schema，补齐完整合法JSON后重新调用原操作；一次只调用一个修改业务状态的工具。错误详情：" +
                JSON.stringify(detail),
              additional_kwargs: { evalbaseParameterError: true },
            }),
          ],
          jumpTo: "model",
        };
      },
    },
    wrapToolCall: async (request, handler) => {
      if (!allowed.has(request.toolCall.name))
        throw new Error("tool_not_allowed");
      await options.guard?.();
      await options.observe?.("tool_call", {
        id: request.toolCall.id,
        name: request.toolCall.name,
        args: request.toolCall.args,
      });
      let result;
      try {
        result = await handler(request);
      } catch (error) {
        const failure = error as {
          code?: string;
          status?: number;
          message?: string;
        };
        await options.observe?.("tool_error", {
          name: request.toolCall.name,
          code: failure.code ?? failure.message,
          status: failure.status,
        });
        if (
          ["read_records", "read_background", "read_processing"].includes(
            request.toolCall.name,
          ) &&
          [404, 409, 422].includes(failure.status ?? 0) &&
          failure.code !== "project_not_found"
        ) {
          result = new ToolMessage({
            tool_call_id: request.toolCall.id!,
            name: request.toolCall.name,
            status: "error",
            content: JSON.stringify({
              error: {
                code: failure.code ?? "invalid_reference",
                message:
                  "读取未执行。请使用当前目录中的真实对象和有效范围；不要猜测引用或扩大范围。",
              },
            }),
          });
        } else throw error;
      }
      await options.observe?.("tool_result", result);
      return result;
    },
  });
  return createDeepAgent({
    model: options.model,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    checkpointer: options.checkpointer,
    backend,
    permissions: [
      { operations: ["read", "write"], paths: ["/**"], mode: "deny" },
    ],
    middleware: [
      createFilesystemMiddleware({
        backend,
        tools: ["read_file"],
        permissions: [
          { operations: ["read", "write"], paths: ["/**"], mode: "deny" },
        ],
      }),
      createSubAgentMiddleware({
        defaultModel: options.model,
        generalPurposeAgent: false,
        subagents: [],
      }),
      ...(options.summaryTokens
        ? [
            createSummarizationMiddleware({
              backend,
              trigger: { type: "tokens", value: options.summaryTokens },
              keep: { type: "messages", value: 4 },
            }),
          ]
        : []),
      boundary,
      ...(options.middleware ?? []),
    ],
  });
}
