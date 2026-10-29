import {
  RequirementRepairError,
  type RequirementTargetBinding,
} from "./session-contract.js";
import { isGraphInterrupt } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { canonicalJson, sha256 } from "../package/contract.js";
import { BusinessError } from "../operations/errors.js";
import { SessionError } from "./session-store.js";
import {
  normalizeToolArguments,
  mergeToolCorrection,
} from "./tool-arguments.js";
export { explicitResumeRequest } from "./control-intent.js";
export type FailedCall = {
  id: string;
  name: string;
  args: unknown;
  workingArgs?: unknown;
  paths: string[][];
  attempts: number;
  removablePaths?: string[][];
  unparsed?: boolean;
  version?: 2;
  schemaHash?: string;
  kind?: "requirements";
  blockedReason?: string;
  targetBindings?: RequirementTargetBinding[];
  contexts?: { deliveryId: string; before: string; after: string }[];
};
const bindRecordedTargets = (
  value: unknown,
  bindings: RequirementTargetBinding[] = [],
) => {
  const args = structuredClone(value) as {
    changes?: {
      deliveries?: { deliveryId?: string; patch?: Record<string, unknown> }[];
    };
  } | null;
  for (const binding of bindings) {
    const item = args?.changes?.deliveries?.[binding.index];
    if (item) {
      const target = item.deliveryId
        ? bindings.find((b) => b.deliveryId === item.deliveryId)
        : binding;
      if (!target) continue;
      item.deliveryId ??= target.deliveryId;
      if (target.patch) {
        const inheritedFields = { ...target.patch };
        delete inheritedFields.instructions;
        item.patch = { ...inheritedFields, ...item.patch };
      }
    }
  }
  return args;
};
type Issue = {
  path: PropertyKey[];
  message: string;
  code: string;
  keys?: string[];
};
/** One boundary owns canonicalization, bounded repair and its durable working version. */
export function sessionFeedback(options: {
  schemas: Map<string, z.ZodType>;
  readOnlyTools?: Set<string>;
  initialPending?: FailedCall;
  savePending?: (p: FailedCall | undefined) => Promise<void>;
  facts: () => Promise<unknown>;
  executionControl?: () => Promise<{
    paused: boolean;
    resumeQueued: boolean;
    amendmentPending?: boolean;
    resumeAuthorized?: boolean;
  }>;
  initialStateRepairs?: number;
  requiredTool?: () => string | undefined;
  guard: () => Promise<void>;
  observe: (kind: string, detail: unknown) => Promise<void>;
  callModel: <T>(call: () => Promise<T> | T) => Promise<T> | T;
}) {
  let pending = options.initialPending;
  let stateRepairs = options.initialStateRepairs ?? 0;
  const executionTools = new Set([
    "submit_processing",
    "prepare_adoption",
    "wait_processing",
    "wait_confirmation",
  ]);
  const control = async () =>
    options.executionControl?.() ?? {
      paused: false,
      resumeQueued: false,
      amendmentPending: false,
      resumeAuthorized: false,
    };
  const stateFeedback = async (id: string, name: string) => {
    if (stateRepairs >= 1)
      throw new SessionError("state_reselection_exhausted", 409);
    stateRepairs++;
    await options.observe("state_feedback", {
      id,
      name,
      attempt: stateRepairs,
      code: "task_paused",
    });
    return new ToolMessage({
      tool_call_id: id,
      name,
      status: "error",
      content: JSON.stringify({
        error: {
          code: "task_paused",
          message:
            "本步骤未执行。原任务仍暂停。用户只问进度时使用read_task_progress；用户明确要求继续时使用continue_task。不得直接处理或准备保存，不得把查询视为继续或保存授权。",
        },
      }),
    });
  };
  const maxCorrections = 2;
  const schemaHash = (name: string) =>
    sha256(
      canonicalJson(
        z.toJSONSchema(options.schemas.get(name)!, { io: "input" }),
      ),
    );
  const normalize = (name: string, args: unknown, preserveMissing = false) => {
    const result = normalizeToolArguments(
      options.schemas.get(name)!,
      args,
      name,
      { applyDefaults: !preserveMissing },
    );
    if (result.unrecoverablePaths?.length)
      throw new BusinessError(
        422,
        "tool_arguments_invalid",
        "模型返回的参数结构不完整，无法安全恢复。本步骤未执行，请重试；已保存内容不受影响。",
      );
    if (result.conflicts?.length)
      throw new BusinessError(
        422,
        "tool_argument_shape_conflict",
        "同一交付的字段同时出现在两个位置且存在歧义，本步骤未执行。",
      );
    return result;
  };
  const checkContract = () => {
    if (pending && !options.schemas.has(pending.name))
      throw new BusinessError(
        403,
        "tool_not_allowed",
        "当前权限或工具能力已变化，本步骤未执行。",
      );
    if (pending?.schemaHash && pending.schemaHash !== schemaHash(pending.name))
      throw new BusinessError(
        409,
        "correction_contract_changed",
        "工具合同已经变化，请按当前要求重新发起操作；原数据和成果保留。",
      );
  };
  const readOnlyEmpty = (name: string) => {
    const s = z.toJSONSchema(options.schemas.get(name)!, { io: "input" });
    return (
      (options.readOnlyTools ?? new Set(["read_project"])).has(name) &&
      s.type === "object" &&
      Object.keys(s.properties ?? {}).length === 0
    );
  };
  const issuePaths = (issues: Issue[]) =>
    issues.flatMap((i) =>
      i.code === "unrecognized_keys"
        ? (i.keys ?? []).map((key) => [...i.path.map(String), key])
        : [i.path.map(String)],
    );
  const removable = (issues: Issue[]) =>
    issues.flatMap((i) =>
      i.code === "unrecognized_keys"
        ? (i.keys ?? []).map((key) => [...i.path.map(String), key])
        : [],
    );
  const unique = (paths: string[][]) => [
    ...new Map(paths.map((p) => [JSON.stringify(p), p])).values(),
  ];
  const clear = async () => {
    pending = undefined;
    await options.savePending?.(undefined);
  };
  const reject = async (
    id: string,
    name: string,
    reason: string,
    changedPaths: string[][] = [],
  ) => {
    await options.observe("correction_rejected", {
      originalCallId: pending?.id,
      callId: id,
      name,
      expectedTool: pending?.name,
      reason,
      invalidPaths: pending?.paths ?? [],
      changedPaths,
    });
    throw new BusinessError(
      422,
      "correction_intent_changed",
      "无法确认自动纠正仍符合原操作和处理范围，已停止该步骤。",
    );
  };
  const feedback = async (
    id: string,
    name: string,
    args: unknown,
    issues: Issue[],
  ) => {
    if (pending && pending.attempts >= maxCorrections)
      throw new SessionError("parameter_correction_exhausted", 422);
    pending = {
      ...pending,
      id: pending?.id ?? id,
      name,
      args: pending ? pending.args : args,
      workingArgs: args,
      paths: issuePaths(issues),
      attempts: (pending?.attempts ?? 0) + 1,
      removablePaths: unique([
        ...(pending?.removablePaths ?? []),
        ...removable(issues),
      ]),
      version: 2,
      schemaHash: schemaHash(name),
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
            "本次未执行。只修正列明的格式错误；未提供的原有效字段由服务端保留。不得新增或更改来源、数量、分类和保存目标。",
          ...detail,
        },
      }),
    });
  };
  const middleware = createMiddleware({
    name: "EvalBaseFormalToolBoundary",
    beforeModel: {
      canJumpTo: ["end"],
      hook: async () => {
        await options.guard();
        if ((await control()).resumeQueued)
          return {
            messages: [new AIMessage("已安排原任务继续。")],
            jumpTo: "end",
          };
      },
    },
    wrapModelCall: async (request, handler) => {
      await options.guard();
      checkContract();
      if (pending && pending.attempts > maxCorrections)
        throw new SessionError("parameter_correction_exhausted", 422);
      const executionState = await control();
      const tools = request.tools.filter(
        (t) =>
          "name" in t &&
          options.schemas.has(String(t.name)) &&
          !(
            executionState.paused &&
            (executionTools.has(String(t.name)) ||
              (t.name === "continue_task" && !executionState.resumeAuthorized))
          ) &&
          (!pending || t.name === pending.name),
      );
      await options.observe(
        "visible_tools",
        tools.map((t) => ("name" in t ? t.name : "")),
      );
      const current = new SystemMessage(
        "当前服务端事实（历史或摘要不能覆盖）：" +
          JSON.stringify(await options.facts()) +
          "\n执行控制：" +
          JSON.stringify(executionState) +
          "；resumeAuthorized为false时，不得恢复任务。需要继续时请用户明确发送继续或点击继续按钮。" +
          (pending
            ? "\n当前待纠正调用（工具声明给出完整结构，未提供的原有效字段由服务端保留）：" +
              JSON.stringify({
                originalCallId: pending.id,
                name: pending.name,
                originalArguments: pending.args,
                workingArguments: pending.workingArgs ?? pending.args,
                invalidPaths: pending.paths,
                unparsed: pending.unparsed ?? false,
                rule:
                  pending.kind === "requirements"
                    ? "本次用户变更已固定。仅修正列明的字段路径，遵循工具错误给出的业务要求；不能改变已明确的新数量、范围、目标、交付身份或其他有效字段。加工规则不重复范围/总数/目标。"
                    : "只修复原错误，不能新增或猜测ID、改变来源/记录范围/数量/分类/保存目标。一次只提交一个工具调用。",
                contexts: pending.contexts,
                blockedReason: pending.blockedReason,
              })
            : ""),
      );
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
          ...((pending?.name ?? options.requiredTool?.())
            ? {
                toolChoice: {
                  type: "function" as const,
                  function: {
                    name: pending
                      ? pending.name
                      : String(options.requiredTool?.()),
                  },
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
        if (!AIMessage.isInstance(last)) return;
        const invalid = [...(last.invalid_tool_calls ?? [])];
        for (const call of last.tool_calls ?? []) {
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
        const calls = [
          ...(last.tool_calls ?? []),
          ...(last.invalid_tool_calls ?? []),
        ];
        const ids = calls
          .map((c) => c.id)
          .filter((id): id is string => typeof id === "string");
        if (new Set(ids).size !== ids.length) {
          await options.observe("tool_response_rejected", {
            reason: "duplicate_tool_call_id",
            callCount: calls.length,
          });
          throw new BusinessError(
            422,
            "tool_call_identity_conflict",
            "模型返回了重复的操作标识，本响应的工具均未执行；输入和已记录要求保留。",
          );
        }
        if (calls.some((c) => !c.name || !options.schemas.has(c.name)))
          throw new SessionError("tool_not_allowed", 422);
        if (!invalid.length && calls.length <= 1) return;
        const first = calls[0];
        if (!first?.name || !last.id)
          throw new SessionError("tool_arguments_invalid", 422);
        const isInvalid = invalid.some((c) => c.id === first.id);
        if (
          pending &&
          (pending.name !== first.name || pending.attempts >= maxCorrections)
        )
          throw new SessionError("parameter_correction_exhausted", 422);
        if (!pending && isInvalid && !readOnlyEmpty(first.name)) {
          await options.observe("correction_rejected", {
            callId: first.id,
            name: first.name,
            reason: "original_arguments_unverifiable",
            changedPaths: [],
          });
          throw new BusinessError(
            422,
            "correction_intent_changed",
            "工具未返回可安全恢复的完整参数，本步骤未执行；请说明要继续处理的要求。",
          );
        }
        const args = pending
          ? pending.args
          : isInvalid
            ? null
            : normalize(first.name, first.args).args;
        const working = pending ? (pending.workingArgs ?? pending.args) : args;
        const parsed = isInvalid
          ? null
          : options.schemas.get(first.name)!.safeParse(working);
        pending = {
          ...pending,
          id: pending?.id ?? first.id ?? last.id,
          name: first.name,
          args,
          workingArgs: working,
          removablePaths:
            pending?.removablePaths ??
            (parsed && !parsed.success ? removable(parsed.error.issues) : []),
          paths:
            pending?.paths ??
            (parsed && !parsed.success ? issuePaths(parsed.error.issues) : []),
          unparsed: pending ? (pending.unparsed ?? false) : isInvalid,
          attempts: (pending?.attempts ?? 0) + 1,
          version: 2,
          schemaHash: schemaHash(first.name),
        };
        await options.savePending?.(pending);
        const reason =
          calls.length > 1 ? "multiple_tool_calls" : "invalid_json";
        await options.observe("parameter_feedback", {
          originalCallId: pending.id,
          name: first.name,
          attempt: pending.attempts,
          reason,
          ...(isInvalid
            ? { rawArguments: invalid.find((c) => c.id === first.id)?.args }
            : {}),
        });
        return {
          messages: [
            new AIMessage({
              id: last.id,
              content: "本响应的工具均未执行；需要先重提单个完整调用。",
              tool_calls: [],
            }),
            new HumanMessage({
              content:
                "仅重试工具 " +
                pending.name +
                "（原调用 " +
                pending.id +
                "），一次一个调用。按声明提供完整JSON；遗漏的原有效字段将保留，不更换来源、数量、分类或保存目标。",
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
      checkContract();
      const state = await control();
      if (
        state.paused &&
        (executionTools.has(call.name) ||
          (call.name === "continue_task" && !state.resumeAuthorized))
      ) {
        if (state.amendmentPending)
          throw new SessionError("requirements_amendment_pending", 409);
        return stateFeedback(id, call.name);
      }
      const normalized = normalize(call.name, call.args, !!pending);
      if (normalized.paths.length)
        await options.observe("parameter_normalized", {
          id,
          name: call.name,
          paths: normalized.paths,
          correctionOf: pending?.id ?? null,
        });
      let args = normalized.args;
      if (pending) {
        if (call.name !== pending.name)
          return reject(id, call.name, "tool_changed");
        if (pending.unparsed) {
          if (!readOnlyEmpty(call.name))
            return reject(id, call.name, "original_arguments_unverifiable");
        } else {
          const base = normalize(
            call.name,
            bindRecordedTargets(
              pending.workingArgs ?? pending.args,
              pending.targetBindings,
            ),
          ).args;
          args = bindRecordedTargets(args, pending.targetBindings);
          const merged = mergeToolCorrection(
            base,
            args,
            pending.removablePaths,
            (value) => normalize(call.name, value).args,
          );
          if (merged.changedPaths.length)
            return reject(
              id,
              call.name,
              "protected_arguments_changed",
              merged.changedPaths,
            );
          args = normalize(call.name, merged.args).args;
        }
      }
      const parsed = options.schemas.get(call.name)!.safeParse(args);
      if (!parsed.success)
        return feedback(id, call.name, args, parsed.error.issues);
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
        await clear();
        return result;
      } catch (error) {
        if (
          isGraphInterrupt(error) ||
          (error instanceof SessionError &&
            ["no_progress", "runtime_interrupted"].includes(error.code))
        )
          throw error;
        if (
          error instanceof SessionError &&
          error.code === "task_paused" &&
          executionTools.has(call.name)
        )
          return stateFeedback(id, call.name);
        if (error instanceof RequirementRepairError) {
          await options.observe("tool_error", {
            id,
            name: call.name,
            code: error.code,
          });
          if (pending && pending.attempts >= maxCorrections)
            throw new SessionError("parameter_correction_exhausted", 422);
          pending = {
            ...pending,
            id: pending?.id ?? id,
            name: call.name,
            args: pending?.args ?? parsed.data,
            workingArgs: parsed.data,
            paths: error.paths,
            removablePaths: error.paths,
            attempts: (pending?.attempts ?? 0) + 1,
            version: 2,
            schemaHash: schemaHash(call.name),
            kind: "requirements",
            contexts: error.contexts,
            targetBindings: error.targetBindings.length
              ? error.targetBindings
              : call.name === "update_requirements"
                ? error.contexts
                    .map((context, index) => ({
                      index: Number(error.paths[index]?.[2]),
                      deliveryId: context.deliveryId,
                    }))
                    .filter((binding) => Number.isInteger(binding.index))
                : [],
          };
          await options.savePending?.(pending);
          const detail = {
            originalCallId: pending.id,
            callId: id,
            name: call.name,
            attempt: pending.attempts,
            code: error.code,
            paths: error.paths,
            contexts: error.contexts,
          };
          await options.observe("requirements_feedback", detail);
          return new ToolMessage({
            tool_call_id: id,
            name: call.name,
            status: "error",
            content: JSON.stringify({
              error: { ...detail, message: error.hint },
            }),
          });
        }
        const failure = error as {
          code?: string;
          status?: number;
          hint?: string;
        };
        await options.observe("tool_error", {
          id,
          name: call.name,
          code: failure.code ?? "tool_failed",
        });
        if (
          typeof failure.status === "number" &&
          failure.status >= 400 &&
          failure.status < 500 &&
          typeof failure.code === "string"
        ) {
          if (
            ["create_requirements", "update_requirements"].includes(call.name)
          ) {
            pending = {
              ...pending,
              id: pending?.id ?? id,
              name: call.name,
              args: pending?.args ?? parsed.data,
              workingArgs: parsed.data,
              paths: pending?.paths ?? [],
              removablePaths: pending?.removablePaths ?? [],
              attempts: (pending?.attempts ?? 0) + 1,
              version: 2,
              schemaHash: schemaHash(call.name),
              kind: "requirements",
              blockedReason: failure.code,
            };
            await options.savePending?.(pending);
            await options.observe("requirements_blocked", {
              originalCallId: pending.id,
              code: failure.code,
            });
          } else await clear();
          throw error instanceof BusinessError
            ? error
            : new BusinessError(
                failure.status,
                failure.code,
                failure.hint?.slice(0, 2000),
              );
        }
        throw error;
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
