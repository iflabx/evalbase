import { useSyncExternalStore } from "react";

const fallback = new Map<string, string>();
export function readAssistantDraft(key: string) {
  try {
    const text = sessionStorage.getItem(key) ?? fallback.get(key) ?? "{}";
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? text : "{}";
  } catch {
    return fallback.get(key) ?? "{}";
  }
}
export function writeAssistantDraft(key: string, value: object) {
  const text = JSON.stringify(value);
  fallback.set(key, text);
  try {
    sessionStorage.setItem(key, text);
  } catch {
    /* This tab still retains the input. */
  }
  window.dispatchEvent(new Event("evalbase:assistant-draft"));
}
export function useAssistantDraft<T extends object>(key: string) {
  const snapshot = useSyncExternalStore(
    (notify) => {
      window.addEventListener("evalbase:assistant-draft", notify);
      return () => window.removeEventListener("evalbase:assistant-draft", notify);
    },
    () => readAssistantDraft(key),
    () => "{}",
  );
  const value = JSON.parse(snapshot) as T;
  return [
    value,
    (patch: Partial<T> | ((current: T) => Partial<T>)) => {
      const current = JSON.parse(readAssistantDraft(key)) as T;
      writeAssistantDraft(key, {
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      });
    },
  ] as const;
}
