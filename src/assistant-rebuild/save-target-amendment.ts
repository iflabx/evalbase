import { compatibleProcessingOperations } from "./processing-context.js";
import type { Database } from "../db/pool.js";
import { BusinessError } from "../operations/errors.js";
type Query = Pick<Database, "query">;

// Events survive suspension snapshots without a second mutable feedback store.
export async function saveTargetAmendment(db: Query, sessionId: string) {
  const row = (
    await db.query(
      "SELECT id,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='save_target_amendment' ORDER BY id DESC LIMIT 1",
      [sessionId],
    )
  ).rows[0];
  return row?.detail?.status === "pending"
    ? { ...row.detail, eventId: row.id }
    : undefined;
}

export function saveNameCommand(text: string): string | undefined {
  const match = text
    .trim()
    .match(
      /^(?:(?:请|麻烦)(?:你)?\s*)?(?:只|仅)?(?:先)?(?:把)?保存名称改(?:成|为)\s*(?:“([^”]+)”|"([^"\n]+)"|「([^」]+)」|([^，,。；;？?\n]+?))(?:[，,；;]\s*(?:先不要继续|不要继续|保持暂停|先不继续|然后继续|再继续|并继续))?[。！!\s]*$/u,
    );
  const name = match && (match[1] ?? match[2] ?? match[3] ?? match[4])?.trim();
  return name && name.length <= 200 ? name : undefined;
}

export async function assertSaveTargetResolved(db: Query, sessionId: string) {
  if (await saveTargetAmendment(db, sessionId))
    throw new BusinessError(
      409,
      "requirements_amendment_pending",
      "保存名称尚未修改，任务保持暂停。请完成或明确撤销这项修改后继续。",
    );
}

export async function recordSaveTargetAmendment(
  db: Query,
  session: any,
  turnId: string,
  text: string,
) {
  const prior = await saveTargetAmendment(db, session.id);
  const cancel =
    /^(?:请)?(?:撤销|取消)(?:刚才|上次|这次)?(?:的)?(?:保存名称|保存名|改名)(?:修改|要求)?[。！!\s]*$/u.test(
      text.trim(),
    );
  const name = saveNameCommand(text);
  if (!name && !(cancel && prior)) return;
  const active = session.requirements.deliveries.filter(
    (d: any) => d.status === "active",
  );
  if (
    name &&
    (active.length !== 1 || active[0].saveTarget?.kind !== "newDraft")
  )
    throw new BusinessError(
      409,
      "save_target_ambiguous",
      "请先明确要修改哪一份待保存结果的名称。",
    );
  const runIds = name
    ? (await compatibleProcessingOperations(db, session)).map(
        (op: any) => op.run_id,
      )
    : [];
  if (
    name &&
    (
      await db.query(
        "SELECT 1 FROM assistant_runtime_operation o LEFT JOIN processing_acceptance a ON a.idempotency_key=o.id WHERE o.session_id=$1 AND o.kind='adopt' AND o.run_id=ANY($2::text[]) AND (o.receipt IS NOT NULL OR a.receipt IS NOT NULL) LIMIT 1",
        [session.id, runIds],
      )
    ).rowCount
  )
    throw new BusinessError(
      409,
      "result_already_saved",
      "这份结果已经保存。请打开已保存草稿修改其名称，不能将原结果再次另建保存。",
    );
  const detail = cancel
    ? { ...prior, status: "cancelled" }
    : {
        status: active[0].saveTarget.name === name ? "completed" : "pending",
        deliveryId: active[0].id,
        name,
        baseRevision: session.requirements_revision,
        turnId,
      };
  await db.query(
    "INSERT INTO assistant_runtime_event(session_id,turn_id,kind,detail) VALUES($1,$2,'save_target_amendment',$3)",
    [session.id, turnId, JSON.stringify(detail)],
  );
  await db.query(
    "UPDATE assistant_runtime_confirmation SET status='expired' WHERE session_id=$1 AND action='adopt' AND status='pending'",
    [session.id],
  );
}

export async function completeSaveTargetAmendment(
  db: Query,
  sessionId: string,
  turnId: string,
  requirements: any,
  expectedRevision: number,
) {
  const pending = await saveTargetAmendment(db, sessionId);
  if (!pending) return;
  const target = requirements.deliveries.find(
    (d: any) => d.id === pending.deliveryId && d.status === "active",
  );
  if (
    target?.saveTarget?.name === pending.name &&
    expectedRevision !== pending.baseRevision
  )
    throw new BusinessError(
      409,
      "requirements_revision_conflict",
      "改名所依据的要求已经变化，请核对后重新提出修改；未覆盖当前要求。",
    );
  if (target?.saveTarget?.name === pending.name)
    await db.query(
      "INSERT INTO assistant_runtime_event(session_id,turn_id,kind,detail) VALUES($1,$2,'save_target_amendment',$3)",
      [sessionId, turnId, JSON.stringify({ ...pending, status: "completed" })],
    );
}
