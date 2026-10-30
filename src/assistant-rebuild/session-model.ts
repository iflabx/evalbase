import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ChatOpenAI } from "@langchain/openai";
import { configuredChatConnection, modelFetch } from "../model/connection.js";
import { sha256 } from "../package/contract.js";
import { ExecutionStore } from "./execution-store.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { observeModelStream } from "./model-stream.js";
export type ModelAttempt = {
  id: string;
  sessionId: string;
  turnId: string;
  purpose: "assistant" | "correction" | "summary" | "connection_test";
  correctionOf: string | null;
  requestHash: string;
};
export type ModelOutcome = {
  id: string;
  status: number | null;
  usage: unknown;
  error: string | null;
};
export type SessionModelHooks = {
  beforeRequest?: (attempt: ModelAttempt) => Promise<void>;
  afterResponse?: (result: ModelOutcome) => Promise<void>;
};

/** Model construction and transport only; execution admission/accounting stay in ExecutionStore. */
export function createSessionModel(options: {
  connection: Awaited<ReturnType<typeof configuredChatConnection>>;
  execution: ExecutionStore;
  store: SessionStore;
  proof: TurnProof;
  signal: AbortSignal;
  hooks?: SessionModelHooks;
  correctionOf: () => string | null;
}) {
  const { connection } = options;
  const transport = createSessionTransport(options);
  const model = () =>
    new ChatOpenAI({
      model: connection.model,
      apiKey: connection.apiKey,
      temperature: 0,
      maxTokens: 8192,
      maxRetries: 0,
      streaming: true,
      modelKwargs: { parallel_tool_calls: false },
      configuration: { baseURL: connection.baseURL, fetch: transport.fetch },
    });

  return {
    model: model(),
    callModel: <T>(call: () => Promise<T> | T) => transport.callModel(call),
    failure: transport.failure,
  };
}

export function createSessionTransport(
  options: Omit<Parameters<typeof createSessionModel>[0], "connection"> & {
    fetch?: typeof fetch;
    purpose?: ModelAttempt["purpose"];
  },
) {
  const { proof } = options;
  const { sessionId, turnId } = proof;
  const ctl = { signal: options.signal };
  const modelContext = new AsyncLocalStorage<"assistant">();
  let requestFailure: string | null = null;
  const fetchFor =
    () =>
    async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const correctionOf = options.correctionOf();
      await options.execution.guard(proof);
      const id = "request_" + randomUUID();
      const attempt: ModelAttempt = {
        id,
        sessionId,
        turnId,
        purpose:
          options.purpose ??
          (modelContext.getStore() === "assistant"
            ? correctionOf
              ? "correction"
              : "assistant"
            : "summary"),
        correctionOf:
          modelContext.getStore() === "assistant" ? correctionOf : null,
        requestHash: sha256(String(init?.body ?? "")),
      };
      await options.hooks?.beforeRequest?.(attempt);
      const admittedMs = await options.execution.reserve(proof, attempt);
      await options.store.event(proof, "model_request", attempt);
      let outcome: ModelOutcome = {
        id,
        status: null,
        usage: null,
        error: null,
      };
      requestFailure = null;
      const requestTimeout = AbortSignal.timeout(admittedMs);
      let streamingResponse = false;
      const finishStream = async (usage: unknown, error: string | null) => {
        if (error && !ctl.signal.aborted && requestTimeout.aborted) {
          error = "model_request_timeout";
          requestFailure =
            (await options.execution.blocked(sessionId)) ?? error;
        }
        outcome.usage = usage;
        outcome.error = error;
        await options.execution.outcome(outcome);
        await options.store.event(proof, "model_response", outcome);
        await options.hooks?.afterResponse?.(outcome);
      };
      try {
        const response = await (options.fetch ?? modelFetch)(url, {
          ...init,
          signal: AbortSignal.any([
            ctl.signal,
            requestTimeout,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        outcome.status = response.status;
        if (!response.ok) requestFailure = "provider_rejected";
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("text/event-stream") &&
          response.body
        ) {
          streamingResponse = true;
          return observeModelStream(
            response,
            async (text) => {
              await options.store.guard(proof);
              if (attempt.purpose !== "summary")
                await options.store.event(proof, "message_delta", {
                  requestId: id,
                  text,
                });
            },
            finishStream,
          );
        }
        const body = (await response.clone().json()) as {
          usage?: unknown;
        } | null;
        outcome = {
          id,
          status: response.status,
          usage: body?.usage ?? null,
          error: response.ok ? null : "provider_rejected",
        };
        return response;
      } catch (e) {
        outcome.error =
          !ctl.signal.aborted && requestTimeout.aborted
            ? "model_request_timeout"
            : "transport_failure";
        requestFailure =
          outcome.error === "model_request_timeout"
            ? ((await options.execution.blocked(sessionId)) ?? outcome.error)
            : outcome.error;
        if (outcome.error === "model_request_timeout")
          throw new SessionError(requestFailure ?? "model_request_timeout");
        throw e;
      } finally {
        if (!streamingResponse)
          await finishStream(outcome.usage, outcome.error);
      }
    };

  return {
    fetch: fetchFor(),
    callModel: <T>(call: () => Promise<T> | T) =>
      modelContext.run("assistant", call),
    failure: () => requestFailure,
  };
}
