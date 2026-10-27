import { describe, it, expect } from "vitest";
import { observeModelStream } from "../../src/assistant-rebuild/model-stream.js";
describe("R04 actual provider streaming", () => {
  it("passes bytes unchanged, joins split UTF-8/data frames and meters the terminal usage once", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"已读取"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"真实资料"}}]}\n\n',
      'data: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n',
    ];
    const raw = new TextEncoder().encode(chunks.join(""));
    let i = 0;
    const texts: string[] = [],
      finished: unknown[] = [];
    const response = new Response(
      new ReadableStream({
        pull(c) {
          if (i >= raw.length) c.close();
          else c.enqueue(raw.slice(i, (i += 7)));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const observed = observeModelStream(
      response,
      async (t) => {
        texts.push(t);
      },
      async (u, e) => {
        finished.push({ u, e });
      },
    );
    expect(await observed.text()).toBe(chunks.join(""));
    expect(texts.join("")).toBe("已读取真实资料");
    expect(finished).toEqual([{ u: { total_tokens: 12 }, e: null }]);
  });
  it("does not display tool arguments or private reasoning as message text", async () => {
    const texts: string[] = [];
    const response = new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"private","tool_calls":[{"function":{"arguments":"secret"}}]}}]}\n\ndata: [DONE]\n\n',
    );
    await observeModelStream(
      response,
      async (t) => {
        texts.push(t);
      },
      async () => {},
    ).text();
    expect(texts).toEqual([]);
  });
  it("records one transport failure on cancellation", async () => {
    const results: unknown[] = [];
    const res = observeModelStream(
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
        }),
      ),
      async () => {},
      async (u, e) => {
        results.push(e);
      },
    );
    await res.body!.cancel();
    expect(results).toEqual(["transport_failure"]);
  });
});
