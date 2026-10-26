import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "langchain";
import { z } from "zod";
import { createHarness } from "../../src/assistant-rebuild/harness.js";
const calls: Record<string, any>[] = [];
let firstArguments: string | undefined;
let allBad = false,
  oneCall = false,
  goodArguments: Record<string, unknown> = { count: 3 };
beforeEach(() => {
  calls.length = 0;
  firstArguments = undefined;
  allBad = false;
  oneCall = false;
  goodArguments = { count: 3 };
});
let server: ReturnType<typeof createServer>, baseURL: string;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    calls.push(JSON.parse(body));
    const attempt = calls.length;
    const message =
      allBad || attempt <= (oneCall ? 1 : 2)
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_" + attempt,
                type: "function",
                function: {
                  name: "read_records",
                  arguments:
                    (attempt === 1 || allBad) && firstArguments !== undefined
                      ? firstArguments
                      : JSON.stringify(
                          attempt === 1 && !oneCall
                            ? { count: "不是数量" }
                            : goodArguments,
                        ),
                },
              },
            ],
          }
        : { role: "assistant", content: "已读取三条。" };
    if (calls.at(-1)?.stream) {
      res.setHeader("content-type", "text/event-stream");
      const packet = (delta: unknown, reason: string | null = null) =>
        "data: " +
        JSON.stringify({
          id: "fixture_" + attempt,
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: reason }],
        }) +
        "\n\n";
      if ("tool_calls" in message && message.tool_calls) {
        const t = message.tool_calls[0],
          args = t.function.arguments,
          half = Math.floor(args.length / 2);
        res.write(
          packet({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: t.id,
                type: "function",
                function: {
                  name: t.function.name,
                  arguments: args.slice(0, half),
                },
              },
            ],
          }),
        );
        res.write(
          packet({
            tool_calls: [
              { index: 0, function: { arguments: args.slice(half) } },
            ],
          }),
        );
      } else res.write(packet({ role: "assistant", content: message.content }));
      res.write(packet({}, "tool_calls" in message ? "tool_calls" : "stop"));
      res.end("data: [DONE]\n\n");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "fixture_" + attempt,
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message,
            finish_reason: attempt <= 2 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
});
afterAll(
  async () =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    ),
);
it("uses the real SDK to reject invalid input, feed the error back, and execute the corrected call once", async () => {
  const executed: number[] = [];
  const read = tool(
    async ({ count }) => {
      executed.push(count);
      return { count };
    },
    {
      name: "read_records",
      description: "读取指定数量",
      schema: z.object({ count: z.number().int().min(1).max(6) }).strict(),
    },
  );
  const agent = createHarness({
    model: new ChatOpenAI({
      apiKey: "local-fixture",
      model: "fixture",
      temperature: 0,
      maxRetries: 0,
      configuration: { baseURL },
    }),
    tools: [read],
    systemPrompt: "使用业务工具完成要求",
  });
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "查看前三条" }] },
    { recursionLimit: 16 },
  );
  expect(executed).toEqual([3]);
  expect(calls).toHaveLength(3);
  for (const request of calls)
    expect((request.tools as any[]).map((t) => t.function.name)).toEqual([
      "read_records",
    ]);
  expect(JSON.stringify(calls[1])).toMatch(/Error|error|invalid|number/);
  expect(result.messages.at(-1)?.content).toBe("已读取三条。");
});

it("feeds truncated JSON back through the real SDK and completes the corrected tool call", async () => {
  calls.length = 0;
  firstArguments = "{";
  const executed: number[] = [];
  const read = tool(
    async ({ count }) => {
      executed.push(count);
      return { count };
    },
    {
      name: "read_records",
      description: "读取指定数量",
      schema: z.object({ count: z.number().int().min(1).max(6) }).strict(),
    },
  );
  const agent = createHarness({
    model: new ChatOpenAI({
      apiKey: "local-fixture",
      model: "fixture",
      maxRetries: 0,
      configuration: { baseURL },
    }),
    tools: [read],
    systemPrompt: "读取前三条",
  });
  await agent.invoke(
    { messages: [{ role: "user", content: "查看前三条" }] },
    { recursionLimit: 16 },
  );
  expect(executed).toEqual([3]);
  expect(calls).toHaveLength(3);
});

it.each([
  { count: 3, unexpected: true },
  { count: [] },
  { count: { value: 3 } },
])(
  "rejects malformed shapes without executing an invalid business call: %j",
  async (invalid) => {
    firstArguments = JSON.stringify(invalid);
    const executed: number[] = [];
    const read = tool(
      async ({ count }) => {
        executed.push(count);
        return { count };
      },
      {
        name: "read_records",
        description: "读取数量",
        schema: z.object({ count: z.number().int().min(1).max(6) }).strict(),
      },
    );
    const agent = createHarness({
      model: new ChatOpenAI({
        apiKey: "local-fixture",
        model: "fixture",
        maxRetries: 0,
        configuration: { baseURL },
      }),
      tools: [read],
      systemPrompt: "查看前三条",
    });
    await agent.invoke(
      { messages: [{ role: "user", content: "查看前三条" }] },
      { recursionLimit: 20 },
    );
    expect(executed).toEqual([3]);
  },
);
it("preserves Chinese and nested arguments across actual streamed chunks", async () => {
  oneCall = true;
  goodArguments = {
    count: 3,
    filters: { label: "预约操作", flags: [true, false] },
  };
  const executed: unknown[] = [];
  const read = tool(
    async (args) => {
      executed.push(args);
      return { count: args.count };
    },
    {
      name: "read_records",
      description: "嵌套读取",
      schema: z
        .object({
          count: z.number().int(),
          filters: z
            .object({ label: z.string(), flags: z.array(z.boolean()) })
            .strict(),
        })
        .strict(),
    },
  );
  const agent = createHarness({
    model: new ChatOpenAI({
      apiKey: "local-fixture",
      model: "fixture",
      maxRetries: 0,
      streaming: true,
      configuration: { baseURL },
    }),
    tools: [read],
    systemPrompt: "读取预约操作",
  });
  await agent.invoke(
    { messages: [{ role: "user", content: "读取前三条预约操作" }] },
    { recursionLimit: 20 },
  );
  expect(executed).toEqual([goodArguments]);
  expect(calls).toHaveLength(2);
});
it.each(["{", JSON.stringify({ count: "无效" })])(
  "bounds repeated failures after two correction requests: %s",
  async (invalid) => {
    allBad = true;
    firstArguments = invalid;
    const read = tool(async ({ count }) => ({ count }), {
      name: "read_records",
      description: "读取数量",
      schema: z.object({ count: z.number().int().min(1).max(6) }).strict(),
    });
    const agent = createHarness({
      model: new ChatOpenAI({
        apiKey: "local-fixture",
        model: "fixture",
        maxRetries: 0,
        configuration: { baseURL },
      }),
      tools: [read],
      systemPrompt: "查看前三条",
    });
    await expect(
      agent.invoke(
        { messages: [{ role: "user", content: "查看前三条" }] },
        { recursionLimit: 40 },
      ),
    ).rejects.toThrow("parameter_correction_exhausted");
    expect(calls).toHaveLength(3);
  },
);
