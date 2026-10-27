import { isGraphInterrupt } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { canonicalJson } from "../package/contract.js";
import { SessionError } from "./session-store.js";
import { normalizeToolArguments } from "./tool-arguments.js";

export type FailedCall = {
  id: string;
  name: string;
  args: unknown;
  paths: string[][];
  attempts: number;
  removablePaths?: string[][];
  unparsed?: boolean;
};
/** One bounded correction path for the formal host; never stacked with validation-host repair. */
export function sessionFeedback(options: {
  schemas: Map<string, z.ZodType>;
  initialPending?: FailedCall;
  savePending?: (pending: FailedCall | undefined) => Promise<void>;
  facts: () => Promise<unknown>;
  guard: () => Promise<void>;
  observe: (kind: string, detail: unknown) => Promise<void>;
  callModel: <T>(call: () => Promise<T> | T) => Promise<T> | T;
}) {
  let pending: FailedCall | undefined = options.initialPending;
  const maxCorrections = 2;
  const scrub = (value: unknown, paths: string[][]): unknown => {
    const copy = structuredClone(value);
    for (const path of paths) {
      if (!path.length) return null;
      let cursor = copy as Record<string, unknown>;
      for (const key of path.slice(0, -1)) {
        if (!cursor || typeof cursor !== "object") break;
        cursor = cursor[key] as Record<string, unknown>;
      }
      if (cursor && typeof cursor === "object") delete cursor[path.at(-1)!];
    }
    return copy;
  };
  const changedPaths = (before: unknown, after: unknown) => {
    const paths: string[][] = [];
    const visit = (a: unknown, b: unknown, path: string[]) => {
      if (paths.length >= 12 || JSON.stringify(a) === JSON.stringify(b)) return;
      if (
        a !== null &&
        b !== null &&
        typeof a === "object" &&
        typeof b === "object" &&
        path.length < 12
      ) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
          visit(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            [...path, key],
          );
      } else paths.push(path);
    };
    visit(before, after, []);
    return paths;
  };
  const sameIntent = (name: string, args: unknown) => {
    if (!pending) return true;
    if (name !== pending.name) return false;
    // Truncated write arguments have no trustworthy semantic snapshot. Fail closed rather than invent intent.
    if (pending.unparsed) return name === "read_project";
    const schema = options.schemas.get(name)!;
    args = normalizeToolArguments(schema, args).args;
    const original = normalizeToolArguments(schema, pending.args).args;
    if (
      canonicalJson(scrub(args, pending.paths)) !==
      canonicalJson(scrub(original, pending.paths))
    )
      return false;
    const read = (value: unknown, path: string[]) =>
      path.reduce<unknown>(
        (v, k) =>
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined,
        value,
      );
    return pending.paths.every((path) => {
      const before = read(original, path),
        after = read(args, path);
      if (
        JSON.stringify(before) === JSON.stringify(after) ||
        (before !== null &&
          after !== null &&
          typeof before === "object" &&
          typeof after === "object" &&
          canonicalJson(before) === canonicalJson(after))
      )
        return true;
      if (after === undefined)
        return (pending?.removablePaths ?? []).some(
          (p) => JSON.stringify(p) === JSON.stringify(path),
        );
      // Only lossless representation repair is allowed; a type error is not permission to change a quantity.
      if (typeof before === "string" && typeof after === "number")
        return (
          before.trim() !== "" &&
          Number.isFinite(Number(before)) &&
          Number(before) === after
        );
      if (typeof before === "string" && typeof after === "boolean")
        return before === String(after);
      if (Array.isArray(after) && after.length === 1)
        return JSON.stringify(before) === JSON.stringify(after[0]);
      return false;
    });
  };
  const feedback = async (
    id: string,
    name: string,
    args: unknown,
    issues: {
      path: PropertyKey[];
      message: string;
      code: string;
      keys?: string[];
    }[],
  ) => {
    if (
      pending &&
      (!sameIntent(name, args) || pending.attempts >= maxCorrections)
    )
      throw new SessionError("parameter_correction_exhausted", 422);
    pending = {
      id: pending?.id ?? id,
      name,
      args: pending?.args ?? args,
      paths:
        pending?.paths ??
        issues.flatMap((i) =>
          i.code === "unrecognized_keys"
            ? (i.keys ?? []).map((key) => [...i.path.map(String), key])
            : [i.path.map(String)],
        ),
      attempts: (pending?.attempts ?? 0) + 1,
      removablePaths:
        pending?.removablePaths ??
        issues.flatMap((i) =>
          i.code === "unrecognized_keys"
            ? (i.keys ?? []).map((key) => [...i.path.map(String), key])
            : [],
        ),
    };
    await options.savePending?.(pending);
    const detail = {
      originalCallId: pending.id,
      callId: id,
      name,
      attempt: pending.attempts,
      issues: issues.map(({ path, message, code }) => ({
        path: path.map(String),
        message,
        code,
      })),
    };
    await options.observe("parameter_feedback", detail);
    return new ToolMessage({
      tool_call_id: id,
      name,
      status: "error",
      content: JSON.stringify({
        error: {
          code: "tool_arguments_invalid",
          message:
            "本次未执行。仅修正这些字段并重试同一工具；对象和数组必须使用JSON结构，不添加记录ID，不改来源、数量或保存目标。",
          ...detail,
        },
      }),
    });
  };
  const middleware = createMiddleware({
    name: "EvalBaseFormalToolBoundary",
    wrapModelCall: async (request, handler) => {
      await options.guard();
      if (pending && pending.attempts > maxCorrections)
        throw new SessionError("parameter_correction_exhausted", 422);
      const tools = request.tools.filter(
        (t) =>
          "name" in t &&
          options.schemas.has(String(t.name)) &&
          (!pending || t.name === pending.name),
      );
      await options.observe(
        "visible_tools",
        tools.map((t) => ("name" in t ? t.name : "")),
      );
      // Inject current authoritative facts after any framework summary; summary prose never replaces them.
      const current = new SystemMessage(
        "当前服务端事实（历史或摘要不能覆盖）：" +
          JSON.stringify(await options.facts()) +
          (pending
            ? "\n当前待纠正调用（仅修复该工具的格式，工具声明提供完整参数结构）：" +
              JSON.stringify({
                originalCallId: pending.id,
                name: pending.name,
                originalArguments: pending.args,
                invalidPaths: pending.paths,
                unparsed: pending.unparsed ?? false,
                rule: "保持来源、记录范围、数量、分类和保存目标；不能新增或猜测ID。",
              })
            : ""),
      );
      // Some OpenAI-compatible chat templates reject any System message after the first user.
      // Keep authority in one leading System message, without changing user/tool chronology.
      const systemMessages = [
        ...(request.systemMessage ? [request.systemMessage] : []),
        ...request.messages.filter((m) => m instanceof SystemMessage),
        current,
      ];
      const content = systemMessages.every((m) => typeof m.content === "string")
        ? systemMessages.map((m) => m.content).join("\n\n")
        : systemMessages.flatMap((m) =>
            typeof m.content === "string"
              ? [{ type: "text" as const, text: m.content }]
              : m.content,
          );
      return options.callModel(() =>
        handler({
          ...request,
          tools,
          ...(pending
            ? {
                toolChoice: {
                  type: "function" as const,
                  function: { name: pending.name },
                },
              }
            : {}),
          systemMessage: new SystemMessage({ content }),
          messages: request.messages.filter(
            (m) => !(m instanceof SystemMessage),
          ),
        }),
      );
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state) => {
        const last = state.messages.at(-1);
        if (!(last instanceof AIMessage)) return;
        if (
          (last.tool_calls ?? []).filter(
            (t) => t.name === "update_requirements",
          ).length > 1
        )
          throw new SessionError("multiple_requirement_updates", 422);
        const invalid = [...(last.invalid_tool_calls ?? [])];
        for (const call of last.tool_calls ?? []) {
          // SDK raw arguments precede its tolerant partial-JSON parser; do not race transport EOF.
          const raw = last.additional_kwargs.tool_calls?.find(
            (t) => t.id === call.id,
          )?.function.arguments;
          if (raw !== undefined) {
            try {
              JSON.parse(raw);
            } catch {
              invalid.push({
                id: call.id ?? "",
                name: call.name,
                args: raw,
                type: "invalid_tool_call",
              });
            }
          }
        }
        if (!invalid.length) return;
        const call = invalid[0]!;
        if (!last.id || !call.name || !options.schemas.has(call.name))
          throw new SessionError("tool_arguments_invalid", 422);
        if (
          pending &&
          (pending.name !== call.name || pending.attempts >= maxCorrections)
        )
          throw new SessionError("parameter_correction_exhausted", 422);
        pending = {
          id: pending?.id ?? call.id ?? last.id,
          name: call.name,
          args: pending ? pending.args : null,
          paths: pending?.paths ?? [],
          unparsed: pending?.unparsed ?? !pending,
          ...(pending?.removablePaths
            ? { removablePaths: pending.removablePaths }
            : {}),
          attempts: (pending?.attempts ?? 0) + 1,
        };
        await options.savePending?.(pending);
        await options.observe("parameter_feedback", {
          originalCallId: pending.id,
          name: call.name,
          attempt: pending.attempts,
          reason: "invalid_json",
          rawArguments: call.args,
        });
        return {
          messages: [
            new AIMessage({
              id: last.id,
              content:
                "工具 " + pending.name + " 的参数JSON不完整，本次未执行。",
              tool_calls: [],
            }),
            new HumanMessage({
              content:
                "上一工具 " +
                pending.name +
                "（原调用 " +
                pending.id +
                "）未执行。仅重试该工具并按其声明提供完整JSON；不能改变来源、数量、分类或保存目标。",
              additional_kwargs: { evalbaseCorrectionOf: pending.id },
            }),
          ],
          jumpTo: "model",
        };
      },
    },
    wrapToolCall: async (request, handler) => {
      const call = request.toolCall,
        id = call.id;
      if (!id || !options.schemas.has(call.name))
        throw new SessionError("tool_not_allowed", 422);
      await options.guard();
      const normalized = normalizeToolArguments(
        options.schemas.get(call.name)!,
        call.args,
      );
      if (normalized.paths.length)
        await options.observe("parameter_normalized", {
          id,
          name: call.name,
          paths: normalized.paths,
          correctionOf: pending?.id ?? null,
        });
      if (!sameIntent(call.name, normalized.args)) {
        await options.observe("correction_rejected", {
          originalCallId: pending?.id,
          callId: id,
          name: call.name,
          expectedTool: pending?.name,
          reason:
            call.name !== pending?.name
              ? "tool_changed"
              : pending?.unparsed
                ? "original_arguments_unverifiable"
                : "protected_arguments_changed",
          invalidPaths: pending?.paths ?? [],
          changedPaths:
            pending && !pending.unparsed
              ? changedPaths(
                  normalizeToolArguments(
                    options.schemas.get(pending.name)!,
                    pending.args,
                  ).args,
                  normalized.args,
                )
              : [],
        });
        throw new SessionError("correction_intent_changed", 422);
      }
      const parsed = options.schemas.get(call.name)!.safeParse(normalized.args);
      if (!parsed.success)
        return feedback(id, call.name, normalized.args, parsed.error.issues);
      await options.observe("tool_call", {
        id,
        name: call.name,
        args: parsed.data,
        correctionOf: pending?.id ?? null,
      });
      try {
        const result = await handler({
          ...request,
          toolCall: { ...call, args: parsed.data as Record<string, unknown> },
        });
        await options.observe("tool_result", { id, name: call.name, result });
        pending = undefined;
        await options.savePending?.(pending);
        return result;
      } catch (error) {
        if (
          isGraphInterrupt(error) ||
          (error instanceof SessionError &&
            ["no_progress", "runtime_interrupted"].includes(error.code))
        )
          throw error;
        const failure = error as {
          code?: string;
          status?: number;
          message?: string;
        };
        await options.observe("tool_error", {
          id,
          name: call.name,
          code: failure.code ?? "tool_failed",
        });
        // Conflicts and authorization failures are not parameter errors: never fetch a fresh revision to overwrite.
        if (
          (failure.status ?? 500) >= 500 ||
          failure.status === 409 ||
          failure.status === 403 ||
          failure.code === "project_not_found"
        )
          throw error;
        if (pending && pending.attempts >= maxCorrections)
          throw new SessionError("parameter_correction_exhausted", 422);
        pending = {
          id: pending?.id ?? id,
          name: call.name,
          args: call.args,
          paths: [],
          attempts: (pending?.attempts ?? 0) + 1,
        };
        await options.savePending?.(pending);
        return new ToolMessage({
          tool_call_id: id,
          name: call.name,
          status: "error",
          content: JSON.stringify({
            error: {
              code: failure.code ?? "tool_failed",
              message:
                "未执行，请核对当前可见对象及要求；不能通过重试更换范围或目标。",
              originalCallId: pending.id,
            },
          }),
        });
      }
    },
  });
  return {
    middleware,
    assertResolved: () => {
      if (pending)
        throw new SessionError("parameter_correction_incomplete", 422);
    },
  };
}
