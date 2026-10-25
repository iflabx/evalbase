import type { Database } from "../db/pool.js";
import { opaqueId } from "../server/support.js";
import {
  AssistantError,
  dependenciesAvailable,
  type AssistantScope,
  type Dependency,
} from "./store.js";
import { closeBudget } from "./tasks.js";

export const taskIdentity = (session: Record<string, any>) =>
  session.task?.taskId ?? "legacy:" + session.id;
export const taskTurnFilter = "coalesce(task_id,'legacy:'||session_id)=$2";
/** Only complete affirmative commands take the fast path. Other wording stays in existing intent/clarification. */
export function taskBoundaryIntent(
  text: string,
): "new" | "restore" | undefined {
  const value = text.trim().replace(/^请/u, "");
  if (
    /^(?:另开|新开|开启|开始)(?:一个|一项|个)?(?:独立|新的|新)?(?:任务|目标)(?:[，,：:。\s]|$)/u.test(
      value,
    ) ||
    /^(?:先)?暂停(?:当前|这个|原)?任务[，,；;]?\s*(?:并|然后)?切换(?:到|为)?/u.test(
      value,
    ) ||
    /^换个任务(?:[，,：:。\s]|$)/u.test(value)
  )
    return "new";
  if (
    /^(?:恢复|回到)(?:之前的|上一个|上个|原来的)?任务(?:[“「"：:\s]|$)/u.test(
      value,
    )
  )
    return "restore";
}
/** A new label is not evidence of a new business goal. Reuse this decision for fast and clarified commands. */
function goalDisposition(
  text: string,
  currentGoal: string,
): "same" | "independent" | "unclear" {
  const normalize = (s: string) =>
    s
      .trim()
      .replace(
        /^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|劳驾|能否|我想(?:要)?)[，,：:\s]*)+/u,
        "",
      );
  const goal = normalize(text);
  const clauses = goal
    .split(/[，,；;。\n]/u)
    .map(normalize)
    .filter(Boolean);
  if (
    !clauses.length ||
    /[“「"]/u.test(goal[0] ?? "") ||
    /^(?:不要|别|不必|无需|不是)/u.test(goal)
  )
    return "unclear";
  const continuing = clauses.some(
    (c) =>
      !/^(?:不要|别|不必|无需)/u.test(c) &&
      (/^(?:继续|接着|重试|重来|重做|重新开始|执行原|按原|按当前)/u.test(c) ||
        /(?:刚才|原来|未完成|失败的|同一个|原任务|原目标|当前任务)/u.test(c) ||
        /^(?:改名|改成|改为|更名|数量|条数|配额|名称|名字|主题|类别|分类|期望输出|Metadata)/u.test(
          c,
        )),
  );
  if (continuing || goal === normalize(currentGoal)) return "same";
  return /^(?:创建|新建|生成|整理|清洗|改写|扩写|查询|查看|制作|设计|编写|准备|给我(?:做|写)|做).{2,}/u.test(
    goal,
  )
    ? "independent"
    : "unclear";
}
function newGoalText(text: string) {
  return text
    .trim()
    .replace(
      /^(?:请)?(?:(?:另开|新开|开启|开始)(?:一个|一项|个)?(?:独立|新的|新)?(?:任务|目标)|换个任务)[，,：:。\s]*/u,
      "",
    )
    .replace(
      /^(?:先)?暂停(?:当前|这个|原)?任务[，,；;]?\s*(?:并|然后)?切换(?:到|为)?[，,：:。\s]*/u,
      "",
    );
}
export async function taskDependencies(
  db: Pick<Database, "query">,
  session: Record<string, any>,
) {
  const rows = (
    await db.query(
      `SELECT EXISTS(SELECT 1 FROM assistant_turn WHERE session_id=$1 AND ${taskTurnFilter} AND requires_write) AS requires_write,
 coalesce((SELECT jsonb_agg(ref) FROM (SELECT DISTINCT ref FROM assistant_turn CROSS JOIN LATERAL jsonb_array_elements(dependencies) ref WHERE session_id=$1 AND ${taskTurnFilter}) unique_refs),'[]'::jsonb) AS refs`,
      [session.id, taskIdentity(session)],
    )
  ).rows[0];
  return {
    requiresWrite: rows.requires_write,
    dependencies: rows.refs as Dependency[],
  };
}
/** Caller holds the session and global concurrency locks; archive + fence + current pointer share its transaction. */
export async function prepareTaskBoundary(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  session: Record<string, any>,
  text: string,
  restoreTaskId?: string,
) {
  let intent = restoreTaskId ? ("restore" as const) : taskBoundaryIntent(text),
    request = text;
  const pending = session.task?.boundaryQuestion;
  const continuingAnswer =
    /^(?:请)?继续(?:当前|原来|原)(?:任务|目标)(?:[，,。！!；;\n]|$)/u.test(
      text.trim(),
    ) &&
    !/(?:另开|新开|切换)(?:一个|一项|个|到)?(?:独立|新的|新)?(?:任务|目标)/u.test(
      text,
    );
  const answeredRequest = pending
    ? pending.request + "\n用户对任务边界的回答：" + text
    : text;
  if (pending && !intent && continuingAnswer) {
    session.task = { ...session.task, boundaryQuestion: null };
    return { request: answeredRequest, switched: false };
  }
  if (pending?.kind === "goal" && !intent) {
    if (
      goalDisposition(text, String(session.task?.goal ?? "")) !== "independent"
    )
      return {
        request,
        switched: false,
        kind: "goal",
        question: "请说明独立的新目标，或回复继续当前任务。",
      };
    intent = "new";
  }
  if (pending && pending.kind !== "goal") {
    if (
      /^(?:请)?(?:另开|新开|独立)(?:一个)?(?:任务|目标)[。！!]?$/u.test(
        text.trim(),
      )
    ) {
      intent = "new";
      request = pending.request;
    } else if (!intent) {
      // Full natural answers are resolved by the existing intent stage with the original request.
      // They do not themselves authorize switching, execution or a fresh budget.
      return { request: answeredRequest, switched: false };
    }
  }
  if (intent === "new") {
    const remainder = newGoalText(request),
      disposition = goalDisposition(
        remainder,
        String(session.task?.goal ?? ""),
      );
    if (
      disposition === "same" ||
      (pending?.kind !== "choice" && disposition !== "independent")
    )
      return {
        request: remainder || request,
        switched: false,
        kind: "goal",
        question:
          "继续或修改当前任务将沿用原预算。请说明独立的新目标后再切换。",
      };
  }
  if (!session.task?.goal && intent !== "restore")
    return { request, switched: false };
  if (/^(?:不要|别|无需|不必).*(?:新|另开|切换)/u.test(text.trim()))
    return { request, switched: false };
  if (!intent) {
    if (/^(?:另外|接下来|再做|另做)[，,]?/u.test(text.trim()))
      return {
        request,
        switched: false,
        question: "这是继续当前任务，还是另开目标？",
      };
    return { request, switched: false };
  }
  let restored: Record<string, any> | undefined;
  if (intent === "restore") {
    const title = text
      .replace(/^(?:请)?(?:恢复|回到)(?:之前的|上一个|上个|原来的)?任务/u, "")
      .replace(/^[“「"：:\s]+|[”」"。\s]+$/gu, "");
    const rows = (
      await db.query(
        restoreTaskId
          ? "SELECT * FROM assistant_task_checkpoint WHERE session_id=$1 AND id=$3 AND id<>$2 LIMIT 1"
          : "SELECT * FROM assistant_task_checkpoint WHERE session_id=$1 AND id<>$2 AND ($3='' OR task->>'title'=$3) ORDER BY saved_at DESC LIMIT 2",
        [session.id, taskIdentity(session), restoreTaskId ?? title],
      )
    ).rows;
    if (restoreTaskId && !rows.length)
      throw new AssistantError(404, "assistant_not_found");
    if (!rows.length || (title && rows.length > 1))
      throw new AssistantError(
        409,
        "assistant_task_boundary_required",
        "请按历史任务名称明确要恢复的任务。",
      );
    restored = rows[0]!;
    await dependenciesAvailable(db, scope, restored!.dependencies);
    // Restoring a write task never reuses a downgraded account's former authority.
    if (restored!.requires_write) {
      const { assistantAccess } = await import("./store.js");
      await assistantAccess(db, scope, true);
    }
  }
  if (session.task?.turnBudget?.turnId)
    await closeBudget(db, session, session.task.turnBudget.turnId);
  const dependencies = await taskDependencies(db, session);
  await db.query(
    "INSERT INTO assistant_task_checkpoint(session_id,id,task,revision,dependencies,requires_write) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,id) DO UPDATE SET task=excluded.task,revision=excluded.revision,dependencies=excluded.dependencies,requires_write=excluded.requires_write,saved_at=now()",
    [
      session.id,
      taskIdentity(session),
      session.task,
      session.task_revision,
      JSON.stringify(dependencies.dependencies),
      dependencies.requiresWrite,
    ],
  );
  await db.query(
    "UPDATE assistant_turn SET status='interrupted',execution_token=NULL,error_code='assistant_task_switched' WHERE session_id=$1 AND status IN('queued','running')",
    [session.id],
  );
  await db.query(
    "UPDATE assistant_proposal SET status='invalid' WHERE session_id=$1 AND status='pending'",
    [session.id],
  );
  const task = restored
    ? {
        ...restored.task,
        taskId: restored.id,
        taskContractVersion: 2,
        boundaryQuestion: null,
        executionPaused: true,
        planValidationRequired: true,
        turnControl: null,
      }
    : { taskContractVersion: 2, taskId: opaqueId("assistanttask") };
  await db.query(
    "UPDATE assistant_session SET task=$2,task_revision=task_revision+1,updated_at=now() WHERE id=$1",
    [session.id, task],
  );
  session.task = task;
  session.task_revision = Number(session.task_revision) + 1;
  return {
    request: restored
      ? "继续原任务，先核对原有要求和未完成位置；不重复已完成操作。"
      : request,
    switched: true,
  };
}
