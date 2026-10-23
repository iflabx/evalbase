import { AssistantError } from "./store.js";
import { toolResultSummary } from "./context.js";

/** Conservative UTF-8 byte upper estimate, not a tokenizer; reserve output and envelope overhead. */
export function projectModelRequest(
  body: Record<string, any>,
  windowTokens: number,
) {
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 4096);
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) + output + 1024 <= windowTokens;
  const result = structuredClone(body);
  const messages = result.messages as Record<string, any>[];
  if (!Array.isArray(messages))
    throw new AssistantError(422, "assistant_context_capacity");
  if (fits(result)) return result;
  const facts = messages.findIndex(
    (m) =>
      typeof m.content === "string" && m.content.startsWith("当前持久事实："),
  );
  // Entire historical exchanges are optional. Current facts, pending intent, system and tool schema are not.
  if (facts > 0)
    result.messages = messages.filter(
      (m, i) =>
        m.role === "system" ||
        i >= facts ||
        (typeof m.content === "string" &&
          m.content.startsWith("近期交流") &&
          messages
            .slice(i + 1)
            .filter(
              (next) =>
                typeof next.content === "string" &&
                next.content.startsWith("近期交流"),
            ).length < 2),
    );
  if (fits(result)) return result;
  // Only bulky tool evidence may be reduced; the summary explicitly advertises rereading.
  const calls = new Map<string, { name: string; input: Record<string, any> }>();
  for (const message of result.messages)
    for (const call of message.tool_calls ?? []) {
      try {
        calls.set(call.id, {
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        });
      } catch {
        /* Keep opaque evidence unchanged. */
      }
    }
  for (const message of result.messages)
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      Buffer.byteLength(message.content) > 3000
    ) {
      const call = calls.get(message.tool_call_id);
      if (!call) continue;
      try {
        const value = JSON.parse(message.content);
        message.content = JSON.stringify(
          toolResultSummary(call.name, call.input, value),
        );
      } catch {
        /* Opaque repair evidence cannot be safely shortened. */
      }
    }
  if (!fits(result))
    throw new AssistantError(
      422,
      "assistant_context_capacity",
      "当前有效要求、待修改内容和工具定义超出模型输入窗口。要求与进度已保留，请按交付或步骤缩小本轮范围；未省略任何生效约束。",
    );
  return result;
}
/** Final provider boundary: shared by initial, incremental, SDK repair and recovery requests. */
export function boundedAssistantFetch(
  request: typeof fetch,
  windowTokens: number,
  onCapacity?: (error: AssistantError) => void,
): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string")
      throw new AssistantError(422, "assistant_context_capacity");
    let body;
    try {
      body = projectModelRequest(JSON.parse(init.body), windowTokens);
    } catch (error) {
      if (error instanceof AssistantError) onCapacity?.(error);
      throw error;
    }
    return request(input, { ...init, body: JSON.stringify(body) });
  };
}
