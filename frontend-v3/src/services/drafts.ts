import { request, type MetadataEntry } from "@/services/workspace";

export type SharedDraft = {
  id: string;
  projectId: string;
  testSetId: string | null;
  parentVersionId: string | null;
  parentVersionLabel: string | null;
  parentRecordCount: number | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  name: string;
  purpose: string;
  status: "editing" | "published";
  suspended: boolean;
  revision: number;
  nameRevision: number;
  purposeRevision: number;
  nameUpdatedBy: string | null;
  purposeUpdatedBy: string | null;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
  publishedVersionId: string | null;
};
export type SharedDraftRecord = {
  id: string;
  position: number;
  caseId: string | null;
  beforeRevisionId: string | null;
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
  source: { assetId: string; ordinal: number } | null;
  sourceFileName: string | null;
  rowRevision: number;
  questionRevision: number;
  expectedOutputRevision: number;
  metadataRevision: number;
  sourceRevision: number;
  fieldAttribution: Record<string, { userId: string; at: string }>;
  updatedBy: string;
  updatedByName?: string;
  updatedAt: string;
};
export type DraftSourceFile = {
  id: string;
  fileName: string;
  collectionName: string;
  recordCount: number;
};
export type DraftSourceRecord = {
  assetId: string;
  ordinal: number;
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
};
const root = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts`;
const item = (projectId: string, draftId: string) =>
  `${root(projectId)}/${encodeURIComponent(draftId)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export async function listSharedDrafts(projectId: string, testSetId?: string) {
  const query = new URLSearchParams();
  if (testSetId) query.set("testSetId", testSetId);
  return (await request<{ drafts: SharedDraft[] }>(`${root(projectId)}?${query}`)).drafts;
}
export async function createSharedDraft(
  projectId: string,
  parent?: { testSetId: string; parentVersionId: string },
) {
  return request<{ draft: SharedDraft; replayed: boolean }>(
    root(projectId),
    json("POST", parent ?? {}),
  );
}
export async function getSharedDraft(
  projectId: string,
  draftId: string,
  input: { limit?: number; offset?: number; search?: string } = {},
) {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 20),
    offset: String(input.offset ?? 0),
  });
  if (input.search) query.set("search", input.search);
  return request<{
    draft: SharedDraft;
    records: SharedDraftRecord[];
    authors: Record<string, { name: string; avatarColor: string }>;
    total: number;
  }>(`${item(projectId, draftId)}?${query}`);
}
export async function saveSharedDraftField(
  projectId: string,
  draftId: string,
  field: "name" | "purpose",
  value: string,
  expectedFieldRevision: number,
) {
  return request<{ draft: SharedDraft }>(
    item(projectId, draftId),
    json("PATCH", { field, value, expectedFieldRevision }),
  );
}
export async function addSharedDraftRecord(
  projectId: string,
  draftId: string,
  input: {
    source?: { assetId: string; ordinal: number };
    question?: string;
    expectedOutput?: string;
    metadata?: MetadataEntry[];
  } = {},
) {
  return request<{ record: SharedDraftRecord; replayed?: boolean }>(
    `${item(projectId, draftId)}/records`,
    json("POST", input),
  );
}
export async function saveSharedDraftRecordField(
  projectId: string,
  draftId: string,
  recordId: string,
  field: "question" | "expectedOutput" | "metadata",
  value: string | MetadataEntry[],
  expectedFieldRevision: number,
) {
  return request<{ record: SharedDraftRecord }>(
    `${item(projectId, draftId)}/records/${encodeURIComponent(recordId)}`,
    json("PATCH", { field, value, expectedFieldRevision }),
  );
}
export async function removeSharedDraftRecord(
  projectId: string,
  draftId: string,
  recordId: string,
  expectedRowRevision: number,
) {
  await request(
    `${item(projectId, draftId)}/records/${encodeURIComponent(recordId)}`,
    json("DELETE", { expectedRowRevision }),
  );
}
export async function discardSharedDraft(projectId: string, draftId: string) {
  await request(item(projectId, draftId), { method: "DELETE" });
}
export async function publishSharedDraft(projectId: string, draftId: string, revision: number) {
  return request<{
    testSet: { id: string; name: string; purpose: string };
    version: { id: string; label: string; recordCount: number };
    replayed: boolean;
  }>(`${item(projectId, draftId)}/publish`, json("POST", { revision }));
}
export async function listDraftSourceFiles(
  projectId: string,
  input: { search?: string; limit?: number; offset?: number } = {},
) {
  const query = new URLSearchParams({
    limit: String(input.limit ?? 10),
    offset: String(input.offset ?? 0),
  });
  if (input.search) query.set("search", input.search);
  return request<{ files: DraftSourceFile[]; total: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/collaborative-draft-source-files?${query}`,
  );
}
export async function listDraftSourceRecords(
  projectId: string,
  assetId: string,
  input: { search?: string; limit?: number; offset?: number } = {},
) {
  const query = new URLSearchParams({
    assetId,
    limit: String(input.limit ?? 20),
    offset: String(input.offset ?? 0),
  });
  if (input.search) query.set("search", input.search);
  return request<{ records: DraftSourceRecord[]; total: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/collaborative-draft-source-records?${query}`,
  );
}
export async function selectDraftSources(
  projectId: string,
  draftId: string,
  input: {
    assetIds: string[];
    search?: string;
    exclude?: Array<{ assetId: string; ordinal: number }>;
    ordinals?: number[];
    mode: "add" | "remove";
  },
) {
  return request<{ matched: number; changed: number }>(
    `${item(projectId, draftId)}/source-selection`,
    json("POST", input),
  );
}

export async function listSelectedDraftSources(projectId: string, draftId: string) {
  return (
    await request<{ sources: Array<{ assetId: string; ordinal: number }> }>(
      `${item(projectId, draftId)}/selected-sources`,
    )
  ).sources;
}
