import { planVerificationCurrent } from "./plan.js";
// Model clarification is useful input, never an execution or save receipt.
export const claimedExecution = (text: string) =>
  /(?:已经|正在|已)(?!有)[^。；;，,\n]{0,40}(?:开始|提交|生成|清洗|改写|扩充|创建|执行)(?!的)/u.test(
    text,
  );
export const claimedUpdate = (text: string) =>
  /(?:已将|已把).{0,40}(?:改为|改成|修改|调整|更新|保存)/u.test(text) ||
  /(?:已|已经)(?:成功|为你|为您|替你)?(?:记录|记下|保存|更新|修改|调整|记住)[\s\S]{0,24}(?:要求|约束|方案|计划|数量|目标)|(?:要求|约束|方案|计划|数量|目标).{0,12}(?:已|已经)(?:成功)?(?:记录|记下|保存|更新|修改|调整)/u.test(
    text,
  );

/** Display facts only: this projection never grants execution or mutates a task. */
export function assistantFeedback(
  task: Record<string, any> = {},
  facts: {
    revision: number;
    hasBackground: boolean;
    documentsKey?: string;
    summaryFailed?: boolean;
    recoveryReason?: string;
  },
) {
  const pending = Boolean(
    task.planValidationRequired ||
    (task.turnControl?.requiresUpdate && !task.turnControl.updateSaved) ||
    (task.planningRecovery?.amendment &&
      task.planningRecovery.taskRevision === facts.revision),
  );
  const saved = Boolean(
    !pending &&
    task.requirementSave?.key &&
    task.requirementSave.taskRevision === facts.revision,
  );
  const verified = Boolean(
    !pending &&
    planVerificationCurrent(task, facts.revision, facts.documentsKey),
  );
  const planReady = Boolean(
    !pending &&
    !task.question &&
    !task.executionPlan?.needsReview &&
    task.executionPlan?.steps?.length,
  );
  const result = (kind: string, message: string, action?: "background") => ({
    kind,
    message,
    requirementsSaved: saved,
    requirementsVerified: verified,
    planReady: kind === "plan" ? planReady : false,
    summaryFailed: Boolean(saved && facts.summaryFailed),
    ...(action ? { action } : {}),
  });
  if (task.stage === "stopped")
    return result("stopped", "任务已停止，已有成果保留。");
  if (
    ["initial_plan_repair_limit", "initial_plan_no_progress"].includes(
      facts.recoveryReason ?? "",
    )
  )
    return result("failed", recoveryReason(facts.recoveryReason)!);
  if (task.requirementProblem && task.requirementProblemKind === "business")
    return result("input", task.requirementProblem);
  if (task.question)
    return result(
      "input",
      claimedExecution(task.question) ||
        claimedUpdate(task.question) ||
        // Machine identifiers (tool_name / fieldName) belong in diagnostics, not business clarification.
        /(?:\b[a-z][a-z0-9]*(?:_[a-z0-9]+|[A-Z][a-z0-9]*)+\b|工具参数|接口参数|JSON\s*Schema)/u.test(
          task.question,
        )
        ? "请补充本次处理的具体要求，已有资料和成果保留。"
        : task.question,
      !facts.hasBackground ? "background" : undefined,
    );
  if (task.error === "assistant_background_required")
    return result(
      "input",
      "请上传本次生成依据的背景文档，或选择已有原始资料进行处理。",
      "background",
    );
  if (pending && facts.recoveryReason === "repair_limit")
    return result("amendment", recoveryReason("repair_limit")!);
  if (pending)
    return result(
      "amendment",
      "本次修改尚未保存，原方案和已有成果保留。请继续完成修改后再执行。",
    );
  if (
    ["background_changed", "context_changed", "requirements_changed"].includes(
      facts.recoveryReason ?? "",
    )
  )
    return result("blocked", recoveryReason(facts.recoveryReason)!);
  if (task.stage === "processing")
    return result("processing", "处理任务已提交，完成后将继续核对候选。");
  if (task.stage === "awaiting_confirmation")
    return result(
      "awaiting_confirmation",
      "操作已准备好，请核对下方确认卡片。",
    );
  if (task.stage === "complete")
    return result("complete", "当前目标已完成，已保存成果可在工作区查看。");
  if (recoveryReason(facts.recoveryReason))
    return result(
      "blocked",
      `${saved ? "方案已保存；" : ""}${recoveryReason(facts.recoveryReason)}`,
    );
  if (verified && task.executionPlan?.mode === "plan" && planReady)
    return result(
      "plan",
      "当前方案已核对，符合本次要求；方案内容未变，尚未执行。",
    );
  if (saved && task.executionPlan?.mode === "plan" && planReady)
    return result(
      "plan",
      facts.summaryFailed
        ? "方案已保存，回复总结未完成；可在工作区查看当前方案。"
        : "方案已保存，尚未执行。",
    );
  if (task.checkedStatus === "failed" && !task.review?.total)
    return result(
      "failed",
      "处理未完成，尚无可用候选。已有要求和任务记录保留。",
    );
  if (task.error || task.stage === "failed")
    return result(
      "failed",
      recoveryReason(facts.recoveryReason) ??
        (saved
          ? "本轮要求已保存，后续处理未完成；已有成果保留。"
          : "本轮尚未完成，已有要求和成果保留。"),
    );
  if (task.executionPaused && task.executionPlan?.mode !== "plan")
    return result("paused", "后续执行已暂停，已有成果保留。");
  if (task.stage === "awaiting_review")
    return result("awaiting_review", "候选已保留，请核对结果后选择采用。");
  return result("idle", "");
}
export function recoveryReason(reason: string | undefined): string | undefined {
  return (
    {
      background_changed: "背景文档已变化，请核对依据后继续。",
      context_changed: "资料或要求已变化，请核对当前内容后继续。",
      revision_changed: "要求已更新，请以当前方案为准。",
      requirements_changed: "要求已变化，请先核对本次修改。",
      permission_denied: "当前权限已变化，请核对访问权限。",
      task_budget_exhausted: "本次任务已达到执行限额，已有成果保留。",
      insufficient_task_time: "剩余执行额度不足，已有进度保留。",
      no_progress: "连续尝试未取得新进展，任务已暂停；已有成果保留。",
      repair_limit: "自动修正次数已用完，原方案保留，本次修改尚未保存。",
      initial_plan_no_progress:
        "连续修正未取得进展。首次方案尚未保存，要求和附件已保留。",
      initial_plan_repair_limit:
        "自动修正次数已用完。首次方案尚未保存，要求和附件已保留。",
      attempt_limit: "本轮恢复次数已达上限，已有成果保留。",
      event_limit: "自动续步已达到上限，已有成果保留。",
      session_limit: "本会话已达到执行上限，已有成果保留。",
      budget_evidence_missing:
        "该历史任务缺少安全恢复所需的记录，已有成果仍可查看。",
    } as Record<string, string>
  )[reason ?? ""];
}
