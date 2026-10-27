import type { RebuildHost } from "./host.js";

type Facts = Awaited<ReturnType<RebuildHost["present"]>>;
/** A read-only projection; never treats a checkpoint, candidate or expired card as a save receipt. */
export function taskStatusReply(facts: Facts, budgetBlocked: boolean) {
  const s = facts.session;
  const run = facts.run?.run;
  if (s.waiting_run_id && !run)
    return "暂时无法读取处理进度，不能确认处理或保存状态。请稍后查询。";
  const cards = facts.confirmations.filter(
    (c) => c.revision === s.revision && c.run_id === s.waiting_run_id,
  );
  const committed = cards.find((c) => c.status === "committed" && c.receipt);
  const receipt =
    committed &&
    facts.receipts.find(
      (r) => r.acceptanceId === committed.receipt.acceptanceId,
    );
  const executing = cards.some((c) => c.status === "executing");
  const pending = cards.some(
    (c) =>
      c.status === "pending" && new Date(c.expires_at).getTime() > Date.now(),
  );
  const expired = cards.some(
    (c) =>
      c.status === "expired" ||
      (c.status === "pending" &&
        new Date(c.expires_at).getTime() <= Date.now()),
  );
  const lines = [
    receipt
      ? "已将 " +
        receipt.adopted +
        " 条保存为“" +
        receipt.name +
        "”测试集草稿。"
      : executing
        ? "保存正在提交，尚未确认保存成功，请勿重复提交。"
        : "尚未保存到测试集草稿。",
  ];
  if (!run) {
    lines.push(
      s.requirements ? "当前要求已记录，尚未提交处理。" : "尚未提交处理任务。",
    );
    return lines.join("\n");
  }
  const expected = s.requirements?.count ?? run.inputCount;
  lines.push("已产生 " + run.outputCount + "/" + expected + " 条处理结果。");
  if (receipt || executing) return lines.join("\n");
  if (run.status === "cancel_requested") {
    lines.push("已收到暂停请求，后台正在停止，无需重新提交。");
  } else if (run.executionComplete) {
    lines.push("处理已完成，结果已保留。");
    if (pending && s.status === "confirmation") {
      lines.push("请核对后点击有效确认卡保存；发送文字不会代替确认。");
    } else if (s.status === "paused" || expired) {
      if (expired) lines.push("旧确认已失效，不能用于保存。");
      if (!budgetBlocked)
        lines.push("可继续原任务以重新提供确认，再点击有效确认卡保存。");
    }
  } else if (s.status === "paused") {
    lines.push("任务已暂停，已有结果保留。");
    if (
      !budgetBlocked &&
      (facts.run!.recovery.canRetry ||
        !["failed", "cancelled"].includes(run.status))
    )
      lines.push(
        "可继续原任务，系统会在执行前检查权限及各项剩余额度，无需重新提交。",
      );
    else if (!budgetBlocked)
      lines.push("当前处理条件不允许直接恢复，请核对处理失败原因。");
  } else {
    lines.push(
      ["failed", "cancelled"].includes(run.status)
        ? "处理尚未完成，已有结果保留。"
        : "后台处理中，请等待结果。",
    );
  }
  if (budgetBlocked)
    lines.push(
      "当前验证执行额度或有效期限制已阻止继续；已有结果和记录保留，查询不会追加或重置额度。",
    );
  return lines.join("\n");
}
