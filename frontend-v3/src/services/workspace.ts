import { createRequestId } from "@/lib/request-id";

export type Project = {
  id: string;
  name: string;
  description: string;
  datasetCount: number;
  testSetCount: number;
  updatedAt: string;
};

export type Collection = {
  id: string;
  name: string;
  description: string;
  isUnfiled: boolean;
  fileCount: number;
  unifiedRecordCount: number;
  updatedAt: string;
};

export type Page<T> = { items: T[]; total: number };

export type DisplayMapping = {
  question?: string | undefined;
  expectedOutput?: string | undefined;
  metadata: string[];
};

export type PendingUpload = {
  id: string;
  fileName: string;
  format: "csv" | "json" | "jsonl";
  size: number;
  recordCount: number;
  fields: Array<{ path: string; sample: unknown }>;
  issues: Array<{ reason?: string; location?: unknown }>;
};

export type MaterialFile = {
  id: string;
  fileName: string;
  format: "csv" | "json" | "jsonl";
  size: number;
  recordCount: number;
  uploadedAt: string;
  status: "可浏览" | "等待解析";
};

export type MetadataEntry = { key: string; value: string };

export type UnifiedRecord = {
  assetId: string;
  ordinal: number;
  sourceFile: string;
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
};

export type TestSet = {
  id: string;
  name: string;
  currentVersionId: string;
  currentVersion: string;
  recordCount: number;
  source: string;
  status: "已发布";
  updatedAt: string;
};

export type TestSetSource = {
  id: string;
  name: string;
  files: Array<{
    id: string;
    fileName: string;
    records: Array<{
      assetId: string;
      ordinal: number;
      question: string;
      expectedOutput: string;
      metadata: MetadataEntry[];
    }>;
  }>;
};

export type TestSetRecord = {
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
  source?: { assetId: string; ordinal: number };
};

export type VersionRecord = {
  ordinal: number;
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
  source: {
    ordinal: number;
    fileName?: string;
  } | null;
};

export type EditableVersionRecord = TestSetRecord & {
  ordinal: number;
  caseId: string;
  revisionId: string;
  source: {
    assetId: string;
    ordinal: number;
  } | null;
  parentOrdinal: number;
};

export type VersionEditOperation =
  | { operation: "add"; after: TestSetRecord }
  | {
      operation: "update";
      caseId: string;
      beforeRevisionId: string;
      after: TestSetRecord;
    }
  | { operation: "delete"; caseId: string; beforeRevisionId: string };

export type VersionRecordPage = Page<VersionRecord> & {
  filterOptions: {
    sourceFiles: Array<{ id: string; name: string }>;
    metadataFields: string[];
  };
};

export type DataCheck = {
  missingQuestionCount: number;
  exactDuplicateCount: number;
  traceableRecordCount: number;
};

export type TestSetVersionNode = {
  id: string;
  label: string;
  parentVersionId: string | null;
  recordCount: number;
  publicationOrder: number;
  generation: number;
  branchNumber: number | null;
  createdAt: string;
  tombstoned?: boolean;
  tombstonedAt?: string;
};

export type TestSetTrashEntry = {
  id: string;
  type: "test_set" | "version_branch";
  testSetId: string;
  testSetName: string;
  rootVersionId: string | null;
  rootVersionLabel: string | null;
  versionCount: number;
  trashedAt: string;
  pendingCleanup: boolean;
};

export type SoloTestSetVersionDetail = {
  testSet: { id: string; name: string; purpose: string };
  version: {
    id: string;
    label: string;
    recordCount: number;
    parentVersionId: string | null;
    createdAt: string;
  };
  versionSummary: {
    sourceFiles: string[];
    manualRecordCount: number;
    changes: { modified: number; added: number; removed: number };
  };
  dataCheck: DataCheck;
  graph: { nodes: TestSetVersionNode[] };
};

export type ProvenanceRecord = {
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
  source: {
    assetId: string;
    ordinal: number;
    fileName?: string;
    collectionId?: string;
  } | null;
};

export type ProvenanceChange = {
  id: string;
  changeType: "unchanged" | "modified" | "added" | "removed";
  current: ProvenanceRecord | null;
  previous: ProvenanceRecord | null;
  source: ProvenanceRecord["source"];
  changedFields: string[];
  fieldEditors?: Record<string, { userId: string; name: string; avatarColor: string; at: string }>;
  recordEditor?: { userId: string; name: string; avatarColor: string; at: string } | null;
};

export type ProvenancePage = {
  summary: {
    parentVersion: { id: string; label: string } | null;
    currentVersion: { id: string; label: string; recordCount: number; createdAt: string };
    counts: Record<ProvenanceChange["changeType"], number>;
    addedFiles: Array<{
      assetId: string;
      fileName: string;
      recordCount: number;
      mapping: {
        question: string | null;
        expectedOutput: string | null;
        metadata: string[];
      };
    }>;
    manualAddedCount: number;
  };
  changes: ProvenanceChange[];
  pagination: { total: number; limit: number; offset: number };
};

type PageRequest = { limit: number; offset: number };

let session: Promise<string> | undefined;

async function csrfToken(): Promise<string> {
  session ??= (async () => {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("请先登录 EvalBase。");
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  })();
  return session;
}

export function resetWorkspaceSession() {
  session = undefined;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (method !== "GET") headers.set("x-csrf-token", await csrfToken());
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 401) {
    session = undefined;
    window.dispatchEvent(new Event("evalbase:session-expired"));
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | {
          error?: {
            code?: string;
            existingFileName?: string;
            existingCollectionName?: string | null;
          };
        }
      | undefined;
    throw Object.assign(new Error(body?.error?.code ?? "操作失败"), body?.error);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listProjects({
  name = "",
  limit,
  offset,
}: PageRequest & { name?: string }): Promise<Page<Project>> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (name.trim()) query.set("name", name.trim());
  const response = await request<{ projects: Project[]; pagination: { total: number } }>(
    `/api/projects?${query}`,
  );
  return { items: response.projects, total: response.pagination.total };
}

export async function createProject(input: {
  name: string;
  description: string;
}): Promise<Project> {
  const response = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.project;
}

export async function listCollections(
  projectId: string,
  input: PageRequest & {
    name?: string;
    type?: "all" | "dataset" | "system";
    content?: "all" | "populated" | "empty";
    sort?: "updated_desc" | "updated_asc";
  },
): Promise<Page<Collection>> {
  const query = new URLSearchParams({
    limit: String(input.limit),
    offset: String(input.offset),
  });
  if (input.name?.trim()) query.set("name", input.name.trim());
  if (input.type && input.type !== "all") query.set("type", input.type);
  if (input.content && input.content !== "all") query.set("content", input.content);
  if (input.sort && input.sort !== "updated_desc") query.set("sort", input.sort);
  const response = await request<{
    collections: Collection[];
    pagination: { total: number };
  }>(`/api/projects/${encodeURIComponent(projectId)}/collections?${query}`);
  return { items: response.collections, total: response.pagination.total };
}

export async function createCollection(
  projectId: string,
  input: { name: string; description: string },
): Promise<Collection> {
  const response = await request<{ collection: Collection }>(
    `/api/projects/${encodeURIComponent(projectId)}/collections`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return response.collection;
}

export async function startPendingUpload(projectId: string, file: File): Promise<PendingUpload> {
  const extension = file.name.toLowerCase().split(".").pop();
  const contentType = extension === "csv" ? "text/csv" : "application/octet-stream";
  const response = await request<{ pendingUpload: PendingUpload }>(
    `/api/projects/${encodeURIComponent(projectId)}/pending-uploads`,
    {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-agentbench-upload-encoding": "percent-utf8",
        "x-file-name": encodeURIComponent(file.name),
        "idempotency-key": createRequestId(),
      },
      body: file,
    },
  );
  return response.pendingUpload;
}

export async function previewPendingUpload(
  projectId: string,
  pendingUploadId: string,
  mapping: DisplayMapping,
): Promise<
  PendingUpload & {
    preview: Array<{ question: string; expectedOutput: string; metadata: MetadataEntry[] }>;
  }
> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/pending-uploads/${encodeURIComponent(pendingUploadId)}/preview`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapping }),
    },
  );
}

export async function confirmPendingUploads(
  projectId: string,
  collectionId: string,
  pendingUploadIds: string[],
  idempotencyKey: string,
) {
  return request<{ assets: Array<{ id: string; fileName: string }> }>(
    `/api/projects/${encodeURIComponent(projectId)}/pending-upload-batches/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ collectionId, pendingUploadIds }),
    },
  );
}

export async function cancelPendingUploads(projectId: string, pendingUploadIds: string[]) {
  await request(`/api/projects/${encodeURIComponent(projectId)}/pending-upload-batches`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pendingUploadIds }),
  });
}

export async function listMaterialFiles(
  projectId: string,
  collectionId: string,
  input: PageRequest & { name?: string },
): Promise<Page<MaterialFile>> {
  const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  if (input.name?.trim()) query.set("name", input.name.trim());
  const response = await request<{ assets: MaterialFile[]; pagination: { total: number } }>(
    `/api/projects/${encodeURIComponent(projectId)}/collections/${encodeURIComponent(collectionId)}/assets?${query}`,
  );
  return { items: response.assets, total: response.pagination.total };
}

export async function getMaterialFile(
  projectId: string,
  collectionId: string,
  assetId: string,
): Promise<Pick<MaterialFile, "fileName" | "format" | "recordCount">> {
  const response = await request<{
    asset: Pick<MaterialFile, "fileName" | "format" | "recordCount">;
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/collections/${encodeURIComponent(collectionId)}/assets/${encodeURIComponent(assetId)}`,
  );
  return response.asset;
}

export async function getMaterialRecord(
  projectId: string,
  collectionId: string,
  assetId: string,
  ordinal: number,
): Promise<UnifiedRecord> {
  const response = await request<{ record: UnifiedRecord }>(
    `/api/projects/${encodeURIComponent(projectId)}/collections/${encodeURIComponent(collectionId)}/assets/${encodeURIComponent(assetId)}/records/${ordinal}`,
  );
  return response.record;
}

export async function getMaterialRawPreview(projectId: string, assetId: string) {
  return request<{ rawPreview: { text: string; truncated: boolean } }>(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/download?view=raw`,
  );
}

export async function listUnifiedRecords(
  projectId: string,
  collectionId: string,
  input: PageRequest & { search?: string; assetId?: string },
): Promise<Page<UnifiedRecord>> {
  const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  if (input.search?.trim()) query.set("search", input.search.trim());
  if (input.assetId) query.set("assetId", input.assetId);
  const response = await request<{ records: UnifiedRecord[]; pagination: { total: number } }>(
    `/api/projects/${encodeURIComponent(projectId)}/collections/${encodeURIComponent(collectionId)}/records?${query}`,
  );
  return { items: response.records, total: response.pagination.total };
}

export async function moveMaterialFile(projectId: string, assetId: string, collectionId: string) {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/collection`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionId }),
    },
  );
}

export async function listTestSets(
  projectId: string,
  input: PageRequest & { name?: string },
): Promise<Page<TestSet>> {
  const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  if (input.name?.trim()) query.set("name", input.name.trim());
  const response = await request<{
    testSets: TestSet[];
    pagination: { total: number };
  }>(`/api/projects/${encodeURIComponent(projectId)}/solo-test-sets?${query}`);
  return { items: response.testSets, total: response.pagination.total };
}

export async function listTestSetSources(projectId: string): Promise<TestSetSource[]> {
  const response = await request<{ datasets: TestSetSource[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-set-sources`,
  );
  return response.datasets;
}

export async function createSoloTestSet(
  projectId: string,
  input: {
    name: string;
    purpose: string;
    selections: Array<{ assetId: string; ordinal: number }>;
    records: Array<TestSetRecord & { parentOrdinal?: number }>;
    idempotencyKey: string;
  },
) {
  return request<{
    testSet: { id: string; name: string; purpose: string };
    version: { id: string; label: string; recordCount: number };
    dataCheck: DataCheck;
  }>(`/api/projects/${encodeURIComponent(projectId)}/solo-test-sets`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({
      name: input.name,
      purpose: input.purpose,
      selections: input.selections,
      operations: input.records.map((record) => ({ operation: "add", after: record })),
    }),
  });
}

export async function getSoloTestSetVersion(
  projectId: string,
  testSetId: string,
  versionId: string,
) {
  return request<SoloTestSetVersionDetail>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}`,
  );
}

export async function listSoloVersionRecords(
  projectId: string,
  testSetId: string,
  versionId: string,
  input: PageRequest & {
    search?: string;
    sourceAssetIds?: string[];
    question?: "all" | "present" | "missing";
    origin?: "all" | "source" | "manual";
    metadataField?: string;
    metadata?: string;
  },
): Promise<VersionRecordPage> {
  const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  if (input.search?.trim()) query.set("search", input.search.trim());
  for (const sourceAssetId of input.sourceAssetIds ?? [])
    query.append("sourceAssetId", sourceAssetId);
  if (input.question && input.question !== "all") query.set("question", input.question);
  if (input.origin && input.origin !== "all") query.set("origin", input.origin);
  if (input.metadataField) query.set("metadataField", input.metadataField);
  if (input.metadata?.trim()) query.set("metadata", input.metadata.trim());
  const response = await request<{
    records: VersionRecord[];
    pagination: { total: number };
    filterOptions: VersionRecordPage["filterOptions"];
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/records?${query}`,
  );
  return {
    items: response.records,
    total: response.pagination.total,
    filterOptions: response.filterOptions,
  };
}

export async function listSoloVersionEditingPage(
  projectId: string,
  testSetId: string,
  versionId: string,
  offset: number,
): Promise<{
  records: EditableVersionRecord[];
  pagination: { total: number; limit: number; offset: number };
}> {
  return request<{
    records: EditableVersionRecord[];
    pagination: { total: number; limit: number; offset: number };
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/editing-records?limit=10&offset=${offset}`,
  );
}

export async function findSoloVersionEditingSource(
  projectId: string,
  testSetId: string,
  versionId: string,
  assetId: string,
  ordinal: number,
): Promise<EditableVersionRecord | undefined> {
  const page = await request<{
    records: EditableVersionRecord[];
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/editing-records?limit=1&offset=0&sourceAssetId=${encodeURIComponent(assetId)}&sourceOrdinal=${ordinal}`,
  );
  return page.records[0];
}

export async function getSoloVersionRecord(
  projectId: string,
  testSetId: string,
  versionId: string,
  ordinal: number,
) {
  return request<{ record: VersionRecord }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/records/${ordinal}`,
  );
}

export async function deriveSoloTestSetVersion(
  projectId: string,
  testSetId: string,
  parentVersionId: string,
  input: {
    operations: VersionEditOperation[];
    idempotencyKey: string;
  },
) {
  return request<{
    version: { id: string; label: string; recordCount: number; parentVersionId: string };
    dataCheck: DataCheck;
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(parentVersionId)}/derived-versions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ operations: input.operations }),
    },
  );
}

export async function getSoloVersionProvenance(
  projectId: string,
  testSetId: string,
  versionId: string,
  input: {
    status: "changed" | "all" | "unchanged" | "modified" | "added" | "removed";
    search: string;
    limit: number;
    offset: number;
  },
) {
  const query = new URLSearchParams({
    status: input.status,
    limit: String(input.limit),
    offset: String(input.offset),
  });
  if (input.search.trim()) query.set("search", input.search.trim());
  return request<ProvenancePage>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/provenance?${query}`,
  );
}

export async function getSoloVersionChange(
  projectId: string,
  testSetId: string,
  versionId: string,
  changeId: string,
) {
  return request<{ change: ProvenanceChange }>(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/provenance/${encodeURIComponent(changeId)}`,
  );
}

export function soloVersionDownloadUrl(
  projectId: string,
  testSetId: string,
  versionId: string,
  file: "data.csv" | "provenance.csv",
) {
  return `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/${file}`;
}

export async function listSoloTestSetTrash(
  projectId: string,
  input: PageRequest,
): Promise<Page<TestSetTrashEntry>> {
  const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
  const response = await request<{
    entries: TestSetTrashEntry[];
    pagination: { total: number };
  }>(`/api/projects/${encodeURIComponent(projectId)}/solo-test-set-trash?${query}`);
  return { items: response.entries, total: response.pagination.total };
}

export async function trashSoloTestSet(projectId: string, testSetId: string) {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/trash`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
}

export async function trashSoloVersionBranch(
  projectId: string,
  testSetId: string,
  versionId: string,
  includeDescendants: boolean,
) {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/trash`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(includeDescendants ? { includeDescendants: true } : {}),
    },
  );
}

export async function restoreSoloTestSetTrash(projectId: string, entryId: string) {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-set-trash/${encodeURIComponent(entryId)}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
}

export async function permanentlyDeleteSoloTestSetTrash(
  projectId: string,
  entryId: string,
  confirmation: string,
) {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-set-trash/${encodeURIComponent(entryId)}/permanent-delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    },
  );
}

export async function tombstoneSoloTestSetVersion(
  projectId: string,
  testSetId: string,
  versionId: string,
  confirmation: string,
) {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/solo-test-sets/${encodeURIComponent(testSetId)}/versions/${encodeURIComponent(versionId)}/tombstone`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    },
  );
}
