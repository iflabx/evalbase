import { isPlainObject } from "../server/support.js";

export const turnControlSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: ["query", "plan", "execute", "pause"] },
    requiresUpdate: {
      type: "boolean",
      description: "本轮先改要求再执行时必须为true；更新成功前禁止执行。",
    },
    pauseFirst: {
      type: "boolean",
      description:
        "用户要求先暂停再修改时为true，先单独提交control；后续修改失败也保留暂停。",
    },
    explanation: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description:
        "用户查询/解释已知事实或先解释再执行时的简短答复；不得声称未执行的操作。",
    },
  },
  required: ["mode"],
} as const;
export type TurnControl = {
  mode: "query" | "plan" | "execute" | "pause";
  requiresUpdate?: boolean;
  pauseFirst?: boolean;
  explanation?: string;
};
export type TurnDecision = TurnControl & {
  turnId: string;
  taskRevision: number;
  source: "model" | "ui" | "legacy_ui" | "continuation" | "readonly";
  updateSaved: boolean;
};
export function validControl(value: unknown): value is TurnControl {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) =>
      ["mode", "requiresUpdate", "pauseFirst", "explanation"].includes(key),
    ) &&
    typeof value.mode === "string" &&
    ["query", "plan", "execute", "pause"].includes(value.mode) &&
    ["requiresUpdate", "pauseFirst"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.explanation === undefined ||
      (typeof value.explanation === "string" &&
        value.explanation.trim().length > 0 &&
        value.explanation.length <= 1000)) &&
    !(value.mode === "query" && (value.requiresUpdate || value.pauseFirst))
  );
}
export function restoredDecision(
  task: Record<string, any>,
  turn: Record<string, any>,
): TurnDecision | undefined {
  const value = task.turnControl;
  if (
    value?.turnId === turn.id &&
    value.taskRevision === turn.task_revision &&
    validControl(
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) =>
            !["turnId", "taskRevision", "source", "updateSaved"].includes(key),
        ),
      ),
    ) &&
    ["model", "ui", "legacy_ui", "continuation", "readonly"].includes(
      value.source,
    ) &&
    typeof value.updateSaved === "boolean"
  )
    return value;
}
export const readTools = [
  "query_project",
  "read_records",
  "read_background",
  "read_processing",
];
export function mayExecute(decision: TurnDecision | undefined) {
  return (
    decision?.mode === "execute" &&
    (!decision.requiresUpdate || decision.updateSaved)
  );
}

/** A control receipt records authorization, never completion of the requested work. */
export function turnNeedsWork(
  decision: TurnDecision | undefined,
  task: Record<string, any>,
  receipts: Record<string, any>[],
  known: Record<string, any> = {},
) {
  if (!decision || decision.mode === "pause") return false;
  const completed = receipts.filter((r) => r.status === "succeeded");
  if (decision.mode === "query")
    return !(
      completed.some((r) => readTools.includes(r.name)) ||
      known.pageObject ||
      known.files?.length ||
      known.drafts?.length ||
      known.versions?.length ||
      known.backgroundDocuments?.length ||
      task.question ||
      task.error ||
      task.runId ||
      task.executionPlan?.steps?.length
    );
  if (task.question || task.executionPlan?.steps?.length) return false;
  if (
    completed.some(
      (r) =>
        r.name === "read_processing" &&
        r.result?.run?.id === task.runId &&
        [
          "queued",
          "running",
          "retry_wait",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(r.result?.run?.status),
    )
  )
    return false;
  if (completed.some((r) => !["plan_task", ...readTools].includes(r.name)))
    return false;
  if (
    decision.mode === "plan" &&
    completed.some((r) => r.name === "plan_task" && !r.result?.unchanged)
  )
    return false;
  return true;
}
export function intentTools(
  tools: string[],
  decision: TurnDecision | undefined,
) {
  return mayExecute(decision)
    ? tools
    : tools.filter((name) => name === "plan_task" || readTools.includes(name));
}
/** Compatibility only for the three fixed labels emitted by older clients. */
export function legacyExecute(text: string) {
  return [
    "按当前已保存方案执行",
    "继续执行已保存方案",
    "继续执行当前任务",
  ].includes(text.trim());
}

/** Automatic events inherit an existing authorization; an unresolved new turn cannot grant it. */
export function continuationAllowed(task: Record<string, any>) {
  const control = task.turnControl;
  return (
    !task.executionPaused &&
    task.executionPlan?.mode !== "plan" &&
    control?.source !== "pending" &&
    !["plan", "pause"].includes(control?.mode) &&
    !(control?.requiresUpdate && !control.updateSaved)
  );
}

/** A continuation preserves the current request; extra business clauses create a new amendment. */
export function planningContinuation(text: string): "plan" | "continue" | null {
  const parts = text
    .trim()
    .split(/[，,；;。!！?？\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !parts.length ||
    !/^请?继续(?:按最后(?:的)?要求)?(?:保存方案|规划|执行|生成|做)?$/u.test(
      parts[0],
    )
  )
    return null;
  if (
    parts
      .slice(1)
      .some(
        (s) =>
          !/^(?:先|暂时|暂且)?(?:不要|别|不)(?:开始)?(?:生成|执行)$/u.test(s),
      )
  )
    return null;
  return /规划|保存方案/u.test(parts[0]) || parts.length > 1
    ? "plan"
    : "continue";
}

/** Only an affirmative business amendment may receive a new bounded correction identity. */
export function requestsBusinessAmendment(text: string) {
  return text
    .split(/[，,；;。\n]/u)
    .some(
      (clause) =>
        !/(?:解释|举例|例如|比如|不要|不得|禁止|不能|别)/u.test(clause) &&
        /(?:改成|改为|调整为|换成|替换为|新增|增加|删掉|取消|去掉|只要)/u.test(
          clause,
        ) &&
        !/(?:改成|改为|调整为|换成|替换为|取消|去掉).{0,12}(?:继续|暂停|停止|执行|生成|规划|保存方案)/u.test(
          clause,
        ),
    );
}
