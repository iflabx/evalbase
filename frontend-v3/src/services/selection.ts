import { request } from "@/services/workspace";
import type { DraftSourceRecord } from "@/services/drafts";

export type SelectionCondition = {
  field: "question" | "expectedOutput" | "metadata";
  key?: string;
  operator: "contains" | "equals" | "empty" | "filled";
  value?: string;
};
export type SelectionConfig = {
  assetIds: string[];
  conditions: SelectionCondition[];
  method: "all" | "random";
  mode?: "count" | "percent";
  value?: number;
  seed?: string;
};
export type SelectionPreview = {
  id: string;
  configuration: SelectionConfig;
  seed: string | null;
  algorithm: string;
  scopeCount: number;
  candidateCount: number;
  selectedCount: number;
  selectedIds: string[];
  targetCount: number;
  draftRevision: number;
  createdAt: string;
  appliedAt: string | null;
  receipt: { added: number; skipped: number; revision: number } | null;
};
export type PreviewRecord = DraftSourceRecord & { id: string; fileName: string; selected: boolean };
export const selectionKey = (source: { assetId: string; ordinal: number }) =>
  JSON.stringify([source.assetId, source.ordinal]);
const base = (projectId: string, draftId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts/${encodeURIComponent(draftId)}/selection-previews`;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export function createSelection(
  projectId: string,
  draftId: string,
  configuration: SelectionConfig,
) {
  return request<{ preview: SelectionPreview }>(base(projectId, draftId), post(configuration));
}
export function previewSelection(
  projectId: string,
  draftId: string,
  id: string,
  query: { view: string; search: string; offset: string; limit: string; includeIds: string[] },
) {
  return request<{
    preview: SelectionPreview;
    currentDraftRevision: number;
    records: PreviewRecord[];
    total: number;
  }>(`${base(projectId, draftId)}/${encodeURIComponent(id)}/records`, post(query));
}
export function applySelection(
  projectId: string,
  draftId: string,
  id: string,
  selectedIds: string[],
  expectedRevision: number,
) {
  return request<{ added: number; skipped: number; revision: number; replayed: boolean }>(
    `${base(projectId, draftId)}/${encodeURIComponent(id)}/apply`,
    post({ selectedIds, expectedRevision }),
  );
}
