import { setTimeout as wait } from "node:timers/promises";
import { MODEL_RECOVERY_RESERVE_MS, requestFitsDeadline } from "./budget.js";

export const TIMEOUT_RETRY_REQUEST_MS = 20000;
export function requestTimeoutMs(deadlineAt: number, now = Date.now()) {
  return Math.max(
    1,
    Math.min(50000, deadlineAt - now - MODEL_RECOVERY_RESERVE_MS),
  );
}

export type RequestTiming = {
  id?: string;
  state:
    | "reserved"
    | "sent"
    | "headers"
    | "body"
    | "parsed"
    | "failed"
    | "not_sent";
  httpStatus: number | null;
  timeToHeadersMs: number;
  preflightMs?: number;
  bodyMs?: number;
  parseMs?: number;
  totalMs?: number;
  parseOk?: boolean;
  [key: string]: any;
};
async function boundedBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      chunks.push(part.value);
      length += part.value.byteLength;
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return all.buffer;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
/** One per logical turn; never retry the agent or a business operation. */
export function assistantTransport(
  request: typeof fetch,
  options: {
    signal: AbortSignal;
    deadlineAt: number;
    initialRetries?: number;
    retryLimit?: number;
    onAttempt?: (observation: RequestTiming) => Promise<void>;
    onObservation?: (observation: RequestTiming) => Promise<void>;
    beforeRequest: (attempt?: { timeoutRetry: boolean }) => Promise<void>;
    onRetry?: (value: {
      used: number;
      delayMs: number;
      httpStatus: number | null;
    }) => void | Promise<void>;
    onFailure?: (error: unknown) => void;
    onRecovered?: () => Promise<void>;
  },
): typeof fetch {
  let used = options.initialRetries ?? 0;
  return async (input, init) => {
    let retried = false;
    let timeoutRetried = false;
    const parent = AbortSignal.any([
      options.signal,
      ...(init?.signal ? [init.signal] : []),
    ]);
    for (;;) {
      parent.throwIfAborted();
      // An attempt has its own deadline; retrying never renews the parent turn.
      const signal = AbortSignal.any([
        parent,
        AbortSignal.timeout(requestTimeoutMs(options.deadlineAt)),
      ]);
      signal.throwIfAborted();
      if (Date.now() >= options.deadlineAt)
        throw new DOMException("Model deadline", "TimeoutError");
      const preflightAt = Date.now();
      await options.beforeRequest({ timeoutRetry: timeoutRetried });
      signal.throwIfAborted();
      const observation: RequestTiming = {
        state: "reserved",
        httpStatus: null,
        timeToHeadersMs: 0,
        preflightMs: Date.now() - preflightAt,
      };
      await options.onAttempt?.(observation);
      if (signal.aborted) {
        observation.state = "not_sent";
        await options.onObservation?.(observation);
        signal.throwIfAborted();
      }
      const requestAt = Date.now();
      let response: Response | undefined,
        complete: Response | undefined,
        failure: unknown;
      try {
        const pending = request(input, { ...init, signal });
        void pending.catch(() => undefined);
        observation.state = "sent";
        await options.onObservation?.(observation);
        response = await pending;
        observation.httpStatus = response.status;
        observation.timeToHeadersMs = Date.now() - requestAt;
        observation.state = "headers";
        await options.onObservation?.(observation);
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          // Buffer the bounded body before the SDK can validate or execute tools.
          const bodyAt = Date.now();
          const body = await boundedBody(response, signal);
          observation.bodyMs = Date.now() - bodyAt;
          observation.state = "body";
          const parseAt = Date.now();
          try {
            JSON.parse(new TextDecoder().decode(body));
            observation.parseOk = true;
          } catch {
            observation.parseOk = false;
          }
          observation.parseMs = Date.now() - parseAt;
          observation.totalMs = Date.now() - requestAt;
          observation.state = "parsed";
          await options.onObservation?.(observation);
          complete = new Response(body, {
            status: response.status,
            headers: response.headers,
            statusText: response.statusText,
          });
        }
      } catch (error) {
        observation.failurePhase = observation.state;
        if (observation.state === "headers")
          observation.bodyMs =
            Date.now() - requestAt - observation.timeToHeadersMs;
        observation.state =
          observation.state === "reserved" ? "not_sent" : "failed";
        observation.totalMs = Date.now() - requestAt;
        await options.onObservation?.(observation);
        options.onFailure?.(error);
        if (signal.aborted) options.onFailure?.(signal.reason);
        parent.throwIfAborted();
        failure = error;
        let cause = error,
          transient = false;
        let timedOut = signal.reason?.name === "TimeoutError";
        for (let i = 0; i < 5 && cause && typeof cause === "object"; i++) {
          timedOut ||= (cause as { name?: string }).name === "TimeoutError";
          transient ||= [
            "ECONNRESET",
            "ECONNREFUSED",
            "EPIPE",
            "ENOTFOUND",
            "EAI_AGAIN",
            "UND_ERR_SOCKET",
            "UND_ERR_CONNECT_TIMEOUT",
          ].includes(String((cause as { code?: string }).code));
          cause = (cause as { cause?: unknown }).cause;
        }
        if (timedOut) {
          if (
            timeoutRetried ||
            !requestFitsDeadline(options.deadlineAt, TIMEOUT_RETRY_REQUEST_MS)
          )
            throw error;
          timeoutRetried = true;
          transient = true;
        } else signal.throwIfAborted();
        if (!transient) throw error;
      }
      if (complete) {
        if (retried) await options.onRecovered?.();
        return complete;
      }
      if (response) {
        observation.totalMs = Date.now() - requestAt;
        observation.state = "failed";
        await options.onObservation?.(observation);
      }
      const header = response?.headers.get("retry-after")?.trim();
      const retryAfter =
        header && /^\d+$/.test(header)
          ? Number(header) * 1000
          : header &&
              /[a-z]/i.test(header) &&
              Number.isFinite(Date.parse(header))
            ? Math.max(0, Date.parse(header) - Date.now())
            : undefined;
      const delayMs = retryAfter ?? (used === 0 ? 500 : 1000);
      if (
        used >= (options.retryLimit ?? 2) ||
        delayMs >= options.deadlineAt - Date.now()
      ) {
        if (failure) throw failure;
        if (response) return response;
        throw failure;
      }
      await response?.body?.cancel().catch(() => undefined);
      used++;
      retried = true;
      await options.onRetry?.({
        used,
        delayMs,
        httpStatus: response?.status ?? null,
      });
      await wait(delayMs, undefined, { signal: parent });
    }
  };
}
