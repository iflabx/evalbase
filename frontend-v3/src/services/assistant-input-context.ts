import { createRequestId } from "@/lib/request-id";
import type { QueryClient } from "@tanstack/react-query";
export type InputSelection = { recordIds: string[]; sourceRevision: string; total: number };
export type InputContext = {
  kind: "asset" | "draft" | "version";
  id: string;
  inputSelection?: InputSelection;
};
export const inputContextKey = (projectId: string, actorId: string) => [
  "assistant-input-context",
  projectId,
  actorId,
];
export function handoffInputContext(client: QueryClient, projectId: string, actorId: string) {
  const context = client.getQueryData<InputContext>(inputContextKey(projectId, actorId));
  if (!context) return undefined;
  const token = createRequestId();
  sessionStorage.setItem(
    "assistant-input:" + token,
    JSON.stringify({ projectId, actorId, context, expiresAt: Date.now() + 30 * 60 * 1000 }),
  );
  return { context, token };
}
export function readInputContext(token: string | undefined, projectId: string, actorId: string) {
  if (!token) return undefined;
  try {
    const value = JSON.parse(sessionStorage.getItem("assistant-input:" + token) ?? "null");
    if (
      value?.projectId === projectId &&
      value?.actorId === actorId &&
      value.expiresAt > Date.now()
    )
      return value.context as InputContext;
  } catch {
    /* Invalid handoffs must not turn into whole-source authorization. */
  }
  return undefined;
}

export function selectionConsumed(token: string | undefined, sessionId: string | undefined) {
  return Boolean(
    token && sessionId && sessionStorage.getItem(`assistant-input-used:${token}:${sessionId}`),
  );
}
export function consumeSelection(token: string | undefined, sessionId: string) {
  if (token) sessionStorage.setItem(`assistant-input-used:${token}:${sessionId}`, "1");
}
