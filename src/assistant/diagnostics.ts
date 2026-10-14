import { modelFailure } from "../processing/recovery.js";

export type AssistantFailure = {
  layer: "model" | "tool" | "business" | "application" | "budget";
  category: string;
  httpStatus: number | null;
  reason: string;
  nextAction: string;
};

/** Whitelist metadata only. Never persist provider bodies, exception messages or prompts. */
export function assistantFailure(
  error: unknown,
  code: string,
  toolFailure?: { effect?: string; error?: { code?: string } },
  modelTransportFailure = false,
): AssistantFailure {
  const chain: { name?: string; statusCode?: number; code?: string }[] = [];
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  const provider = chain.find(
    (e) =>
      Number.isInteger(e.statusCode) &&
      e.statusCode! >= 400 &&
      e.statusCode! <= 599,
  );
  const modelTransport =
    modelTransportFailure || chain.some((e) => e.name === "AI_APICallError");
  const httpStatus = modelTransport ? (provider?.statusCode ?? null) : null;
  const result = (
    layer: AssistantFailure["layer"],
    category: string,
    reason: string,
    nextAction: string,
  ): AssistantFailure => ({ layer, category, httpStatus, reason, nextAction });
  if (chain.some((item) => item.code === "model_response_too_large"))
    return result(
      "model",
      "output_protocol",
      "模型回复超过接口容量上限。",
      "核对保留成果后减少本轮输出范围再试。",
    );
  if (code.startsWith("model_"))
    return result(
      "model",
      "provider_rejected",
      "模型连接尚未配置完成或当前不可用。",
      "请管理员检查模型连接和加密配置后再试。",
    );
  if (
    /assistant_no_progress|assistant_session_limit|assistant_budget/.test(code)
  )
    return result(
      "budget",
      "budget_exhausted",
      "本轮已暂停：达到执行限额或没有取得新进展。",
      "检查当前步骤和要求后继续未完成部分。",
    );
  if (
    toolFailure ||
    ![
      "assistant_model_failed",
      "assistant_result_incomplete",
      "assistant_internal_error",
    ].includes(code)
  ) {
    if (
      /not_found|forbidden|unavailable|context_deleted|interrupted/.test(code)
    )
      return result(
        "business",
        "permission_or_source",
        "当前权限、来源或执行状态已经变化。",
        "核对访问权限和来源后继续。",
      );
    if (/conflict|revalidation|context_changed/.test(code))
      return result(
        "business",
        "conflict",
        "当前要求或数据修订发生冲突。",
        "核对当前数据或更正要求后继续。",
      );
    if (code === "assistant_operation_failed")
      return result(
        "application",
        "internal_error",
        "当前操作发生内部异常。",
        "保留输入并联系管理员检查诊断编号；恢复前先核对已执行操作。",
      );
    return result(
      "tool",
      "parameter_invalid",
      "当前操作的参数或范围未通过校验。",
      toolFailure && toolFailure.effect !== "none"
        ? "先核对真实操作回执，再继续未完成部分。"
        : "按操作记录中的具体字段或范围更正要求后继续。",
    );
  }
  if (provider && modelTransport) {
    const category = modelFailure(provider);
    if (httpStatus === 429)
      return result(
        "model",
        "rate_limit",
        "模型服务请求过多，本轮回复未完成。",
        "稍后重试未完成步骤，已执行操作会先核对回执。",
      );
    if (category === "temporary_service")
      return result(
        "model",
        category,
        "模型服务暂时不可用，本轮回复未完成。",
        "稍后重试未完成步骤。",
      );
    return result(
      "model",
      "provider_rejected",
      "模型服务拒绝了请求。",
      "请管理员检查模型连接、凭据和兼容性后再试。",
    );
  }
  if (
    modelTransport &&
    chain.some((e) => ["AbortError", "TimeoutError"].includes(e.name ?? ""))
  )
    return result(
      "model",
      "timeout",
      "等待模型回复超时。",
      "核对保留成果后重试未完成步骤。",
    );
  if (
    modelTransport &&
    chain.some((e) =>
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(e.code ?? ""),
    )
  )
    return result(
      "model",
      "network_error",
      "与模型服务的连接中断。",
      "恢复连接后重试未完成步骤。",
    );
  if (
    code === "assistant_result_incomplete" ||
    chain.some((e) =>
      [
        "AI_JSONParseError",
        "AI_TypeValidationError",
        "AI_InvalidResponseDataError",
        "AI_NoObjectGeneratedError",
        "AI_NoOutputGeneratedError",
        "AI_NoContentGeneratedError",
      ].includes(e.name ?? ""),
    )
  )
    return result(
      "model",
      "output_protocol",
      "模型回复不完整或未符合接口格式。",
      "核对已保留成果后重试未完成步骤。",
    );
  return result(
    "application",
    "internal_error",
    "本轮发生内部异常。",
    "保留输入并联系管理员检查诊断编号；恢复前先核对已执行操作。",
  );
}
