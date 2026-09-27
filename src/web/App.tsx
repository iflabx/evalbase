import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CAPACITY_LIMITS } from "../capacity.js";
import { api } from "./api.js";
import { AppShell, EvidenceTrack, StateView } from "./components.js";
import { DeliveryRecordsList } from "./delivery-list.js";
import { parseRoute, type AppRoute } from "./navigation.js";
import { StructuredListsPanel } from "./structured-lists.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

const projectId = "project_demo";
const draftStorageKey = "agentbench.ticket04.draft";

function newLifecycleCorrelationId() {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

type FilterOperator = "eq" | "neq" | "contains" | "range" | "is_null";
type ManualDecision = {
  id: string;
  action: "include" | "exclude";
  reason?: string;
  actorId?: string;
};

async function waitFor<T>(
  load: () => Promise<T>,
  ready: (value: T) => boolean,
  active: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (!active()) throw new Error("route_superseded");
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("后台任务等待超时");
}

function capacityErrorMessage(details: any) {
  const code = details?.code ?? "capacity_blocked";
  if (code === "asset_too_large")
    return `Data Asset 上传被阻断（${details.blockingPhase}）：已观察 ${(
      details.actualBytes ?? 0
    ).toLocaleString("en-US")} bytes，上限 ${details.limitBytes.toLocaleString(
      "en-US",
    )} bytes（50 MB / ${CAPACITY_LIMITS.dataAssetBytes.toLocaleString(
      "en-US",
    )} bytes）。${details.retry}`;
  if (code === "parsed_view_not_draft_eligible")
    return `Parsed View ${details.object?.id ?? ""} 不能加入草稿（${
      details.blockingPhase ?? "parsed_view"
    }）：${details.actualRecords?.toLocaleString("en-US") ?? "存在未排除错误"} 条记录，上限 ${
      details.limitRecords?.toLocaleString("en-US") ??
      CAPACITY_LIMITS.parsedViewRecords.toLocaleString("en-US")
    }。${details.retry ?? ""}`;
  if (code !== "draft_capacity_exceeded")
    return `${code}：请在当前阶段修正后重试。`;
  const labels: Record<string, string> = {
    assets: `附件 ${details.actual.assets}/${details.limit.assets}`,
    originalBytes: `原始字节 ${details.actual.originalBytes.toLocaleString(
      "en-US",
    )}/${details.limit.originalBytes.toLocaleString("en-US")}`,
    sourceRecords: `Source Records ${details.actual.sourceRecords.toLocaleString(
      "en-US",
    )}/${details.limit.sourceRecords.toLocaleString("en-US")}`,
  };
  return `Working Draft ${details.object?.id ?? ""} 的${
    labels[details.exceededDimension] ?? "附件容量"
  }超限；阻断阶段：${details.blockingPhase}。${
    details.retry ?? "请替换附件后重试。"
  }`;
}

function locatorLabel(locator?: any): string {
  if (!locator) return "对象级错误";
  if (locator.kind === "json_pointer") return locator.pointer || "顶层对象";
  if (locator.kind === "jsonl_line") return `物理行 ${locator.physicalLine}`;
  return `数据行 ${locator.dataRow}（物理行 ${locator.physicalLine}）`;
}

function byteLimitLabel(limitBytes: number) {
  return `${(limitBytes / 1_000_000).toLocaleString("en-US")} MB / ${limitBytes.toLocaleString(
    "en-US",
  )} bytes`;
}

function bytePairLabel(actualBytes: number, limitBytes: number) {
  return `${actualBytes.toLocaleString("en-US")}/${limitBytes.toLocaleString(
    "en-US",
  )} bytes（${byteLimitLabel(limitBytes)}）`;
}

function capacityValue(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) => `${key} ${capacityValue(item)}`)
      .join("；");
  return String(value);
}

function isAggregateCapacity(value: unknown): value is {
  assets: number;
  originalBytes: number;
  sourceRecords: number;
  largestAssetBytes: number;
  largestAssetRecords: number;
} {
  if (!value || typeof value !== "object") return false;
  const measurement = value as Record<string, unknown>;
  return [
    "assets",
    "originalBytes",
    "sourceRecords",
    "largestAssetBytes",
    "largestAssetRecords",
  ].every((key) => typeof measurement[key] === "number");
}

export function App() {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<AppRoute>(() =>
    parseRoute(`${window.location.pathname}${window.location.search}`),
  );
  const [csrf, setCsrf] = useState("");
  const [actor, setActor] = useState<any>();
  const [members, setMembers] = useState<any[]>([]);
  const [memberChanges, setMemberChanges] = useState<any[]>([]);
  const [memberUsername, setMemberUsername] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"editor" | "viewer">("viewer");
  const [file, setFile] = useState<File>();
  const [asset, setAsset] = useState<any>();
  const [assetDetail, setAssetDetail] = useState<any>();
  const [attributionHistory, setAttributionHistory] = useState<any[]>([]);
  const [assetAudit, setAssetAudit] = useState<any[]>([]);
  const [deletionPreview, setDeletionPreview] = useState<any>();
  const [deletionResult, setDeletionResult] = useState<any>();
  const [deletionReasonCode, setDeletionReasonCode] =
    useState("nonproduction_test");
  const [deletionReasonNote, setDeletionReasonNote] = useState("");
  const [parsedView, setParsedView] = useState<any>();
  const [parseFailures, setParseFailures] = useState<any[]>([]);
  const [attempts, setAttempts] = useState<any[]>([]);
  const [transformationOperation, setTransformationOperation] =
    useState("agent_augmentation");
  const [transformationLevel, setTransformationLevel] = useState<
    "asset_level" | "record_level"
  >("asset_level");
  const [transformationPurpose, setTransformationPurpose] = useState(
    "External Agent augmentation",
  );
  const [transformationToolName, setTransformationToolName] =
    useState("dataset-expander");
  const [transformationToolVersion, setTransformationToolVersion] =
    useState("0.3.1");
  const [transformationCodeRef, setTransformationCodeRef] = useState("");
  const [transformationToolDescription, setTransformationToolDescription] =
    useState("");
  const [transformationModelProvider, setTransformationModelProvider] =
    useState("synthetic-provider");
  const [transformationModelName, setTransformationModelName] =
    useState("synthetic-model");
  const [transformationModelParameters, setTransformationModelParameters] =
    useState("{}");
  const [transformationPromptVersion, setTransformationPromptVersion] =
    useState("browser-scenario-d-v1");
  const [transformationPromptMode, setTransformationPromptMode] = useState<
    "content" | "immutable_ref"
  >("content");
  const [transformationPromptAssetId, setTransformationPromptAssetId] =
    useState("");
  const [transformationPromptSha256, setTransformationPromptSha256] =
    useState("");
  const [transformationPromptContent, setTransformationPromptContent] =
    useState("Expand billing refund questions with synthetic facts only.");
  const [transformationInputVersionId, setTransformationInputVersionId] =
    useState("");
  const [transformationInputSha256, setTransformationInputSha256] =
    useState("");
  const [transformationScopeKey, setTransformationScopeKey] =
    useState("category");
  const [transformationScopeValue, setTransformationScopeValue] =
    useState("billing");
  const [transformationExtraInputsJson, setTransformationExtraInputsJson] =
    useState("[]");
  const [transformationRecordEdges, setTransformationRecordEdges] =
    useState("[]");
  const [transformationManualBefore, setTransformationManualBefore] =
    useState("{}");
  const [transformationManualAfter, setTransformationManualAfter] =
    useState("{}");
  const [transformationManualDiff, setTransformationManualDiff] =
    useState("{}");
  const [transformationManualReason, setTransformationManualReason] =
    useState("");
  const [transformationRun, setTransformationRun] = useState<any>();
  const [transformationAnnotation, setTransformationAnnotation] = useState("");
  const [lineageTrace, setLineageTrace] = useState<any>();
  const [lineageTraceSubjectId, setLineageTraceSubjectId] = useState("");
  const [eligibleRecordCount, setEligibleRecordCount] = useState<number>();
  const [records, setRecords] = useState<any[]>([]);
  const [locatedRecord, setLocatedRecord] = useState<any>();
  const [status, setStatus] = useState("请先登录");
  const [version, setVersion] = useState<any>();
  const [versionHistory, setVersionHistory] = useState<any[]>([]);
  const [testSetSummary, setTestSetSummary] = useState<any>();
  const [versionHistoryPagination, setVersionHistoryPagination] = useState({
    total: 0,
    limit: 20,
    offset: 0,
  });
  const [deliveryResults, setDeliveryResults] = useState<any[]>([]);
  const [langfusePreview, setLangfusePreview] = useState("");
  const [selectedCaseDetailId, setSelectedCaseDetailId] = useState("");
  const [caseDetail, setCaseDetail] = useState<any>();
  const [comparison, setComparison] = useState<any>();
  const [compareBaseVersionId, setCompareBaseVersionId] = useState("");
  const [compareTargetVersionId, setCompareTargetVersionId] = useState("");
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [lifecycleCorrelationId, setLifecycleCorrelationId] = useState(
    newLifecycleCorrelationId,
  );
  const [draft, setDraft] = useState<any>();
  const [recipeCounts, setRecipeCounts] = useState<any[]>();
  const [recipeExits, setRecipeExits] = useState<Record<string, any>>({});
  const [mappingPairs, setMappingPairs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeJob, setActiveJob] = useState<any>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem("agentbench-active-job") ?? "null",
      );
    } catch {
      return null;
    }
  });
  const [sourceName, setSourceName] = useState("Owner synthetic upload");
  const [sourceType, setSourceType] = useState("synthetic");
  const [responsiblePerson, setResponsiblePerson] = useState("Project Owner");
  const [sourcePurpose, setSourcePurpose] = useState(
    "Non-production test data curation",
  );
  const [licenseStatus, setLicenseStatus] = useState("not_applicable");
  const [sensitivity, setSensitivity] = useState("non_sensitive");
  const [sourceAddress, setSourceAddress] = useState("");
  const [acquiredAt, setAcquiredAt] = useState("");
  const [deidentificationConfirmed, setDeidentificationConfirmed] =
    useState(false);
  const [testSetName, setTestSetName] = useState("Billing tracer");
  const [testSetPurpose, setTestSetPurpose] = useState("Synthetic regression");
  const [filterField, setFilterField] = useState("category");
  const [filterValue, setFilterValue] = useState("billing");
  const [filterOperator, setFilterOperator] = useState<FilterOperator>("eq");
  const [filterMinimum, setFilterMinimum] = useState("0");
  const [filterMaximum, setFilterMaximum] = useState("100");
  const [secondFilterEnabled, setSecondFilterEnabled] = useState(false);
  const [secondFilterField, setSecondFilterField] = useState("internal_note");
  const [secondFilterOperator, setSecondFilterOperator] =
    useState<FilterOperator>("eq");
  const [secondFilterValue, setSecondFilterValue] = useState("synthetic-only");
  const [secondFilterMinimum, setSecondFilterMinimum] = useState("0");
  const [secondFilterMaximum, setSecondFilterMaximum] = useState("100");
  const [filterCombination, setFilterCombination] = useState<"all" | "any">(
    "all",
  );
  const [filterNegated, setFilterNegated] = useState(false);
  const [advancedFilterEnabled, setAdvancedFilterEnabled] = useState(false);
  const [advancedFilterJson, setAdvancedFilterJson] = useState(
    '{"all":[{"field":"/category","operator":"eq","value":"billing"}]}',
  );
  const [sampleEnabled, setSampleEnabled] = useState(false);
  const [sampleMode, setSampleMode] = useState<"count" | "ratio">("count");
  const [sampleValue, setSampleValue] = useState("1");
  const [sampleSeed, setSampleSeed] = useState("ticket04");
  const [manualRecordId, setManualRecordId] = useState("");
  const [manualAction, setManualAction] =
    useState<ManualDecision["action"]>("exclude");
  const [manualReason, setManualReason] = useState("");
  const [manualDecisions, setManualDecisions] = useState<ManualDecision[]>([]);
  const [manualCaseInput, setManualCaseInput] = useState(
    '{"message":"Manual synthetic case"}',
  );
  const [manualCaseOutput, setManualCaseOutput] = useState("Manual result");
  const [selectedParentCaseId, setSelectedParentCaseId] = useState("");
  const [manualChangeCounts, setManualChangeCounts] = useState({
    added: 0,
    modified: 0,
    deleted: 0,
  });
  const [latestManualCreationEvent, setLatestManualCreationEvent] =
    useState("");
  const [duplicateDecisionCaseId, setDuplicateDecisionCaseId] = useState("");
  const [duplicateDecisionAction, setDuplicateDecisionAction] = useState<
    "include" | "exclude"
  >("include");
  const [activeSourceId, setActiveSourceId] = useState("");
  const [versionDescription, setVersionDescription] = useState("");
  const [workbenchHydrated, setWorkbenchHydrated] = useState(false);
  const [mappingJson, setMappingJson] = useState(
    '{"input":{"object":{"message":{"source":"/question"}}},"expectedOutput":{"source":"/answer"},"metadata":{"object":{}}}',
  );
  const [schemaMode, setSchemaMode] = useState<"gold_required" | "input_only">(
    "gold_required",
  );
  const [schemaSuggestion, setSchemaSuggestion] = useState<any>();
  const [schemaProposalId, setSchemaProposalId] = useState<string>();
  const [mappingValidation, setMappingValidation] = useState<any>();
  const [candidateValidationReport, setCandidateValidationReport] =
    useState<any>();
  const [requiresNewTestSet, setRequiresNewTestSet] = useState(false);
  const [unmappedFields, setUnmappedFields] = useState("");
  const [unmappedProfile, setUnmappedProfile] = useState<
    Array<{ path: string; sample: unknown }> | undefined
  >();
  const [unmappedConfirmed, setUnmappedConfirmed] = useState(false);
  const [inputSchema, setInputSchema] = useState(
    '{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}',
  );
  const [outputSchema, setOutputSchema] = useState('{"type":"string"}');
  const [csvEncoding, setCsvEncoding] = useState("auto");
  const [csvDelimiter, setCsvDelimiter] = useState(",");
  const [csvHeaderRow, setCsvHeaderRow] = useState("1");
  const [csvQuote, setCsvQuote] = useState('"');
  const [jsonRecordPath, setJsonRecordPath] = useState("");
  const draftRef = useRef<any>(undefined);
  const saveQueueRef = useRef(Promise.resolve());
  const skipNextAutosaveRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const routeLoadRef = useRef("");

  function navigate(path: string, replace = false) {
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", path);
    routeLoadRef.current = "";
    setRoute(parseRoute(path));
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  useEffect(() => {
    const syncRoute = () =>
      setRoute(
        parseRoute(`${window.location.pathname}${window.location.search}`),
      );
    window.addEventListener("popstate", syncRoute);
    if (window.location.pathname === "/") navigate("/assets", true);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    document.querySelector<HTMLElement>("[data-page-title]")?.focus();
  }, [route.page, route.id]);

  function currentMapping(): Record<string, unknown> {
    return JSON.parse(mappingJson) as Record<string, unknown>;
  }

  function currentUnmappedFields(sourceDraft = draftRef.current ?? draft) {
    const sources = Array.isArray(sourceDraft?.sources)
      ? sourceDraft.sources
      : [];
    if (sources.length > 1) {
      return [
        ...new Set(
          sources.flatMap((source: any) =>
            Array.isArray(source.unmappedFields) ? source.unmappedFields : [],
          ),
        ),
      ].sort();
    }
    return unmappedFields
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  const selectedSourceId = activeSourceId || draft?.sources?.[0]?.id;

  function rememberActiveJob(job: any) {
    setActiveJob(job);
    if (job)
      sessionStorage.setItem("agentbench-active-job", JSON.stringify(job));
    else sessionStorage.removeItem("agentbench-active-job");
  }

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const jobId = activeJob?.id;
    if (
      !jobId ||
      ["succeeded", "failed", "cancelled"].includes(activeJob.status)
    )
      return;
    const timer = setInterval(async () => {
      try {
        const result = await api.job(projectId, jobId);
        rememberActiveJob(result.job);
      } catch {
        // The next poll retains the last durable public state.
      }
    }, 500);
    return () => clearInterval(timer);
  }, [activeJob?.id, activeJob?.status]);

  function clearDeliveryWorkspace() {
    setDeliveryResults([]);
    setLangfusePreview("");
  }

  async function loadDeliveryRecords(
    versionId: string,
    active: () => boolean = () => true,
  ) {
    const result = await api.versionDeliveries(projectId, versionId);
    if (!active()) return;
    setDeliveryResults(
      result.deliveries.map((delivery: any) => ({
        ...delivery,
        deliveryId: delivery.id,
      })),
    );
  }

  async function waitForDeliveryJob(jobId: string) {
    const result = await waitFor(
      () => api.job(projectId, jobId),
      (item: any) =>
        ["succeeded", "failed", "cancelled"].includes(item.job?.status),
    );
    rememberActiveJob(result.job);
    if (result.job.status === "failed")
      throw new Error(result.job.errorCode ?? "delivery_generation_failed");
    if (result.job.status === "cancelled")
      throw new Error("delivery_generation_cancelled");
    return result.job;
  }

  function rememberDelivery(result: any) {
    setDeliveryResults((current) => [
      ...current.filter((item) => item.packageType !== result.packageType),
      result,
    ]);
  }

  async function generatePackageDelivery(
    packageType: "standard" | "full_provenance",
  ) {
    if (!version?.id || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.requestPackage(
        projectId,
        version.id,
        csrf,
        packageType,
      );
      rememberActiveJob(response.job);
      const job = await waitForDeliveryJob(response.job.id);
      rememberDelivery(job.result);
      setStatus(
        packageType === "full_provenance"
          ? "Full Provenance Package 已生成；验证级别：full。"
          : "Standard Package 已生成；验证级别：standard；仅验证冻结证据与引用。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function generateLangfuseDelivery() {
    if (!version?.id || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.requestLangfuseCsv(
        projectId,
        version.id,
        csrf,
      );
      rememberActiveJob(response.job);
      const job = await waitForDeliveryJob(response.job.id);
      const csv = await api.deliveryText(projectId, job.result.deliveryId);
      setLangfusePreview(csv.split("\n").slice(0, 2).join("\n"));
      rememberDelivery({
        ...job.result,
        status: "generated",
        externalCopyRecorded: false,
      });
      setStatus("Langfuse CSV 已生成并通过本地契约校验。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function attestLangfuseImport(deliveryId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.attestDeliveryImported(
        projectId,
        deliveryId,
        csrf,
      );
      setDeliveryResults((current) =>
        current.map((item) =>
          item.deliveryId === deliveryId
            ? { ...item, status: result.delivery.status }
            : item,
        ),
      );
      setStatus("用户已确认导入；这是本地用户声明，未经 Langfuse 远端验证。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  const fileFormat = (file?.name.split(".").pop()?.toLowerCase() ?? "") as
    | "csv"
    | "json"
    | "jsonl";

  async function loadParsedView(
    assetId: string,
    parsedViewId?: string,
    active: () => boolean = () => true,
  ) {
    const preview = await waitFor(
      () =>
        queryClient.fetchQuery({
          queryKey: ["source-records", assetId, parsedViewId],
          queryFn: () => api.preview(projectId, assetId, { parsedViewId }),
        }),
      (item: any) => !["queued", "parsing"].includes(item.parsedView?.status),
      active,
    );
    if (!active()) return preview;
    setParsedView(preview.parsedView);
    setLocatedRecord(undefined);
    const validRecords = preview.records.filter(
      (record: any) => record.parseStatus === "valid",
    );
    setRecords(validRecords);
    if (validRecords[0])
      setManualRecordId(`${preview.parsedView.id}:${validRecords[0].ordinal}`);
    const failures = preview.parsedView.failureCount
      ? await api.preview(projectId, assetId, {
          parsedViewId: preview.parsedView.id,
          parseStatus: "invalid",
        })
      : { records: [] };
    if (!active()) return preview;
    setParseFailures(failures.records);
    setEligibleRecordCount(
      preview.parsedView.draftEligible
        ? preview.parsedView.successCount
        : undefined,
    );
    const parseAttempts = await api.parseAttempts(projectId, assetId);
    if (active()) setAttempts(parseAttempts.attempts);
    return preview;
  }

  async function loadProjectMembers() {
    const result = await api.projectMembers(projectId);
    setMembers(result.members);
    setMemberChanges(result.changes ?? []);
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const session = await api.login(data.get("username"), data.get("password"));
    setCsrf(session.csrfToken);
    setActor(session.actor);
    if (session.actor.capabilities.manage) await loadProjectMembers();
    if (route.page !== "assets" || route.id) {
      setStatus(
        !session.actor.capabilities.write
          ? "Viewer 已登录；当前身份只读，可在限定范围导出。"
          : `${session.actor.projectRole ?? "项目成员"} 已登录，可以上传合成 UTF-8 CSV`,
      );
      return;
    }
    const stored = localStorage.getItem(draftStorageKey);
    if (!stored) {
      setStatus(
        !session.actor.capabilities.write
          ? "Viewer 已登录；当前身份只读，可在限定范围导出。"
          : `${session.actor.projectRole ?? "项目成员"} 已登录，可以上传合成 UTF-8 CSV`,
      );
      return;
    }
    try {
      const reference = JSON.parse(stored);
      setAsset({ id: reference.assetId });
      if (reference.assetId) await loadParsedView(reference.assetId);
      const restored = await api.draft(projectId, reference.draftId);
      hydrateWorkbench(
        { ...restored.draft, testSetId: reference.testSetId },
        true,
      );
      navigate(`/workbench/${encodeURIComponent(reference.draftId)}`);
      setStatus(
        restored.draft.leaseToken
          ? "已恢复 Working Draft；已保存 Recipe 和编辑租约可继续使用。"
          : "已恢复 Working Draft；当前租约由其他写者持有，页面为只读。",
      );
    } catch {
      localStorage.removeItem(draftStorageKey);
      setStatus("已登录；先前的 Working Draft 已不可恢复。请重新打开。");
    }
  }

  async function addMember() {
    if (!memberUsername.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.addProjectMember(
        projectId,
        csrf,
        memberUsername.trim(),
        memberRole,
      );
      setMemberUsername("");
      await loadProjectMembers();
      setStatus("项目成员已加入；授权由服务端项目成员角色决定。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function updateMember(userId: string, role: "editor" | "viewer") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.updateProjectMember(projectId, userId, csrf, role);
      await loadProjectMembers();
      setStatus("项目成员角色已更新。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.removeProjectMember(projectId, userId, csrf);
      await loadProjectMembers();
      setStatus("项目成员已移除。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!csrf) return;
    const refreshSession = async () => {
      try {
        const session = await api.currentSession();
        setCsrf(session.csrfToken);
        setActor(session.actor);
        if (session.actor.capabilities.manage) await loadProjectMembers();
        else {
          setMembers([]);
          setMemberChanges([]);
        }
      } catch {
        setCsrf("");
        setActor(undefined);
        setMembers([]);
        setMemberChanges([]);
      }
    };
    window.addEventListener("focus", refreshSession);
    return () => window.removeEventListener("focus", refreshSession);
  }, [csrf]);

  async function loadAssetLifecycle(
    assetId: string,
    active: () => boolean = () => true,
  ) {
    const [detail, history, audit] = await Promise.all([
      api.asset(projectId, assetId),
      api.attributionHistory(projectId, assetId),
      api.assetAudit(projectId, assetId),
    ]);
    if (!active()) return detail;
    setAsset(detail.asset);
    setAssetDetail(detail);
    setAttributionHistory(history.attributions);
    setAssetAudit(audit.events);
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError("");
    setRequiresNewTestSet(false);
    setDeletionPreview(undefined);
    setDeletionResult(undefined);
    setParsedView(undefined);
    setRecords([]);
    setStatus("正在流式保存原始字节…");
    try {
      const uploaded = await api.uploadAsset(projectId, csrf, file, {
        sourceType,
        sourceName,
        responsiblePerson,
        purpose: sourcePurpose,
        licenseStatus,
        sensitivity,
        sourceAddress,
        acquiredAt: acquiredAt ? new Date(acquiredAt).toISOString() : undefined,
        deidentificationConfirmed,
      });
      setAsset(uploaded.asset);
      await loadAssetLifecycle(uploaded.asset.id);
      setStatus(`Worker 正在解析 ${uploaded.asset.format.toUpperCase()}…`);
      const preview = await loadParsedView(uploaded.asset.id);
      navigate(`/assets/${encodeURIComponent(uploaded.asset.id)}`);
      setStatus(
        preview.parsedView.status === "parse_failed"
          ? "解析失败；原件仍可下载，请修正配置后新建解析尝试"
          : preview.parsedView.draftEligible
            ? "解析完成；请确认筛选、字段映射与未映射字段处置"
            : preview.parsedView.errors?.some(
                  (item: any) => item.code === "source_record_limit_exceeded",
                )
              ? "解析完成，但 Parsed View 已超过容量上限；请减少或替换资产后重试"
              : "解析完成，但可定位错误必须先显式排除",
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "未知错误";
      if (message === "requires_new_test_set") setRequiresNewTestSet(true);
      const details = (caught as { details?: any }).details;
      setError(details ? capacityErrorMessage(details) : message);
    } finally {
      setBusy(false);
    }
  }

  async function archiveAsset() {
    if (!asset) return;
    setBusy(true);
    setError("");
    try {
      const archived = await api.archiveAsset(projectId, asset.id, csrf);
      setAsset(archived.asset);
      await loadAssetLifecycle(asset.id);
      setStatus("资产已归档；原始字节、来源修订和引用记录仍保留。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "归档失败");
    } finally {
      setBusy(false);
    }
  }

  async function requestOrdinaryDeletion() {
    if (!asset) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteAsset(projectId, asset.id, csrf);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "删除被阻断";
      setStatus(
        `普通删除被阻断（${code}）；请使用受控删除流程，当前 Ticket 不执行物理删除。`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function previewControlledDeletion() {
    if (!asset || busy || actor?.projectRole !== "owner") return;
    setBusy(true);
    setError("");
    try {
      const result = await api.deletionPreview(projectId, asset.id, csrf);
      setDeletionPreview(result.deletion);
      setDeletionResult(undefined);
      setStatus("影响预览已冻结；确认前仍可重新预览。非生产治理流程模拟。 ");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "受控删除预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmControlledDeletion() {
    if (
      !deletionPreview ||
      busy ||
      actor?.projectRole !== "owner" ||
      !deletionReasonCode ||
      !deletionReasonNote.trim()
    )
      return;
    if (
      !window.confirm(
        "确认由同一 Project Owner 提交受控删除？确认后不可取消，并会立即阻断受影响内容。",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const confirmed = await api.confirmDeletion(
        projectId,
        deletionPreview.id,
        csrf,
        deletionPreview.previewHash,
        deletionReasonCode,
        deletionReasonNote,
      );
      setDeletionResult(confirmed.deletion);
      const outcome = await waitFor(
        () => api.deletionOutcome(projectId, deletionPreview.id),
        (item: any) => ["completed", "failed"].includes(item.deletion?.status),
      );
      setDeletionResult(outcome.deletion);
      setStatus(
        outcome.deletion.status === "completed"
          ? "受控删除已完成；内容已降级为最小墓碑，外部副本仅列出人工处置。"
          : `受控删除失败（${outcome.deletion.failureCode ?? "unknown"}）；闭包仍保持不可访问，可由同一 Owner 重试。`,
      );
      if (outcome.deletion.status === "completed") {
        setAsset(undefined);
        setAssetDetail(undefined);
        setParsedView(undefined);
        setDeletionPreview(undefined);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "受控删除确认失败");
    } finally {
      setBusy(false);
    }
  }

  async function retryControlledDeletion() {
    if (!deletionResult?.id || busy || actor?.projectRole !== "owner") return;
    setBusy(true);
    setError("");
    try {
      await api.retryDeletion(projectId, deletionResult.id, csrf);
      const outcome = await waitFor(
        () => api.deletionOutcome(projectId, deletionResult.id),
        (item: any) => ["completed", "failed"].includes(item.deletion?.status),
      );
      setDeletionResult(outcome.deletion);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "受控删除重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function locateSourceRecord(ordinal: number) {
    if (!parsedView) return;
    try {
      setLocatedRecord(
        await api.sourceRecordLocation(projectId, parsedView.id, ordinal),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "原始位置查询失败");
    }
  }

  function currentParserConfig(): Record<string, unknown> {
    if (asset?.format === "csv") {
      return {
        encoding: csvEncoding,
        delimiter: csvDelimiter,
        headerRow: Number(csvHeaderRow),
        quote: csvQuote,
      };
    }
    if (asset?.format === "json") return { recordPath: jsonRecordPath };
    return {};
  }

  async function retryParse() {
    setBusy(true);
    setError("");
    try {
      const retry = await api.retryParse(
        projectId,
        asset.id,
        csrf,
        currentParserConfig(),
      );
      setStatus("正在使用新配置创建解析尝试…");
      await loadParsedView(asset.id, retry.parsedView.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function excludeFailures() {
    setBusy(true);
    setError("");
    try {
      const result = await api.excludeFailures(
        projectId,
        parsedView.id,
        csrf,
        parseFailures.map((record) => record.locator),
      );
      setParseFailures(result.report.remainingFailures);
      setEligibleRecordCount(
        result.report.draftEligible
          ? result.report.eligibleRecordCount
          : undefined,
      );
      setParsedView((view: any) => ({
        ...view,
        draftEligible: result.report.draftEligible,
      }));
      setStatus(
        result.report.draftEligible
          ? "全部可定位错误已显式排除；Parsed View 可加入草稿"
          : `已排除 ${result.report.excludedCount} 条；仍有 ${result.report.remainingFailureCount} 条错误未排除`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  async function selectAttempt(viewId: string) {
    await api.selectParsedView(projectId, viewId, csrf);
    await loadParsedView(asset.id, viewId);
  }

  async function cancelActiveJob() {
    if (!activeJob) return;
    try {
      const result = await api.cancelJob(projectId, activeJob.id, csrf);
      rememberActiveJob(result.job);
      setStatus(`后台任务 ${activeJob.id} 已请求取消。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消后台任务失败");
    }
  }

  async function retryActiveJob() {
    if (!activeJob) return;
    try {
      const result = await api.retryJob(projectId, activeJob.id, csrf);
      rememberActiveJob(result.job);
      setStatus(`后台任务 ${activeJob.id} 已手工重试。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重试后台任务失败");
    }
  }

  async function publishTracer() {
    setBusy(true);
    setError("");
    setStatus("正在保存策展方案…");
    try {
      if (draftRef.current) await queueWorkbenchSave();
      const currentDraft = draftRef.current;
      const created = currentDraft
        ? { draft: currentDraft, testSet: { id: currentDraft.testSetId } }
        : await api.createTestSet(projectId, csrf, asset.id, {
            name: testSetName,
            purpose: testSetPurpose,
          });
      let draftToConfigure = created.draft;
      if (!currentDraft) {
        const saved = await api.saveRecipe(
          projectId,
          created.draft.id,
          csrf,
          created.draft,
          workbenchRecipe(),
        );
        draftToConfigure = { ...created.draft, ...saved.draft };
        draftRef.current = draftToConfigure;
      }
      setDraft({ ...draftToConfigure, testSetId: created.testSet.id });
      const proposal = await api.suggestMappingSchema(
        projectId,
        draftToConfigure.id,
      );
      setSchemaSuggestion(proposal);
      setSchemaProposalId(proposal.proposalId);
      const configured = await api.configureDraft(
        projectId,
        draftToConfigure.id,
        csrf,
        {
          leaseToken: draftToConfigure.leaseToken,
          expectedRevision: draftToConfigure.revision,
          proposalId: proposal.proposalId,
          filter: { field: filterField, operator: "eq", value: filterValue },
          mapping: currentMapping(),
          unmappedFields: currentUnmappedFields(draftToConfigure),
          unmappedConfirmed:
            draftToConfigure.sources?.length > 1
              ? draftToConfigure.sources.every(
                  (source: any) => source.unmappedConfirmed,
                )
              : unmappedConfirmed,
          formalSchema: {
            mode: schemaMode,
            input: JSON.parse(inputSchema),
            expectedOutput: JSON.parse(outputSchema),
          },
        },
      );
      setDraft({
        ...draftToConfigure,
        ...configured.draft,
        testSetId: created.testSet.id,
      });
      setStatus("Worker 正在物化不可变 Candidate…");
      const materialized = await api.materialize(
        projectId,
        draftToConfigure.id,
        csrf,
        {
          leaseToken: draftToConfigure.leaseToken,
          revision: configured.draft.revision,
        },
      );
      rememberActiveJob(materialized.job);
      const materializationJob = await waitFor(
        () =>
          queryClient.fetchQuery({
            queryKey: ["job", materialized.job.id],
            queryFn: () => api.job(projectId, materialized.job.id),
          }),
        (item: any) =>
          ["succeeded", "failed", "cancelled"].includes(item.job?.status),
      );
      rememberActiveJob(materializationJob.job);
      if (materializationJob.job.status === "cancelled") {
        setStatus("Candidate 物化已取消；原始资产和 Working Draft 已保留。");
        return;
      }
      const candidate = await queryClient.fetchQuery({
        queryKey: ["candidate", materialized.candidate.id],
        queryFn: () => api.candidate(projectId, materialized.candidate.id),
      });
      if (candidate.candidate.status === "failed") {
        setCandidateValidationReport(candidate.candidate.validationReport);
        throw new Error("candidate_validation_failed");
      }
      setStatus(
        `Candidate 已验证（${candidate.candidate.itemCount} 条），正在原子发布 v1…`,
      );
      const publishing = await api.publish(
        projectId,
        materialized.candidate.id,
        csrf,
      );
      rememberActiveJob(publishing.job);
      const job = await waitFor(
        () =>
          queryClient.fetchQuery({
            queryKey: ["job", publishing.job.id],
            queryFn: () => api.job(projectId, publishing.job.id),
          }),
        (item: any) =>
          ["succeeded", "failed", "cancelled"].includes(item.job?.status),
      );
      if (job.job.status === "failed") {
        rememberActiveJob(job.job);
        const publicationReport = job.job.result?.publicationReport;
        if (publicationReport) setCandidateValidationReport(publicationReport);
        throw new Error(job.job.errorCode);
      }
      if (job.job.status === "cancelled") {
        setStatus("发布已取消；Candidate 仍可从 ready_to_publish 状态重试。");
        return;
      }
      rememberActiveJob(job.job);
      if (draftRef.current) {
        const publishedDraft = { ...draftRef.current, status: "published" };
        draftRef.current = publishedDraft;
        setDraft(publishedDraft);
      }
      const published = await queryClient.fetchQuery({
        queryKey: ["version", job.job.result.versionId],
        queryFn: () =>
          api.version(projectId, created.testSet.id, job.job.result.versionId),
      });
      setVersion(published.version);
      await loadVersionHistory(created.testSet.id, published.version);
      navigate(
        `/test-sets/${encodeURIComponent(
          created.testSet.id,
        )}?version=${encodeURIComponent(published.version.id)}`,
      );
      setStatus(
        `v${published.version.number} 已发布；Standard Version Package 可下载并离线验证`,
      );
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "未知错误";
      if (code === "requires_new_test_set") setRequiresNewTestSet(true);
      setError(code);
    } finally {
      setBusy(false);
    }
  }

  async function loadVersionHistory(
    testSetId: string,
    selected?: any,
    filters: Record<string, string> = { limit: "100", offset: "0" },
  ) {
    clearDeliveryWorkspace();
    const history = await api.versions(projectId, testSetId, filters);
    setTestSetSummary(history.testSet);
    setVersionHistory(history.versions);
    setVersionHistoryPagination(
      history.pagination ?? {
        total: history.versions.length,
        limit: Number(filters.limit ?? 100),
        offset: Number(filters.offset ?? 0),
      },
    );
    const nextVersion =
      selected ?? history.versions.find((item: any) => item.isDefault);
    if (nextVersion) {
      const detail = await api.version(projectId, testSetId, nextVersion.id);
      setVersion(detail.version);
      await loadDeliveryRecords(nextVersion.id);
      setSelectedCaseDetailId(detail.version.lineage?.[0]?.caseId ?? "");
      setCaseDetail(undefined);
      setCompareBaseVersionId(history.versions[0]?.id ?? "");
      setCompareTargetVersionId(history.versions[1]?.id ?? nextVersion.id);
    }
  }

  function versionHistoryPath({
    versionId,
    offset,
  }: {
    versionId?: string;
    offset?: number;
  } = {}) {
    const testSetId = draft?.testSetId ?? route.id;
    if (!testSetId) return "/test-sets";
    const query = new URLSearchParams();
    const selectedVersionId = versionId ?? route.query.version;
    if (selectedVersionId) query.set("version", selectedVersionId);
    query.set("versionLimit", String(versionHistoryPagination.limit));
    query.set(
      "versionOffset",
      String(offset ?? versionHistoryPagination.offset),
    );
    return `/test-sets/${encodeURIComponent(testSetId)}?${query.toString()}`;
  }

  function setVersionHistoryPage(offset: number) {
    if (route.page !== "test-set-detail") return;
    navigate(versionHistoryPath({ offset }));
  }

  async function selectVersion(item: any) {
    if (!draft?.testSetId) return;
    if (route.page === "test-set-detail") {
      navigate(versionHistoryPath({ versionId: item.id }));
      return;
    }
    clearDeliveryWorkspace();
    const selected = await api.version(projectId, draft.testSetId, item.id);
    setVersion(selected.version);
    await loadDeliveryRecords(item.id);
    setSelectedCaseDetailId(selected.version.lineage?.[0]?.caseId ?? "");
    setCaseDetail(undefined);
    setComparison(undefined);
  }

  async function loadCaseDetail() {
    if (!draft?.testSetId || !version?.id || !selectedCaseDetailId) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.versionCase(
        projectId,
        draft.testSetId,
        version.id,
        selectedCaseDetailId,
      );
      setCaseDetail(result.testCase);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "用例详情读取失败");
    } finally {
      setBusy(false);
    }
  }

  async function compareSelectedVersions() {
    if (
      !draft?.testSetId ||
      !compareBaseVersionId ||
      !compareTargetVersionId ||
      compareBaseVersionId === compareTargetVersionId
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await api.compareVersions(
        projectId,
        draft.testSetId,
        compareBaseVersionId,
        compareTargetVersionId,
      );
      setComparison(result.comparison);
      setStatus(
        `版本差异：+${result.comparison.counts.added} / -${result.comparison.counts.removed} / ~${result.comparison.counts.modified} / =${result.comparison.counts.unchanged}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "版本比较失败");
    } finally {
      setBusy(false);
    }
  }

  async function makeVersionDefault(item: any) {
    if (!draft?.testSetId || !lifecycleReason.trim()) return;
    setBusy(true);
    setError("");
    try {
      const currentDefault =
        versionHistory.find((candidate) => candidate.isDefault)?.id ?? null;
      await api.setDefaultVersion(
        projectId,
        draft.testSetId,
        item.id,
        csrf,
        lifecycleReason,
        currentDefault,
        lifecycleCorrelationId,
      );
      await loadVersionHistory(draft.testSetId, item);
      setLifecycleReason("");
      setLifecycleCorrelationId(newLifecycleCorrelationId());
      setStatus(`v${item.number} 已显式设为默认版本；较新版本未被改写。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "默认版本切换失败");
    } finally {
      setBusy(false);
    }
  }

  async function archiveSelectedVersion(item: any) {
    if (!draft?.testSetId) return;
    setBusy(true);
    setError("");
    try {
      const currentDefault =
        versionHistory.find((candidate) => candidate.isDefault)?.id ?? null;
      await api.archiveVersion(
        projectId,
        draft.testSetId,
        item.id,
        csrf,
        lifecycleReason,
        currentDefault,
        lifecycleCorrelationId,
      );
      await loadVersionHistory(draft.testSetId);
      setLifecycleReason("");
      setLifecycleCorrelationId(newLifecycleCorrelationId());
      setStatus(`v${item.number} 已归档；历史内容和哈希保持可读取。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "版本归档失败");
    } finally {
      setBusy(false);
    }
  }

  async function deriveFromVersion() {
    const current = draftRef.current ?? draft;
    const testSetId = current?.testSetId ?? route.id;
    if (!testSetId || !version?.id || busy) return;
    setBusy(true);
    setError("");
    try {
      const opened = await api.openDraft(
        projectId,
        testSetId,
        csrf,
        version.id,
      );
      const next = { ...opened.draft, testSetId };
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          draftId: next.id,
          testSetId,
          assetId: next.sources?.[0]?.assetId ?? "",
        }),
      );
      hydrateWorkbench(next, true);
      navigate(`/workbench/${encodeURIComponent(next.id)}`);
      setManualChangeCounts({ added: 0, modified: 0, deleted: 0 });
      setSelectedParentCaseId(version.lineage?.[0]?.caseId ?? "");
      setStatus(
        `已从 v${version.number} 创建 Working Draft；父版本内容和哈希保持不变。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建派生草稿失败");
    } finally {
      setBusy(false);
    }
  }

  async function openWorkbench() {
    if (!asset) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.createTestSet(projectId, csrf, asset.id, {
        name: testSetName,
        purpose: testSetPurpose,
      });
      const opened = { ...created.draft, testSetId: created.testSet.id };
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          draftId: opened.id,
          testSetId: created.testSet.id,
          assetId: asset.id,
        }),
      );
      hydrateWorkbench(opened, false);
      navigate(`/workbench/${encodeURIComponent(opened.id)}`);
      setStatus("工作草稿已打开；筛选修改可保存并重新打开。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法打开草稿");
    } finally {
      setBusy(false);
    }
  }

  async function attachCurrentAsset() {
    const current = draftRef.current;
    if (!current || !asset) return;
    setBusy(true);
    setError("");
    try {
      const attached = await api.attachDraftSource(
        projectId,
        current.id,
        csrf,
        current,
        asset.id,
      );
      const preview = await api.previewMapping(
        projectId,
        current.id,
        csrf,
        currentMapping(),
        attached.source.id,
      );
      const savedMapping = await api.saveSourceMapping(
        projectId,
        current.id,
        attached.source.id,
        csrf,
        attached.draft,
        currentMapping(),
        preview.unmappedFields.map((field: { path: string }) => field.path),
      );
      const next = {
        ...attached.draft,
        ...savedMapping.draft,
        testSetId: current.testSetId,
      };
      draftRef.current = next;
      setDraft(next);
      setActiveSourceId(attached.source.id);
      setUnmappedFields(
        preview.unmappedFields
          .map((field: { path: string }) => field.path)
          .join(", "),
      );
      setUnmappedConfirmed(true);
      navigate(`/workbench/${encodeURIComponent(next.id)}`);
      setStatus(
        `附件 ${next.capacity.attachedAssets}/${next.capacity.assetLimit} 已保存，并使用独立 mapping；容量以精确字节和记录数计量。`,
      );
    } catch (caught) {
      const details = (caught as { details?: any }).details;
      setError(
        details
          ? capacityErrorMessage(details)
          : caught instanceof Error
            ? caught.message
            : "附件容量阻断",
      );
    } finally {
      setBusy(false);
    }
  }

  async function registerCurrentTransformationRun() {
    if (!asset || !parsedView || busy) return;
    setBusy(true);
    setError("");
    try {
      const inputVersionId =
        transformationInputVersionId.trim() || version?.id || "";
      if (!inputVersionId) throw new Error("请先发布或填写输入版本 ID");
      const nowText = new Date().toISOString();
      const isAgent = transformationOperation.startsWith("agent_");
      const manifest: Record<string, unknown> = {
        schemaVersion: "1.0",
        operationType: transformationOperation,
        lineageLevel: transformationLevel,
        purpose: transformationPurpose,
        tool: {
          name: transformationToolName,
          version: transformationToolVersion,
          ...(transformationCodeRef.trim()
            ? { codeRef: transformationCodeRef.trim() }
            : {}),
          ...(transformationOperation === "unknown_external_tool" &&
          transformationToolDescription.trim()
            ? { description: transformationToolDescription.trim() }
            : {}),
        },
        ...(isAgent
          ? {
              model: {
                provider: transformationModelProvider,
                name: transformationModelName,
                parameters: JSON.parse(transformationModelParameters),
              },
              prompt: {
                version: transformationPromptVersion,
                ...(transformationPromptMode === "content"
                  ? { content: transformationPromptContent }
                  : {
                      sha256: transformationPromptSha256,
                      immutableRef: {
                        assetId: transformationPromptAssetId,
                        sha256: transformationPromptSha256,
                      },
                    }),
              },
            }
          : {}),
        ...(transformationOperation === "manual_revision"
          ? {
              manual: {
                before: JSON.parse(transformationManualBefore),
                after: JSON.parse(transformationManualAfter),
                diff: JSON.parse(transformationManualDiff),
                reason: transformationManualReason,
              },
            }
          : {}),
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: inputVersionId,
            sha256: transformationInputSha256.trim(),
            scope: {
              [transformationScopeKey]: transformationScopeValue,
            },
          },
          ...JSON.parse(transformationExtraInputsJson),
        ],
        outputs: [
          {
            assetId: asset.id,
            sha256: asset.sha256,
            recordCount: parsedView.recordCount,
          },
        ],
        ...(transformationLevel === "record_level"
          ? { recordEdges: JSON.parse(transformationRecordEdges) }
          : {}),
        executedBy: "user_owner",
        startedAt: nowText,
        finishedAt: nowText,
      };
      const registered = await api.registerTransformationRun(
        projectId,
        csrf,
        manifest,
      );
      setTransformationRun(registered.run);
      setStatus(
        `Transformation Run ${registered.run.status} 已登记；血缘粒度 ${registered.run.lineageLevel}。`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Transformation Run 登记失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function annotateCurrentTransformationRun() {
    if (!transformationRun || !transformationAnnotation.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.annotateTransformationRun(
        projectId,
        transformationRun.id,
        csrf,
        transformationAnnotation.trim(),
      );
      const refreshed = await api.transformationRun(
        projectId,
        transformationRun.id,
      );
      setTransformationRun(refreshed.run);
      setTransformationAnnotation("");
      setStatus("补充说明已追加；核心 manifest 与哈希保持不变。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "补充说明追加失败");
    } finally {
      setBusy(false);
    }
  }

  async function completeCurrentTransformationRun() {
    if (!transformationRun || transformationRun.status === "complete" || busy)
      return;
    setBusy(true);
    setError("");
    try {
      const current = transformationRun.manifest as Record<string, unknown>;
      const manifest = {
        ...current,
        purpose: transformationPurpose,
        tool: {
          ...(current.tool as Record<string, unknown>),
          name: transformationToolName,
          version: transformationToolVersion,
        },
        ...(transformationOperation.startsWith("agent_")
          ? {
              model: {
                provider: transformationModelProvider,
                name: transformationModelName,
                parameters: JSON.parse(transformationModelParameters),
              },
              prompt: {
                version: transformationPromptVersion,
                ...(transformationPromptMode === "content"
                  ? { content: transformationPromptContent }
                  : {
                      sha256: transformationPromptSha256,
                      immutableRef: {
                        assetId: transformationPromptAssetId,
                        sha256: transformationPromptSha256,
                      },
                    }),
              },
            }
          : {}),
      };
      const completed = await api.completeTransformationRun(
        projectId,
        transformationRun.id,
        csrf,
        manifest,
      );
      const refreshed = await api.transformationRun(
        projectId,
        completed.run.id,
      );
      setTransformationRun(refreshed.run);
      setStatus(
        "Transformation Run 已补全；输入、输出与 record edges 保持不变。",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Transformation Run 补全失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function traceLineageSubject() {
    if (!lineageTraceSubjectId.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const traced = await api.lineageTrace(
        projectId,
        "case_revision",
        lineageTraceSubjectId.trim(),
      );
      setLineageTrace(traced);
      setStatus(`已返回最多 ${traced.maxHops} 跳的向上血缘图。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "血缘追踪失败");
    } finally {
      setBusy(false);
    }
  }

  async function createNewTestSetFromDraft() {
    if (!asset) return;
    setBusy(true);
    try {
      const created = await api.createTestSet(projectId, csrf, asset.id, {
        name: `${testSetName} (new schema)`,
        purpose: testSetPurpose,
      });
      const next = { ...created.draft, testSetId: created.testSet.id };
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          draftId: next.id,
          testSetId: next.testSetId,
          assetId: asset.id,
        }),
      );
      hydrateWorkbench(next, false);
      setRequiresNewTestSet(false);
      navigate(`/workbench/${encodeURIComponent(next.id)}`);
      setStatus(
        "已创建新的 Test Set；请在此草稿中重新确认 Schema 后再物化 Candidate。",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法创建新 Test Set",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveActiveSourceMapping() {
    const current = draftRef.current;
    if (!current?.leaseToken || !selectedSourceId || busy) return;
    setBusy(true);
    setError("");
    try {
      const preview = await api.previewMapping(
        projectId,
        current.id,
        csrf,
        currentMapping(),
        selectedSourceId,
      );
      const saved = await api.saveSourceMapping(
        projectId,
        current.id,
        selectedSourceId,
        csrf,
        current,
        currentMapping(),
        preview.unmappedFields.map((field: { path: string }) => field.path),
      );
      const next = { ...current, ...saved.draft };
      draftRef.current = next;
      setDraft(next);
      setUnmappedFields(
        preview.unmappedFields
          .map((field: { path: string }) => field.path)
          .join(", "),
      );
      setUnmappedProfile(preview.unmappedFields);
      setUnmappedConfirmed(true);
      setStatus("所选 Source 的独立 mapping 已保存。");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Source mapping 保存失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeActiveSource() {
    const current = draftRef.current;
    if (!current?.leaseToken || !selectedSourceId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.removeDraftSource(
        projectId,
        current.id,
        selectedSourceId,
        csrf,
        current,
      );
      const refreshed = await api.draft(projectId, current.id);
      const next = refreshed.draft;
      hydrateWorkbench(next, true, next.sources?.[0]?.id);
      setActiveSourceId("");
      setStatus(
        "所选 Source 已从 Working Draft 移除；资产和既有证据保持不变。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移除 Source 失败");
    } finally {
      setBusy(false);
    }
  }

  function filterNode(
    field: string,
    operator: FilterOperator,
    value: string,
    minimum: string,
    maximum: string,
  ) {
    if (operator === "range")
      return {
        field,
        operator,
        minimum: Number(minimum),
        maximum: Number(maximum),
      };
    if (operator === "is_null") return { field, operator };
    return { field, operator, value };
  }

  function workbenchRecipe() {
    const first = filterNode(
      filterField,
      filterOperator,
      filterValue,
      filterMinimum,
      filterMaximum,
    );
    const filters = secondFilterEnabled
      ? [
          first,
          filterNode(
            secondFilterField,
            secondFilterOperator,
            secondFilterValue,
            secondFilterMinimum,
            secondFilterMaximum,
          ),
        ]
      : [first];
    const simpleCombined: any =
      filters.length === 1 ? first : { [filterCombination]: filters };
    const combined: any = advancedFilterEnabled
      ? JSON.parse(advancedFilterJson)
      : filterNegated
        ? { not: simpleCombined }
        : simpleCombined;
    const steps: any[] = [
      {
        kind: "filter",
        filter: combined,
      },
    ];
    if (sampleEnabled)
      steps.push({
        kind: "sample",
        mode: sampleMode,
        value: Number(sampleValue),
        seed: sampleSeed,
      });
    if (manualDecisions.length)
      steps.push({
        kind: "manual",
        include: manualDecisions
          .filter((decision) => decision.action === "include")
          .map(({ id, reason, actorId }) => ({ id, reason, actorId })),
        exclude: manualDecisions
          .filter((decision) => decision.action === "exclude")
          .map(({ id, reason, actorId }) => ({ id, reason, actorId })),
      });
    const multiSource = (draft?.sources?.length ?? 0) > 1;
    return {
      steps,
      versionDescription,
      ...(multiSource
        ? {}
        : {
            mapping: currentMapping(),
            unmappedFields: unmappedFields
              .split(",")
              .map((field) => field.trim())
              .filter(Boolean),
            unmappedConfirmed,
          }),
    };
  }

  function hydrateWorkbench(
    nextDraft: any,
    restored: boolean,
    preferredSourceId = activeSourceId,
  ) {
    const replacingDraft = draftRef.current?.id !== nextDraft.id;
    if (replacingDraft) {
      // Derived validation and manual-edit state belongs to one draft only.
      setRecipeCounts(undefined);
      setRecipeExits({});
      setMappingPairs([]);
      setMappingValidation(undefined);
      setCandidateValidationReport(undefined);
      setEligibleRecordCount(undefined);
      setSchemaSuggestion(undefined);
      setSchemaProposalId(undefined);
      setManualChangeCounts({ added: 0, modified: 0, deleted: 0 });
      setLatestManualCreationEvent("");
      setRequiresNewTestSet(false);
      setSelectedParentCaseId("");
      setDuplicateDecisionCaseId("");
      setActiveSourceId("");
    }

    // Clear local form values only when switching drafts. Same-draft refreshes
    // still receive explicit defaults below for omitted recipe fields.
    if (replacingDraft) {
      setFilterField("category");
      setFilterValue("billing");
      setFilterOperator("eq");
      setFilterMinimum("0");
      setFilterMaximum("100");
      setSecondFilterEnabled(false);
      setSecondFilterField("internal_note");
      setSecondFilterOperator("eq");
      setSecondFilterValue("synthetic-only");
      setSecondFilterMinimum("0");
      setSecondFilterMaximum("100");
      setFilterCombination("all");
      setFilterNegated(false);
      setAdvancedFilterEnabled(false);
      setAdvancedFilterJson(
        '{"all":[{"field":"/category","operator":"eq","value":"billing"}]}',
      );
      setSampleEnabled(false);
      setSampleMode("count");
      setSampleValue("1");
      setSampleSeed("ticket04");
      setManualRecordId("");
      setManualAction("exclude");
      setManualReason("");
      setManualDecisions([]);
      setManualCaseInput('{"message":"Manual synthetic case"}');
      setManualCaseOutput("Manual result");
      setUnmappedFields("");
      setUnmappedProfile(undefined);
      setUnmappedConfirmed(false);
      setMappingJson(
        '{"input":{"object":{"message":{"source":"/question"}}},"expectedOutput":{"source":"/answer"},"metadata":{"object":{}}}',
      );
      setSchemaMode("gold_required");
      setInputSchema(
        '{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}',
      );
      setOutputSchema('{"type":"string"}');
      setVersionDescription("");
    }

    const recipe = nextDraft.recipe ?? {};
    let root = recipe.steps?.find(
      (step: any) => step.kind === "filter",
    )?.filter;
    const negated = Boolean(root?.not);
    if (negated) root = root.not;
    const combination = root?.all ? "all" : root?.any ? "any" : "all";
    const filters = root?.all ?? root?.any ?? (root ? [root] : []);
    const isLeaf = (filter: any) =>
      Boolean(filter?.field && typeof filter.operator === "string");
    const simpleTree =
      isLeaf(root) ||
      ((root?.all || root?.any) &&
        filters.length <= 2 &&
        filters.every(isLeaf));
    const savedFilter = recipe.steps?.find(
      (step: any) => step.kind === "filter",
    )?.filter;
    setAdvancedFilterEnabled(Boolean(savedFilter) && !simpleTree);
    setAdvancedFilterJson(
      savedFilter
        ? JSON.stringify(savedFilter, null, 2)
        : '{"all":[{"field":"/category","operator":"eq","value":"billing"}]}',
    );
    const applyFilter = (filter: any, second: boolean) => {
      if (!filter?.field) return;
      const setField = second ? setSecondFilterField : setFilterField;
      const setOperator = second ? setSecondFilterOperator : setFilterOperator;
      const setValue = second ? setSecondFilterValue : setFilterValue;
      const setMinimum = second ? setSecondFilterMinimum : setFilterMinimum;
      const setMaximum = second ? setSecondFilterMaximum : setFilterMaximum;
      setField(filter.field);
      setOperator(filter.operator);
      if (filter.value !== undefined) setValue(String(filter.value));
      if (filter.minimum !== undefined) setMinimum(String(filter.minimum));
      if (filter.maximum !== undefined) setMaximum(String(filter.maximum));
    };
    if (filters[0]) applyFilter(filters[0], false);
    else {
      setFilterField("category");
      setFilterOperator("eq");
      setFilterValue("billing");
      setFilterMinimum("0");
      setFilterMaximum("100");
    }
    if (filters[1]) applyFilter(filters[1], true);
    else {
      setSecondFilterField("internal_note");
      setSecondFilterOperator("eq");
      setSecondFilterValue("synthetic-only");
      setSecondFilterMinimum("0");
      setSecondFilterMaximum("100");
    }
    setSecondFilterEnabled(Boolean(filters[1]));
    setFilterCombination(combination);
    setFilterNegated(negated);
    const sample = recipe.steps?.find((step: any) => step.kind === "sample");
    setSampleEnabled(Boolean(sample));
    if (sample) {
      setSampleMode(sample.mode);
      setSampleValue(String(sample.value));
      setSampleSeed(sample.seed);
    } else {
      setSampleMode("count");
      setSampleValue("1");
      setSampleSeed("ticket04");
    }
    const manual = recipe.steps?.find((step: any) => step.kind === "manual");
    setManualDecisions([
      ...(manual?.include ?? []).map((decision: any) => ({
        ...decision,
        action: "include" as const,
      })),
      ...(manual?.exclude ?? []).map((decision: any) => ({
        ...decision,
        action: "exclude" as const,
      })),
    ]);
    const source =
      (nextDraft.sources ?? []).find(
        (item: any) => item.id === preferredSourceId,
      ) ?? nextDraft.sources?.[0];
    if (source) {
      setActiveSourceId(source.id);
      setMappingJson(
        source.mapping
          ? JSON.stringify(source.mapping, null, 2)
          : '{"input":{"object":{"message":{"source":"/question"}}},"expectedOutput":{"source":"/answer"},"metadata":{"object":{}}}',
      );
      setUnmappedFields((source.unmappedFields ?? []).join(", "));
      setUnmappedConfirmed(Boolean(source.unmappedConfirmed));
    } else {
      setActiveSourceId("");
      setMappingJson(
        recipe.mapping
          ? JSON.stringify(recipe.mapping, null, 2)
          : '{"input":{"object":{"message":{"source":"/question"}}},"expectedOutput":{"source":"/answer"},"metadata":{"object":{}}}',
      );
      setUnmappedFields(
        Array.isArray(recipe.unmappedFields)
          ? recipe.unmappedFields.join(", ")
          : "",
      );
      setUnmappedConfirmed(Boolean(recipe.unmappedConfirmed));
    }
    setUnmappedProfile(undefined);
    setVersionDescription(nextDraft.versionDescription ?? "");
    skipNextAutosaveRef.current = restored;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setWorkbenchHydrated(true);
  }

  async function persistWorkbench(recipe = workbenchRecipe()) {
    const current = draftRef.current;
    if (!current?.leaseToken || current.status !== "editing") return;
    setError("");
    const saved = await api.saveRecipe(
      projectId,
      current.id,
      csrf,
      current,
      recipe,
    );
    const next = { ...current, ...saved.draft };
    draftRef.current = next;
    setDraft(next);
    setSchemaProposalId(undefined);
    setSchemaSuggestion(undefined);
    if (next.recipe?.unmappedConfirmed === false) setUnmappedConfirmed(false);
    const evaluated = await api.evaluateRecipe(projectId, current.id, csrf);
    setRecipeCounts(evaluated.evaluation.steps);
    setRecipeExits(evaluated.evaluation.exits);
    setStatus("草稿已自动保存；筛选计数已更新。");
  }

  function queueWorkbenchSave(recipe = workbenchRecipe()) {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = undefined;
    }
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => persistWorkbench(recipe))
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "保存草稿失败");
      });
    return saveQueueRef.current;
  }

  async function saveWorkbenchRecipe() {
    setBusy(true);
    try {
      await queueWorkbenchSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recipe JSON 无效");
    }
    setBusy(false);
  }

  async function takeoverWorkbench() {
    const current = draftRef.current;
    if (
      !current ||
      !confirm("确认接管编辑租约？已保存内容将保持不变并写入审计。")
    )
      return;
    try {
      const takenOver = await api.takeoverDraftLease(
        projectId,
        current.id,
        csrf,
        current.revision,
      );
      hydrateWorkbench({ ...current, ...takenOver.draft }, true);
      setStatus("已确认接管；已保存内容保持不变，接管事件已审计。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "接管租约失败");
    }
  }

  async function previewMapping() {
    const current = draftRef.current;
    if (!current) return;
    try {
      const preview = await api.previewMapping(
        projectId,
        current.id,
        csrf,
        currentMapping(),
        selectedSourceId,
      );
      setMappingPairs(preview.pairs);
      setUnmappedProfile(preview.unmappedFields);
      setUnmappedFields(
        preview.unmappedFields
          .map((field: { path: string }) => field.path)
          .join(", "),
      );
      setUnmappedConfirmed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "映射预览失败");
    }
  }

  async function suggestSchema() {
    try {
      await saveQueueRef.current;
      await persistWorkbench();
      const current = draftRef.current;
      if (!current) return;
      const result = await api.suggestMappingSchema(projectId, current.id);
      setSchemaSuggestion(result);
      setSchemaProposalId(result.proposalId);
      setStatus(
        `已扫描 ${result.scannedRecordCount} 条映射记录；请审阅后明确确认 Schema。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Schema 建议失败");
    }
  }

  async function validateMapping() {
    const current = draftRef.current;
    if (!current) return;
    try {
      const result = await api.mappingValidation(projectId, current.id);
      setMappingValidation(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "映射验证失败");
    }
  }

  async function abandonWorkbench() {
    if (!draft || !confirm("放弃此 Working Draft？已保存内容不会发布为版本。"))
      return;
    try {
      const abandoned = await api.abandonDraft(
        projectId,
        draft.id,
        csrf,
        draft,
      );
      setDraft(abandoned.draft);
      draftRef.current = abandoned.draft;
      setWorkbenchHydrated(false);
      localStorage.removeItem(draftStorageKey);
      setStatus("草稿已放弃；Data Asset、父版本和历史均未改变。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "放弃草稿失败");
    }
  }

  function addManualDecision() {
    if (!manualRecordId) return;
    setManualDecisions((current) => [
      ...current.filter((decision) => decision.id !== manualRecordId),
      {
        id: manualRecordId,
        action: manualAction,
        ...(manualReason ? { reason: manualReason } : {}),
      },
    ]);
    setManualReason("");
  }

  async function createManualCase() {
    const current = draftRef.current;
    if (!current?.leaseToken || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.createManualCase(
        projectId,
        current.id,
        csrf,
        current,
        {
          input: JSON.parse(manualCaseInput),
          expectedOutput: manualCaseOutput,
          metadata: {},
        },
        manualReason,
      );
      const next = { ...current, ...created.draft };
      hydrateWorkbench(next, true);
      setManualChangeCounts((counts) => ({
        ...counts,
        added: counts.added + 1,
      }));
      setLatestManualCreationEvent(created.case.id);
      setManualReason("");
    } catch (caught) {
      const details = (caught as { details?: any }).details;
      setError(
        details
          ? `${details.code}${details.caseId ? `：${details.caseId}` : ""}`
          : caught instanceof Error
            ? caught.message
            : "人工用例保存失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function modifySelectedParentCase() {
    const current = draftRef.current;
    if (!current?.leaseToken || !selectedParentCaseId || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.updateManualCase(
        projectId,
        current.id,
        selectedParentCaseId,
        csrf,
        current,
        {
          input: JSON.parse(manualCaseInput),
          expectedOutput: manualCaseOutput,
        },
        manualReason,
      );
      const next = { ...current, ...updated.draft };
      hydrateWorkbench(next, true);
      setManualChangeCounts((counts) => ({
        ...counts,
        modified: counts.modified + 1,
      }));
      setStatus(
        `父版本用例 ${selectedParentCaseId} 已创建新修订；原修订保持不变。`,
      );
      setManualReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "人工修订保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedParentCase() {
    const current = draftRef.current;
    if (!current?.leaseToken || !selectedParentCaseId || busy) return;
    setBusy(true);
    setError("");
    try {
      const deleted = await api.deleteManualCase(
        projectId,
        current.id,
        selectedParentCaseId,
        csrf,
        current,
      );
      const next = { ...current, ...deleted.draft };
      hydrateWorkbench(next, true);
      setManualChangeCounts((counts) => ({
        ...counts,
        deleted: counts.deleted + 1,
      }));
      setStatus(
        `用例 ${selectedParentCaseId} 将在 v2 中删除；父版本保持不变。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除用例失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveDuplicateDecision() {
    const current = draftRef.current;
    if (!current?.leaseToken || !duplicateDecisionCaseId || busy) return;
    setBusy(true);
    setError("");
    try {
      const recipe = current.recipe ?? {};
      const decisions = {
        ...(recipe.duplicateDecisions ?? {}),
        [duplicateDecisionCaseId]: duplicateDecisionAction,
      };
      const currentRecipe = workbenchRecipe();
      const saved = await api.saveRecipe(projectId, current.id, csrf, current, {
        steps: currentRecipe.steps,
        versionDescription: currentRecipe.versionDescription,
        duplicateDecisions: decisions,
      });
      hydrateWorkbench({ ...current, ...saved.draft }, true);
      setDuplicateDecisionCaseId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重复取舍保存失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (
      busy ||
      !workbenchHydrated ||
      !draft?.leaseToken ||
      draft.status !== "editing"
    )
      return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    let recipe;
    try {
      recipe = workbenchRecipe();
    } catch {
      setError("Recipe JSON 无效");
      return;
    }
    setSchemaSuggestion(undefined);
    setSchemaProposalId(undefined);
    autosaveTimerRef.current = setTimeout(
      () => queueWorkbenchSave(recipe),
      600,
    );
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [
    busy,
    filterField,
    filterOperator,
    filterValue,
    filterMinimum,
    filterMaximum,
    secondFilterEnabled,
    secondFilterField,
    secondFilterOperator,
    secondFilterValue,
    secondFilterMinimum,
    secondFilterMaximum,
    filterCombination,
    filterNegated,
    advancedFilterEnabled,
    advancedFilterJson,
    sampleEnabled,
    sampleMode,
    sampleValue,
    sampleSeed,
    manualDecisions,
    versionDescription,
    mappingJson,
    schemaMode,
    unmappedFields,
    unmappedConfirmed,
    workbenchHydrated,
  ]);

  useEffect(() => {
    if (!draft?.leaseToken || draft.status !== "editing") return;
    const timer = setInterval(async () => {
      const current = draftRef.current;
      if (!current?.leaseToken || current.status !== "editing") return;
      try {
        const renewed = await api.renewDraftLease(
          projectId,
          current.id,
          csrf,
          current,
        );
        const next = { ...current, ...renewed.draft };
        draftRef.current = next;
        setDraft(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "续租失败");
      }
    }, draft.leaseRenewIntervalMs ?? 10_000);
    return () => clearInterval(timer);
  }, [draft?.id, draft?.leaseToken, draft?.status, csrf]);

  useEffect(() => {
    if (!csrf || !route.id) return;
    if (!["asset-detail", "workbench", "test-set-detail"].includes(route.page))
      return;
    const routeId = route.id;
    const key = `${route.page}:${routeId}:${route.query.version ?? ""}:${route.query.versionLimit ?? ""}:${route.query.versionOffset ?? ""}`;
    if (routeLoadRef.current === key) return;
    routeLoadRef.current = key;
    let disposed = false;
    const isCurrent = () => !disposed && routeLoadRef.current === key;
    async function loadRouteContext() {
      // Navigation actions that already loaded this draft must not rehydrate
      // it asynchronously and overwrite edits made immediately afterward.
      if (route.page === "workbench" && draftRef.current?.id === routeId)
        return;
      setBusy(true);
      setError("");
      try {
        if (route.page === "asset-detail") {
          // Keep an in-memory editing draft while moving from the workbench
          // through the asset list; it is the context used to attach another
          // asset. A fresh deep link still uses the scoped local-storage check
          // below and will not inherit an unrelated draft.
          const preservedDraft = draftRef.current;
          const preserveEditingDraft =
            preservedDraft?.status === "editing" && Boolean(preservedDraft.id);
          if (!preserveEditingDraft) {
            draftRef.current = undefined;
            setDraft(undefined);
          }
          setAsset(undefined);
          setAssetDetail(undefined);
          setAttributionHistory([]);
          setAssetAudit([]);
          setDeletionPreview(undefined);
          setDeletionResult(undefined);
          setParsedView(undefined);
          setParseFailures([]);
          setAttempts([]);
          setRecords([]);
          setLocatedRecord(undefined);
          if (!preserveEditingDraft) setVersion(undefined);
          setVersionHistory([]);
          setTestSetSummary(undefined);
          setVersionHistoryPagination({ total: 0, limit: 20, offset: 0 });
          setDeliveryResults([]);
          await Promise.all([
            loadAssetLifecycle(routeId, isCurrent),
            loadParsedView(routeId, undefined, isCurrent),
          ]);
          if (!isCurrent()) return;
          const stored = preserveEditingDraft
            ? null
            : localStorage.getItem(draftStorageKey);
          if (stored) {
            try {
              const reference = JSON.parse(stored);
              if (reference.assetId !== routeId) return;
              const restored = await api.draft(projectId, reference.draftId);
              if (!isCurrent()) return;
              hydrateWorkbench(
                { ...restored.draft, testSetId: reference.testSetId },
                true,
              );
            } catch {
              // A stale browser draft must not block the asset evidence page.
            }
          }
        } else if (route.page === "workbench") {
          draftRef.current = undefined;
          setAsset(undefined);
          setAssetDetail(undefined);
          setAttributionHistory([]);
          setAssetAudit([]);
          setDeletionPreview(undefined);
          setDeletionResult(undefined);
          setParsedView(undefined);
          setParseFailures([]);
          setAttempts([]);
          setRecords([]);
          setLocatedRecord(undefined);
          setVersion(undefined);
          setVersionHistory([]);
          setTestSetSummary(undefined);
          setVersionHistoryPagination({ total: 0, limit: 20, offset: 0 });
          setDeliveryResults([]);
          const result = await api.draft(projectId, routeId);
          if (!isCurrent()) return;
          const next = result.draft;
          hydrateWorkbench(next, true);
          if (next.baseVersionId && next.testSetId) {
            const base = await api.version(
              projectId,
              next.testSetId,
              next.baseVersionId,
            );
            if (!isCurrent()) return;
            setVersion(base.version);
          }
          const assetId = next.sources?.[0]?.assetId;
          if (assetId) {
            if (!isCurrent()) return;
            await Promise.all([
              loadAssetLifecycle(assetId, isCurrent),
              loadParsedView(assetId, undefined, isCurrent),
            ]);
          }
        } else {
          draftRef.current = undefined;
          setAsset(undefined);
          setAssetDetail(undefined);
          setAttributionHistory([]);
          setAssetAudit([]);
          setDeletionPreview(undefined);
          setDeletionResult(undefined);
          setParsedView(undefined);
          setParseFailures([]);
          setAttempts([]);
          setRecords([]);
          setLocatedRecord(undefined);
          setDraft({ testSetId: routeId, status: "readonly" });
          setVersion(undefined);
          setVersionHistory([]);
          setTestSetSummary(undefined);
          setVersionHistoryPagination({ total: 0, limit: 20, offset: 0 });
          setCaseDetail(undefined);
          setComparison(undefined);
          setSelectedCaseDetailId("");
          setCompareBaseVersionId("");
          setCompareTargetVersionId("");
          setDeliveryResults([]);
          const history = await api.versions(projectId, routeId, {
            limit: route.query.versionLimit ?? "20",
            offset: route.query.versionOffset ?? "0",
          });
          if (!isCurrent()) return;
          setTestSetSummary(history.testSet);
          setVersionHistory(history.versions);
          setVersionHistoryPagination(
            history.pagination ?? {
              total: history.versions.length,
              limit: Number(route.query.versionLimit ?? 20),
              offset: Number(route.query.versionOffset ?? 0),
            },
          );
          const selected = route.query.version
            ? history.versions.find(
                (item: any) => item.id === route.query.version,
              )
            : (history.versions.find((item: any) => item.isDefault) ??
              history.versions[0]);
          const selectedId = route.query.version ?? selected?.id;
          if (selectedId) {
            const detail = await api.version(projectId, routeId, selectedId);
            if (!isCurrent()) return;
            setVersion(detail.version);
            await loadDeliveryRecords(selectedId, isCurrent);
            if (!isCurrent()) return;
            setSelectedCaseDetailId(detail.version.lineage?.[0]?.caseId ?? "");
            setCompareBaseVersionId(history.versions[0]?.id ?? "");
            setCompareTargetVersionId(history.versions[1]?.id ?? selectedId);
          }
        }
      } catch (caught) {
        if (!disposed && (caught as Error)?.message !== "route_superseded")
          setError(
            caught instanceof Error ? caught.message : "页面数据读取失败",
          );
      } finally {
        if (!disposed) setBusy(false);
      }
    }
    void loadRouteContext();
    return () => {
      disposed = true;
      setBusy(false);
    };
  }, [
    csrf,
    route.page,
    route.id,
    route.query.version,
    route.query.versionLimit,
    route.query.versionOffset,
  ]);

  const parsedViewCapacityError = parsedView?.errors?.find(
    (item: any) => item.code === "source_record_limit_exceeded",
  );
  const projectRole = actor?.projectRole;
  const canWrite = actor?.capabilities?.write === true;
  const fullDelivery = deliveryResults.find(
    (item) => item.packageType === "full_provenance",
  );
  const csvDelivery = deliveryResults.find(
    (item) => item.packageType === "langfuse_csv",
  );
  const versionLineage = Array.isArray(version?.lineage)
    ? version.lineage.slice(0, 100)
    : [];
  const showAssetsList = route.page === "assets";
  const showAssetDetail = route.page === "asset-detail";
  const showWorkbench = route.page === "workbench";
  const showTestSetList = route.page === "test-sets";
  const showTestSetDetail = route.page === "test-set-detail";
  const showDeliveries = route.page === "deliveries";
  const showVersionEvidence = showTestSetDetail;
  const draftIncludesAsset =
    showAssetDetail &&
    !!asset?.id &&
    Array.isArray(draft?.sources) &&
    draft.sources.some((source: any) => source.assetId === asset.id);
  const pageMeta = {
    assets: {
      eyebrow: "DATA ASSETS / RAW-FIRST",
      title: "先看清原始资产，再开始策展",
      description:
        "上传、解析并定位允许的非生产原始资产。测试集不会在此页创建。",
    },
    "asset-detail": {
      eyebrow: "DATA ASSET / EVIDENCE",
      title: "数据资产详情",
      description: "核对来源说明、解析视图和原始位置，再进入唯一活跃工作草稿。",
    },
    workbench: {
      eyebrow: "CURATION WORKBENCH / DRAFT",
      title: "按顺序把来源整理成候选版本",
      description:
        "筛选、映射、确认 Formal Schema，然后保存草稿或发布不可变版本。",
    },
    "test-sets": {
      eyebrow: "TEST SETS / CONTRACTS",
      title: "测试集",
      description: "从稳定的测试集身份进入版本、用例和交付证据。",
    },
    "test-set-detail": {
      eyebrow: "TEST SET / VERSION EVIDENCE",
      title: "测试集详情",
      description: "查看版本历史、用例、血缘、差异和当前交付状态。",
    },
    deliveries: {
      eyebrow: "DELIVERY RECORDS / LOCAL EVIDENCE",
      title: "交付记录",
      description: "查看标准包、完整溯源包和人工导入确认事实。",
    },
    "not-found": {
      eyebrow: "PAGE NOT FOUND",
      title: "找不到这个页面",
      description: "请从一个已批准的 Phase 1A 对象入口继续。",
    },
  }[route.page];

  const lastRecipeStep = recipeCounts?.[recipeCounts.length - 1];
  const workbenchCount =
    lastRecipeStep?.outputCount ?? eligibleRecordCount ?? records.length;
  const workbenchDelta = lastRecipeStep
    ? lastRecipeStep.outputCount - lastRecipeStep.inputCount
    : 0;
  const workbenchBlocker = error
    ? error
    : parsedView && !parsedView.draftEligible
      ? "Parsed View 尚未达到可加入草稿条件"
      : draft && draft.status === "editing" && !draft.leaseToken
        ? "编辑租约由其他写者持有"
        : "无";
  const workbenchWarning = parsedView?.failureCount
    ? `${parsedView.failureCount} 条解析错误待处置`
    : candidateValidationReport?.valid === false
      ? "Candidate 校验未通过"
      : "无";
  const workbenchSourceStatus = draft?.sources?.length
    ? `${draft.sources.length} 个 Source 已附加`
    : "等待附加 Source";
  const workbenchMappingStatus = draft?.sources?.length
    ? draft.sources.every((source: any) => source.mapping)
      ? "全部 Source 已 mapping"
      : "仍有 Source 未 mapping"
    : "等待 Source mapping";
  const workbenchSchemaStatus = schemaProposalId
    ? "Schema Proposal 待确认"
    : inputSchema.trim() && outputSchema.trim()
      ? "Schema 草稿已填写"
      : "等待 Formal Schema";
  const workbenchValidationStatus = candidateValidationReport
    ? candidateValidationReport.valid
      ? "Candidate 校验通过"
      : "Candidate 校验失败"
    : mappingValidation
      ? mappingValidation.valid
        ? "Mapping 校验通过"
        : "Mapping 校验失败"
      : "等待校验";

  const evidenceSteps = [
    {
      label: "数据资产",
      detail: asset?.id ?? "等待上传",
      state: asset ? "done" : "current",
    },
    {
      label: "解析视图",
      detail: records.length ? "ready" : "等待解析",
      state: records.length ? "done" : asset ? "current" : "todo",
    },
    {
      label: "工作草稿",
      detail: version ? "已冻结" : "等待确认",
      state: version ? "done" : records.length ? "current" : "todo",
    },
    {
      label: "候选快照",
      detail: version ? "校验通过" : "等待物化",
      state: version ? "done" : "todo",
    },
    {
      label: "测试集版本",
      detail: version ? "v1" : "等待发布",
      state: version ? "done" : "todo",
    },
    {
      label: "交付记录",
      detail: version ? "Standard Package" : "等待生成",
      state: version ? "done" : "todo",
    },
  ] as const;

  function parentCaseOperations() {
    if (!draft?.baseVersionId) return null;
    return (
      <section aria-label="父版本人工用例操作">
        <h4>父版本用例人工操作</h4>
        <p>系统只追加和显式取舍，不执行 Join、自动去重或身份合并。</p>
        <p>
          当前变更：+{manualChangeCounts.added} / -{manualChangeCounts.deleted}{" "}
          / ~{manualChangeCounts.modified}
        </p>
        <label>
          选择父版本用例
          <select
            value={selectedParentCaseId}
            onChange={(event) => setSelectedParentCaseId(event.target.value)}
          >
            {versionLineage.map((item: any) => (
              <option key={item.caseId} value={item.caseId}>
                {item.caseId}
              </option>
            ))}
          </select>
        </label>
        <label>
          人工 input JSON
          <textarea
            value={manualCaseInput}
            onChange={(event) => setManualCaseInput(event.target.value)}
          />
        </label>
        <label>
          人工 expected output
          <Input
            value={manualCaseOutput}
            onChange={(event) => setManualCaseOutput(event.target.value)}
          />
        </label>
        <label>
          人工理由（新建和修改必填）
          <Input
            value={manualReason}
            onChange={(event) => setManualReason(event.target.value)}
          />
        </label>
        <Button onClick={createManualCase} disabled={busy || !canWrite}>
          新建人工用例
        </Button>
        <Button
          onClick={modifySelectedParentCase}
          disabled={busy || !selectedParentCaseId || !canWrite}
        >
          修改所选父用例
        </Button>
        <Button
          onClick={deleteSelectedParentCase}
          disabled={busy || !selectedParentCaseId || !canWrite}
        >
          删除所选父用例
        </Button>
        {latestManualCreationEvent && (
          <p aria-label="人工创建 lineage 事件">
            {latestManualCreationEvent} · manual creation event · record_level
          </p>
        )}
      </section>
    );
  }

  return (
    <AppShell
      identityRole={projectRole}
      activePage={route.page}
      onNavigate={navigate}
    >
      <section className="hero page-heading" aria-labelledby="page-title">
        <p className="eyebrow">{pageMeta.eyebrow}</p>
        <h2 id="page-title" data-page-title tabIndex={-1}>
          {pageMeta.title}
        </h2>
        <p>{pageMeta.description}</p>
        {showAssetDetail || showWorkbench || showTestSetDetail ? (
          <EvidenceTrack steps={[...evidenceSteps]} />
        ) : null}
      </section>
      {actor && showAssetsList && (
        <Card className="card wide">
          <span className="step">SESSION / PROJECT ROLE</span>
          <h3>项目角色：{projectRole}</h3>
          <p>
            Editor/Viewer
            是非生产测试身份，不构成真实多人、外部共享、敏感数据或生产批准。项目成员资格与角色只在服务端授权。
          </p>
          <p className="scope">
            Phase 1A 仅验证正常重启/重新部署后的本地持久化；无备份、off-host
            copy、RPO/RTO/SLA 或整机丢失恢复承诺。
          </p>
          {!canWrite && (
            <p className="scope" role="note" aria-label="Viewer 只读边界">
              Viewer
              只读边界：可查看版本、血缘、审计与交付，并可导出原件、Standard
              Package 和 Full Provenance Package。正向导出仅使用合成非敏感
              Fixture；这是当前已接受的非生产范围限制，不构成生产批准。写入、策展、发布和成员管理由服务端拒绝。
            </p>
          )}
        </Card>
      )}
      {!csrf ? (
        <form className="card login" onSubmit={login}>
          <h3>登录</h3>
          <label>
            用户名
            <Input
              name="username"
              defaultValue="owner"
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <Input
              name="password"
              type="password"
              defaultValue="owner-test-password"
              autoComplete="current-password"
            />
          </label>
          <Button type="submit">进入 AgentBench</Button>
        </form>
      ) : (
        <div className="grid">
          {showAssetsList && actor?.capabilities?.manage === true && (
            <Card
              id="membership"
              className="card wide"
              role="region"
              aria-label="项目成员与角色"
            >
              <span className="step">PROJECT ACCESS</span>
              <h3>项目成员与角色</h3>
              <ul aria-label="成员列表">
                {members.map((member) => (
                  <li key={member.userId}>
                    {member.username} · {member.role}
                    {member.isProjectOwner ? " · Project Owner" : ""}
                    <br />
                    <code>{member.userId}</code>
                  </li>
                ))}
              </ul>
              {!!memberChanges.length && (
                <ul aria-label="成员授权审计">
                  {memberChanges.map((change) => (
                    <li key={change.id}>
                      {change.occurredAt} · {change.actor} · {change.action} ·
                      {change.affectedUserId}
                      {change.role ? ` · ${change.role}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <label>
                已有用户名
                <Input
                  aria-label="已有用户名"
                  value={memberUsername}
                  onChange={(event) => setMemberUsername(event.target.value)}
                />
              </label>
              <label>
                项目角色
                <select
                  aria-label="项目角色"
                  value={memberRole}
                  onChange={(event) =>
                    setMemberRole(event.target.value as "editor" | "viewer")
                  }
                >
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
              </label>
              <label>
                要调整的成员 user ID
                <Input
                  aria-label="要调整的成员 user ID"
                  value={memberUserId}
                  onChange={(event) => setMemberUserId(event.target.value)}
                />
              </label>
              <div className="draft-controls">
                <Button
                  onClick={() => updateMember(memberUserId.trim(), memberRole)}
                  disabled={busy || !memberUserId.trim()}
                >
                  更新成员角色
                </Button>
                <Button
                  onClick={() => removeMember(memberUserId.trim())}
                  disabled={busy || !memberUserId.trim()}
                >
                  移除成员
                </Button>
              </div>
              <Button
                onClick={addMember}
                disabled={busy || !memberUsername.trim()}
              >
                加入项目
              </Button>
            </Card>
          )}
          {(showAssetsList ||
            showTestSetList ||
            (showTestSetDetail && version)) && (
            <StructuredListsPanel
              key={`${route.page}:${route.id ?? ""}:${JSON.stringify(route.query)}`}
              projectId={projectId}
              testSetId={draft?.testSetId ?? route.id}
              versionId={version?.id}
              defaultCaseId={selectedCaseDetailId}
              section={
                showAssetsList
                  ? "assets"
                  : showTestSetList
                    ? "test-sets"
                    : "cases"
              }
              onNavigate={navigate}
            />
          )}
          {showTestSetDetail && version && (
            <StructuredListsPanel
              key={`audit:${route.id ?? ""}:${version.id}`}
              projectId={projectId}
              versionId={version.id}
              section="audit"
              onNavigate={navigate}
            />
          )}
          {route.page === "not-found" && (
            <Card className="card wide" role="alert">
              <h3>页面不存在</h3>
              <p>这个地址不属于当前批准的 Phase 1A 页面。</p>
              <Button onClick={() => navigate("/assets")}>返回数据资产</Button>
            </Card>
          )}
          {(showAssetsList || showAssetDetail) && (
            <Card id="data-assets" className="card">
              {showAssetsList && (
                <>
                  <span className="step">01 / 原始资产</span>
                  <h3>上传合成 CSV / JSON / JSONL</h3>
                  <Input
                    aria-label="资产文件"
                    type="file"
                    accept=".csv,.json,.jsonl,text/csv,application/json,application/x-ndjson"
                    disabled={!canWrite}
                    onChange={(event) => setFile(event.target.files?.[0])}
                  />
                  {fileFormat === "csv" && (
                    <div className="parser-config" aria-label="CSV 解析配置">
                      <label>
                        编码
                        <select
                          value={csvEncoding}
                          onChange={(event) =>
                            setCsvEncoding(event.target.value)
                          }
                        >
                          <option value="auto">自动检测</option>
                          <option value="utf8">UTF-8</option>
                          <option value="gb18030">GB18030</option>
                          <option value="gbk">GBK</option>
                        </select>
                      </label>
                      <label>
                        分隔符
                        <Input
                          value={csvDelimiter}
                          maxLength={1}
                          onChange={(event) =>
                            setCsvDelimiter(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        表头行
                        <Input
                          type="number"
                          min={1}
                          value={csvHeaderRow}
                          onChange={(event) =>
                            setCsvHeaderRow(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        引号字符
                        <Input
                          value={csvQuote}
                          maxLength={1}
                          onChange={(event) => setCsvQuote(event.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  {fileFormat === "json" && (
                    <label>
                      记录数组路径（RFC 6901）
                      <Input
                        placeholder="例如 /payload/records；顶层留空"
                        value={jsonRecordPath}
                        onChange={(event) =>
                          setJsonRecordPath(event.target.value)
                        }
                      />
                    </label>
                  )}
                  <label>
                    来源类型
                    <select
                      value={sourceType}
                      onChange={(event) => setSourceType(event.target.value)}
                    >
                      <option value="synthetic">合成</option>
                      <option value="public">公开</option>
                      <option value="deidentified">完全去标识</option>
                    </select>
                  </label>
                  <label>
                    来源名称
                    <Input
                      value={sourceName}
                      onChange={(event) => setSourceName(event.target.value)}
                    />
                  </label>
                  <label>
                    责任人
                    <Input
                      value={responsiblePerson}
                      onChange={(event) =>
                        setResponsiblePerson(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    使用目的
                    <Input
                      value={sourcePurpose}
                      onChange={(event) => setSourcePurpose(event.target.value)}
                    />
                  </label>
                  <label>
                    许可状态
                    <select
                      value={licenseStatus}
                      onChange={(event) => setLicenseStatus(event.target.value)}
                    >
                      <option value="not_applicable">不适用</option>
                      <option value="clear">许可清晰</option>
                      <option value="confirmed">已确认</option>
                      <option value="unknown">未知</option>
                      <option value="restricted">受限</option>
                    </select>
                  </label>
                  <label>
                    敏感级别
                    <select
                      value={sensitivity}
                      onChange={(event) => setSensitivity(event.target.value)}
                    >
                      <option value="non_sensitive">非敏感</option>
                      <option value="sensitive">敏感</option>
                      <option value="production">生产</option>
                      <option value="secret">秘密</option>
                      <option value="restricted">受限</option>
                    </select>
                  </label>
                  {sourceType !== "synthetic" && (
                    <>
                      <label>
                        来源地址
                        <Input
                          value={sourceAddress}
                          onChange={(event) =>
                            setSourceAddress(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        获取时间
                        <Input
                          type="datetime-local"
                          value={acquiredAt}
                          onChange={(event) =>
                            setAcquiredAt(event.target.value)
                          }
                        />
                      </label>
                    </>
                  )}
                  {sourceType === "deidentified" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={deidentificationConfirmed}
                        onChange={(event) =>
                          setDeidentificationConfirmed(event.target.checked)
                        }
                      />
                      已确认完全去标识且非敏感
                    </label>
                  )}
                  <p className="scope" role="note">
                    当前仅允许非生产、非敏感的合成数据，或许可清晰的公开数据，或已确认完全去标识的数据。许可未知、受限或敏感/生产/秘密数据会在加入草稿和发布前阻断；来源、许可、敏感级别或去标识确认变更时必须重新评审。
                  </p>
                  <Button
                    onClick={upload}
                    disabled={!file || busy || !canWrite}
                  >
                    保存并解析
                  </Button>
                  <p>
                    单资产上限：50 MB（
                    {CAPACITY_LIMITS.dataAssetBytes.toLocaleString(
                      "en-US",
                    )}{" "}
                    bytes）、
                    {CAPACITY_LIMITS.parsedViewRecords.toLocaleString(
                      "en-US",
                    )}{" "}
                    条 Source Record；恰好等于上限允许，超过 1 byte 或 1
                    条记录阻断。
                  </p>
                </>
              )}
              {showAssetDetail && (
                <>
                  <span className="step">DATA ASSET / EVIDENCE</span>
                  <h3>数据资产详情</h3>
                  <a
                    className="back-link"
                    href="/assets"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate("/assets");
                    }}
                  >
                    ← 返回数据资产
                  </a>
                </>
              )}
              {showAssetDetail && (
                <>
                  {!asset && busy && (
                    <p className="state-view" aria-busy="true">
                      正在加载资产证据…
                    </p>
                  )}
                  {asset && (
                    <dl>
                      <dt>Asset</dt>
                      <dd>{asset.id}</dd>
                      <dt>文件名</dt>
                      <dd>{asset.fileName}</dd>
                      <dt>大小</dt>
                      <dd>
                        {Number(asset.size ?? 0).toLocaleString("en-US")} bytes
                      </dd>
                      <dt>SHA-256</dt>
                      <dd>{asset.sha256}</dd>
                      <dt>格式</dt>
                      <dd>{asset.format}</dd>
                      <dt>状态</dt>
                      <dd>{asset.status}</dd>
                    </dl>
                  )}
                  {asset && parsedView?.draftEligible && (
                    <section aria-label="外部处理 Transformation Run">
                      <h4>外部处理 / Transformation Run</h4>
                      <p>
                        AgentBench 只登记外部处理证据，不执行代码、规则、模型或
                        Agent。缺核心字段会保留资产，但发布前阻断。
                      </p>
                      <div className="draft-controls">
                        <label>
                          处理类型
                          <select
                            aria-label="处理类型"
                            value={transformationOperation}
                            onChange={(event) =>
                              setTransformationOperation(event.target.value)
                            }
                          >
                            <option value="import">import</option>
                            <option value="code_rule">code / rule</option>
                            <option value="agent_rewrite">Agent rewrite</option>
                            <option value="agent_extraction">
                              Agent extraction
                            </option>
                            <option value="agent_augmentation">
                              Agent augmentation
                            </option>
                            <option value="agent_generation">
                              Agent generation
                            </option>
                            <option value="manual_revision">
                              manual revision
                            </option>
                            <option value="unknown_external_tool">
                              unknown external tool
                            </option>
                          </select>
                        </label>
                        <label>
                          血缘粒度
                          <select
                            aria-label="血缘粒度"
                            value={transformationLevel}
                            onChange={(event) =>
                              setTransformationLevel(
                                event.target.value as
                                  | "asset_level"
                                  | "record_level",
                              )
                            }
                          >
                            <option value="asset_level">asset_level</option>
                            <option value="record_level">record_level</option>
                          </select>
                        </label>
                      </div>
                      <div className="draft-controls">
                        <label>
                          处理目的
                          <Input
                            aria-label="处理目的"
                            value={transformationPurpose}
                            onChange={(event) =>
                              setTransformationPurpose(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          输入版本 ID
                          <Input
                            aria-label="输入版本 ID"
                            value={transformationInputVersionId}
                            onChange={(event) =>
                              setTransformationInputVersionId(
                                event.target.value,
                              )
                            }
                            placeholder={version?.id ?? "version_..."}
                          />
                        </label>
                        <label>
                          输入版本 Manifest SHA-256
                          <Input
                            aria-label="输入版本 Manifest SHA-256"
                            value={transformationInputSha256}
                            onChange={(event) =>
                              setTransformationInputSha256(event.target.value)
                            }
                            placeholder={version?.manifestHash ?? ""}
                          />
                        </label>
                      </div>
                      <div className="draft-controls">
                        <label>
                          工具名称
                          <Input
                            aria-label="工具名称"
                            value={transformationToolName}
                            onChange={(event) =>
                              setTransformationToolName(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          工具版本
                          <Input
                            aria-label="工具版本"
                            value={transformationToolVersion}
                            onChange={(event) =>
                              setTransformationToolVersion(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          代码 / 制品引用
                          <Input
                            aria-label="代码 / 制品引用"
                            value={transformationCodeRef}
                            onChange={(event) =>
                              setTransformationCodeRef(event.target.value)
                            }
                          />
                        </label>
                      </div>
                      {transformationOperation === "unknown_external_tool" && (
                        <label>
                          工具说明
                          <Input
                            aria-label="工具说明"
                            value={transformationToolDescription}
                            onChange={(event) =>
                              setTransformationToolDescription(
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {transformationOperation.startsWith("agent_") && (
                        <div className="draft-controls">
                          <label>
                            模型供应商
                            <Input
                              aria-label="模型供应商"
                              value={transformationModelProvider}
                              onChange={(event) =>
                                setTransformationModelProvider(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                          <label>
                            模型名称
                            <Input
                              aria-label="模型名称"
                              value={transformationModelName}
                              onChange={(event) =>
                                setTransformationModelName(event.target.value)
                              }
                            />
                          </label>
                          <label>
                            模型参数 JSON
                            <Input
                              aria-label="模型参数 JSON"
                              value={transformationModelParameters}
                              onChange={(event) =>
                                setTransformationModelParameters(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        </div>
                      )}
                      {transformationOperation.startsWith("agent_") && (
                        <div className="draft-controls">
                          <label>
                            Prompt 证据
                            <select
                              aria-label="Prompt 证据"
                              value={transformationPromptMode}
                              onChange={(event) =>
                                setTransformationPromptMode(
                                  event.target.value as
                                    | "content"
                                    | "immutable_ref",
                                )
                              }
                            >
                              <option value="content">直接内容</option>
                              <option value="immutable_ref">
                                受控不可变引用
                              </option>
                            </select>
                          </label>
                          {transformationPromptMode === "immutable_ref" && (
                            <>
                              <label>
                                Prompt 资产 ID
                                <Input
                                  aria-label="Prompt 资产 ID"
                                  value={transformationPromptAssetId}
                                  onChange={(event) =>
                                    setTransformationPromptAssetId(
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Prompt SHA-256
                                <Input
                                  aria-label="Prompt SHA-256"
                                  value={transformationPromptSha256}
                                  onChange={(event) =>
                                    setTransformationPromptSha256(
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                            </>
                          )}
                          <label>
                            Prompt 版本
                            <Input
                              aria-label="Prompt 版本"
                              value={transformationPromptVersion}
                              onChange={(event) =>
                                setTransformationPromptVersion(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                          <label>
                            Prompt 正文
                            <Input
                              aria-label="Prompt 正文"
                              value={transformationPromptContent}
                              onChange={(event) =>
                                setTransformationPromptContent(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        </div>
                      )}
                      {transformationOperation === "manual_revision" && (
                        <div className="draft-controls">
                          <label>
                            修订前 JSON
                            <Input
                              aria-label="修订前 JSON"
                              value={transformationManualBefore}
                              onChange={(event) =>
                                setTransformationManualBefore(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                          <label>
                            修订后 JSON
                            <Input
                              aria-label="修订后 JSON"
                              value={transformationManualAfter}
                              onChange={(event) =>
                                setTransformationManualAfter(event.target.value)
                              }
                            />
                          </label>
                          <label>
                            差异 JSON
                            <Input
                              aria-label="差异 JSON"
                              value={transformationManualDiff}
                              onChange={(event) =>
                                setTransformationManualDiff(event.target.value)
                              }
                            />
                          </label>
                          <label>
                            人工理由
                            <Input
                              aria-label="人工理由"
                              value={transformationManualReason}
                              onChange={(event) =>
                                setTransformationManualReason(
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        </div>
                      )}
                      <div className="draft-controls">
                        <label>
                          输入范围键
                          <Input
                            aria-label="输入范围键"
                            value={transformationScopeKey}
                            onChange={(event) =>
                              setTransformationScopeKey(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          输入范围值
                          <Input
                            aria-label="输入范围值"
                            value={transformationScopeValue}
                            onChange={(event) =>
                              setTransformationScopeValue(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          额外输入 JSON 数组
                          <Input
                            aria-label="额外输入 JSON 数组"
                            value={transformationExtraInputsJson}
                            onChange={(event) =>
                              setTransformationExtraInputsJson(
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      </div>
                      {transformationLevel === "record_level" && (
                        <label>
                          Record edges JSON
                          <Input
                            aria-label="Record edges JSON"
                            value={transformationRecordEdges}
                            onChange={(event) =>
                              setTransformationRecordEdges(event.target.value)
                            }
                          />
                        </label>
                      )}
                      <Button
                        onClick={registerCurrentTransformationRun}
                        disabled={
                          busy ||
                          !asset ||
                          !parsedView?.draftEligible ||
                          !canWrite
                        }
                      >
                        登记 Transformation Run
                      </Button>
                      {transformationRun && (
                        <div aria-label="Transformation Run 证据">
                          <p>
                            <strong>{transformationRun.operationType}</strong> ·{" "}
                            <strong>{transformationRun.lineageLevel}</strong> ·{" "}
                            {transformationRun.status}
                          </p>
                          <p className="mono">{transformationRun.id}</p>
                          <p className="mono">
                            manifest {transformationRun.manifestHash}
                          </p>
                          <p>
                            工具 {transformationRun.manifest.tool?.name} v
                            {transformationRun.manifest.tool?.version}
                            {transformationRun.manifest.model?.name
                              ? ` · 模型 ${transformationRun.manifest.model.name}`
                              : ""}
                            {transformationRun.manifest.prompt?.version
                              ? ` · Prompt ${transformationRun.manifest.prompt.version}`
                              : ""}
                          </p>
                          {transformationRun.manifest.inputs?.[0]?.scope && (
                            <p>
                              输入范围：{" "}
                              {Object.entries(
                                transformationRun.manifest.inputs[0].scope,
                              )
                                .map(([key, value]) => `${key}=${value}`)
                                .join("；")}
                            </p>
                          )}
                          {!transformationRun.validationReport?.valid && (
                            <p>
                              缺少核心字段：
                              {transformationRun.validationReport.errors
                                .map((item: any) => item.path)
                                .join(", ")}
                            </p>
                          )}
                          {transformationRun.status === "incomplete" && (
                            <Button
                              onClick={completeCurrentTransformationRun}
                              disabled={busy || !canWrite}
                            >
                              补全 Transformation Run
                            </Button>
                          )}
                          <label>
                            追加说明
                            <Input
                              aria-label="追加说明"
                              value={transformationAnnotation}
                              onChange={(event) =>
                                setTransformationAnnotation(event.target.value)
                              }
                            />
                          </label>
                          <Button
                            onClick={annotateCurrentTransformationRun}
                            disabled={
                              busy ||
                              !transformationAnnotation.trim() ||
                              !canWrite
                            }
                          >
                            追加补充说明
                          </Button>
                        </div>
                      )}
                    </section>
                  )}
                  {asset && parsedView?.draftEligible && (
                    <Button
                      onClick={
                        draft?.status === "editing"
                          ? attachCurrentAsset
                          : openWorkbench
                      }
                      disabled={
                        busy ||
                        !canWrite ||
                        (draft?.status === "editing" && !draft.leaseToken)
                      }
                    >
                      {draft?.status === "editing"
                        ? "追加此资产到当前草稿"
                        : "创建 Working Draft 并附加此资产"}
                    </Button>
                  )}
                  {showAssetDetail && draft && (
                    <p
                      className="scope"
                      role="note"
                      aria-label="当前草稿与资产关系"
                    >
                      {draftIncludesAsset
                        ? "当前 Working Draft 已包含此资产。"
                        : "当前 Working Draft 尚未包含此资产；可以将当前资产追加进去。现有来源不会被伪装为当前资产的关联。"}
                    </p>
                  )}
                  {assetDetail && (
                    <section aria-label="来源与生命周期">
                      <h4>来源与生命周期</h4>
                      <p>
                        当前修订：{assetDetail.attribution.sourceType} /{" "}
                        {assetDetail.attribution.licenseStatus} /{" "}
                        {assetDetail.attribution.sensitivity}
                      </p>
                      <p>
                        已发布版本引用：{assetDetail.references.length}
                        ；归档保留原始字节、来源和引用。
                      </p>
                      <section aria-label="资产下游血缘">
                        <h4>下游草稿、版本与处理运行</h4>
                        <p className="scope">
                          仅展示最近各 20
                          条有界下游证据；空列表不代表资产不存在关联。
                        </p>
                        {assetDetail.lineage?.drafts?.length ? (
                          <ul aria-label="资产关联草稿">
                            {assetDetail.lineage.drafts.map((item: any) => {
                              const href = `/workbench/${encodeURIComponent(item.draftId)}`;
                              return (
                                <li key={item.draftId}>
                                  <a
                                    href={href}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      navigate(href);
                                    }}
                                  >
                                    Working Draft {item.draftId}
                                  </a>{" "}
                                  · {item.status} · revision {item.revision} ·{" "}
                                  {item.testSetName}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="state-view">暂无关联 Working Draft。</p>
                        )}
                        {assetDetail.lineage?.versions?.length ? (
                          <ul aria-label="资产关联测试集版本">
                            {assetDetail.lineage.versions.map((item: any) => {
                              const href = `/test-sets/${encodeURIComponent(item.testSetId)}?version=${encodeURIComponent(item.versionId)}`;
                              return (
                                <li key={item.versionId}>
                                  <a
                                    href={href}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      navigate(href);
                                    }}
                                  >
                                    {item.testSetName} v{item.number}
                                  </a>{" "}
                                  · {item.status}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="state-view">暂无关联测试集版本。</p>
                        )}
                        {assetDetail.lineage?.transformationRuns?.length ? (
                          <ul aria-label="资产关联 Transformation Run">
                            {assetDetail.lineage.transformationRuns.map(
                              (item: any) => (
                                <li key={item.id}>
                                  <code>{item.id}</code> · {item.operationType}{" "}
                                  · {item.lineageLevel} · {item.status}
                                </li>
                              ),
                            )}
                          </ul>
                        ) : (
                          <p className="state-view">
                            暂无关联 Transformation Run。
                          </p>
                        )}
                      </section>
                      <ul aria-label="来源修订历史">
                        {attributionHistory.map((revision) => (
                          <li key={revision.id}>
                            {revision.sourceName} - {revision.responsiblePerson}{" "}
                            - {revision.licenseStatus}
                          </li>
                        ))}
                      </ul>
                      <ul aria-label="资产审计">
                        {assetAudit.map((event) => (
                          <li key={event.id}>
                            {event.occurredAt} - {event.actor} - {event.action}{" "}
                            - {event.objectType}
                          </li>
                        ))}
                      </ul>
                      <Button
                        onClick={archiveAsset}
                        disabled={
                          busy || asset.status === "archived" || !canWrite
                        }
                      >
                        归档资产
                      </Button>
                      <Button
                        onClick={requestOrdinaryDeletion}
                        disabled={busy || !canWrite}
                      >
                        尝试普通删除
                      </Button>
                      {actor?.projectRole === "owner" && (
                        <Button
                          onClick={previewControlledDeletion}
                          disabled={busy || asset.status === "tombstoned"}
                        >
                          预览受控删除影响
                        </Button>
                      )}
                      <p>已发布版本引用的资产只能通过受控删除流程处理。</p>
                    </section>
                  )}
                  {(deletionPreview || deletionResult) && (
                    <section aria-label="受控删除治理模拟">
                      <h4>受控删除（非生产治理流程模拟）</h4>
                      {deletionPreview && (
                        <>
                          <p>
                            影响对象：资产{" "}
                            {deletionPreview.closure?.assets?.length ?? 0}
                            、Parsed View{" "}
                            {deletionPreview.closure?.parsedViews?.length ?? 0}
                            、Source Record{" "}
                            {deletionPreview.closure?.sourceRecords?.length ??
                              0}
                            、草稿{" "}
                            {deletionPreview.closure?.drafts?.length ?? 0}
                            、草稿来源{" "}
                            {deletionPreview.closure?.draftSources?.length ?? 0}
                            、草稿修订{" "}
                            {deletionPreview.closure?.draftRevisions?.length ??
                              0}
                            、候选{" "}
                            {deletionPreview.closure?.candidates?.length ?? 0}
                            、Case Revision{" "}
                            {deletionPreview.closure?.caseRevisions?.length ??
                              0}
                            、版本{" "}
                            {deletionPreview.closure?.versions?.length ?? 0}
                            、Transformation Run{" "}
                            {deletionPreview.closure?.transformationRuns
                              ?.length ?? 0}
                            、交付/导出{" "}
                            {deletionPreview.closure?.deliveries?.length ?? 0}
                            、共享 Blob{" "}
                            {deletionPreview.closure?.sharedBlobs?.length ?? 0}
                            、在线载荷{" "}
                            {deletionPreview.closure?.artifacts?.length ?? 0}
                            、外部副本{" "}
                            {deletionPreview.closure?.externalCopies?.length ??
                              0}
                            ；确认后不可取消。
                          </p>
                          {!!deletionPreview.closure?.defaultImpacts
                            ?.length && (
                            <p>
                              默认指针：将清空{" "}
                              {deletionPreview.closure.defaultImpacts.length}{" "}
                              个受影响版本， 不会自动回退。
                            </p>
                          )}
                          <p className="mono">
                            Preview hash: {deletionPreview.previewHash}
                          </p>
                          <label>
                            结构化理由
                            <select
                              value={deletionReasonCode}
                              onChange={(event) =>
                                setDeletionReasonCode(event.target.value)
                              }
                              disabled={busy || actor?.projectRole !== "owner"}
                            >
                              <option value="owner_requested">
                                owner_requested
                              </option>
                              <option value="nonproduction_test">
                                nonproduction_test
                              </option>
                              <option value="nonproduction_validation">
                                nonproduction_validation
                              </option>
                              <option value="data_correction">
                                data_correction
                              </option>
                              <option value="retention_cleanup">
                                retention_cleanup
                              </option>
                              <option value="other">other</option>
                            </select>
                          </label>
                          <label>
                            理由说明（不写法律或合规结论）
                            <Input
                              value={deletionReasonNote}
                              maxLength={500}
                              onChange={(event) =>
                                setDeletionReasonNote(event.target.value)
                              }
                              disabled={busy || actor?.projectRole !== "owner"}
                            />
                          </label>
                          <Button
                            onClick={confirmControlledDeletion}
                            disabled={
                              busy ||
                              actor?.projectRole !== "owner" ||
                              !deletionReasonNote.trim()
                            }
                          >
                            同一 Project Owner 二次确认并执行
                          </Button>
                        </>
                      )}
                      {deletionResult && (
                        <div aria-live="polite">
                          <p>
                            状态：{deletionResult.status} · 阶段：
                            {deletionResult.stage ?? "queued"}
                          </p>
                          {deletionResult.failureCode && (
                            <p role="alert">
                              失败阶段：{deletionResult.failureCode}
                            </p>
                          )}
                          {!!deletionResult.testSets?.length && (
                            <p>
                              Test Set 状态：
                              {deletionResult.testSets
                                .map(
                                  (testSet: any) =>
                                    `${testSet.id}=${testSet.availability}`,
                                )
                                .join("；")}
                            </p>
                          )}
                          {!!deletionResult.tombstones?.length && (
                            <ul aria-label="受控删除墓碑">
                              {deletionResult.tombstones.map(
                                (tombstone: any) => (
                                  <li
                                    key={`${tombstone.objectType}:${tombstone.opaqueObjectId}`}
                                  >
                                    墓碑：{tombstone.objectType}/
                                    {tombstone.opaqueObjectId} ·{" "}
                                    {tombstone.resultStatus}
                                  </li>
                                ),
                              )}
                            </ul>
                          )}
                          {!!deletionResult.externalCopies?.length && (
                            <p>
                              外部副本：仅生成人工处置清单，系统不会撤回或验证。
                            </p>
                          )}
                          {deletionResult.status === "failed" &&
                            actor?.projectRole === "owner" && (
                              <Button
                                onClick={retryControlledDeletion}
                                disabled={busy}
                              >
                                重试受控删除
                              </Button>
                            )}
                        </div>
                      )}
                    </section>
                  )}
                  {asset && (
                    <Button onClick={retryParse} disabled={busy || !canWrite}>
                      按当前配置新建解析尝试
                    </Button>
                  )}
                  {!!attempts.length && (
                    <div className="attempts" aria-label="解析尝试">
                      {attempts.map((attempt) => (
                        <div key={attempt.id}>
                          <span>{attempt.status}</span>
                          <code>{attempt.id}</code>
                          {attempt.status === "superseded" && (
                            <Button
                              onClick={() => selectAttempt(attempt.id)}
                              disabled={!canWrite}
                            >
                              设为当前视图
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
          {showWorkbench && (
            <Card id="workbench" className="card">
              <span className="step">02 / 策展方案</span>
              <section
                className="workbench-summary"
                aria-label="Working Draft 状态摘要"
              >
                <div>
                  <span>当前计数</span>
                  <strong>
                    {Number(workbenchCount).toLocaleString("en-US")}
                  </strong>
                </div>
                <div>
                  <span>相对上一步</span>
                  <strong>
                    {workbenchDelta >= 0 ? "+" : ""}
                    {Number(workbenchDelta).toLocaleString("en-US")}
                  </strong>
                </div>
                <div>
                  <span>阻断</span>
                  <strong>{workbenchBlocker}</strong>
                </div>
                <div>
                  <span>警告</span>
                  <strong>{workbenchWarning}</strong>
                </div>
                <div>
                  <span>自动保存</span>
                  <strong>
                    {draft?.status === "editing"
                      ? "已启用（租约有效时）"
                      : "等待可编辑草稿"}
                  </strong>
                </div>
                <div>
                  <span>上游对象</span>
                  <strong>{workbenchSourceStatus}</strong>
                </div>
              </section>
              <ol className="workbench-sequence" aria-label="策展顺序">
                <li>
                  <strong>1. Source attachment / lease</strong>
                  <span>
                    {workbenchSourceStatus} ·{" "}
                    {draft?.leaseToken ? "租约有效" : "需要租约"}
                  </span>
                </li>
                <li>
                  <strong>2. Filter / sample</strong>
                  <span>
                    {recipeCounts?.length ? "Recipe 已保存" : "等待筛选和抽样"}
                  </span>
                </li>
                <li>
                  <strong>3. Mapping</strong>
                  <span>{workbenchMappingStatus}</span>
                </li>
                <li>
                  <strong>4. Formal Schema</strong>
                  <span>{workbenchSchemaStatus}</span>
                </li>
                <li>
                  <strong>5. Validation / publish</strong>
                  <span>{workbenchValidationStatus}</span>
                </li>
              </ol>
              <label>
                测试集名称
                <Input
                  value={testSetName}
                  onChange={(event) => setTestSetName(event.target.value)}
                />
              </label>
              <label>
                测试集目的
                <Input
                  value={testSetPurpose}
                  onChange={(event) => setTestSetPurpose(event.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={advancedFilterEnabled}
                  onChange={(event) =>
                    setAdvancedFilterEnabled(event.target.checked)
                  }
                />
                编辑完整递归布尔树
              </label>
              {advancedFilterEnabled && (
                <label>
                  递归布尔筛选树 JSON
                  <textarea
                    value={advancedFilterJson}
                    onChange={(event) =>
                      setAdvancedFilterJson(event.target.value)
                    }
                  />
                  <small>
                    仅接受 all / any / not
                    与批准的结构化操作，不执行表达式或脚本。
                  </small>
                </label>
              )}
              <h4>2. Filter / sample</h4>
              <label>
                筛选字段
                <Input
                  value={filterField}
                  onChange={(event) => setFilterField(event.target.value)}
                />
              </label>
              <label>
                筛选操作
                <select
                  value={filterOperator}
                  onChange={(event) =>
                    setFilterOperator(event.target.value as FilterOperator)
                  }
                >
                  <option value="eq">等于</option>
                  <option value="neq">不等于</option>
                  <option value="contains">包含</option>
                  <option value="range">范围（含端点）</option>
                  <option value="is_null">空值</option>
                </select>
              </label>
              {filterOperator === "range" ? (
                <div className="parser-config">
                  <label>
                    范围最小值
                    <Input
                      type="number"
                      value={filterMinimum}
                      onChange={(event) => setFilterMinimum(event.target.value)}
                    />
                  </label>
                  <label>
                    范围最大值
                    <Input
                      type="number"
                      value={filterMaximum}
                      onChange={(event) => setFilterMaximum(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                filterOperator !== "is_null" && (
                  <label>
                    筛选值
                    <Input
                      value={filterValue}
                      onChange={(event) => setFilterValue(event.target.value)}
                    />
                  </label>
                )
              )}
              <label>
                <input
                  type="checkbox"
                  checked={secondFilterEnabled}
                  onChange={(event) =>
                    setSecondFilterEnabled(event.target.checked)
                  }
                />
                启用第二个筛选条件
              </label>
              {secondFilterEnabled && (
                <div className="parser-config" aria-label="第二个筛选条件">
                  <label>
                    布尔组合
                    <select
                      value={filterCombination}
                      onChange={(event) =>
                        setFilterCombination(
                          event.target.value as "all" | "any",
                        )
                      }
                    >
                      <option value="all">全部满足（AND）</option>
                      <option value="any">任一满足（OR）</option>
                    </select>
                  </label>
                  <label>
                    第二筛选字段
                    <Input
                      value={secondFilterField}
                      onChange={(event) =>
                        setSecondFilterField(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    第二筛选操作
                    <select
                      value={secondFilterOperator}
                      onChange={(event) =>
                        setSecondFilterOperator(
                          event.target.value as FilterOperator,
                        )
                      }
                    >
                      <option value="eq">等于</option>
                      <option value="neq">不等于</option>
                      <option value="contains">包含</option>
                      <option value="range">范围（含端点）</option>
                      <option value="is_null">空值</option>
                    </select>
                  </label>
                  {secondFilterOperator === "range" ? (
                    <>
                      <label>
                        第二范围最小值
                        <Input
                          type="number"
                          value={secondFilterMinimum}
                          onChange={(event) =>
                            setSecondFilterMinimum(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        第二范围最大值
                        <Input
                          type="number"
                          value={secondFilterMaximum}
                          onChange={(event) =>
                            setSecondFilterMaximum(event.target.value)
                          }
                        />
                      </label>
                    </>
                  ) : (
                    secondFilterOperator !== "is_null" && (
                      <label>
                        第二筛选值
                        <Input
                          value={secondFilterValue}
                          onChange={(event) =>
                            setSecondFilterValue(event.target.value)
                          }
                        />
                      </label>
                    )
                  )}
                </div>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={filterNegated}
                  onChange={(event) => setFilterNegated(event.target.checked)}
                />
                对筛选结果取反（NOT）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={sampleEnabled}
                  onChange={(event) => setSampleEnabled(event.target.checked)}
                />
                启用确定性抽样
              </label>
              {sampleEnabled && (
                <div className="parser-config" aria-label="确定性抽样">
                  <label>
                    抽样模式
                    <select
                      value={sampleMode}
                      onChange={(event) =>
                        setSampleMode(event.target.value as "count" | "ratio")
                      }
                    >
                      <option value="count">固定数量</option>
                      <option value="ratio">固定比例</option>
                    </select>
                  </label>
                  <label>
                    抽样数量或比例
                    <Input
                      type="number"
                      min="0"
                      max={sampleMode === "ratio" ? "1" : undefined}
                      step={sampleMode === "ratio" ? "0.01" : "1"}
                      value={sampleValue}
                      onChange={(event) => setSampleValue(event.target.value)}
                    />
                  </label>
                  <label>
                    抽样种子
                    <Input
                      value={sampleSeed}
                      onChange={(event) => setSampleSeed(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <label>
                人工取舍记录
                <select
                  value={manualRecordId}
                  onChange={(event) => setManualRecordId(event.target.value)}
                >
                  {records.map((record) => (
                    <option
                      key={record.ordinal}
                      value={`${parsedView?.id}:${record.ordinal}`}
                    >
                      {parsedView?.id}:{record.ordinal}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                人工取舍动作
                <select
                  value={manualAction}
                  onChange={(event) =>
                    setManualAction(
                      event.target.value as ManualDecision["action"],
                    )
                  }
                >
                  <option value="include">包含</option>
                  <option value="exclude">排除</option>
                </select>
              </label>
              <label>
                人工取舍理由（可选）
                <Input
                  value={manualReason}
                  onChange={(event) => setManualReason(event.target.value)}
                />
              </label>
              <Button
                onClick={addManualDecision}
                disabled={!draft?.leaseToken || !manualRecordId || !canWrite}
              >
                添加人工取舍
              </Button>
              {!!manualDecisions.length && (
                <ul aria-label="已保存人工取舍">
                  {manualDecisions.map((decision) => (
                    <li key={decision.id}>
                      {decision.id} · {decision.action} ·
                      {decision.reason || "无理由"} ·
                      {decision.actorId || "保存后记录操作者"}
                      <button
                        type="button"
                        onClick={() =>
                          setManualDecisions((current) =>
                            current.filter((item) => item.id !== decision.id),
                          )
                        }
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label>
                版本说明
                <Input
                  value={versionDescription}
                  onChange={(event) =>
                    setVersionDescription(event.target.value)
                  }
                />
              </label>
              <h4>3. Mapping</h4>
              {!!draft?.sources?.length && (
                <label>
                  选择 Source
                  <select
                    value={selectedSourceId}
                    onChange={(event) => {
                      setActiveSourceId(event.target.value);
                      const source = draft?.sources.find(
                        (item: any) => item.id === event.target.value,
                      );
                      if (source?.mapping) {
                        setMappingJson(JSON.stringify(source.mapping, null, 2));
                        setUnmappedFields(source.unmappedFields.join(", "));
                        setUnmappedProfile(undefined);
                        setUnmappedConfirmed(source.unmappedConfirmed);
                      }
                    }}
                  >
                    {draft?.sources.map((source: any) => (
                      <option key={source.id} value={source.id}>
                        Source {source.position} · {source.assetId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!!draft?.sources?.length && (
                <div className="draft-controls">
                  <Button
                    onClick={saveActiveSourceMapping}
                    disabled={busy || !canWrite}
                  >
                    保存所选 Source 独立 mapping
                  </Button>
                  <Button
                    onClick={removeActiveSource}
                    disabled={busy || !canWrite}
                  >
                    移除所选 Source
                  </Button>
                </div>
              )}
              <label>
                映射 JSON（source、object、constant、interpretAs）
                <textarea
                  aria-label="映射 JSON"
                  value={mappingJson}
                  onChange={(event) => {
                    setMappingJson(event.target.value);
                    setUnmappedProfile(undefined);
                    setUnmappedConfirmed(false);
                    setSchemaSuggestion(undefined);
                    setSchemaProposalId(undefined);
                  }}
                />
              </label>
              <label>
                未映射字段
                <Input value={unmappedFields} readOnly />
              </label>
              {unmappedProfile && (
                <div aria-label="未映射字段样例">
                  {unmappedProfile.length ? (
                    unmappedProfile.map((field) => (
                      <p key={field.path}>
                        {field.path} · 样例：{JSON.stringify(field.sample)}
                      </p>
                    ))
                  ) : (
                    <p>所有源字段均已映射。</p>
                  )}
                </div>
              )}
              <h4>4. Formal Schema</h4>
              <label>
                Input Formal Schema
                <textarea
                  value={inputSchema}
                  onChange={(event) => setInputSchema(event.target.value)}
                />
              </label>
              <label>
                Expected Output Formal Schema
                <textarea
                  value={outputSchema}
                  onChange={(event) => setOutputSchema(event.target.value)}
                />
              </label>
              <label>
                Formal Schema 模式
                <select
                  value={schemaMode}
                  onChange={(event) =>
                    setSchemaMode(
                      event.target.value as "gold_required" | "input_only",
                    )
                  }
                >
                  <option value="gold_required">
                    gold_required（必须有 expected_output）
                  </option>
                  <option value="input_only">
                    input_only（允许空 expected_output）
                  </option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={unmappedConfirmed}
                  onChange={(event) =>
                    setUnmappedConfirmed(event.target.checked)
                  }
                  disabled={!unmappedProfile}
                />
                确认未映射字段仅保留在 Data Asset
              </label>
              {draft && (
                <>
                  <h4>5. Validation / publish</h4>
                  <Button onClick={previewMapping} disabled={!canWrite}>
                    预览映射（最多 20 条）
                  </Button>
                  <Button onClick={suggestSchema} disabled={!canWrite}>
                    扫描全部映射记录并建议 Schema
                  </Button>
                  <Button onClick={validateMapping} disabled={!canWrite}>
                    验证全部映射记录
                  </Button>
                  {!!mappingPairs.length && (
                    <div aria-label="映射预览">
                      <strong>
                        映射预览：{mappingPairs.length} 条 Source Record
                      </strong>
                      {mappingPairs.map((pair) => (
                        <div key={pair.ordinal}>
                          <p>
                            #{pair.ordinal} · {locatorLabel(pair.locator)} →{" "}
                            {JSON.stringify(pair.item)}
                          </p>
                          {pair.errors?.map((error: any) => (
                            <p
                              key={`${error.target}-${error.path}-${error.code}`}
                            >
                              {error.target} · {error.path} · {error.code}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {schemaSuggestion && (
                    <pre aria-label="Schema 建议">
                      已扫描 {schemaSuggestion.scannedRecordCount} 条；Proposal{" "}
                      {schemaProposalId}；尚未确认：
                      {JSON.stringify(schemaSuggestion.suggestion, null, 2)}
                    </pre>
                  )}
                  {mappingValidation && (
                    <div aria-label="映射验证结果">
                      {mappingValidation.valid
                        ? "所有映射记录通过验证"
                        : mappingValidation.errors.map((item: any) => (
                            <p
                              key={`${item.ordinal}-${item.path ?? item.instancePath}`}
                            >
                              #{item.ordinal} · {locatorLabel(item.locator)} ·{" "}
                              {item.path ?? item.instancePath ?? "/"} ·{" "}
                              {item.code ?? item.keyword}
                            </p>
                          ))}
                    </div>
                  )}
                  {candidateValidationReport?.valid === false && (
                    <div aria-label="Candidate 验证失败报告">
                      <p>
                        阻断阶段：
                        {candidateValidationReport.blockingPhase ??
                          "candidate_materialization"}
                        ；对象：
                        {candidateValidationReport.object?.type ?? "candidate"}
                        {candidateValidationReport.object?.id
                          ? ` ${candidateValidationReport.object.id}`
                          : ""}
                        。超限维度：
                        {candidateValidationReport.exceededDimension ??
                          candidateValidationReport.errorCode ??
                          "unknown"}
                        。{" "}
                        {candidateValidationReport.actual !== undefined &&
                        candidateValidationReport.limit !== undefined
                          ? `actual/limit：${capacityValue(
                              candidateValidationReport.actual,
                            )}/${capacityValue(
                              candidateValidationReport.limit,
                            )}；`
                          : ""}
                        {candidateValidationReport.actualItems !== undefined &&
                        candidateValidationReport.limitItems !== undefined
                          ? `记录数：${(
                              candidateValidationReport.actualItems ?? 0
                            ).toLocaleString("en-US")}/${(
                              candidateValidationReport.limitItems ??
                              CAPACITY_LIMITS.candidateItems
                            ).toLocaleString("en-US")}；`
                          : ""}
                        {candidateValidationReport.minimumItems !== undefined
                          ? `最小记录数：至少 ${capacityValue(
                              candidateValidationReport.minimumItems,
                            )} 条；`
                          : ""}
                        {candidateValidationReport.actualBytes !== undefined &&
                        candidateValidationReport.limitBytes !== undefined
                          ? `字节数：${bytePairLabel(
                              candidateValidationReport.actualBytes ?? 0,
                              candidateValidationReport.limitBytes ??
                                CAPACITY_LIMITS.itemsBytes,
                            )}；`
                          : ""}
                        {candidateValidationReport.retry}
                      </p>
                      {!!candidateValidationReport.duplicateCaseIds?.length && (
                        <div aria-label="重复内容取舍">
                          <p>
                            精确内容重复的 case_id：
                            {candidateValidationReport.duplicateCaseIds.join(
                              "、",
                            )}
                            ；必须逐条明确 include/exclude。
                          </p>
                          <label>
                            重复用例 case_id
                            <Input
                              value={duplicateDecisionCaseId}
                              onChange={(event) =>
                                setDuplicateDecisionCaseId(event.target.value)
                              }
                            />
                          </label>
                          <label>
                            重复取舍
                            <select
                              value={duplicateDecisionAction}
                              onChange={(event) =>
                                setDuplicateDecisionAction(
                                  event.target.value as "include" | "exclude",
                                )
                              }
                            >
                              <option value="include">include（保留）</option>
                              <option value="exclude">exclude（排除）</option>
                            </select>
                          </label>
                          <Button
                            onClick={saveDuplicateDecision}
                            disabled={
                              busy || !duplicateDecisionCaseId || !canWrite
                            }
                          >
                            保存重复取舍
                          </Button>
                          {Object.entries(
                            draft.recipe?.duplicateDecisions ?? {},
                          ).map(([caseId, action]) => (
                            <p key={caseId}>
                              重复用例 {caseId} 已明确 {String(action)}。
                            </p>
                          ))}
                        </div>
                      )}
                      {isAggregateCapacity(candidateValidationReport.actual) &&
                        isAggregateCapacity(
                          candidateValidationReport.limit,
                        ) && (
                          <p>
                            Working Draft aggregate · assets{" "}
                            {candidateValidationReport.actual.assets.toLocaleString(
                              "en-US",
                            )}
                            /
                            {candidateValidationReport.limit.assets?.toLocaleString(
                              "en-US",
                            )}
                            ；originalBytes{" "}
                            {bytePairLabel(
                              candidateValidationReport.actual.originalBytes,
                              candidateValidationReport.limit.originalBytes,
                            )}
                            ；sourceRecords{" "}
                            {candidateValidationReport.actual.sourceRecords.toLocaleString(
                              "en-US",
                            )}
                            /
                            {candidateValidationReport.limit.sourceRecords?.toLocaleString(
                              "en-US",
                            )}
                            ；largestAssetBytes{" "}
                            {bytePairLabel(
                              candidateValidationReport.actual
                                .largestAssetBytes,
                              candidateValidationReport.limit.largestAssetBytes,
                            )}
                            ；largestAssetRecords{" "}
                            {candidateValidationReport.actual.largestAssetRecords.toLocaleString(
                              "en-US",
                            )}
                            /
                            {candidateValidationReport.limit.largestAssetRecords?.toLocaleString(
                              "en-US",
                            )}
                            ；超限维度{" "}
                            {candidateValidationReport.exceededDimension ??
                              candidateValidationReport.errorCode}
                          </p>
                        )}
                      {candidateValidationReport.errors
                        .filter((item: any) => !item.ordinal && !item.locator)
                        .map((item: any) => (
                          <p
                            key={`object-${item.code}-${item.actualBytes ?? ""}`}
                          >
                            对象级错误 · {item.code}
                            {item.exceededDimension
                              ? ` · ${item.exceededDimension}`
                              : ""}
                            {item.actual !== undefined &&
                            item.limit !== undefined
                              ? ` · ${capacityValue(item.actual)}/${capacityValue(
                                  item.limit,
                                )}`
                              : ""}
                            {item.actualBytes !== undefined
                              ? ` · ${bytePairLabel(
                                  item.actualBytes,
                                  item.limitBytes,
                                )}`
                              : ""}
                            {item.actualItems !== undefined
                              ? ` · ${item.actualItems.toLocaleString(
                                  "en-US",
                                )}/${item.limitItems?.toLocaleString("en-US")} 条`
                              : ""}
                          </p>
                        ))}
                      {candidateValidationReport.errors
                        .filter((item: any) => item.ordinal || item.locator)
                        .map((item: any) => (
                          <p
                            key={`${item.ordinal}-${item.path ?? item.instancePath}-${item.code}`}
                          >
                            #{item.ordinal} · {locatorLabel(item.locator)} ·{" "}
                            {item.path ?? item.instancePath ?? "/"} ·{" "}
                            {item.code}
                            {item.actualBytes !== undefined
                              ? ` · ${bytePairLabel(
                                  item.actualBytes,
                                  item.limitBytes,
                                )}`
                              : ""}
                          </p>
                        ))}
                    </div>
                  )}
                </>
              )}
              {!draft && (
                <Button
                  onClick={openWorkbench}
                  disabled={
                    !records.length ||
                    !parsedView?.draftEligible ||
                    busy ||
                    !canWrite
                  }
                >
                  打开 Working Draft
                </Button>
              )}
              {draft && (
                <div className="draft-controls">
                  <p>
                    Working Draft {draft.id} · revision {draft.revision} ·
                    当前写者 {draft.leaseHolderId}
                  </p>
                  <p>
                    编辑租约：
                    {draft.leaseToken
                      ? `可写，续租至 ${draft.leaseExpiresAt}`
                      : "只读；需要明确确认后接管"}
                  </p>
                  {draft.capacity && (
                    <p aria-label="Working Draft 容量">
                      {`附件 ${draft.capacity.attachedAssets}/${draft.capacity.assetLimit}；原始字节 ${draft.capacity.originalBytes.toLocaleString(
                        "en-US",
                      )}/${draft.capacity.originalByteLimit.toLocaleString(
                        "en-US",
                      )} bytes（100 MB / ${CAPACITY_LIMITS.draftOriginalBytes.toLocaleString(
                        "en-US",
                      )} bytes）；Source Records ${draft.capacity.sourceRecords.toLocaleString(
                        "en-US",
                      )}/${draft.capacity.sourceRecordLimit.toLocaleString(
                        "en-US",
                      )}`}
                    </p>
                  )}
                  {!!draft.sources?.length && (
                    <div aria-label="分源 Mapping">
                      {draft.sources.map((source: any) => (
                        <p key={source.id}>
                          Source {source.position} · {source.assetId} ·{" "}
                          {source.mapping
                            ? "独立 mapping 已保存"
                            : "mapping 未配置"}
                          {source.unmappedConfirmed
                            ? " · 未映射字段已确认"
                            : ""}
                        </p>
                      ))}
                    </div>
                  )}
                  {recipeCounts?.map((step) => (
                    <p key={`${step.kind}-${step.inputCount}`}>
                      {step.kind}: {step.inputCount} → {step.outputCount}（排除{" "}
                      {step.excludedCount}，错误 {step.errorCount}）
                    </p>
                  ))}
                  {Object.entries(recipeExits).map(([recordId, exit]) => (
                    <p key={recordId}>
                      记录退出：{recordId} · 步骤 {(exit as any).step} ·{" "}
                      {(exit as any).reason}
                    </p>
                  ))}
                  {!draft.leaseToken && draft.status === "editing" && (
                    <Button onClick={takeoverWorkbench} disabled={!canWrite}>
                      确认接管编辑租约
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={saveWorkbenchRecipe}
                    disabled={
                      busy ||
                      draft.status !== "editing" ||
                      !draft.leaseToken ||
                      !canWrite
                    }
                  >
                    立即保存并预览 Recipe
                  </Button>
                  <Button
                    variant="outline"
                    onClick={abandonWorkbench}
                    disabled={
                      busy ||
                      draft.status !== "editing" ||
                      !draft.leaseToken ||
                      !canWrite
                    }
                  >
                    放弃草稿
                  </Button>
                </div>
              )}
              <Button
                className="publish-action"
                onClick={publishTracer}
                disabled={
                  !records.length ||
                  !parsedView?.draftEligible ||
                  !unmappedProfile ||
                  !versionDescription.trim() ||
                  busy ||
                  !canWrite
                }
              >
                确认并发布 v
                {draft?.baseVersionId ? (version?.number ?? 1) + 1 : 1}
              </Button>
              {activeJob && (
                <section
                  aria-label="后台任务状态"
                  className="draft-controls"
                  role="status"
                >
                  <h4>后台任务</h4>
                  <p>
                    {activeJob.kind ?? "unknown"} · {activeJob.status} ·{" "}
                    {activeJob.stage ?? "queued"}
                  </p>
                  <progress
                    aria-label="后台任务进度"
                    max={100}
                    value={Number(activeJob.progress ?? 0)}
                  />
                  <p>
                    尝试 {Number(activeJob.attempt ?? 0)}/
                    {Number(activeJob.maxAttempts ?? 0)} · correlation ID{" "}
                    <code>{activeJob.correlationId ?? activeJob.id}</code>
                  </p>
                  {!!activeJob.counts &&
                    Object.keys(activeJob.counts).length > 0 && (
                      <p>计数：{JSON.stringify(activeJob.counts)}</p>
                    )}
                  {activeJob.errorCode && (
                    <p role="alert">稳定错误：{activeJob.errorCode}</p>
                  )}
                  {!["succeeded", "failed", "cancelled"].includes(
                    activeJob.status,
                  ) && (
                    <Button onClick={cancelActiveJob} disabled={!canWrite}>
                      取消后台任务
                    </Button>
                  )}
                  {activeJob.status === "failed" &&
                    [
                      "infrastructure_unavailable",
                      "job_lease_expired",
                    ].includes(activeJob.errorCode) && (
                      <Button onClick={retryActiveJob} disabled={!canWrite}>
                        重试后台任务
                      </Button>
                    )}
                </section>
              )}
              {requiresNewTestSet && (
                <Button
                  onClick={createNewTestSetFromDraft}
                  disabled={busy || !canWrite}
                >
                  创建新 Test Set 以采用破坏性 Schema
                </Button>
              )}
              {parentCaseOperations()}
            </Card>
          )}
          {(showAssetDetail || showWorkbench) && (
            <Card className="card wide">
              <span className="step">SOURCE RECORD PREVIEW</span>
              {parsedView && (
                <p className="parse-summary">
                  {Number(parsedView.totalCount).toLocaleString("en-US")} 总计 ·{" "}
                  {Number(parsedView.successCount).toLocaleString("en-US")} 成功
                  · {Number(parsedView.failureCount).toLocaleString("en-US")}{" "}
                  失败
                </p>
              )}
              {eligibleRecordCount !== undefined && (
                <p className="eligible-count">
                  {Number(eligibleRecordCount).toLocaleString("en-US")}{" "}
                  条可加入草稿
                </p>
              )}
              {parsedView?.fieldSummary?.detectedEncoding && (
                <p>检测编码：{parsedView.fieldSummary.detectedEncoding}</p>
              )}
              {!!parsedView?.fieldSummary?.profiles?.length && (
                <div className="field-profiles" aria-label="字段发现">
                  {parsedView.fieldSummary.profiles
                    .slice(0, 20)
                    .map((profile: any) => (
                      <code key={profile.path || "root"}>
                        {profile.path || "/"} · {profile.types.join(" | ")}
                      </code>
                    ))}
                </div>
              )}
              {parsedViewCapacityError && !parsedView.draftEligible && (
                <section
                  className="parse-errors"
                  aria-label="Parsed View 容量阻断"
                  role="alert"
                >
                  <h3>Parsed View 容量阻断</h3>
                  <p>对象：Parsed View {parsedView.id}</p>
                  <p>
                    Source Records：
                    {Number(
                      parsedViewCapacityError.actualRecords,
                    ).toLocaleString("en-US")}
                    /
                    {Number(
                      parsedViewCapacityError.limitRecords,
                    ).toLocaleString("en-US")}
                  </p>
                  <p>错误码：{parsedViewCapacityError.code}</p>
                  <p>实际阻断阶段：Parsed View</p>
                  <p>
                    重试方式：
                    {parsedViewCapacityError.retry ??
                      "Use an asset with at most 10,000 Source Records."}
                  </p>
                </section>
              )}
              {!!parseFailures.length && (
                <section className="parse-errors" aria-label="解析错误">
                  <h3>可定位解析错误</h3>
                  {parseFailures.map((record) => (
                    <article key={record.ordinal}>
                      <strong>
                        {record.locator.kind === "jsonl_line"
                          ? `物理行 ${record.locator.physicalLine}`
                          : JSON.stringify(record.locator)}
                      </strong>
                      <p>原因：{record.error.reason}</p>
                      <p>重试方式：修正该物理行，或显式排除后继续。</p>
                      <p>实际阻断阶段：Parsed View</p>
                      <button
                        type="button"
                        className="location-link"
                        onClick={() => locateSourceRecord(record.ordinal)}
                        aria-label={`查看第 ${record.ordinal} 条记录的原始位置`}
                      >
                        查看原始位置
                      </button>
                    </article>
                  ))}
                  {!parsedView.draftEligible && (
                    <Button
                      onClick={excludeFailures}
                      disabled={busy || !canWrite}
                    >
                      排除 {parseFailures.length} 条可定位错误
                    </Button>
                  )}
                </section>
              )}
              {locatedRecord && (
                <aside className="source-location" aria-label="原始位置">
                  <h3>原始位置</h3>
                  <p>定位对象：Source Record {locatedRecord.object.ordinal}</p>
                  <p>{locatorLabel(locatedRecord.locator)}</p>
                  <a href={locatedRecord.rawAssetDownloadUrl}>下载原始资产</a>
                </aside>
              )}
              {parsedView?.status === "parse_failed" && (
                <section className="parse-errors" role="alert">
                  <h3>解析尝试失败</h3>
                  <p>对象：Parsed View {parsedView.id}</p>
                  <p>
                    位置：{parsedView.errors?.[0]?.location?.kind ?? "原始资产"}
                  </p>
                  <p>
                    原因：{parsedView.errors?.[0]?.reason ?? "记录边界不可信"}
                  </p>
                  <p>
                    重试方式：修正编码、dialect 或 record path 后新建解析尝试。
                  </p>
                  <p>实际阻断阶段：Parsed View</p>
                </section>
              )}
              <StateView
                loading={busy && !records.length}
                error={parsedView?.status === "parse_failed" ? "" : error}
                data={records}
                empty={(items) => !items.length}
              >
                {(items) => (
                  <table className="responsive-table">
                    <thead>
                      <tr>
                        <th>行</th>
                        <th>源记录</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((record) => (
                        <tr key={record.ordinal}>
                          <td data-label="行">
                            <button
                              type="button"
                              className="location-link"
                              onClick={() => locateSourceRecord(record.ordinal)}
                              aria-label={`查看第 ${record.ordinal} 条记录的原始位置`}
                            >
                              {locatorLabel(record.locator)}
                            </button>
                          </td>
                          <td data-label="源记录">
                            <pre className="source-value">
                              {JSON.stringify(record.value, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </StateView>
            </Card>
          )}
          {showTestSetDetail && testSetSummary && (
            <Card className="card wide" aria-label="测试集概览">
              <span className="step">TEST SET / OVERVIEW</span>
              <h3>{testSetSummary.name}</h3>
              <a
                className="back-link"
                href="/test-sets"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/test-sets");
                }}
              >
                ← 返回测试集
              </a>
              <dl className="overview-list">
                <dt>用途</dt>
                <dd>{testSetSummary.purpose || "未登记"}</dd>
                <dt>Owner</dt>
                <dd>
                  {testSetSummary.owner || "未登记"} · {testSetSummary.ownerId}
                </dd>
                <dt>可用性</dt>
                <dd>
                  {testSetSummary.availability === "unavailable_by_deletion"
                    ? "删除不可用（仅保留审计与墓碑）"
                    : testSetSummary.availability}
                </dd>
                <dt>默认版本</dt>
                <dd>
                  {testSetSummary.defaultVersion
                    ? `v${testSetSummary.defaultVersion.number} · ${testSetSummary.defaultVersion.status}`
                    : "未设置"}
                </dd>
                <dt>最新版本</dt>
                <dd>
                  {testSetSummary.latestVersion
                    ? `v${testSetSummary.latestVersion.number} · ${testSetSummary.latestVersion.status} · ${testSetSummary.latestVersion.publishedBy ?? "未登记"}`
                    : "尚未发布"}
                </dd>
              </dl>
              {testSetSummary.availability === "unavailable_by_deletion" && (
                <p className="state-view" role="status">
                  此测试集因受控删除不可用；只能查看墓碑和审计事实，不能创建草稿、导出或评测。
                </p>
              )}
              {!versionHistoryPagination.total &&
                testSetSummary.availability !== "unavailable_by_deletion" && (
                  <div className="state-view" role="status">
                    <p>尚未发布任何版本。</p>
                    <p>
                      请先从数据资产入口上传允许的原始资产，再创建 Working
                      Draft；这里不会直接创建空版本。
                    </p>
                    <Button onClick={() => navigate("/assets")}>
                      前往数据资产
                    </Button>
                  </div>
                )}
            </Card>
          )}
          {showVersionEvidence && version?.evidence && (
            <Card id="delivery-records" className="card wide success">
              <span className="step">VERSION EVIDENCE</span>
              <h3>
                v{version.number}
                {version.number === 1 ? " · 默认版本" : ""}
              </h3>
              {showTestSetDetail && (
                <a
                  className="back-link"
                  href="/test-sets"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate("/test-sets");
                  }}
                >
                  ← 返回测试集
                </a>
              )}
              <p className="mono">Manifest {version.manifestHash}</p>
              <p>
                {version.itemCount} 条 · record_level{" "}
                {version.lineageLevels?.recordLevel ?? version.itemCount} ·
                asset_level {version.lineageLevels?.assetLevel ?? 0}
              </p>
              {version.lineagePagination && (
                <p className="scope" role="note">
                  当前仅展示前 {versionLineage.length} 条血缘（共{" "}
                  {version.lineagePagination.total} 条）；可用下方结构化 case_id
                  或元数据查询定位其他用例。
                </p>
              )}
              {version.parentVersionId && (
                <p>派生版本已发布；默认版本不会自动切换。</p>
              )}
              <div className="evidence-grid">
                <div>
                  <strong>来源说明</strong>
                  <p>
                    {version.evidence.attribution.sourceName} ·{" "}
                    {version.evidence.attribution.sensitivity}
                  </p>
                </div>
                <div>
                  <strong>策展方案</strong>
                  <p>
                    {version.evidence.recipe.filter.field} ={" "}
                    {version.evidence.recipe.filter.value}
                  </p>
                </div>
                <div>
                  <strong>正式 Schema</strong>
                  <p>{version.evidence.schema.mode}</p>
                </div>
                <div>
                  <strong>校验报告</strong>
                  <p>
                    {version.evidence.validationReport.valid ? "通过" : "失败"}
                  </p>
                </div>
              </div>
              {versionLineage[0]?.locator && (
                <p>
                  原始位置：第 {versionLineage[0].locator.physicalLine} 行 ·{" "}
                  <a href={versionLineage[0].rawAssetDownloadUrl}>
                    下载原始资产
                  </a>
                </p>
              )}
              {!!versionLineage.length && (
                <section aria-label="用例修订详情">
                  <h4>用例 / 修订详情</h4>
                  <label>
                    选择用例
                    <select
                      aria-label="查看用例修订"
                      value={selectedCaseDetailId}
                      onChange={(event) => {
                        setSelectedCaseDetailId(event.target.value);
                        setCaseDetail(undefined);
                      }}
                    >
                      {versionLineage.map((item: any) => (
                        <option key={item.caseId} value={item.caseId}>
                          {item.caseId} · {item.level}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button onClick={loadCaseDetail} disabled={busy}>
                    查看用例修订
                  </Button>
                  {caseDetail && (
                    <div aria-label="用例修订内容">
                      <p>
                        case_id：{caseDetail.caseId} · revision：
                        {caseDetail.revisionId} · origin：
                        {caseDetail.originKind}
                      </p>
                      {caseDetail.reason && <p>原因：{caseDetail.reason}</p>}
                      {caseDetail.origin?.level && (
                        <p>
                          血缘粒度：
                          <strong>{caseDetail.origin.level}</strong>
                          {caseDetail.origin.transformation_run?.id
                            ? ` · ${caseDetail.origin.transformation_run.id}`
                            : ""}
                        </p>
                      )}
                      <pre className="source-value">
                        {JSON.stringify(
                          {
                            input: caseDetail.input,
                            expected_output: caseDetail.expected_output,
                            metadata: caseDetail.metadata,
                            parentCaseRevisionId:
                              caseDetail.parentCaseRevisionId,
                            origin: caseDetail.origin,
                          },
                          null,
                          2,
                        )}
                      </pre>
                      {caseDetail.sourceRecord && (
                        <p>
                          原始位置：
                          {locatorLabel(caseDetail.sourceRecord.locator)} ·{" "}
                          <a href={caseDetail.sourceRecord.rawAssetDownloadUrl}>
                            下载原始资产
                          </a>
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}
              <section aria-label="三跳血缘追踪">
                <h4>三跳血缘追踪</h4>
                <label>
                  Case Revision ID
                  <Input
                    aria-label="追踪 Case Revision ID"
                    value={lineageTraceSubjectId}
                    onChange={(event) =>
                      setLineageTraceSubjectId(event.target.value)
                    }
                  />
                </label>
                <Button onClick={traceLineageSubject} disabled={busy}>
                  向上追踪血缘
                </Button>
                {lineageTrace && (
                  <div aria-label="血缘图">
                    <p>最多 {lineageTrace.maxHops} 跳</p>
                    <ul>
                      {lineageTrace.nodes.map((node: any) => (
                        <li key={`${node.type}:${node.id}`}>
                          {node.type} · {node.id}
                          {node.lineageLevel ? ` · ${node.lineageLevel}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
              {versionHistoryPagination.total > 0 && (
                <section aria-label="版本历史与生命周期">
                  <h4>版本历史</h4>
                  {versionHistory.length ? (
                    <ul>
                      {versionHistory.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="location-link"
                            onClick={() => selectVersion(item)}
                          >
                            v{item.number}
                          </button>{" "}
                          · {item.status}
                          {item.isDefault ? " · 默认" : ""} · {item.itemCount}{" "}
                          条
                          {item.archivedAt
                            ? ` · 归档于 ${item.archivedAt}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="state-view">当前版本历史页暂无内容。</p>
                  )}
                  <div className="pager" aria-label="版本历史分页">
                    <Button
                      aria-label="版本历史上一页"
                      disabled={versionHistoryPagination.offset === 0}
                      onClick={() =>
                        setVersionHistoryPage(
                          Math.max(
                            0,
                            versionHistoryPagination.offset -
                              versionHistoryPagination.limit,
                          ),
                        )
                      }
                    >
                      上一页
                    </Button>
                    <span>
                      {versionHistoryPagination.offset + 1}-
                      {Math.min(
                        versionHistoryPagination.offset +
                          versionHistoryPagination.limit,
                        versionHistoryPagination.total,
                      )}{" "}
                      / {versionHistoryPagination.total}
                    </span>
                    <Button
                      aria-label="版本历史下一页"
                      disabled={
                        versionHistoryPagination.offset +
                          versionHistoryPagination.limit >=
                        versionHistoryPagination.total
                      }
                      onClick={() =>
                        setVersionHistoryPage(
                          versionHistoryPagination.offset +
                            versionHistoryPagination.limit,
                        )
                      }
                    >
                      下一页
                    </Button>
                  </div>
                  <label>
                    生命周期原因（默认切换必填）
                    <Input
                      value={lifecycleReason}
                      onChange={(event) => {
                        setLifecycleReason(event.target.value);
                        setLifecycleCorrelationId(newLifecycleCorrelationId());
                      }}
                    />
                  </label>
                  {(() => {
                    const selected = versionHistory.find(
                      (item) => item.id === version.id,
                    );
                    return selected ? (
                      <div className="draft-controls">
                        <Button
                          onClick={() => makeVersionDefault(selected)}
                          disabled={
                            busy ||
                            selected.isDefault ||
                            selected.status !== "published" ||
                            !lifecycleReason.trim() ||
                            !canWrite
                          }
                        >
                          设为默认
                        </Button>
                        <Button
                          onClick={() => archiveSelectedVersion(selected)}
                          disabled={
                            busy ||
                            selected.isDefault ||
                            selected.status === "archived" ||
                            !canWrite
                          }
                        >
                          归档此版本
                        </Button>
                      </div>
                    ) : null;
                  })()}
                  {versionHistory.length > 1 && (
                    <div className="draft-controls">
                      <label>
                        基准版本
                        <select
                          value={compareBaseVersionId}
                          onChange={(event) =>
                            setCompareBaseVersionId(event.target.value)
                          }
                        >
                          {versionHistory.map((item) => (
                            <option key={item.id} value={item.id}>
                              v{item.number}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        目标版本
                        <select
                          value={compareTargetVersionId}
                          onChange={(event) =>
                            setCompareTargetVersionId(event.target.value)
                          }
                        >
                          {versionHistory.map((item) => (
                            <option key={item.id} value={item.id}>
                              v{item.number}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        onClick={compareSelectedVersions}
                        disabled={
                          busy ||
                          !compareBaseVersionId ||
                          !compareTargetVersionId ||
                          compareBaseVersionId === compareTargetVersionId
                        }
                      >
                        比较版本
                      </Button>
                    </div>
                  )}
                  {comparison && (
                    <div aria-label="版本比较结果">
                      <p>
                        v{comparison.baseVersion.number} → v
                        {comparison.targetVersion.number}：+
                        {comparison.counts.added} / -{comparison.counts.removed}{" "}
                        / ~{comparison.counts.modified} / =
                        {comparison.counts.unchanged}
                      </p>
                      <p>
                        变化：sources={String(comparison.changes.sources)}；
                        recipe={String(comparison.changes.recipe)}；
                        formalSchema={String(comparison.changes.formalSchema)}
                      </p>
                      {comparison.pagination && (
                        <p className="scope" role="note">
                          差异列表仅展示 {comparison.items.length} 条，共{" "}
                          {comparison.pagination.total}{" "}
                          条；计数仍基于完整比较结果。
                        </p>
                      )}
                      {comparison.changes.formalSchema && (
                        <pre className="source-value">
                          {JSON.stringify(comparison.formalSchema, null, 2)}
                        </pre>
                      )}
                      {comparison.changes.recipe && (
                        <pre aria-label="Recipe 变化" className="source-value">
                          {JSON.stringify(comparison.recipe, null, 2)}
                        </pre>
                      )}
                      {comparison.changes.sources && (
                        <pre aria-label="Source 变化" className="source-value">
                          {JSON.stringify(comparison.sources, null, 2)}
                        </pre>
                      )}
                      {comparison.items.map((item: any) => (
                        <div key={`${item.status}-${item.caseId}`}>
                          <p>
                            {item.status} · {item.caseId}
                            {item.reason ? ` · ${item.reason}` : ""}
                          </p>
                          {item.before && (
                            <pre className="source-value">
                              {JSON.stringify(item.before, null, 2)}
                            </pre>
                          )}
                          {item.after && (
                            <pre className="source-value">
                              {JSON.stringify(item.after, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {version?.status === "published" && (
                <Button
                  onClick={deriveFromVersion}
                  disabled={busy || !canWrite}
                >
                  从 v{version.number} 创建 v{version.number + 1} 草稿
                </Button>
              )}
              {parentCaseOperations()}
              <section aria-label="交付包与 Langfuse 人工导入">
                <h4>交付包与验证级别</h4>
                <p>
                  Standard Package 不包含原始资产字节，仅验证冻结证据及引用；
                  Full Provenance Package
                  额外验证版本实际引用的原始字节、locator 和 Source Record
                  hash。
                </p>
                <div className="draft-controls">
                  <Button
                    onClick={() => generatePackageDelivery("standard")}
                    disabled={busy}
                  >
                    生成 Standard Package
                  </Button>
                  <Button
                    onClick={() => generatePackageDelivery("full_provenance")}
                    disabled={busy}
                  >
                    生成 Full Provenance Package
                  </Button>
                  <a
                    className="button"
                    href={`/api/projects/${projectId}/versions/${version.id}/package`}
                  >
                    下载 Standard Version Package
                  </a>
                  {fullDelivery && (
                    <a
                      className="button"
                      href={`/api/projects/${projectId}/deliveries/${fullDelivery.deliveryId}/download`}
                    >
                      下载 Full Provenance Package
                    </a>
                  )}
                </div>
                {fullDelivery && (
                  <p>
                    Full Provenance：verification level=
                    {fullDelivery.verificationLevel} · format=
                    {fullDelivery.formatVersion} · delivery=
                    {fullDelivery.deliveryId}
                  </p>
                )}
                {!!deliveryResults.length && (
                  <ul aria-label="版本交付验证证据">
                    {deliveryResults.map((delivery: any) => (
                      <li key={delivery.deliveryId ?? delivery.id}>
                        {delivery.packageType} · {delivery.status}
                        {delivery.localValidation
                          ? ` · 本地 CSV 校验：${delivery.localValidation.valid ? "通过" : "失败"}`
                          : ""}
                        {delivery.offlineValidation?.valid
                          ? " · 离线包校验：生成时已通过"
                          : delivery.offlineValidation?.status ===
                              "recipient_required"
                            ? " · 离线包校验：下载后由接收方运行"
                            : ""}
                        {delivery.packageType === "langfuse_csv"
                          ? " · 人工导入仅是本地用户声明，未经远端验证"
                          : ""}
                      </li>
                    ))}
                  </ul>
                )}

                <h4>Langfuse CSV（人工导入适配物）</h4>
                <p>
                  三列映射：input → input，expected_output → expected output，
                  metadata → metadata。CSV 不参与正式版本哈希。
                </p>
                <Button
                  onClick={generateLangfuseDelivery}
                  disabled={busy || !canWrite}
                >
                  生成 Langfuse CSV
                </Button>
                {csvDelivery && (
                  <>
                    {canWrite && (
                      <a
                        className="button"
                        href={`/api/projects/${projectId}/deliveries/${csvDelivery.deliveryId}/download`}
                      >
                        下载 Langfuse CSV
                      </a>
                    )}
                    <p>
                      状态：{csvDelivery.status} · remoteVerified=false ·
                      本地校验行数：
                      {csvDelivery.localValidation?.rowCount}
                    </p>
                  </>
                )}
                <ul aria-label="Langfuse 人工导入边界">
                  <li>未获取或验证远端 Langfuse Schema。</li>
                  <li>未设置稳定远端 item ID。</li>
                  <li>重复人工上传不幂等。</li>
                </ul>
                {canWrite && langfusePreview && (
                  <pre aria-label="Langfuse CSV 预览" className="source-value">
                    {langfusePreview}
                  </pre>
                )}
                <p>额外或未映射列：无；CSV 只导出固定三列。</p>
                {csvDelivery && (
                  <Button
                    onClick={() => attestLangfuseImport(csvDelivery.deliveryId)}
                    disabled={
                      busy ||
                      csvDelivery.status === "user_confirmed_imported" ||
                      !canWrite
                    }
                  >
                    确认已人工导入（仅用户声明）
                  </Button>
                )}
              </section>
            </Card>
          )}
          {showVersionEvidence && version && !version.evidence && (
            <Card className="card wide" role="status">
              <span className="step">VERSION EVIDENCE / DEGRADED</span>
              <h3>版本证据不可用</h3>
              <p>
                当前版本处于 {version.status ?? "degraded_by_deletion"} 状态；
                系统不会展示已删除的原始载荷或完整版本哈希。
              </p>
              {!!version.tombstones?.length && (
                <ul aria-label="版本删除墓碑">
                  {version.tombstones.map((tombstone: any) => (
                    <li
                      key={`${tombstone.objectType}:${tombstone.opaqueObjectId}`}
                    >
                      {tombstone.objectType} / {tombstone.opaqueObjectId} ·{" "}
                      {tombstone.resultStatus}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {showDeliveries && (
            <DeliveryRecordsList
              key={route.page + ":" + JSON.stringify(route.query)}
              projectId={projectId}
              csrf={csrf}
              canWrite={canWrite}
              onNavigate={navigate}
            />
          )}
        </div>
      )}
      <div className="status" role="status">
        {status}
      </div>
      {!!error && (
        <div role="alert" aria-label="操作错误">
          <p>{error}</p>
          {error === "integrity_blocked" && (
            <p>
              对象完整性检查已阻断此发布/下载；请先审查一致性告警。系统不会自动重写已发布哈希。
            </p>
          )}
          {error === "http_503" && (
            <p>
              PostgreSQL 或 MinIO
              暂不可用；这是依赖健康失败，不会被记录为数据业务失败。
            </p>
          )}
          {error === "dependency_unavailable" && (
            <p>
              PostgreSQL 或 MinIO 暂不可用；请稍后重试，这不会改变数据业务状态。
            </p>
          )}
        </div>
      )}
    </AppShell>
  );
}
