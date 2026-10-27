import type { ServerResponse } from "node:http";
/** Controlled provider uses the same OpenAI wire contract as the real SDK. */
export async function sendFormalCompletion(
  res: ServerResponse,
  body: { stream?: boolean },
  message: any,
  omitUsage = false,
) {
  const id = "controlled_response";
  const usage = omitUsage
    ? undefined
    : { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
          },
        ],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  if (message.bodyDelayMs)
    await new Promise((r) => setTimeout(r, message.bodyDelayMs));
  const emit = (delta: any, finish_reason: string | null = null) =>
    res.write(
      "data: " +
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  emit({ role: "assistant" });
  if (message.content)
    for (let i = 0; i < message.content.length; i += 3)
      emit({ content: message.content.slice(i, i + 3) });
  if (message.tool_calls)
    emit({
      tool_calls: message.tool_calls.map((call: any, index: number) => ({
        ...call,
        index,
      })),
    });
  emit({}, message.tool_calls?.length ? "tool_calls" : "stop");
  if (usage)
    res.write("data: " + JSON.stringify({ id, choices: [], usage }) + "\n\n");
  res.end("data: [DONE]\n\n");
}
