/** Meter the actual provider SSE, forwarding bytes unchanged to the SDK. */
export function observeModelStream(
  response: Response,
  onText: (text: string) => Promise<void>,
  finish: (usage: unknown, error: string | null) => Promise<void>,
  onTool?: (call: { id: string; name: string; args: string }) => void,
): Response {
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    pending = "",
    usage: unknown = null,
    done = false;
  const tools = new Map<number, { id: string; name: string; args: string }>();
  const flush = async () => {
    if (pending) {
      const text = pending;
      pending = "";
      await onText(text);
    }
  };
  const complete = async (error: string | null) => {
    if (done) return;
    done = true;
    for (const call of tools.values()) onTool?.(call);
    try {
      await flush();
    } finally {
      await finish(usage, error);
    }
  };
  const parse = async () => {
    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      let data;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (data.usage) usage = data.usage;
      for (const choice of data.choices ?? []) {
        if (typeof choice.delta?.content === "string")
          pending += choice.delta.content;
        for (const t of choice.delta?.tool_calls ?? []) {
          const current = tools.get(t.index) ?? { id: "", name: "", args: "" };
          if (t.id) {
            if (current.id && current.id !== t.id)
              throw Error("provider_tool_identity_changed");
            current.id = t.id;
          }
          if (t.function?.name) current.name += t.function.name;
          if (t.function?.arguments) current.args += t.function.arguments;
          tools.set(t.index, current);
        }
      }
      if (pending.length >= 80) await flush();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          await parse();
          await complete(null);
          controller.close();
        } else {
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1000000)
            throw Error("provider_stream_frame_too_large");
          await parse();
          controller.enqueue(chunk.value);
        }
      } catch (e) {
        await complete("transport_failure");
        controller.error(e);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await complete("transport_failure");
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
