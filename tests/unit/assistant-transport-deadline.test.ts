import { describe, expect, it } from "vitest";
import {
  assistantTransport,
  requestTimeoutMs,
} from "../../src/assistant/transport.js";

describe("bounded model request deadline", () => {
  it("caps one request and reserves time to save recovery state", () => {
    expect(requestTimeoutMs(80000, 0)).toBe(50000);
    expect(requestTimeoutMs(80000, 55000)).toBe(15000);
    expect(requestTimeoutMs(80000, 75000)).toBe(1);
  });
  it("reports the request deadline reason when fetch rejects with a different abort error", async () => {
    const failures: unknown[] = [];
    const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const transport = assistantTransport(fetcher, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10050,
      beforeRequest: async () => undefined,
      onFailure: (error) => failures.push(error),
    });
    let thrown: unknown;
    try {
      await transport("https://example.test");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe("TimeoutError");
    expect(failures).toContain(thrown);
  });
});
