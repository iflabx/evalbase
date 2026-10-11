import { useState, useRef, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/state-view";
import { ProcessingSourcePicker } from "@/components/processing-source-picker";
import { ProcessingFilters } from "@/components/processing-filters";
import { ProcessingReview, issueLabels, type ReviewRow } from "@/components/processing-review";
import type { SelectionCondition } from "@/services/selection";
import { MetadataSummary } from "@/components/material-record-table";
import { request, canRetainReadResult, type MetadataEntry } from "@/services/workspace";
import { useProjectAccess } from "@/hooks/use-project-access";
import { Pagination } from "@/routes/index";

export const Route = createFileRoute("/projects/$projectId/processing")({
  validateSearch: (
    value: Record<string, unknown>,
  ): {
    source?: "assets" | "draft" | "version" | undefined;
    sourceId?: string | undefined;
    run?: string | undefined;
    parent?: string | undefined;
    mode?: "continue" | "rerun" | undefined;
  } => ({
    source:
      typeof value["source"] === "string" &&
      ["assets", "draft", "version"].includes(value["source"])
        ? (value["source"] as "assets" | "draft" | "version")
        : undefined,
    sourceId: typeof value["sourceId"] === "string" ? value["sourceId"] : undefined,
    run: typeof value["run"] === "string" ? value["run"] : undefined,
    parent: typeof value["parent"] === "string" ? value["parent"] : undefined,
    mode: value["mode"] === "continue" || value["mode"] === "rerun" ? value["mode"] : undefined,
  }),
  component: ProcessingPage,
});
type RecordValue = { question: string; expectedOutput: string; metadata: MetadataEntry[] };
type InputRecord = RecordValue & { id: string; raw?: unknown };
type SourceSummary = {
  name: string;
  kindLabel: string;
  href?: string;
  files: { name: string; href: string }[];
};
type Receipt = {
  assetId: string;
  draftId: string | null;
  adopted: number;
  collectionId?: string;
  fileName?: string;
};
type Run = {
  parentRunId?: string;
  continuationKind?: "continue" | "rerun";
  sourceSummary?: SourceSummary;
  actorName?: string;
  id: string;
  source: { kind: string; id?: string };
  options: {
    operation: "clean" | "rewrite" | "augment";
    instructions: string;
    allowedFields?: string[];
    outputCount?: number;
  };
  status: string;
  partial?: boolean;
  executionComplete?: boolean;
  hasSavedResult?: boolean;
  outputCount?: number;
  missingCount?: number;
  progress: number;
  inputCount: number;
  createdAt: string;
  errorCode: string | null;
  result?: { partial?: boolean };
};
type ResultPage = {
  run: Run;
  records: ReviewRow[];
  rootOperation?: string;
  adoptionFields?: string[];
  adoptedIds?: string[];
  stats?: { all: number; changed: number; needsReview: number };
  receipts?: Receipt[];
  total: number;
  offset?: number;
  allIds: string[];
  issues: { code: string; count?: number }[];
};
const labels = { clean: "清洗", rewrite: "改写", augment: "扩充" };
const statuses: Record<string, string> = {
  queued: "等待中",
  running: "处理中",
  retry_wait: "等待重试",
  succeeded: "已完成",
  failed: "失败",
  cancel_requested: "正在取消",
  cancelled: "已取消",
};
function ProcessingStatus({ run }: { run: Run }) {
  const partial = run.status === "succeeded" && run.executionComplete === false;
  return (
    <Badge
      variant="outline"
      className={
        partial
          ? "border-chart-5/30 bg-chart-5/10 text-chart-5"
          : run.status === "succeeded"
            ? "border-chart-2/30 bg-chart-2/10 text-chart-2"
            : run.status === "failed"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : run.status === "running"
                ? "border-primary/30 bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
      }
    >
      {partial ? "部分完成，需核对执行" : statuses[run.status]}
    </Badge>
  );
}
const errors: Record<string, string> = {
  model_connection_unavailable: "请先由管理员在设置中启用模型连接。",
  processing_source_unavailable: "来源已回收或不可用，恢复来源后可继续。",
  processing_scope_changed: "选中的记录已变化，请重新选择。",
  processing_mapping_required: "请先整理字段，或填写需要模型完成的清洗要求。",
  processing_capacity_exceeded: "所选数据超过处理上限，请缩小范围。",
  draft_revision_conflict: "草稿已变化，请重新核对后采用。",
  draft_field_conflict: "有人修改了同一字段，未覆盖其输入。请重新创建处理任务。",
  processing_still_running: "请等任务完成或取消后再采用结果。",
  test_set_capacity_exceeded: "目标草稿超过 5 个来源文件、10,000 条记录或 100 MB 的上限。",
  processing_not_found: "当前任务不可访问，或来源已被删除。",
  processing_record_too_large: "单条输入超过模型处理大小限制，请缩小记录内容。",
  processing_already_adopted: "所选结果已有保存记录，请移除已保存选择，或从保存后的数据继续处理。",
  processing_input_corrupt: "历史输入快照不可用，无法重新运行。请返回来源重新选择。",
  draft_not_editing: "原草稿已发布，不能继续写入。处理结果和选择已保留。",
  draft_paused: "原草稿已暂停，请恢复父对象后再保存。",
  draft_not_found: "目标草稿已发布、删除或不可用，未改动其他草稿。处理结果和选择已保留。",
  draft_record_removed: "原记录已被移除，未覆盖草稿。处理结果和选择已保留。",
};
const errorText = (error: unknown) =>
  errors[error instanceof Error ? error.message : ""] ?? "操作失败，输入已保留，请重试。";
function post<T>(path: string, body: unknown, key?: string) {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
}
function ProcessingPage() {
  const { projectId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate();
  const access = useProjectAccess(projectId),
    queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("all");
  const [historyPage, setHistoryPage] = useState(1);
  const actorId = queryClient.getQueryData<{ actor: { id: string } }>(["session"])?.actor.id ?? "";
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-runs`;
  const runs = useQuery({
    queryKey: ["processing-runs", projectId],
    queryFn: () => request<{ runs: Run[] }>(path),
    enabled:
      access.canWrite && !search.run && !search.parent && !(search.source && search.sourceId),
    refetchInterval: 5000,
  });
  const history = (runs.data?.runs ?? []).filter(
    (run) =>
      (historyStatus === "all" || run.status === historyStatus) &&
      [run.sourceSummary?.name, run.sourceSummary?.kindLabel, run.options.instructions].some(
        (value) => value?.toLowerCase().includes(historySearch.trim().toLowerCase()),
      ),
  );
  const runId = search.run;
  const source =
    search.parent && search.mode
      ? {
          kind: search.mode === "continue" ? "results" : "rerun",
          id: search.parent,
          ...(search.mode === "continue"
            ? {
                resultIds:
                  queryClient.getQueryData<string[]>([
                    "processing-followup-selection",
                    actorId,
                    projectId,
                    search.parent,
                  ]) ?? [],
              }
            : {}),
        }
      : search.source && search.sourceId
        ? {
            kind: search.source,
            ...(search.source === "assets"
              ? { assetIds: [search.sourceId] }
              : { id: search.sourceId }),
          }
        : null;
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {!(source && !runId) && (
        <PageHeader
          title="数据处理"
          description="选择记录、提交处理，核对结果后再采用。原件和正式版本保持不变。"
          actions={
            <>
              {access.canWrite && !source && !runId && (
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  新建处理
                </Button>
              )}
              {(source || runId) && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void navigate({
                      search: { source: undefined, sourceId: undefined, run: undefined },
                    })
                  }
                >
                  返回处理任务
                </Button>
              )}
            </>
          }
        />
      )}
      {creating && access.canWrite && (
        <ProcessingSourcePicker
          projectId={projectId}
          onClose={() => setCreating(false)}
          onChoose={(kind, id) => {
            setCreating(false);
            void navigate({ search: { source: kind, sourceId: id, run: undefined } });
          }}
        />
      )}
      {access.isPending ? (
        <p>正在读取权限…</p>
      ) : !access.canWrite ? (
        <p role="alert">编辑权限才能运行处理和查看未发布结果。</p>
      ) : (
        <>
          {source && !runId && (
            <ProcessingForm
              key={`${projectId}:${JSON.stringify(source)}`}
              projectId={projectId}
              source={source}
              actorId={actorId}
              onCreated={async (id) => {
                await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
                await navigate({
                  search: {
                    source: undefined,
                    sourceId: undefined,
                    parent: undefined,
                    mode: undefined,
                    run: id,
                  },
                });
              }}
            />
          )}
          {runId && (
            <ProcessingResults
              key={`${projectId}:${runId}`}
              projectId={projectId}
              runId={runId}
              onFollowup={(mode, ids) => {
                queryClient.setQueryData(
                  ["processing-followup-selection", actorId, projectId, runId],
                  ids,
                );
                void navigate({
                  search: {
                    source: undefined,
                    sourceId: undefined,
                    run: undefined,
                    parent: runId,
                    mode,
                  },
                });
              }}
              onBack={() => {
                void navigate({
                  search: { source: undefined, sourceId: undefined, run: undefined },
                });
              }}
            />
          )}
          {!source && !runId && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    aria-label="搜索处理任务"
                    placeholder="搜索来源或处理要求"
                    className="pl-8"
                    value={historySearch}
                    maxLength={200}
                    onChange={(event) => {
                      setHistorySearch(event.target.value);
                      setHistoryPage(1);
                    }}
                  />
                </div>
                <Select
                  value={historyStatus}
                  onValueChange={(value) => {
                    setHistoryStatus(value);
                    setHistoryPage(1);
                  }}
                >
                  <SelectTrigger aria-label="任务执行状态" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部执行状态</SelectItem>
                    {Object.entries(statuses).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(historySearch || historyStatus !== "all") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setHistorySearch("");
                      setHistoryStatus("all");
                      setHistoryPage(1);
                    }}
                  >
                    清除条件
                  </Button>
                )}
              </div>
              <Card className="min-w-0 overflow-hidden">
                <CardContent className="p-0">
                  {runs.isPending ? (
                    <p className="p-5 text-sm text-muted-foreground">正在读取处理任务…</p>
                  ) : runs.error ? (
                    <div className="p-5" role="alert">
                      <p>{errorText(runs.error)}</p>
                      <Button variant="outline" onClick={() => void runs.refetch()}>
                        重试
                      </Button>
                    </div>
                  ) : !history.length ? (
                    <p className="p-5 text-sm text-muted-foreground">
                      {historySearch || historyStatus !== "all"
                        ? "没有匹配结果，请清除搜索或筛选。"
                        : "暂无处理任务。点击“新建处理”开始。"}
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2 font-medium">任务</th>
                            <th className="px-4 py-2 font-medium">输入记录</th>
                            <th className="px-4 py-2 font-medium">状态</th>
                            <th className="px-4 py-2 font-medium">发起人 / 时间</th>
                            <th className="px-4 py-2 text-right font-medium">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.slice((historyPage - 1) * 20, historyPage * 20).map((run) => (
                            <tr key={run.id} className="border-t">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2 font-medium">
                                  <FileText className="size-4 shrink-0 text-primary" />
                                  {run.sourceSummary?.name ?? "来源未记录"} ·{" "}
                                  {labels[run.options.operation]}
                                </div>
                                <p
                                  className="mt-0.5 max-w-sm truncate pl-6 text-xs text-muted-foreground"
                                  title={run.options.instructions}
                                >
                                  {run.sourceSummary?.kindLabel ?? "来源类型未记录"} ·{" "}
                                  {run.options.instructions || "未记录处理要求"}
                                </p>
                                {run.parentRunId && (
                                  <p className="mt-1 pl-6 text-xs text-muted-foreground">
                                    {run.continuationKind === "rerun" ? "重新运行自" : "继续处理自"}{" "}
                                    <Link
                                      className="text-primary hover:underline"
                                      to="/projects/$projectId/processing"
                                      params={{ projectId }}
                                      search={{ run: run.parentRunId }}
                                    >
                                      上一轮任务
                                    </Link>
                                  </p>
                                )}
                              </td>
                              <td className="px-4 py-3">{run.inputCount} 条</td>
                              <td className="px-4 py-3">
                                <ProcessingStatus run={run} />
                                {run.status === "running" ? ` ${run.progress}%` : ""}
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {run.hasSavedResult ? "有保存记录" : "暂无保存记录"}
                                </p>
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                <p>{run.actorName ?? "未记录"}</p>
                                {new Date(run.createdAt).toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    void navigate({
                                      search: {
                                        run: run.id,
                                        source: undefined,
                                        sourceId: undefined,
                                      },
                                    });
                                  }}
                                >
                                  查看
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Pagination
                current={historyPage}
                total={history.length}
                pages={Math.max(1, Math.ceil(history.length / 20))}
                unit="项匹配任务（最近 100 项范围）"
                onChange={setHistoryPage}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
function ProcessingForm({
  projectId,
  source,
  actorId,
  onCreated,
}: {
  actorId: string;
  projectId: string;
  source: Record<string, unknown>;
  onCreated: (id: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const cacheKey = ["processing-config", actorId, projectId, JSON.stringify(source)];
  const followup = source["kind"] === "results" || source["kind"] === "rerun";
  const rerun = source["kind"] === "rerun";
  queryClient.setQueryDefaults(["processing-config"], { gcTime: Infinity });
  queryClient.setQueryDefaults(["processing-followup-selection"], { gcTime: Infinity });
  const saved = useRef(
    queryClient.getQueryData<{
      page: number;
      selected: string[];
      operation: "clean" | "rewrite" | "augment";
      search: string;
      conditions: SelectionCondition[];
      selectedOnly: boolean;
      instructions: string;
      allowedFields: string[];
      count: string;
      sourceRevision?: string;
      operationKey: string;
      pendingSubmission?: { key: string; body: unknown };
    }>(cacheKey),
  ).current;
  const sourceRevision = useRef(saved?.sourceRevision);
  const submittedConfig = useRef(false);
  const initialized = useRef(Boolean(saved));
  const pendingSubmission = useRef(saved?.pendingSubmission);
  const [unknownSubmit, setUnknownSubmit] = useState(Boolean(saved?.pendingSubmission));
  const [scopeChanged, setScopeChanged] = useState(false);
  const [page, setPage] = useState(saved?.page ?? 1),
    [selected, setSelected] = useState<Set<string>>(new Set(saved?.selected)),
    [operation, setOperation] = useState<"clean" | "rewrite" | "augment">(
      saved?.operation ?? "clean",
    );
  const [search, setSearch] = useState(saved?.search ?? ""),
    [conditions, setConditions] = useState<SelectionCondition[]>(saved?.conditions ?? []),
    [selectedOnly, setSelectedOnly] = useState(saved?.selectedOnly ?? false);
  const [instructions, setInstructions] = useState(saved?.instructions ?? ""),
    [allowedFields, setAllowedFields] = useState(saved?.allowedFields ?? ["question"]),
    [count, setCount] = useState(saved?.count ?? "20"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [operationKey, setOperationKey] = useState(saved?.operationKey ?? crypto.randomUUID());
  const input = useQuery({
    queryKey: [
      "processing-inputs",
      actorId,
      projectId,
      source,
      page,
      search,
      conditions,
      selectedOnly,
      selectedOnly ? [...selected] : null,
    ],
    queryFn: () =>
      post<{
        records: InputRecord[];
        allIds: string[];
        total: number;
        sourceTotal?: number;
        matchedTotal?: number;
        sourceSummary?: SourceSummary;
        sourceRevision?: string;
        metadataKeys?: string[];
        parent?: { id: string; options: Run["options"]; createdAt: string };
      }>(`/api/projects/${encodeURIComponent(projectId)}/processing-inputs`, {
        source,
        offset: (page - 1) * 20,
        limit: 20,
        search,
        conditions,
        selectedOnly,
        ...(selectedOnly ? { selectedIds: [...selected] } : {}),
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  useEffect(() => {
    if (!followup || !input.data || initialized.current) return;
    initialized.current = true;
    setSelected(new Set(input.data.allIds));
    if (rerun && input.data.parent) {
      const options = input.data.parent.options;
      setOperation(options.operation);
      setInstructions(options.instructions);
      setAllowedFields(options.allowedFields ?? ["question"]);
      setCount(String(options.outputCount ?? 20));
    }
  }, [followup, rerun, input.data]);
  useEffect(() => {
    if (!canRetainReadResult(input.error))
      queryClient.removeQueries({
        queryKey: ["processing-inputs", actorId, projectId, source],
        type: "inactive",
      });
  }, [actorId, projectId, source, queryClient, input.error]);
  useEffect(() => {
    const revision = input.data?.sourceRevision;
    if (revision && sourceRevision.current && sourceRevision.current !== revision) {
      setScopeChanged(true);
    } else if (revision) sourceRevision.current = revision;
  }, [input.data?.sourceRevision]);
  useEffect(() => {
    if (submittedConfig.current) return;
    queryClient.setQueryData(cacheKey, {
      page,
      selected: [...selected],
      operation,
      search,
      conditions,
      selectedOnly,
      instructions,
      allowedFields,
      count,
      sourceRevision: sourceRevision.current,
      operationKey,
      pendingSubmission: pendingSubmission.current,
    });
  });
  function change() {
    if (unknownSubmit) return;
    setOperationKey(crypto.randomUUID());
    setError("");
  }
  const invalidCount =
    operation === "augment" &&
    (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || Number(count) > 10000);
  const reason = !selected.size
    ? "请先勾选输入记录。"
    : !allowedFields.length
      ? "请至少选择一个允许修改的字段。"
      : invalidCount
        ? "新增数量须为 1–10,000 的整数。"
        : operation !== "clean" && !instructions.trim()
          ? `请填写${labels[operation]}要求。`
          : "";
  async function submit() {
    if (
      busy ||
      (!pendingSubmission.current && (reason || input.isError || input.isFetching || scopeChanged))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const body = followup
        ? {
            mode: rerun ? "rerun" : "continue",
            ...(rerun ? {} : { resultIds: [...selected].map((id) => id.slice(10)) }),
            options: {
              operation,
              instructions,
              allowedFields,
              ...(operation === "augment" ? { outputCount: Number(count) } : {}),
            },
          }
        : {
            source: { ...source, recordIds: [...selected] },
            options: {
              operation,
              instructions,
              allowedFields,
              ...(operation === "augment" ? { outputCount: Number(count) } : {}),
            },
          };
      pendingSubmission.current ??= { key: operationKey, body };
      queryClient.setQueryData(cacheKey, {
        ...queryClient.getQueryData<object>(cacheKey),
        pendingSubmission: pendingSubmission.current,
      });
      const result = await post<{ run: Run }>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs${followup ? `/${encodeURIComponent(String(source["id"]))}/followups` : ""}`,
        pendingSubmission.current.body,
        pendingSubmission.current.key,
      );
      submittedConfig.current = true;
      queryClient.removeQueries({ queryKey: cacheKey, exact: true });
      await onCreated(result.run.id);
    } catch (e) {
      setError(errorText(e));
      const code = e instanceof Error ? e.message : "";
      if (
        code.startsWith("processing_") ||
        code.startsWith("model_connection_") ||
        ["idempotency_conflict", "validation_error", "csrf_rejected"].includes(code)
      )
        pendingSubmission.current = undefined;
      else {
        setUnknownSubmit(true);
        setError("");
      }
      if (!pendingSubmission.current) setUnknownSubmit(false);
    } finally {
      setBusy(false);
    }
  }
  const description = {
    clean: "不填要求时整理首尾空白并提示空值、重复，不会删除重复记录；填写语义要求时调用模型。",
    rewrite: "保留原意，按要求修改表达。未勾选的字段保持原值。",
    augment: "参考选中数据生成新记录，不覆盖原始输入。",
  }[operation];
  const hidden = [...selected].filter((id) => !input.data?.allIds.includes(id)).length;
  const visibleInput = input.isError ? undefined : input.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title={`处理 ${visibleInput?.sourceSummary?.name ?? "数据"}`}
        description={`${visibleInput?.sourceSummary?.kindLabel ?? "来源读取中"} · 共 ${visibleInput?.sourceTotal ?? visibleInput?.total ?? 0} 条 · 已选 ${selected.size} 条${followup && visibleInput?.parent ? ` · ${labels[visibleInput.parent.options.operation]} · ${new Date(visibleInput.parent.createdAt).toLocaleString()}` : ""}`}
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link
                to="/projects/$projectId/processing"
                params={{ projectId }}
                search={
                  followup
                    ? { run: String(source["id"]) }
                    : { source: undefined, sourceId: undefined, run: undefined }
                }
              >
                {followup ? "返回上次结果" : "返回处理任务"}
              </Link>
            </Button>
            {visibleInput?.sourceSummary?.href && (
              <Button variant="outline" asChild>
                <a href={visibleInput.sourceSummary.href} target="_blank" rel="noopener noreferrer">
                  查看来源
                </a>
              </Button>
            )}
          </>
        }
      />
      {followup && (
        <p className="text-sm text-muted-foreground">
          {rerun
            ? "使用上次提交的完整输入重新处理；不会读取来源的最新内容。"
            : "来自上一次处理结果；本轮只处理所选输入，未选结果保留在上一轮。"}
        </p>
      )}
      {followup && visibleInput?.parent && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">查看上一轮处理要求</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">
            {visibleInput.parent.options.instructions || "未填写要求"}
          </p>
        </details>
      )}
      {unknownSubmit && (
        <div role="alert" className="rounded-lg border p-4 text-sm">
          提交结果尚未确认，请用同一次请求核对，避免重复创建。
          <Button className="ml-2" variant="outline" onClick={() => void submit()} disabled={busy}>
            核对提交结果
          </Button>
        </div>
      )}
      {(visibleInput?.sourceSummary?.files.length ?? 0) > 1 && (
        <details className="text-sm">
          <summary>查看来源文件</summary>
          {visibleInput!.sourceSummary!.files.map((file) => (
            <a
              key={file.href}
              className="block text-primary"
              href={file.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {file.name}
            </a>
          ))}
        </details>
      )}
      {scopeChanged && (
        <div role="alert" className="rounded-md border bg-muted/40 p-4 text-sm">
          来源修订已变化，处理要求已保留。请重新核对输入记录。
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            onClick={() => {
              setSelected(new Set());
              setSelectedOnly(false);
              setPage(1);
              change();
              sourceRevision.current = visibleInput?.sourceRevision;
              setScopeChanged(false);
            }}
          >
            重新选择记录
          </Button>
        </div>
      )}
      <Card className="sticky top-12 z-10 flex flex-wrap items-center gap-2 p-3 text-sm xl:hidden">
        <span>已选 {selected.size} 条</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            document
              .getElementById("processing-settings")
              ?.scrollIntoView({ block: "start", behavior: "instant" })
          }
        >
          设置处理
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || Boolean(reason) || input.isError || input.isFetching || scopeChanged}
          onClick={() => void submit()}
        >
          开始{labels[operation]}
        </Button>
      </Card>
      <fieldset disabled={busy || unknownSubmit} className="min-w-0">
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="border-b bg-muted/60 px-4 py-3">
              <h2 className="font-semibold">选择输入记录</h2>
            </CardHeader>
            <CardContent className="p-0">
              <div className="space-y-3 border-b p-4">
                <ProcessingFilters
                  search={search}
                  conditions={conditions}
                  metadataKeys={visibleInput?.metadataKeys ?? []}
                  disabled={rerun || busy}
                  onChange={(text, filters) => {
                    setSearch(text);
                    setConditions(filters);
                    setPage(1);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rerun || busy || !visibleInput || input.isFetching}
                    onClick={() => {
                      setSelected(
                        (old) => new Set([...old, ...visibleInput!.records.map((row) => row.id)]),
                      );
                      change();
                    }}
                  >
                    勾选本页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rerun || busy || !visibleInput || input.isFetching}
                    onClick={() => {
                      setSelected((old) => new Set([...old, ...visibleInput!.allIds]));
                      change();
                    }}
                  >
                    选择全部匹配记录（{visibleInput?.matchedTotal ?? visibleInput?.total ?? 0} 条）
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rerun || busy || !selected.size}
                    onClick={() => {
                      setSelected(new Set());
                      setPage(1);
                      change();
                    }}
                  >
                    清空选择
                  </Button>
                  <label className="ml-auto flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selectedOnly}
                      disabled={rerun || busy}
                      onCheckedChange={(value) => {
                        setSelectedOnly(value === true);
                        setPage(1);
                      }}
                    />
                    只看已选
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  匹配 {visibleInput?.matchedTotal ?? visibleInput?.total ?? 0} 条 / 已选{" "}
                  {selected.size} 条
                  {hidden > 0 && visibleInput ? `（${hidden} 条在当前筛选外）` : ""}
                  。提交使用完整已选集合。
                </p>
              </div>
              {input.error ? (
                <div className="space-y-2 p-5" role="alert">
                  <p>{errorText(input.error)} 已选记录与处理要求已保留。</p>
                  <Button variant="outline" onClick={() => void input.refetch()}>
                    重试读取来源
                  </Button>
                </div>
              ) : input.isPending ? (
                <p className="p-5 text-sm text-muted-foreground">正在读取记录…</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] table-fixed text-sm">
                    <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="w-12 px-4 py-2 font-medium">
                          <Checkbox
                            aria-label="选择本页记录"
                            disabled={
                              rerun ||
                              busy ||
                              input.isFetching ||
                              !visibleInput?.records.length ||
                              scopeChanged
                            }
                            checked={
                              Boolean(visibleInput?.records.length) &&
                              visibleInput!.records.every((row) => selected.has(row.id))
                            }
                            onCheckedChange={(checked) => {
                              setSelected((old) => {
                                const next = new Set(old);
                                for (const row of visibleInput?.records ?? []) {
                                  if (checked) next.add(row.id);
                                  else next.delete(row.id);
                                }
                                return next;
                              });
                              change();
                            }}
                          />
                        </th>
                        <th className="px-4 py-2 font-medium">问题 / 原始内容</th>
                        <th className="w-[22%] px-4 py-2 font-medium">期望输出</th>
                        <th className="w-[30%] px-4 py-2 font-medium">Metadata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleInput?.records.map((row) => (
                        <tr key={row.id} className="border-t align-top">
                          <td className="px-4 py-3">
                            <Checkbox
                              aria-label={`选择记录 ${row.id}`}
                              disabled={rerun || busy || input.isFetching || scopeChanged}
                              checked={selected.has(row.id)}
                              onCheckedChange={(checked) => {
                                setSelected((old) => {
                                  const next = new Set(old);
                                  if (checked) next.add(row.id);
                                  else next.delete(row.id);
                                  return next;
                                });
                                if (selectedOnly) setPage(1);
                                change();
                              }}
                            />
                          </td>
                          <td className="break-words px-4 py-3">
                            <details>
                              <summary className="cursor-pointer line-clamp-2">
                                {row.question || JSON.stringify(row.raw) || "（空问题）"}
                              </summary>
                              <p className="mt-2 whitespace-pre-wrap break-words">
                                {row.raw ? JSON.stringify(row.raw, null, 2) : row.question}
                              </p>
                            </details>
                          </td>
                          <td className="px-4 py-3">
                            <details>
                              <summary className="cursor-pointer line-clamp-2 break-words">
                                {row.expectedOutput || "（空值）"}
                              </summary>
                              <p className="whitespace-pre-wrap break-words">
                                {row.expectedOutput || "（空值）"}
                              </p>
                            </details>
                          </td>
                          <td className="px-4 py-3">
                            <MetadataSummary entries={row.metadata} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visibleInput?.records.length && (
                    <div className="space-y-2 p-6 text-center text-sm">
                      <p>{selectedOnly ? "当前范围没有已选记录。" : "没有匹配记录。"}</p>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSearch("");
                          setConditions([]);
                          setSelectedOnly(false);
                          setPage(1);
                        }}
                      >
                        显示全部记录
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="px-4 pb-3">
                <Pagination
                  current={page}
                  total={visibleInput?.total ?? 0}
                  unit="条记录"
                  pages={Math.max(1, Math.ceil((visibleInput?.total ?? 0) / 20))}
                  onChange={setPage}
                />
              </div>
            </CardContent>
          </Card>
          <Card
            id="processing-settings"
            className="scroll-mt-28 min-w-0 overflow-hidden xl:sticky xl:top-20"
          >
            <CardHeader className="border-b bg-muted/60 px-4 py-3">
              <h2 className="font-semibold">处理要求</h2>
            </CardHeader>
            <CardContent className="space-y-5 p-4">
              <div className="space-y-2 text-sm">
                <div className="flex gap-2" role="group" aria-label="处理方式">
                  {Object.entries(labels).map(([value, label]) => (
                    <Button
                      key={value}
                      size="sm"
                      className="flex-1"
                      variant={operation === value ? "default" : "outline"}
                      aria-pressed={operation === value}
                      disabled={busy}
                      onClick={() => {
                        setOperation(value as typeof operation);
                        change();
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">允许修改的字段</legend>
                <div className="flex flex-wrap gap-4">
                  {[
                    ["question", "问题"],
                    ["expectedOutput", "期望输出"],
                    ["metadata", "Metadata"],
                  ].map(([field, label]) => (
                    <label key={field} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        disabled={busy}
                        checked={allowedFields.includes(field!)}
                        onCheckedChange={(yes) => {
                          setAllowedFields((old) =>
                            yes ? [...old, field!] : old.filter((value) => value !== field),
                          );
                          change();
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  未勾选的字段保留输入原值；切换处理方式不改变字段授权。
                </p>
                {!allowedFields.length && (
                  <p className="text-xs text-destructive">请至少选择一个字段。</p>
                )}
              </fieldset>
              <label className="block space-y-2 text-sm">
                <span>{operation === "clean" ? "补充要求（选填）" : "具体要求"}</span>
                <Textarea
                  disabled={busy}
                  value={instructions}
                  maxLength={8000}
                  rows={4}
                  placeholder={
                    {
                      clean: "例如：统一标点，保留原意。留空则只整理首尾空白。",
                      rewrite: "例如：保留原意，改写为清晰、独立的问题。",
                      augment: "例如：围绕相同意图增加不同措辞和场景。",
                    }[operation]
                  }
                  onChange={(event) => {
                    setInstructions(event.target.value);
                    change();
                  }}
                />
                {operation !== "clean" && !instructions.trim() && (
                  <p className="text-xs text-muted-foreground">
                    请填写{labels[operation]}要求后开始。
                  </p>
                )}
              </label>
              {operation === "augment" && (
                <label className="block space-y-2 text-sm">
                  <span>新增记录数量（输入 {selected.size} 条）</span>
                  <Input
                    aria-label="新增记录数量"
                    type="number"
                    min={1}
                    max={10000}
                    value={count}
                    disabled={busy}
                    onChange={(event) => {
                      setCount(event.target.value);
                      change();
                    }}
                  />
                  {invalidCount && (
                    <p className="text-xs text-destructive">请输入 1–10,000 的整数。</p>
                  )}
                </label>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="space-y-2 border-t pt-4">
                {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
                <Button
                  className="w-full"
                  disabled={
                    busy || Boolean(reason) || input.isError || input.isFetching || scopeChanged
                  }
                  onClick={() => void submit()}
                >
                  {busy ? "正在提交…" : `开始${labels[operation]} · ${selected.size} 条输入`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </fieldset>
    </div>
  );
}
function ProcessingResults({
  projectId,
  runId,
  onBack,
  onFollowup,
}: {
  projectId: string;
  runId: string;
  onBack: () => void;
  onFollowup: (mode: "continue" | "rerun", ids: string[]) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(runId)}`;
  const queryClient = useQueryClient();
  const actorId = queryClient.getQueryData<{ actor: { id: string } }>(["session"])?.actor.id ?? "";
  const cacheKey = ["processing-result-position", actorId, projectId, runId];
  queryClient.setQueryDefaults(["processing-result-position"], { gcTime: Infinity });
  const position = useRef(
    queryClient.getQueryData<{
      view: string;
      text: string;
      page: number;
      selected: string[];
      pendingSave?: { key: string; body: unknown };
      destination?: string;
      name?: string;
      targetDraftId?: string;
    }>(cacheKey),
  ).current;
  const [view, setView] = useState(position?.view ?? "all");
  const [text, setText] = useState(position?.text ?? "");
  const [page, setPage] = useState(position?.page ?? 1),
    [selected, setSelected] = useState<Set<string>>(new Set(position?.selected)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [destination, setDestination] = useState(position?.destination ?? "asset"),
    [name, setName] = useState(position?.name ?? ""),
    [key, setKey] = useState(() => position?.pendingSave?.key ?? crypto.randomUUID()),
    [receipt, setReceipt] = useState<Receipt | null>(null);
  const [targetDraftId, setTargetDraftId] = useState(position?.targetDraftId ?? "");
  useEffect(() => {
    queryClient.setQueryData(cacheKey, {
      view,
      text,
      page,
      selected: [...selected],
      pendingSave: submitted.current,
      destination,
      name,
      targetDraftId,
    });
  });
  const drafts = useQuery({
    queryKey: ["processing-target-drafts", projectId],
    queryFn: () =>
      request<{
        drafts: { id: string; name: string; parentVersionLabel: string | null; paused: boolean }[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts`),
    enabled: confirm,
  });
  const data = useQuery({
    queryKey: ["processing-run", projectId, runId, page, view, text],
    placeholderData: (previous, query) =>
      canRetainReadResult(query?.state.error) ? previous : undefined,
    queryFn: () =>
      request<ResultPage>(
        `${path}?offset=${(page - 1) * 20}&limit=20&view=${view}&search=${encodeURIComponent(text)}`,
      ),
    refetchInterval: (q) =>
      ["queued", "running", "retry_wait", "cancel_requested"].includes(
        q.state.data?.run.status ?? "",
      )
        ? 3000
        : false,
    retry: false,
  });
  const lastConfirmed = useRef<ResultPage | undefined>(undefined);
  useEffect(() => {
    if (!canRetainReadResult(data.error)) {
      lastConfirmed.current = undefined;
      queryClient.removeQueries({
        queryKey: ["processing-run", projectId, runId],
        type: "inactive",
      });
    } else if (data.isSuccess && !data.isPlaceholderData) lastConfirmed.current = data.data;
  }, [
    projectId,
    runId,
    queryClient,
    data.error,
    data.data,
    data.isSuccess,
    data.isPlaceholderData,
  ]);
  const transient = canRetainReadResult(data.error);
  const value = transient ? (data.data ?? lastConfirmed.current) : undefined;
  async function action(kind: "cancel" | "retry") {
    setBusy(true);
    setError("");
    try {
      await post(`${path}/${kind}`, {});
      await data.refetch();
      await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const submitted = useRef<{ key: string; body: unknown } | null>(position?.pendingSave ?? null);
  const [unknownSave, setUnknownSave] = useState(Boolean(position?.pendingSave));
  async function accept() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (submitted.current?.key !== key) {
        let target: Record<string, unknown> = { kind: "asset" };
        if (destination === "draft" || destination === "existingDraft") {
          const id = destination === "draft" ? data.data!.run.source.id! : targetDraftId;
          const current = await request<{ draft: { revision: number } }>(
            `/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts/${encodeURIComponent(id)}`,
          );
          target = { kind: "draft", id, expectedRevision: current.draft.revision };
        } else if (destination === "newDraft") target = { kind: "newDraft", name, purpose: "" };
        submitted.current = { key, body: { resultIds: [...selected], target } };
      }
      queryClient.setQueryData(cacheKey, {
        ...queryClient.getQueryData<object>(cacheKey),
        pendingSave: submitted.current,
        destination,
        name,
        targetDraftId,
      });
      const result = await post<{
        receipt: Receipt;
      }>(`${path}/accept`, submitted.current!.body, key);
      setReceipt(result.receipt);
      submitted.current = null;
      setUnknownSave(false);
      setConfirm(false);
      setSelected(new Set());
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      await data.refetch();
    } catch (e) {
      setError(errorText(e));
      const code = e instanceof Error ? e.message : "";
      const rejected =
        code.startsWith("processing_") ||
        code.startsWith("draft_") ||
        [
          "draft_revision_conflict",
          "draft_field_conflict",
          "processing_source_unavailable",
          "processing_not_found",
          "processing_still_running",
          "test_set_capacity_exceeded",
          "processing_capacity_exceeded",
          "idempotency_conflict",
          "validation_error",
          "processing_selection_invalid",
        ].includes(code);
      if (submitted.current && !rejected) setUnknownSave(true);
      else if (rejected) {
        submitted.current = null;
        setKey(crypto.randomUUID());
        setUnknownSave(false);
      }
    } finally {
      setBusy(false);
    }
  }
  if (data.isPending && !value) return <p>正在读取处理结果…</p>;
  if (!value)
    return (
      <div role="alert">
        <p>{errorText(data.error)}</p>
        <Button variant="outline" onClick={() => void data.refetch()}>
          重试
        </Button>
        <Button variant="ghost" onClick={onBack}>
          返回任务
        </Button>
      </div>
    );
  const run = value.run,
    terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
  const stale = data.isFetching || data.isPlaceholderData || !data.data;
  const saved = value.receipts?.length ? value.receipts : receipt ? [receipt] : [];
  const savedSelection = [...selected].filter((id) => value.adoptedIds?.includes(id));
  const sourceDraft = run.source.kind === "draft";
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{labels[run.options.operation]}结果</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {run.sourceSummary?.name ?? "来源未记录"}
              </p>
              <div
                role="status"
                className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              >
                <ProcessingStatus run={run} />
                <span>
                  已产生 {run.outputCount ?? value.stats?.all ?? value.total} /{" "}
                  {run.options.outputCount ?? run.inputCount} 条结果
                  {run.missingCount ? ` · 尚缺 ${run.missingCount} 条` : ""}
                  {value.stats?.needsReview ? ` · ${value.stats.needsReview} 条自动检查问题` : ""}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {terminal && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="更多任务操作"
                      disabled={busy || unknownSave || stale || data.isError}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onFollowup("rerun", [])}>
                      重新运行
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {!terminal ? (
                <Button
                  variant="outline"
                  disabled={busy || run.status === "cancel_requested"}
                  onClick={() => void action("cancel")}
                >
                  取消任务
                </Button>
              ) : (
                (run.status !== "succeeded" || Boolean(run.missingCount)) && (
                  <Button variant="outline" disabled={busy} onClick={() => void action("retry")}>
                    重试未完成批次
                  </Button>
                )
              )}
            </div>
          </div>
          {run.parentRunId && (
            <Link
              className="mt-2 inline-block text-sm text-primary hover:underline"
              to="/projects/$projectId/processing"
              params={{ projectId }}
              search={{ run: run.parentRunId }}
            >
              返回上一轮任务
            </Link>
          )}
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">查看提交的处理要求</summary>
            <div className="mt-2 space-y-1">
              <p className="whitespace-pre-wrap break-words">
                {run.options.instructions || "未填要求：整理首尾空白并提示空值、重复。"}
              </p>
              <p>
                允许修改：
                {run.options.allowedFields
                  ?.map(
                    (field) =>
                      ({ question: "问题", expectedOutput: "期望输出", metadata: "Metadata" })[
                        field as "question"
                      ],
                  )
                  .join("、") ?? "未记录"}
              </p>
              <p>
                {run.actorName ?? "未记录"} · {new Date(run.createdAt).toLocaleString()}
              </p>
            </div>
          </details>
        </CardContent>
      </Card>
      {data.isError && (
        <div role="alert" className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
          状态读取中断，下面保留上次确认的结果；不能确认当前进度。
          <Button variant="ghost" size="sm" onClick={() => void data.refetch()}>
            重试读取
          </Button>
        </div>
      )}
      {(error || run.errorCode || value.issues.length > 0) && (
        <div
          role="alert"
          className="rounded-lg border border-chart-5/40 bg-chart-5/10 px-4 py-3 text-sm"
        >
          <p>
            {error ||
              (run.errorCode
                ? (errors[run.errorCode] ?? "部分批次未完成，已成功的结果仍可查看和采用。")
                : "结果存在空值、重复或缺失项，请核对后选择采用。")}
          </p>
          {value.issues.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-primary">查看校验说明</summary>
              <ul className="mt-2 space-y-1">
                {value.issues.slice(0, 20).map((issue, i) => (
                  <li key={i}>
                    {issueLabels[issue.code] ?? "结果需要核对"}
                    {issue.count ? `：${issue.count}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {saved.map((item, index) => (
        <div
          key={index}
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-chart-2/40 bg-chart-2/10 px-4 py-3 text-sm"
        >
          <span>
            已保存 {item.adopted} 条处理结果{item.draftId ? "到草稿。" : "到原始数据。"}
          </span>
          {item.draftId && (
            <Link
              className="text-primary"
              to="/projects/$projectId/test-sets/drafts/$draftId"
              params={{ projectId, draftId: item.draftId }}
            >
              返回草稿
            </Link>
          )}
          {item.collectionId && !item.draftId && (
            <Link
              className="text-primary"
              to="/projects/$projectId/datasets/$collectionId/files/$assetId"
              params={{ projectId, collectionId: item.collectionId, assetId: item.assetId }}
            >
              打开原始数据
            </Link>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2" aria-label="结果筛选">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索处理结果"
            placeholder="搜索问题、期望输出、Metadata 或来源"
            className="pl-8"
            value={text}
            maxLength={200}
            onChange={(event) => {
              setText(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {text && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText("");
              setPage(1);
            }}
          >
            清除搜索
          </Button>
        )}
        {[
          ["all", "全部"],
          ["changed", "有变化"],
          ["issues", "自动检查问题"],
        ].map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={view === key ? "default" : "outline"}
            onClick={() => {
              setView(key!);
              setPage(1);
            }}
          >
            {label}{" "}
            {value.stats?.[key === "issues" ? "needsReview" : (key as "all" | "changed")] ??
              (key === "all" ? value.total : "")}
          </Button>
        ))}
      </div>
      <Card className="min-w-0 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!terminal || busy || data.isError || stale || unknownSave}
              onClick={() => {
                setSelected((old) => new Set([...old, ...value.records.map((r) => r.id)]));
                setKey(crypto.randomUUID());
              }}
            >
              勾选本页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!terminal || busy || data.isError || stale || unknownSave}
              onClick={() => {
                setSelected((old) => new Set([...old, ...value.allIds]));
                setKey(crypto.randomUUID());
              }}
            >
              选择全部匹配结果
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || unknownSave}
              onClick={() => {
                setSelected(new Set());
                setKey(crypto.randomUUID());
              }}
            >
              清空选择
            </Button>
            <span className="text-sm text-muted-foreground">
              已选 {selected.size} 条
              {[...selected].filter((id) => !value.allIds.includes(id)).length > 0
                ? `（${[...selected].filter((id) => !value.allIds.includes(id)).length} 条在当前筛选外）`
                : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={
                !terminal ||
                busy ||
                !selected.size ||
                data.isError ||
                stale ||
                unknownSave ||
                savedSelection.length > 0
              }
              onClick={() => onFollowup("continue", [...selected])}
            >
              继续处理所选 {selected.size} 条
            </Button>
            <Button
              size="sm"
              disabled={!terminal || busy || !selected.size || data.isError || stale}
              onClick={() => {
                if (!unknownSave) setDestination(sourceDraft ? "draft" : "asset");
                setConfirm(true);
              }}
            >
              {sourceDraft ? "保存回原草稿" : `保存所选 ${selected.size} 条`}
            </Button>
            {sourceDraft && (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  !terminal || busy || !selected.size || data.isError || stale || unknownSave
                }
                onClick={() => {
                  setDestination("asset");
                  setConfirm(true);
                }}
              >
                另存到…
              </Button>
            )}
          </div>
          {(savedSelection.length > 0 || !terminal || !selected.size || value.total === 0) && (
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {savedSelection.length ? (
                <>
                  已选中 {savedSelection.length} 条已保存结果，不能继续处理。
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || unknownSave}
                    onClick={() => {
                      setSelected(
                        (old) => new Set([...old].filter((id) => !savedSelection.includes(id))),
                      );
                      setKey(crypto.randomUUID());
                    }}
                  >
                    移除已保存选择
                  </Button>
                </>
              ) : !terminal ? (
                "任务结束后可继续处理。"
              ) : value.total === 0 ? (
                "暂无可用结果；可重试未完成批次。"
              ) : (
                "请先选择要继续处理的结果。"
              )}
            </div>
          )}
          {stale && (
            <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">
              正在读取结果，下面保留上一次条件的内容；读取完成后可选择。
            </p>
          )}
          <ProcessingReview
            rows={value.records}
            selected={selected}
            disabled={!terminal || busy || data.isError || stale || unknownSave}
            generated={value.rootOperation === "augment" || run.options.operation === "augment"}
            offset={stale ? (value.offset ?? (page - 1) * 20) : (page - 1) * 20}
            total={value.total}
            pageSize={20}
            onPageChange={setPage}
            loading={data.isFetching || data.isPlaceholderData}
            error={data.isError}
            onRetry={() => void data.refetch()}
            onToggle={(id, checked) => {
              setSelected((old) => {
                const next = new Set(old);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              });
              setKey(crypto.randomUUID());
            }}
          />
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            结构检查通过不代表内容正确，请审核后保存。
          </p>
        </CardContent>
      </Card>
      <Pagination
        current={page}
        total={value.total}
        unit="条结果"
        pages={Math.max(1, Math.ceil(value.total / 20))}
        onChange={setPage}
      />
      <Dialog
        open={confirm}
        onOpenChange={(v) => {
          if (!busy) setConfirm(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存 {selected.size} 条处理结果</DialogTitle>
            <DialogDescription>
              {destination === "draft" &&
              value.rootOperation !== "augment" &&
              run.options.operation !== "augment"
                ? `更新 ${selected.size} 条记录的指定字段（${(value.adoptionFields ?? run.options.allowedFields)?.map((field) => ({ question: "问题", expectedOutput: "期望输出", metadata: "Metadata" })[field as "question"]).join("、") ?? "未记录"}）。`
                : destination === "asset"
                  ? `保存 ${selected.size} 条到独立原始数据文件。`
                  : `向草稿追加 ${selected.size} 条记录。`}{" "}
              确认后才保存，不会发布版本。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {destination === "draft" ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                保存回原草稿：<strong>{run.sourceSummary?.name ?? "来源名称读取中"}</strong>
              </div>
            ) : (
              <label className="block space-y-2 text-sm">
                <span>保存到</span>
                <Select
                  value={destination}
                  disabled={busy || unknownSave}
                  onValueChange={(v) => {
                    setDestination(v);
                    setKey(crypto.randomUUID());
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asset">保存为原始数据</SelectItem>
                    <SelectItem value="newDraft">新建测试集草稿</SelectItem>
                    <SelectItem value="existingDraft">加入已有草稿</SelectItem>
                    {run.source.kind === "draft" && (
                      <SelectItem value="draft">
                        {run.options.operation === "augment" ? "加入来源草稿" : "更新来源草稿"}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </label>
            )}
            {destination === "existingDraft" && (
              <label className="block space-y-2 text-sm">
                <span>目标草稿</span>
                <Select
                  value={targetDraftId}
                  disabled={busy || unknownSave}
                  onValueChange={(id) => {
                    setTargetDraftId(id);
                    setKey(crypto.randomUUID());
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择草稿" />
                  </SelectTrigger>
                  <SelectContent>
                    {drafts.data?.drafts
                      .filter((d) => !d.paused && d.id !== run.source.id)
                      .map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name || "未命名测试集"}
                          {d.parentVersionLabel ? ` · 基于 ${d.parentVersionLabel}` : " · 新建草稿"}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {drafts.error ? <p role="alert">草稿读取失败，请关闭确认框后重试。</p> : null}
              </label>
            )}
            {destination === "newDraft" && (
              <label className="block space-y-2 text-sm">
                <span>测试集名称</span>
                <Input
                  value={name}
                  maxLength={200}
                  disabled={busy || unknownSave}
                  onChange={(e) => {
                    setName(e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                />
              </label>
            )}
            {destination === "draft" && (
              <p className="text-sm text-muted-foreground">
                {value.rootOperation === "augment" || run.options.operation === "augment"
                  ? "所选生成记录会追加到原草稿，不替换已有记录。"
                  : "只采用本次允许修改的字段。同字段已被他人修改时会停止采用并保留其内容。"}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          {unknownSave && (
            <p role="alert" className="text-sm text-destructive">
              保存响应未确认。目标与选择已锁定，请再次确认保存以查询同一回执；不会重复追加。
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button
              disabled={
                busy ||
                (!submitted.current &&
                  ((destination === "newDraft" && !name.trim()) ||
                    (destination === "existingDraft" && !targetDraftId)))
              }
              onClick={() => void accept()}
            >
              {busy ? "正在保存…" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
