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
    acceptanceId?: string;
    draftId?: string;
    assetId?: string;
    fileName?: string;
    adopted?: number;
    isCurrent: boolean;
  }[];
  results: { id: string; run_id: string; status: string; output_count: number }[];
  workspace: {
    cursor: string;
    attachments: Attachment[];
    streams: { id: string; turnId: string; text: string }[];
    process: { id: string; turnId: string; kind: string; name?: string; code?: string }[];
  };
};
export type SessionItem = { id: string; title: string; status: string };
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
  return [...tabs.filter((t) => t.id !== tab.id), tab];
}
export function errorText(error: unknown) {
  const code = (error as { message?: string })?.message;
  return (
    (
      {
        source_revision_conflict: "来源数据或字段映射已变化。输入已保留，请返回来源重新选择。",
        conversation_revision_conflict: "会话已在其他页面更新。输入已保留，请核对后重新提交。",
        submission_conflict: "这次提交与已接收内容不一致。输入已保留，请核对。",
        conversation_busy: "任务仍在进行，请先停止或等待完成。",
        confirmation_expired: "这张确认卡已失效，请核对最新要求。",
        conversation_not_found: "会话不存在或无权访问。",
        attachment_capacity: "最多上传5份文档，每份不超过10MB。",
        assistant_document_format: "支持 TXT、Markdown 和 PDF 文档。",
      } as Record<string, string>
    )[code ?? ""] ?? "连接或操作未完成，输入已保留。请重试。"
  );
}

export function visibleMessages(snapshot: Snapshot, earlier: Snapshot["messages"] = []) {
  const messages = [...earlier, ...snapshot.messages].map((m) => ({
    id: m.role === "assistant" ? "assistant:" + m.turn_id : "user:" + m.turn_id,
    role: m.role,
    content: m.content,
  }));
  const done = new Set(
    snapshot.messages.filter((m) => m.role === "assistant").map((m) => m.turn_id),
  );
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
