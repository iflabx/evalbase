import { createRequestId } from "@/lib/request-id";
import { request } from "./workspace";
export type Source =
  | { kind: "assets"; assetIds: string[]; recordIds?: string[] }
  | { kind: "draft" | "version"; id: string; recordIds?: string[] };
export type Envelope = {
  submissionId: string;
  expectedRevision: number;
  text: string;
  attachments?: string[];
  context?: Source;
  contextRevision?: string;
};
export type Attachment = { id: string; name: string };
export type Snapshot = {
  contentInvalidated?: boolean;
  invalidationReason?: string | null;
  history?: { runtime: string; budget: unknown; invalidated: boolean };
  currentRuntime?: string;
  canWrite?: boolean;
  canResumeCompleted?: boolean;
  canRenewConfirmation?: boolean;
  session: {
    id: string;
    runtime_version?: string;
    title: string;
    revision: number;
    requirements_revision: number;
    status: string;
    requirements: { objective: string; mode: string; deliveries: Record<string, unknown>[] };
  };
  messages: { id: string; turn_id: string; role: "assistant" | "user"; content: string }[];
  turns: { id: string; submission_id: string; status: string; error_code: string | null }[];
  execution: null | {
    status: string;
    reason: string | null;
    no_progress: number;
    turn_id: string;
    requests: number;
    request_limit: number;
    active_ms?: number;
    active_limit_ms?: number;
  };
  executionReadiness?: {
    ready: boolean;
    complete: boolean;
    issues: { code: string; message: string; deliveryId?: string; field?: string }[];
  };
  confirmations: {
    id: string;
    action: string;
    status: string;
    expires_at: string;
    payload: Record<string, unknown>;
  }[];
  receipts: {
    grantId?: string;
    addedRequests?: number;
    addedActiveMs?: number;
    versionId?: string;
    testSetId?: string;
    label?: string;
    recordCount?: number;
    action?: string;
    added?: number;
    deleted?: boolean;
    acceptanceId?: string;
    draftId?: string;
    assetId?: string;
    fileName?: string;
    draftName?: string | null;
    savedDraftName?: string | null;
    draftStatus?: string;
    draftRecordCount?: number | null;
    adopted?: number;
    isCurrent: boolean;
  }[];
  results: {
    id: string;
    run_id: string;
    status: string;
    output_count: number;
    isCurrent?: boolean;
    isLatest?: boolean;
    round_number?: number;
  }[];
  workspace: {
    nativeActions?: NativeAction[];
    cursor: string;
    attachments: Attachment[];
    streams: { id: string; turnId: string; text: string }[];
    process: { id: string; turnId: string; kind: string; name?: string; code?: string }[];
  };
};
export type NativeAction = {
  id: string;
  kind:
    | "upload"
    | "mapping"
    | "navigation"
    | "processing"
    | "version_download"
    | "model_settings"
    | "sign_out"
    | "recycle_management";
  operation?: "permanent_delete" | "tombstone";
  entryId?: string;
  confirmationName?: string;
  configuration?: { name?: string; endpoint?: string; model?: string; enabled?: boolean };
  draftId?: string;
  recordIds?: string[];
  sourceRevision?: string;
  testSetId?: string;
  versionId?: string;
  format?: "csv" | "bundle";
  assetId?: string;
  collectionId?: string;
  name?: string;
  href?: string;
};
export type SessionItem = { id: string; title: string; status: string; runtime_version?: string };
export const base = (project: string) =>
  "/api/projects/" + encodeURIComponent(project) + "/assistant-runtime/sessions";
export const endpoint = (project: string, session: string) =>
  base(project) + "/" + encodeURIComponent(session);
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export const api = request;
export function submission(
  revision: number,
  text: string,
  attachments: string[],
  context?: Source,
  contextRevision?: string,
): Envelope {
  return {
    submissionId: createRequestId(),
    expectedRevision: revision,
    text,
    attachments,
    ...(context ? { context } : {}),
    ...(contextRevision ? { contextRevision } : {}),
  };
}
export function acceptedDraft(current: string, envelope: Envelope) {
  return current === envelope.text ? "" : current;
}
export type WorkspaceTab = {
  id: string;
  kind: "document" | "result" | "draft";
  name: string;
  content?: string;
  loading?: boolean;
  error?: string;
  offset?: number;
  total?: number;
  status?: string;
  document?: {
    fragments: { text: string; page?: number; startLine?: number; endLine?: number }[];
    offset: number;
    nextOffset: number | null;
    total: number;
    truncated: boolean;
  };
  href?: string;
  downloadHref?: string;
  rows?: {
    id: string;
    result: {
      question: string;
      expectedOutput: string;
      metadata: { key: string; value: string }[];
    };
  }[];
};
export function openTab(tabs: WorkspaceTab[], tab: WorkspaceTab) {
  return tabs.some((t) => t.id === tab.id)
    ? tabs.map((t) => (t.id === tab.id ? tab : t))
    : [...tabs, tab];
}
export function errorText(error: unknown) {
  const code = (error as { message?: string })?.message;
  return (
    (
      {
        assistant_runtime_disabled: "项目助手暂时停用，已有成果和人工页面仍可查看使用。",
        assistant_runtime_retired: "旧助手已停止执行，请在项目助手中查看历史或新建会话。",
        source_revision_conflict: "来源数据或字段映射已变化。输入已保留，请返回来源重新选择。",
        snapshot_revision_conflict: "会话已在其他页面更新。输入已保留，请重试读取。",
        draft_conflict: "草稿已发生并发修改，输入已保留。请打开草稿核对后选择如何处理。",
        draft_field_conflict: "这个字段已被修改，输入已保留。请核对双方内容后再决定。",
        draft_revision_conflict: "草稿已有新修改，请核对最新内容后重新确认。",
        selection_preview_expired: "选取条件已改变，请使用最新预览。",
        conversation_revision_conflict: "会话已在其他页面更新。输入已保留，请核对后重新提交。",
        submission_conflict: "这次提交与已接收内容不一致。输入已保留，请核对。",
        conversation_busy: "任务仍在进行，请先停止或等待完成。",
        activity_budget_exhausted: "本次验证活动额度已用完或已关闭，不能追加任务额度。",
        budget_offer_changed: "任务用量已变化，请核对后重新申请追加。",
        budget_offer_unavailable: "当前任务无需追加额度，请核对任务状态。",
        confirmation_expired: "这张确认卡已失效，请核对最新要求。",
        conversation_not_found: "会话不存在或无权访问。",
        attachment_capacity: "最多上传 5 份背景文档，合计不超过 10MB。",
        assistant_document_format: "支持 TXT、Markdown 和 PDF 文档。",
      } as Record<string, string>
    )[code ?? ""] ?? "连接或操作未完成，输入已保留。请重试。"
  );
}

export function visibleMessages(snapshot: Snapshot, earlier: Snapshot["messages"] = []) {
  const all = mergeMessages(earlier, snapshot.messages);
  const messages = all.map((m) => ({
    id: m.role === "assistant" ? "assistant:" + m.turn_id : "user:" + m.turn_id,
    role: m.role,
    content: m.content,
  }));
  const done = new Set(all.filter((m) => m.role === "assistant").map((m) => m.turn_id));
  const streaming = new Map<string, { id: string; role: "assistant"; content: string }>();
  for (const part of snapshot.workspace.streams)
    if (!done.has(part.turnId))
      streaming.set(part.turnId, {
        id: "assistant:" + part.turnId,
        role: "assistant",
        content: part.text,
      });
  return [...messages, ...streaming.values()];
}

export function mergeMessages(
  old: Snapshot["messages"],
  incoming: Snapshot["messages"],
): Snapshot["messages"] {
  const byId = new Map([...old, ...incoming].map((m) => [m.id, m]));
  return [...byId.values()].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
}
export function mergeSnapshot(old: Snapshot | null, incoming: Snapshot): Snapshot {
  if (incoming.contentInvalidated) return incoming;
  if (old?.session.id === incoming.session.id && old.contentInvalidated) return old;
  return old?.session.id === incoming.session.id
    ? { ...incoming, messages: mergeMessages(old.messages, incoming.messages) }
    : incoming;
}
