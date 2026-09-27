import {
  encodeUploadHeader,
  UPLOAD_HEADER_ENCODING,
} from "../upload-headers.js";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = body?.error?.code ?? `http_${response.status}`;
    throw Object.assign(new Error(code), { details: body?.error });
  }
  return response.json() as Promise<T>;
}

function queryString(filters: Record<string, string> = {}) {
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  );
  return query.size ? `?${query}` : "";
}

type SessionResponse = {
  csrfToken: string;
  actor: {
    id: string;
    username: string;
    role: "owner" | "editor" | "viewer";
    projectRole: "owner" | "editor" | "viewer" | null;
    capabilities: {
      read: boolean;
      write: boolean;
      export: boolean;
      manage: boolean;
    };
    testIdentity: boolean;
  };
};

export const api = {
  login(
    username: FormDataEntryValue | null,
    password: FormDataEntryValue | null,
  ) {
    return requestJson<SessionResponse>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  },
  currentSession() {
    return requestJson<SessionResponse>("/api/session");
  },
  uploadAsset(
    projectId: string,
    csrf: string,
    file: File,
    attribution: {
      sourceType: string;
      sourceName: string;
      responsiblePerson: string;
      purpose: string;
      licenseStatus: string;
      sensitivity: string;
      sourceAddress?: string;
      acquiredAt?: string;
      deidentificationConfirmed?: boolean;
    },
  ) {
    const extension = file.name.toLowerCase().split(".").pop();
    const contentType =
      extension === "jsonl"
        ? "application/x-ndjson"
        : extension === "json"
          ? "application/octet-stream"
          : "text/csv; charset=utf-8";
    return requestJson<any>(`/api/projects/${projectId}/assets`, {
      method: "POST",
      headers: {
        "x-csrf-token": csrf,
        "idempotency-key": `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "content-type": contentType,
        "x-agentbench-upload-encoding": UPLOAD_HEADER_ENCODING,
        "x-file-name": encodeUploadHeader(file.name),
        "x-source-type": encodeUploadHeader(attribution.sourceType),
        "x-source-name": encodeUploadHeader(attribution.sourceName),
        "x-responsible-person": encodeUploadHeader(
          attribution.responsiblePerson,
        ),
        "x-source-purpose": encodeUploadHeader(attribution.purpose),
        "x-license-status": encodeUploadHeader(attribution.licenseStatus),
        "x-sensitivity": encodeUploadHeader(attribution.sensitivity),
        ...(attribution.sourceAddress
          ? {
              "x-source-address": encodeUploadHeader(attribution.sourceAddress),
            }
          : {}),
        ...(attribution.acquiredAt
          ? { "x-acquired-at": encodeUploadHeader(attribution.acquiredAt) }
          : {}),
        ...(attribution.deidentificationConfirmed
          ? { "x-deidentification-confirmed": "true" }
          : {}),
      },
      body: file,
    });
  },
  asset(projectId: string, assetId: string) {
    return requestJson<any>(`/api/projects/${projectId}/assets/${assetId}`);
  },
  assets(projectId: string, filters: Record<string, string> = {}) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets${queryString(filters)}`,
    );
  },
  testSets(projectId: string, filters: Record<string, string> = {}) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets${queryString(filters)}`,
    );
  },
  attributionHistory(projectId: string, assetId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/attributions`,
    );
  },
  assetAudit(projectId: string, assetId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/audit`,
    );
  },
  projectAudit(projectId: string, filters: Record<string, string> = {}) {
    return requestJson<any>(
      `/api/projects/${projectId}/audit${queryString(filters)}`,
    );
  },
  auditSummary(projectId: string) {
    return requestJson<any>(`/api/projects/${projectId}/audit/summary`);
  },
  archiveAsset(projectId: string, assetId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/archive`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  deleteAsset(projectId: string, assetId: string, csrf: string) {
    return requestJson<any>(`/api/projects/${projectId}/assets/${assetId}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
    });
  },
  deletionPreview(projectId: string, assetId: string, csrf: string) {
    return requestJson<any>(`/api/projects/${projectId}/deletions/preview`, {
      method: "POST",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "data_asset", targetId: assetId }),
    });
  },
  confirmDeletion(
    projectId: string,
    eventId: string,
    csrf: string,
    previewHash: string,
    reasonCode: string,
    reasonNote: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/deletions/${eventId}/confirm`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ previewHash, reasonCode, reasonNote }),
      },
    );
  },
  deletionOutcome(projectId: string, eventId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/deletions/${eventId}/outcome`,
    );
  },
  retryDeletion(projectId: string, eventId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/deletions/${eventId}/retry`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  preview(
    projectId: string,
    assetId: string,
    options: { parsedViewId?: string; parseStatus?: "valid" | "invalid" } = {},
  ) {
    const query = new URLSearchParams();
    if (options.parsedViewId) query.set("parsedViewId", options.parsedViewId);
    if (options.parseStatus) query.set("parseStatus", options.parseStatus);
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/records${query.size ? `?${query}` : ""}`,
    );
  },
  parseAttempts(projectId: string, assetId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/parse-attempts`,
    );
  },
  retryParse(
    projectId: string,
    assetId: string,
    csrf: string,
    config: Record<string, unknown>,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/assets/${assetId}/parse-attempts`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ config }),
      },
    );
  },
  excludeFailures(
    projectId: string,
    parsedViewId: string,
    csrf: string,
    locators: unknown[],
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/parsed-views/${parsedViewId}/exclusions`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ locators }),
      },
    );
  },
  selectParsedView(projectId: string, parsedViewId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/parsed-views/${parsedViewId}/select`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  sourceRecordLocation(
    projectId: string,
    parsedViewId: string,
    ordinal: number,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/parsed-views/${parsedViewId}/records/${ordinal}/location`,
    );
  },
  createTestSet(
    projectId: string,
    csrf: string,
    assetId: string,
    details: { name: string; purpose: string },
  ) {
    return requestJson<any>(`/api/projects/${projectId}/test-sets`, {
      method: "POST",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({
        name: details.name,
        purpose: details.purpose,
        assetId,
      }),
    });
  },
  attachDraftSource(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
    assetId: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/sources`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          assetId,
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  openDraft(
    projectId: string,
    testSetId: string,
    csrf: string,
    baseVersionId: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/drafts`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ baseVersionId }),
      },
    );
  },
  saveSourceMapping(
    projectId: string,
    draftId: string,
    sourceId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
    mapping: Record<string, unknown>,
    unmappedFields: string[],
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/sources/${sourceId}/mapping`,
      {
        method: "PUT",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          mapping,
          unmappedFields,
          unmappedConfirmed: true,
        }),
      },
    );
  },
  removeDraftSource(
    projectId: string,
    draftId: string,
    sourceId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/sources/${sourceId}`,
      {
        method: "DELETE",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  createManualCase(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
    item: { input: unknown; expectedOutput: unknown; metadata?: unknown },
    reason: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/cases`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          ...item,
          reason,
        }),
      },
    );
  },
  updateManualCase(
    projectId: string,
    draftId: string,
    caseId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
    item: { input?: unknown; expectedOutput?: unknown; metadata?: unknown },
    reason?: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/cases/${caseId}`,
      {
        method: "PUT",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          ...item,
          ...(reason ? { reason } : {}),
        }),
      },
    );
  },
  deleteManualCase(
    projectId: string,
    draftId: string,
    caseId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/cases/${caseId}`,
      {
        method: "DELETE",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  configureDraft(
    projectId: string,
    draftId: string,
    csrf: string,
    configuration: Record<string, unknown>,
  ) {
    return requestJson<any>(`/api/projects/${projectId}/drafts/${draftId}`, {
      method: "PUT",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify(configuration),
    });
  },
  saveRecipe(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
    recipe: {
      steps: unknown[];
      versionDescription: string;
      mapping?: Record<string, unknown>;
      unmappedFields?: string[];
      unmappedConfirmed?: boolean;
      duplicateDecisions?: Record<string, "include" | "exclude">;
    },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/recipe`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          ...recipe,
        }),
      },
    );
  },
  previewMapping(
    projectId: string,
    draftId: string,
    csrf: string,
    mapping: Record<string, unknown>,
    sourceId?: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/mapping/preview`,
      {
        method: "POST",
        headers: {
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mapping, ...(sourceId ? { sourceId } : {}) }),
      },
    );
  },
  suggestMappingSchema(projectId: string, draftId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/mapping/schema-suggestion`,
    );
  },
  mappingValidation(projectId: string, draftId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/mapping/validation`,
    );
  },
  draft(projectId: string, draftId: string) {
    return requestJson<any>(`/api/projects/${projectId}/drafts/${draftId}`);
  },
  renewDraftLease(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/lease/renew`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  takeoverDraftLease(
    projectId: string,
    draftId: string,
    csrf: string,
    expectedRevision: number,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/lease/takeover`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, expectedRevision }),
      },
    );
  },
  evaluateRecipe(projectId: string, draftId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/evaluate`,
      {
        method: "POST",
        headers: {
          "x-csrf-token": csrf,
        },
      },
    );
  },
  abandonDraft(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/abandon`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  materialize(
    projectId: string,
    draftId: string,
    csrf: string,
    draft: { leaseToken: string; revision: number },
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/drafts/${draftId}/candidates`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
        }),
      },
    );
  },
  candidate(projectId: string, candidateId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/candidates/${candidateId}`,
    );
  },
  publish(projectId: string, candidateId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/candidates/${candidateId}/publish`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  job(projectId: string, jobId: string) {
    return requestJson<any>(`/api/projects/${projectId}/jobs/${jobId}`);
  },
  cancelJob(projectId: string, jobId: string, csrf: string) {
    return requestJson<any>(`/api/projects/${projectId}/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
    });
  },
  retryJob(projectId: string, jobId: string, csrf: string) {
    return requestJson<any>(`/api/projects/${projectId}/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { "x-csrf-token": csrf },
    });
  },
  requestPackage(
    projectId: string,
    versionId: string,
    csrf: string,
    packageType: "standard" | "full_provenance",
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/versions/${versionId}/packages`,
      {
        method: "POST",
        headers: {
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ packageType, formatVersion: "1.0" }),
      },
    );
  },
  requestLangfuseCsv(projectId: string, versionId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/versions/${versionId}/langfuse-csv`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  versionDeliveries(projectId: string, versionId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/versions/${versionId}/deliveries`,
    );
  },
  deliveries(projectId: string, filters: Record<string, string> = {}) {
    return requestJson<any>(
      `/api/projects/${projectId}/deliveries${queryString(filters)}`,
    );
  },
  projectMembers(projectId: string) {
    return requestJson<any>(`/api/projects/${projectId}/members`);
  },
  addProjectMember(
    projectId: string,
    csrf: string,
    username: string,
    role: "editor" | "viewer",
  ) {
    return requestJson<any>(`/api/projects/${projectId}/members`, {
      method: "POST",
      headers: {
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ username, role }),
    });
  },
  updateProjectMember(
    projectId: string,
    userId: string,
    csrf: string,
    role: "editor" | "viewer",
  ) {
    return requestJson<any>(`/api/projects/${projectId}/members/${userId}`, {
      method: "PUT",
      headers: {
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role }),
    });
  },
  removeProjectMember(projectId: string, userId: string, csrf: string) {
    return requestJson<any>(`/api/projects/${projectId}/members/${userId}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrf },
    });
  },
  async deliveryText(projectId: string, deliveryId: string) {
    const response = await fetch(
      `/api/projects/${projectId}/deliveries/${deliveryId}/preview`,
    );
    if (!response.ok) throw new Error("delivery_preview_failed");
    return await response.text();
  },
  attestDeliveryImported(projectId: string, deliveryId: string, csrf: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/deliveries/${deliveryId}/imported`,
      { method: "POST", headers: { "x-csrf-token": csrf } },
    );
  },
  registerTransformationRun(
    projectId: string,
    csrf: string,
    manifest: Record<string, unknown>,
  ) {
    return requestJson<any>(`/api/projects/${projectId}/transformation-runs`, {
      method: "POST",
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
  },
  transformationRun(projectId: string, runId: string) {
    return requestJson<any>(
      `/api/projects/${projectId}/transformation-runs/${runId}`,
    );
  },
  completeTransformationRun(
    projectId: string,
    runId: string,
    csrf: string,
    manifest: Record<string, unknown>,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/transformation-runs/${runId}/complete`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify(manifest),
      },
    );
  },
  annotateTransformationRun(
    projectId: string,
    runId: string,
    csrf: string,
    note: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/transformation-runs/${runId}/annotations`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ note }),
      },
    );
  },
  lineageTrace(
    projectId: string,
    subjectType: "case_revision" | "test_set_version",
    subjectId: string,
  ) {
    const query = new URLSearchParams({ subjectType, subjectId });
    return requestJson<any>(
      `/api/projects/${projectId}/lineage/trace?${query}`,
    );
  },
  version(
    projectId: string,
    testSetId: string,
    versionId: string,
    filters: Record<string, string> = {},
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${versionId}${queryString(filters)}`,
    );
  },
  versions(
    projectId: string,
    testSetId: string,
    filters: Record<string, string> = {},
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions${queryString(filters)}`,
    );
  },
  versionCases(
    projectId: string,
    testSetId: string,
    versionId: string,
    filters: Record<string, string> = {},
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${versionId}/cases${queryString(filters)}`,
    );
  },
  versionCase(
    projectId: string,
    testSetId: string,
    versionId: string,
    caseId: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${versionId}/cases/${caseId}`,
    );
  },
  compareVersions(
    projectId: string,
    testSetId: string,
    baseVersionId: string,
    targetVersionId: string,
    filters: Record<string, string> = {},
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${baseVersionId}/compare/${targetVersionId}${queryString(filters)}`,
    );
  },
  setDefaultVersion(
    projectId: string,
    testSetId: string,
    versionId: string,
    csrf: string,
    reason: string,
    expectedDefaultVersionId: string | null,
    correlationId: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${versionId}/default`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          reason,
          expectedDefaultVersionId,
          correlationId,
        }),
      },
    );
  },
  archiveVersion(
    projectId: string,
    testSetId: string,
    versionId: string,
    csrf: string,
    reason: string,
    expectedDefaultVersionId: string | null,
    correlationId: string,
  ) {
    return requestJson<any>(
      `/api/projects/${projectId}/test-sets/${testSetId}/versions/${versionId}/archive`,
      {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          ...(reason.trim() ? { reason } : {}),
          expectedDefaultVersionId,
          correlationId,
        }),
      },
    );
  },
};
