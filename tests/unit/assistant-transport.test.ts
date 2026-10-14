import { describe, it, expect, vi } from "vitest";
import { assistantTransport } from "../../src/assistant/transport.js";

describe("assistant transport budget", () => {
  it("shares two retries across separate requests and never changes their payload", async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("busy", { status: 503 }));
      const retry = vi.fn();
      const fetchModel = assistantTransport(call, {
        signal: AbortSignal.timeout(80000),
        deadlineAt: Date.now() + 80000,
        beforeRequest: async () => {},
        onRetry: retry,
      });
      const input = { method: "POST", body: "same request" };
      const first = fetchModel("http://model.test", input);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await first).status).toBe(503);
      expect(call).toHaveBeenCalledTimes(3);
      expect((await fetchModel("http://model.test", input)).status).toBe(503);
      expect(call).toHaveBeenCalledTimes(4);
      expect(retry.mock.calls.map(([value]) => value.delayMs)).toEqual([
        500, 1000,
      ]);
      expect(
        call.mock.calls.every(
          ([url, init]) =>
            url === "http://model.test" && init?.body === input.body,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([401, 403, 400, 501])(
    "does not retry deterministic HTTP %s",
    async (status) => {
      const call = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("rejected", { status }));
      const fetchModel = assistantTransport(call, {
        signal: AbortSignal.timeout(80000),
        deadlineAt: Date.now() + 80000,
        beforeRequest: async () => {},
      });
      expect((await fetchModel("http://model.test")).status).toBe(status);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it("does not sleep beyond the remaining deadline for Retry-After", async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      );
    const retry = vi.fn();
    const fetchModel = assistantTransport(call, {
      signal: AbortSignal.timeout(80000),
      deadlineAt: Date.now() + 80000,
      beforeRequest: async () => {},
      onRetry: retry,
    });
    expect((await fetchModel("http://model.test")).status).toBe(429);
    expect(call).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
  it("cancels backoff without sending another request", async () => {
    const controller = new AbortController();
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const fetchModel = assistantTransport(call, {
      signal: controller.signal,
      deadlineAt: Date.now() + 80000,
      beforeRequest: async () => {},
      onRetry: () => controller.abort(),
    });
    await expect(fetchModel("http://model.test")).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("checks revocation again before a retry", async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const guard = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("revoked"));
    const fetchModel = assistantTransport(call, {
      signal: AbortSignal.timeout(80000),
      deadlineAt: Date.now() + 80000,
      beforeRequest: guard,
    });
    await expect(fetchModel("http://model.test")).rejects.toThrow("revoked");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("retries a broken response body before any tool response can be read", async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
        },
      }),
    );
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response("complete"));
    const fetchModel = assistantTransport(call, {
      signal: AbortSignal.timeout(80000),
      deadlineAt: Date.now() + 80000,
      beforeRequest: async () => {},
    });
    expect(await (await fetchModel("http://model.test")).text()).toBe(
      "complete",
    );
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("does not replay a request when recording recovery fails", async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("complete"));
    const fetchModel = assistantTransport(call, {
      signal: AbortSignal.timeout(80000),
      deadlineAt: Date.now() + 80000,
      beforeRequest: async () => {},
      onRecovered: async () => {
        throw Object.assign(new Error("database"), { code: "ECONNRESET" });
      },
    });
    await expect(fetchModel("http://model.test")).rejects.toThrow("database");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("aborts an in-flight request at the shared deadline", async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_input, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener(
              "abort",
              () => reject(init!.signal!.reason),
              { once: true },
            ),
          ),
      );
    const fetchModel = assistantTransport(call, {
      signal: AbortSignal.timeout(30),
      deadlineAt: Date.now() + 30,
      beforeRequest: async () => {},
    });
    await expect(fetchModel("http://model.test")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
