import { createRequestId } from "@/lib/request-id";
import { request } from "@/services/workspace";

export type OnlineUser = {
  id: string;
  name: string;
  avatarColor: string;
  role: "admin" | "editor" | "viewer";
  focus?: { draftId: string; recordId: string | null; field: string | null };
};
export type DraftEvent = {
  draftId: string;
  revision: number;
  status: string;
  changedBy: string | null;
  at: string;
};
export type PresenceFocus = {
  draftId?: string;
  recordId?: string;
  field?: "question" | "expectedOutput" | "metadata" | "name" | "purpose";
};
const clientId = createRequestId();
let activeFocus: PresenceFocus = {};
const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
export function setPresenceFocus(focus: PresenceFocus) {
  activeFocus = focus;
}
export function currentPresenceFocus() {
  return activeFocus;
}
export function heartbeat(projectId: string) {
  return request<void>(`${projectPath(projectId)}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, ...activeFocus }),
  });
}
export function leavePresence(projectId: string) {
  return request<void>(`${projectPath(projectId)}/presence/${clientId}`, { method: "DELETE" });
}
export async function projectPresence(projectId: string, draftId?: string) {
  const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
  return (await request<{ users: OnlineUser[] }>(`${projectPath(projectId)}/presence${query}`))
    .users;
}
export function draftEvents(projectId: string, draftId: string, after: number) {
  return request<{
    events: DraftEvent[];
    cursor: number;
    hasMore: boolean;
    needsSnapshot: boolean;
    status: string;
  }>(
    `${projectPath(projectId)}/collaborative-drafts/${encodeURIComponent(draftId)}/events?after=${after}`,
  );
}
