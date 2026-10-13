import { useState, useRef, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, MoreHorizontal, RefreshCw, CircleHelp } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Arrow as TooltipArrow } from "@radix-ui/react-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
import {
  EmptyBlock,
  LoadingBlock,
  PageHeader,
  QueryFeedback,
  StateView,
  TableLoadingBlock,
} from "@/components/state-view";
import { useListSearch } from "@/hooks/use-list-search";
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
    mode?: "continue" | "rerun" | "saved" | undefined;
  } => ({
    source:
      typeof value["source"] === "string" &&
      ["assets", "draft", "version"].includes(value["source"])
        ? (value["source"] as "assets" | "draft" | "version")
        : undefined,
    sourceId: typeof value["sourceId"] === "string" ? value["sourceId"] : undefined,
    run: typeof value["run"] === "string" ? value["run"] : undefined,
    parent: typeof value["parent"] === "string" ? value["parent"] : undefined,
    mode: ["continue", "rerun", "saved"].includes(String(value["mode"]))
      ? (value["mode"] as "continue" | "rerun" | "saved")
      : undefined,
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
  taskId?: string;
  title?: string;
  roundCount?: number;
  currentCount?: number;
  savedCount?: number;
  unsavedCount?: number;
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
    metadataKeys?: string[];
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
type Deduplication = {
  checkedIds: string[];
  keptIds: string[];
  excludedIds: string[];
  removedRecordIds: string[];
  inspected: number;
};
type ResultPage = {
  recovery?: { canRetry: boolean; canContinue: boolean; reason: string | null };
  diagnostics?: {
    batch: number;
    attempts: number;
    accepted: number;
    missing: number;
    calls: {
      attempt: number;
      durationMs: number;
      code: string;
      finishReason?: string;
      generated: number;
      validated: number;
      duplicates: number;
      invalid: number;
      accepted: number;
    }[];
  }[];
  task?: {
    id: string;
    revision: number;
    title: string;
    latestRunId: string;
    roundCount: number;
    currentCount: number;
    incomplete: boolean;
    excludedCount: number;
    savedCount: number;
    unsavedCount: number;
    fullySaved: boolean;
    canContinueSaved?: boolean;
    latestUsableCount?: number;
  };
  unprocessedIds?: string[];
  unsavedIds?: string[];
  saveDisposition?: { updateIds: string[]; addIds: string[]; removeCount: number };
  run: Run;
  records: ReviewRow[];
  rootOperation?: string;
  adoptionFields?: string[];
  adoptedIds?: string[];
  usableCount?: number;
  duplicateCount?: number;
  stats?: { all: number; changed: number; needsReview: number; duplicates?: number };
  receipts?: Receipt[];
  total: number;
  offset?: number;
  allIds: string[];
  issues: { code: string; count?: number }[];
};
const labels = { clean: "清洗", rewrite: "改写", augment: "扩充" };
const operationScenarios = {
  clean: [
    "导入的数据前后有多余空格。",
    "文本有明显错别字，希望按补充要求纠正。",
    "标点或格式不统一，希望规范整理。",
    "希望检查空问题、重复内容。",
  ],
  rewrite: [
    "问题表达不清楚，希望改得更自然、易懂。",
    "希望调整措辞、语气或表达方式。",
    "期望输出不准确，需要修改答案或分类标签。",
    "希望补充或调整 Metadata 中的分类、场景等信息。",
  ],
  augment: [
    "现有测试数据不足，希望增加新题目。",
    "希望围绕同一意图，增加不同的问法。",
    "希望补充不同场景、难度或边界情况。",
    "希望参考已有数据，生成指定数量的新记录。",
  ],
};
const HISTORY_COLUMN_WIDTHS = ["40%", "10%", "15%", "22%", "13%"];
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
  const partial =
    (run.status === "failed" && (run.outputCount ?? 0) > 0) ||
    (run.status === "succeeded" && run.executionComplete === false);
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
      {partial ? "部分完成" : statuses[run.status]}
    </Badge>
  );
}
const diagnosticLabels: Record<string, string> = {
  temporary_service: "模型服务暂不可用或限流",
  network_error: "模型连接中断",
  timeout: "模型调用超时",
  provider_rejected: "模型服务拒绝请求，请检查连接配置",
  output_truncated: "模型输出被长度截断",
  invalid_json: "模型未返回有效 JSON",
  invalid_fields: "来源或字段格式不符合要求",
  duplicate_content: "重复内容已剔除",
  insufficient_output: "模型返回数量不足",
  budget_exhausted: "本轮调用或时间额度已用完",
  remaining_budget: "本轮仍可重试未完成部分",
  source_or_configuration: "请先核对来源或配置",
  ok: "已校验",
};
const errors: Record<string, string> = {
  processing_retry_unavailable: "本轮已无法重试，请刷新后继续未完成部分。已有结果已保留。",
  processing_completion_unavailable: "当前没有可继续的缺失记录，请刷新后核对。",
  processing_task_changed: "任务已变化，输入已保留，请刷新当前成果后重新核对。",
  processing_task_not_found: "当前任务不可访问，或来源已被删除。",
  processing_saved_range_unavailable: "保存范围无法确认，请从已保存的草稿继续处理。",
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
  processing_duplicate_target: "目标草稿已有相同内容，请重新去重或核对保存目标。",
  processing_deduplication_changed: "去重范围已变化，请恢复排除后重新检查。",
  processing_deduplication_invalid: "请选择要检查的结果。",
  processing_input_corrupt: "历史输入快照不可用，无法重新运行。请返回来源重新选择。",
  draft_not_editing: "原草稿已发布，不能继续写入。处理结果和选择已保留。",
  draft_paused: "原草稿已暂停，请恢复父对象后再保存。",
  draft_not_found: "目标草稿已发布、删除或不可用，未改动其他草稿。处理结果和选择已保留。",
  draft_record_removed: "原记录已被移除，未覆盖草稿。处理结果和选择已保留。",
};
const errorText = (error: unknown) =>
  errors[error instanceof Error ? error.message : ""] ?? "操作失败，输入已保留，请重试。";
function post<T>(path: string, body: unknown, key?: string, signal?: AbortSignal) {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}
function ProcessingPage() {
  const { projectId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate();
  const access = useProjectAccess(projectId),
    queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [historyStatus, setHistoryStatus] = useState("all");
  const [historyPage, setHistoryPage] = useState(1);
  const {
    search: historySearch,
    committedSearch,
    setSearch: setHistorySearch,
    inputProps,
  } = useListSearch(setHistoryPage);
  const actorId = queryClient.getQueryData<{ actor: { id: string } }>(["session"])?.actor.id ?? "";
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-tasks`;
  const runs = useQuery({
    queryKey: ["processing-runs", projectId, actorId, committedSearch, historyStatus, historyPage],
    queryFn: ({ signal }) =>
      request<{ runs: Run[]; pagination: { total: number }; hasActive: boolean }>(
        `${path}?limit=20&offset=${(historyPage - 1) * 20}&search=${encodeURIComponent(committedSearch)}&status=${historyStatus}`,
        { signal },
      ),
    enabled:
      access.canWrite && !search.run && !search.parent && !(search.source && search.sourceId),
    refetchInterval: (query) => (query.state.data?.hasActive ? 5000 : false),
    refetchIntervalInBackground: false,
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: false,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === projectId &&
      query.queryKey[2] === actorId &&
      canRetainReadResult(query.state.error)
        ? previous
        : undefined,
  });
  const history = access.canWrite ? runs.data?.runs : undefined;
  const historyTotal = access.canWrite
    ? (runs.data?.pagination?.total ?? runs.data?.runs.length ?? 0)
    : 0;
  const runId = search.run;
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(historyTotal / 20));
    if (runs.isSuccess && !runs.isPlaceholderData && historyPage > pages) setHistoryPage(pages);
  }, [runs.isSuccess, runs.isPlaceholderData, historyTotal, historyPage]);
  const source =
    search.parent && search.mode
      ? {
          kind: search.mode === "continue" ? "results" : search.mode,
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
      {!(source && (!runId || search.mode)) && (
        <PageHeader
          title="数据处理"
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
          {source && (!runId || search.mode) && (
            <ProcessingForm
              key={`${projectId}:${actorId}:${JSON.stringify(source)}`}
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
          {runId && !search.mode && (
            <ProcessingResults
              key={`${projectId}:${actorId}:${runId}`}
              projectId={projectId}
              runId={runId}
              onCreated={() => void navigate({ search: { run: runId } })}
              onFollowup={(mode, ids) => {
                queryClient.setQueryData(
                  ["processing-followup-selection", actorId, projectId, runId],
                  ids,
                );
                void navigate({
                  search: {
                    source: undefined,
                    sourceId: undefined,
                    run: runId,
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
                    {...inputProps}
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
                    <SelectItem value="all">全部状态</SelectItem>
                    {Object.entries({
                      active: "进行中",
                      complete: "已完成",
                      attention: "需处理",
                      cancelled: "已取消",
                    }).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="刷新处理任务"
                  title="刷新处理任务"
                  disabled={runs.isFetching}
                  onClick={() => void runs.refetch()}
                >
                  <RefreshCw
                    className={`size-4 ${runs.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`}
                  />
                </Button>
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
              <StateView
                isLoading={runs.isPending}
                data={history}
                error={runs.error}
                loading={
                  <TableLoadingBlock
                    columns={["任务", "输入记录", "状态", "发起人 / 时间", "操作"]}
                    widths={HISTORY_COLUMN_WIDTHS}
                  />
                }
                isRefreshing={runs.isFetching || historySearch !== committedSearch}
                isPlaceholder={runs.isPlaceholderData}
                retainDataOnError
                isEmpty={(items) => items.length === 0}
                onRetry={() => void runs.refetch()}
                empty={
                  <EmptyBlock
                    title={
                      committedSearch || historyStatus !== "all"
                        ? "没有匹配结果，请清除搜索或筛选。"
                        : "暂无处理任务。点击“新建处理”开始。"
                    }
                  />
                }
              >
                {(history) => (
                  <Card className="min-w-0 overflow-hidden">
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] table-fixed text-sm">
                          <colgroup>
                            {HISTORY_COLUMN_WIDTHS.map((width, i) => (
                              <col key={i} style={{ width }} />
                            ))}
                          </colgroup>
                          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                            <tr>
                              <th className="px-4 py-2 font-medium">任务</th>
                              <th className="px-4 py-2 font-medium">当前成果</th>
                              <th className="px-4 py-2 font-medium">状态</th>
                              <th className="px-4 py-2 font-medium">发起人 / 时间</th>
                              <th className="px-4 py-2 text-right font-medium">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {history.map((run) => (
                              <tr key={run.id} className="border-t">
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2 font-medium">
                                    <FileText className="size-4 shrink-0 text-primary" />
                                    <span
                                      className="min-w-0 truncate"
                                      title={run.sourceSummary?.name}
                                    >
                                      {run.title ??
                                        `${run.sourceSummary?.name ?? "来源未记录"} · 数据处理`}
                                    </span>
                                  </div>
                                  <p
                                    className="mt-0.5 max-w-sm truncate pl-6 text-xs text-muted-foreground"
                                    title={run.options.instructions}
                                  >
                                    第 {run.roundCount ?? 1} 轮 · {labels[run.options.operation]}
                                  </p>
                                  {!run.roundCount && run.parentRunId && (
                                    <p className="mt-1 pl-6 text-xs text-muted-foreground">
                                      {run.continuationKind === "rerun"
                                        ? "重新运行自"
                                        : "继续处理自"}{" "}
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
                                <td className="px-4 py-3">
                                  {run.currentCount ?? run.inputCount} 条
                                </td>
                                <td className="px-4 py-3">
                                  <ProcessingStatus run={run} />
                                  {run.status === "running" ? ` ${run.progress}%` : ""}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {run.savedCount !== undefined
                                      ? run.savedCount
                                        ? `已保存 ${run.savedCount} · 未保存 ${run.unsavedCount ?? 0}`
                                        : "未保存"
                                      : run.hasSavedResult === true
                                        ? "有已保存结果"
                                        : run.hasSavedResult === false
                                          ? "未保存"
                                          : "保存状态未记录"}
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
                    </CardContent>
                  </Card>
                )}
              </StateView>
              <Pagination
                current={historyPage}
                total={historyTotal}
                pages={Math.max(1, Math.ceil(historyTotal / 20))}
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
  const followup = ["results", "rerun", "saved"].includes(String(source["kind"]));
  const taskMode = source["kind"] === "results" ? "continue" : String(source["kind"]);
  const rerun = source["kind"] === "rerun";
  queryClient.setQueryDefaults(["processing-config"], { gcTime: Infinity });
  queryClient.setQueryDefaults(["processing-followup-selection"], { gcTime: Infinity });
  const settingsKey = `processing-settings:${actorId}:${projectId}:${JSON.stringify(source)}`;
  const restoredSettings = useRef<
    Partial<
      Record<
        Run["options"]["operation"],
        { instructions: string; allowedFields: string[]; count: string; metadataKeys?: string[] }
      >
    >
  >(
    (() => {
      try {
        return JSON.parse(sessionStorage.getItem(settingsKey) ?? "{}") ?? {};
      } catch {
        return {};
      }
    })(),
  );
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
      metadataKeys?: string[];
      count: string;
      operationConfigs?: Partial<
        Record<
          Run["options"]["operation"],
          { instructions: string; allowedFields: string[]; count: string; metadataKeys?: string[] }
        >
      >;
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
  const [operationHelp, setOperationHelp] = useState<keyof typeof labels | null>(null);
  const helpOpenOnPointerDown = useRef(false);
  const [page, setPage] = useState(saved?.page ?? 1),
    [selected, setSelected] = useState<Set<string>>(new Set(saved?.selected)),
    [operation, setOperation] = useState<"clean" | "rewrite" | "augment">(
      saved?.operation ?? "clean",
    );
  const [search, setSearch] = useState(saved?.search ?? ""),
    [conditions, setConditions] = useState<SelectionCondition[]>(saved?.conditions ?? []),
    [selectedOnly, setSelectedOnly] = useState(saved?.selectedOnly ?? false);
  const restored = restoredSettings.current[saved?.operation ?? "clean"];
  const [metadataKeys, setMetadataKeys] = useState<string[] | undefined>(
    saved?.metadataKeys ?? restored?.metadataKeys,
  );
  const [instructions, setInstructions] = useState(
      saved?.instructions ?? restored?.instructions ?? "",
    ),
    [allowedFields, setAllowedFields] = useState(
      saved?.allowedFields ?? restored?.allowedFields ?? ["question"],
    ),
    [count, setCount] = useState(saved?.count ?? restored?.count ?? "20"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operationConfigs = useRef(saved?.operationConfigs ?? restoredSettings.current);
  function switchOperation(next: Run["options"]["operation"]) {
    if (next === operation) return;
    operationConfigs.current[operation] = {
      instructions,
      allowedFields,
      count,
      ...(metadataKeys ? { metadataKeys } : {}),
    };
    const config = operationConfigs.current[next] ?? {
      instructions: "",
      allowedFields: ["question"],
      count: "20",
    };
    setOperation(next);
    setInstructions(config.instructions);
    setAllowedFields(config.allowedFields);
    setCount(config.count);
    setMetadataKeys(config.metadataKeys);
    change();
  }
  function setField(field: string, yes: boolean) {
    setAllowedFields((old) =>
      yes ? [...new Set([...old, field])] : old.filter((value) => value !== field),
    );
    change();
  }
  const fieldNames: Record<string, string> = {
    question: "问题",
    expectedOutput: "期望输出",
    metadata: "Metadata",
  };
  const fieldChoices = (
    <div className="flex flex-wrap gap-4">
      {Object.entries(fieldNames).map(([field, label]) => (
        <label key={field} className="flex items-center gap-2 text-sm">
          <Checkbox
            disabled={busy}
            checked={allowedFields.includes(field)}
            onCheckedChange={(yes) => setField(field, yes === true)}
          />
          {label}
        </label>
      ))}
    </div>
  );
  const protectedFields = Object.keys(fieldNames)
    .filter((field) => !allowedFields.includes(field))
    .map((field) => fieldNames[field])
    .join("、");
  const configSummary =
    operation === "augment"
      ? `生成${allowedFields.map((field) => fieldNames[field]).join("、")}${protectedFields ? ` · ${protectedFields}沿用参考值` : ""}`
      : `${operation === "clean" ? "清洗" : "改写"}${allowedFields.map((field) => fieldNames[field]).join("、") || "范围未选择"}${protectedFields ? ` · ${protectedFields}保持原值` : ""}`;
  const customFields =
    allowedFields.length !== 1 || allowedFields[0] !== "question" || Boolean(metadataKeys?.length);
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
    queryFn: ({ signal }) =>
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
      }>(
        followup
          ? `/api/projects/${encodeURIComponent(projectId)}/processing-tasks/${encodeURIComponent(String(source["id"]))}/input`
          : `/api/projects/${encodeURIComponent(projectId)}/processing-inputs`,
        followup
          ? {
              mode: taskMode,
              resultIds: source["resultIds"],
              offset: (page - 1) * 20,
              limit: 20,
              search,
              conditions,
            }
          : {
              source,
              offset: (page - 1) * 20,
              limit: 20,
              search,
              conditions,
              selectedOnly,
              ...(selectedOnly ? { selectedIds: [...selected] } : {}),
            },
        undefined,
        signal,
      ),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === actorId &&
      query.queryKey[2] === projectId &&
      JSON.stringify(query.queryKey[3]) === JSON.stringify(source) &&
      canRetainReadResult(query.state.error)
        ? previous
        : undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  useEffect(() => {
    if (!followup || !input.data || input.isPlaceholderData || initialized.current) return;
    initialized.current = true;
    setSelected(new Set(input.data.allIds));
    if (rerun && input.data.parent) {
      const options = input.data.parent.options;
      setOperation(options.operation);
      setInstructions(options.instructions);
      setAllowedFields(options.allowedFields ?? ["question"]);
      setMetadataKeys(options.metadataKeys);
      setCount(String(options.outputCount ?? 20));
    }
  }, [followup, rerun, input.data, input.isPlaceholderData]);
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
    operationConfigs.current[operation] = {
      instructions,
      allowedFields,
      count,
      ...(metadataKeys ? { metadataKeys } : {}),
    };
    try {
      sessionStorage.setItem(settingsKey, JSON.stringify(operationConfigs.current));
    } catch {
      /* In-memory form remains usable if browser storage is full/disabled. */
    }
    queryClient.setQueryData(cacheKey, {
      page,
      selected: [...selected],
      operation,
      search,
      conditions,
      selectedOnly,
      instructions,
      allowedFields,
      ...(metadataKeys ? { metadataKeys } : {}),
      count,
      operationConfigs: {
        ...operationConfigs.current,
        [operation]: {
          instructions,
          allowedFields,
          count,
          ...(metadataKeys ? { metadataKeys } : {}),
        },
      },
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
      ? "请至少选择一项处理内容。"
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
            mode: taskMode,
            expectedRevision: Number(sourceRevision.current),
            ...(taskMode === "continue"
              ? { resultIds: [...selected].map((id) => id.slice(10)) }
              : {}),
            options: {
              operation,
              instructions,
              allowedFields,
              ...(allowedFields.includes("metadata") && metadataKeys ? { metadataKeys } : {}),
              ...(operation === "augment" ? { outputCount: Number(count) } : {}),
            },
          }
        : {
            source: { ...source, recordIds: [...selected] },
            options: {
              operation,
              instructions,
              allowedFields,
              ...(allowedFields.includes("metadata") && metadataKeys ? { metadataKeys } : {}),
              ...(operation === "augment" ? { outputCount: Number(count) } : {}),
            },
          };
      pendingSubmission.current ??= { key: operationKey, body };
      queryClient.setQueryData(cacheKey, {
        ...queryClient.getQueryData<object>(cacheKey),
        pendingSubmission: pendingSubmission.current,
      });
      const result = await post<{ run: Run }>(
        followup
          ? `/api/projects/${encodeURIComponent(projectId)}/processing-tasks/${encodeURIComponent(String(source["id"]))}/rounds`
          : `/api/projects/${encodeURIComponent(projectId)}/processing-runs`,
        pendingSubmission.current.body,
        pendingSubmission.current.key,
      );
      submittedConfig.current = true;
      queryClient.removeQueries({ queryKey: cacheKey, exact: true });
      try {
        sessionStorage.removeItem(settingsKey);
      } catch {
        // Settings persistence is optional; a created task must still open.
      }
      await onCreated(followup ? (result.run.taskId ?? String(source["id"])) : result.run.id);
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
    clean: "整理空白，检查空值与重复。",
    rewrite: "按要求修改所选内容。",
    augment: "参考所选记录，生成新记录。",
  }[operation];
  const hidden = [...selected].filter((id) => !input.data?.allIds.includes(id)).length;
  const visibleInput = canRetainReadResult(input.error) ? input.data : undefined;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="max-w-full break-words text-xl font-semibold tracking-tight text-foreground">
            处理 {visibleInput?.sourceSummary?.name ?? "数据"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {visibleInput?.sourceSummary?.kindLabel ?? "来源读取中"} · {visibleInput?.sourceTotal ?? visibleInput?.total ?? 0} 条
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
            {followup && visibleInput?.parent && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost">上一轮要求</Button>
                </PopoverTrigger>
                <PopoverContent aria-label="上一轮处理要求" align="end" className="max-h-[60vh] w-[min(24rem,calc(100vw-2rem))] space-y-2 overflow-y-auto">
                  <h2 className="text-sm font-semibold">上一轮处理要求</h2>
                  <p className="text-xs text-muted-foreground">
                    {labels[visibleInput.parent.options.operation]} · {new Date(visibleInput.parent.createdAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap break-words border-t pt-2 text-sm">
                    {visibleInput.parent.options.instructions || "未填写要求"}
                  </p>
                </PopoverContent>
              </Popover>
            )}
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
        </div>
      </div>
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
                    disabled={rerun || busy || !visibleInput || input.isFetching || input.isError}
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
                    disabled={rerun || busy || !visibleInput || input.isFetching || input.isError}
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
                  {hidden > 0 && visibleInput ? `（含筛选外 ${hidden} 条，也会提交）` : ""}
                  {followup && (
                    <span> · {rerun ? "沿用上次完整输入" : taskMode === "saved" ? "仅限草稿已保存范围" : "未选记录保留"}</span>
                  )}
                </p>
              </div>
              <div className="px-4">
                <QueryFeedback
                  busy={input.isFetching}
                  error={visibleInput ? input.error : undefined}
                  onRetry={() => void input.refetch()}
                />
              </div>
              {input.error && !visibleInput ? (
                <div className="space-y-2 p-5" role="alert">
                  <p>{errorText(input.error)} 已选记录与处理要求已保留。</p>
                  <Button variant="outline" onClick={() => void input.refetch()}>
                    重试读取来源
                  </Button>
                </div>
              ) : input.isPending ? (
                <TableLoadingBlock
                  columns={["选择", "问题 / 原始内容", "期望输出", "Metadata"]}
                  minWidth="440px"
                  framed={false}
                />
              ) : (
                <div className="overflow-x-auto" inert={input.isError || input.isPlaceholderData}>
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
            <CardContent className="space-y-4 p-4">
              <div className="space-y-2 text-sm">
                <TooltipProvider delayDuration={250}>
                  <div className="flex gap-2" role="group" aria-label="处理方式">
                    {Object.entries(labels).map(([value, label]) => {
                      const kind = value as keyof typeof labels;
                      return (
                        <div key={value} className="relative min-w-0 flex-1">
                          <Button
                            size="sm"
                            className="w-full pr-8"
                            variant={operation === value ? "default" : "outline"}
                            aria-pressed={operation === value}
                            disabled={busy}
                            onClick={() => switchOperation(kind)}
                          >
                            {label}
                          </Button>
                          <Tooltip
                            open={operationHelp === kind}
                            onOpenChange={(open) =>
                              setOperationHelp((current) =>
                                open ? kind : current === kind ? null : current,
                              )
                            }
                          >
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label={`${label}适用场景`}
                                className={`absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-sm cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${operation === value ? "text-primary-foreground/80 hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                                onPointerDown={() => {
                                  helpOpenOnPointerDown.current = operationHelp === kind;
                                }}
                                onClick={(event) => {
                                  event.preventDefault();
                                  const wasOpen =
                                    event.detail === 0
                                      ? operationHelp === kind
                                      : helpOpenOnPointerDown.current;
                                  setOperationHelp(wasOpen ? null : kind);
                                }}
                              >
                                <CircleHelp className="size-3.5" aria-hidden="true" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align="end"
                              sideOffset={8}
                              collisionPadding={16}
                              className="max-w-[min(20rem,calc(100vw-2rem))] space-y-2 overflow-visible rounded-md border border-border bg-popover/95 p-3 leading-relaxed text-popover-foreground shadow-md backdrop-blur-sm"
                            >
                              <p className="font-semibold">什么时候适合用{label}？</p>
                              <ul className="list-disc space-y-1 pl-4">
                                {operationScenarios[kind].map((scenario) => (
                                  <li key={scenario}>{scenario}</li>
                                ))}
                              </ul>
                              {kind === "clean" && (
                                <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                                  纠错和统一格式需填写补充要求；重复检查不会自动删除记录。
                                </p>
                              )}
                              <TooltipArrow width={12} height={6} className="fill-popover/95 stroke-border" />
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      );
                    })}
                  </div>
                </TooltipProvider>
                <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
              </div>
              {customFields && (
                <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
                  已调整处理字段：{allowedFields.map((field) => fieldNames[field]).join("、") || "未选择"}
                  {allowedFields.includes("metadata") && metadataKeys?.length
                    ? `（Metadata 仅 ${metadataKeys.join("、")}）`
                    : ""}
                </p>
              )}
              {operation === "rewrite" ? (
                <details key="rewrite-settings" className="space-y-3 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">高级设置</summary>
                  <p className="text-xs leading-relaxed text-muted-foreground">{configSummary}</p>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 font-medium">改写哪些内容</legend>
                    {fieldChoices}
                  </fieldset>
                </details>
              ) : operation === "clean" ? (
                <details key="clean-settings" className="space-y-3 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">高级设置</summary>
                  <p className="text-xs leading-relaxed text-muted-foreground">{configSummary}</p>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 font-medium">清洗范围</legend>
                    {fieldChoices}
                  </fieldset>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    未填补充要求时，仅整理所选字段的首尾空白；检查空值和重复，不删除记录。
                  </p>
                </details>
              ) : (
                <details key="generation-settings" className="space-y-3 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">高级设置</summary>
                  <p className="text-xs leading-relaxed text-muted-foreground">{configSummary}</p>
                  {!allowedFields.includes("question") && (
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={false}
                        disabled={busy}
                        onCheckedChange={(yes) => setField("question", yes === true)}
                      />
                      生成问题（原配置沿用参考值）
                    </label>
                  )}
                  {["expectedOutput", "metadata"].map((field) => (
                    <div key={field} className="space-y-2">
                      <span>{fieldNames[field]}</span>
                      <Select
                        disabled={busy}
                        value={allowedFields.includes(field) ? "generate" : "inherit"}
                        onValueChange={(value) => setField(field, value === "generate")}
                      >
                        <SelectTrigger aria-label={`${fieldNames[field]}生成方式`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherit">沿用参考值</SelectItem>
                          <SelectItem value="generate">由模型生成</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    类别标签可沿用；具体答案建议随新问题生成。沿用值来自对应参考记录。
                  </p>
                </details>
              )}
              <label className="block space-y-2 text-sm">
                <span>
                  {operation === "clean"
                    ? "补充要求（选填）"
                    : operation === "augment"
                      ? "生成要求"
                      : "具体要求"}
                </span>
                <Textarea
                  disabled={busy}
                  value={instructions}
                  maxLength={8000}
                  rows={4}
                  placeholder={
                    {
                      clean: "例如：统一标点，纠正错别字。",
                      rewrite: "例如：改为自然、口语化的提问。",
                      augment: "例如：增加不同场景的同类问题。",
                    }[operation]
                  }
                  onChange={(event) => {
                    setInstructions(event.target.value);
                    change();
                  }}
                />
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
function ProcessingRoundHistory({
  projectId,
  taskId,
  open,
  onOpenChange,
  initialRound,
}: {
  projectId: string;
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRound?: string | undefined;
}) {
  const [page, setPage] = useState(1),
    [round, setRound] = useState<string>(),
    [resultPage, setResultPage] = useState(1);
  useEffect(() => {
    if (open && initialRound) setRound(initialRound);
  }, [open, initialRound]);
  const actorId = useQueryClient().getQueryData<{ actor: { id: string } }>(["session"])?.actor.id;
  const history = useQuery({
    queryKey: ["processing-round-history", projectId, actorId, taskId, page],
    queryFn: () =>
      request<{ rounds: (Run & { roundNumber: number; savedCount: number })[]; total: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-tasks/${encodeURIComponent(taskId)}/history?limit=20&offset=${(page - 1) * 20}`,
      ),
    enabled: open,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["processing-round-readonly", projectId, actorId, round, resultPage],
    queryFn: () =>
      request<ResultPage>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(round!)}?view=all&limit=20&offset=${(resultPage - 1) * 20}`,
      ),
    enabled: open && Boolean(round),
    retry: false,
  });
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setRound(undefined);
      }}
    >
      <SheetContent
        className={
          round ? "w-full overflow-y-auto sm:max-w-5xl" : "w-full overflow-y-auto sm:max-w-lg"
        }
      >
        <SheetHeader>
          <SheetTitle>{round ? "历史轮次结果" : "轮次历史"}</SheetTitle>
          <SheetDescription>历史输入与结果保持不变；继续处理和保存使用当前成果。</SheetDescription>
        </SheetHeader>
        <div className="mt-5 space-y-4">
          {round ? (
            <>
              <Button variant="ghost" onClick={() => setRound(undefined)}>
                返回轮次历史
              </Button>
              {detail.isPending ? (
                <LoadingBlock rows={3} />
              ) : detail.isError ? (
                <p role="alert">{errorText(detail.error)}</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    本轮输出 {detail.data?.total ?? 0} 条
                  </p>
                  <ProcessingReview
                    rows={detail.data?.records ?? []}
                    selected={new Set()}
                    onToggle={() => {}}
                    disabled
                    generated={detail.data?.rootOperation === "augment"}
                    offset={(resultPage - 1) * 20}
                    total={detail.data?.total ?? 0}
                    onPageChange={setResultPage}
                  />
                  <Pagination
                    current={resultPage}
                    total={detail.data?.total ?? 0}
                    unit="条结果"
                    pages={Math.max(1, Math.ceil((detail.data?.total ?? 0) / 20))}
                    onChange={setResultPage}
                  />
                </>
              )}
            </>
          ) : (
            <>
              {history.isPending ? (
                <LoadingBlock rows={3} />
              ) : history.isError ? (
                <p role="alert">{errorText(history.error)}</p>
              ) : (
                history.data?.rounds.map((item) => (
                  <Card key={item.id}>
                    <CardContent className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-medium">
                          第 {item.roundNumber} 轮 · {labels[item.options.operation]}
                        </h3>
                        <ProcessingStatus run={item} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {item.actorName} · {new Date(item.createdAt).toLocaleString()} · 输入{" "}
                        {item.inputCount} / 输出 {item.outputCount ?? 0}
                      </p>
                      <p className="line-clamp-3 whitespace-pre-wrap text-sm">
                        {item.options.instructions || "整理首尾空白"}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {item.savedCount ? `已保存 ${item.savedCount} 条` : "未保存"}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRound(item.id);
                            setResultPage(1);
                          }}
                        >
                          查看本轮
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
              <Pagination
                current={page}
                total={history.data?.total ?? 0}
                unit="轮"
                pages={Math.max(1, Math.ceil((history.data?.total ?? 0) / 20))}
                onChange={setPage}
              />
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                返回当前成果
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
function ProcessingResults({
  projectId,
  runId,
  onBack,
  onFollowup,
  onCreated,
}: {
  projectId: string;
  runId: string;
  onBack: () => void;
  onFollowup: (mode: "continue" | "rerun" | "saved", ids: string[]) => void;
  onCreated: (id: string) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-tasks/${encodeURIComponent(runId)}`;
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
      selectionInitialized?: boolean;
      pendingSave?: { key: string; body: unknown };
      deduplication?: Deduplication;
      destination?: string;
      name?: string;
      targetDraftId?: string;
    }>(cacheKey),
  ).current;
  const [deduplication, setDeduplication] = useState<Deduplication | undefined>(
    position?.deduplication,
  );
  const [dedupPreview, setDedupPreview] = useState<Deduplication | null>(null);
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
  const [roundHistoryOpen, setRoundHistoryOpen] = useState(false);
  const [linkedRound, setLinkedRound] = useState<string>();
  const linkedRoundOpened = useRef(false);
  useEffect(() => {
    queryClient.setQueryData(cacheKey, {
      view,
      text,
      page,
      selected: [...selected],
      selectionInitialized: selectionInitialized.current,
      deduplication,
      pendingSave: submitted.current,
      destination,
      name,
      targetDraftId,
    });
  });
  const drafts = useQuery({
    queryKey: ["processing-target-drafts", projectId, actorId],
    queryFn: () =>
      request<{
        drafts: { id: string; name: string; parentVersionLabel: string | null; paused: boolean }[];
      }>(`/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts`),
    enabled: confirm,
  });
  const data = useQuery<ResultPage>({
    queryKey: ["processing-run", projectId, runId, actorId, page, view, text],
    placeholderData: (previous, query) =>
      query?.queryKey[1] === projectId &&
      query.queryKey[2] === runId &&
      query.queryKey[3] === actorId &&
      canRetainReadResult(query.state.error)
        ? previous
        : undefined,
    queryFn: ({ signal }) =>
      request<ResultPage>(
        `${path}?offset=${(page - 1) * 20}&limit=20&view=${view}&search=${encodeURIComponent(text)}`,
        { signal },
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
  const linkedTaskId = data.data?.task?.id;
  useEffect(() => {
    if (linkedTaskId && linkedTaskId !== runId && !linkedRoundOpened.current) {
      linkedRoundOpened.current = true;
      setLinkedRound(runId);
      setRoundHistoryOpen(true);
    }
  }, [linkedTaskId, runId]);
  const transient = canRetainReadResult(data.error);
  const value = transient ? (data.data ?? lastConfirmed.current) : undefined;
  useEffect(() => {
    const pages = Math.max(1, Math.ceil((value?.total ?? 0) / 20));
    if (data.isSuccess && !data.isPlaceholderData && page > pages) setPage(pages);
  }, [value?.total, data.isSuccess, data.isPlaceholderData, page]);
  async function action(kind: "cancel" | "retry") {
    setBusy(true);
    setError("");
    try {
      await post(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(value!.run.id)}/${kind}`,
        {},
      );
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
  const selectionInitialized = useRef(position?.selectionInitialized ?? Boolean(position));
  useEffect(() => {
    if (!value?.task || !data.isSuccess || data.isPlaceholderData) return;
    if (!selectionInitialized.current) {
      if (!["succeeded", "failed", "cancelled"].includes(value.run.status)) return;
      selectionInitialized.current = true;
      setSelected(new Set(value.unsavedIds ?? []));
    } else if (!unknownSave)
      setSelected((old) => new Set([...old].filter((id) => !value.adoptedIds?.includes(id))));
  }, [
    value?.task,
    value?.run.status,
    value?.unsavedIds,
    value?.adoptedIds,
    data.isSuccess,
    data.isPlaceholderData,
    unknownSave,
  ]);

  const completionSubmission = useRef<string | null>(null);
  async function completeMissing() {
    setBusy(true);
    setError("");
    const submitKey = completionSubmission.current ?? crypto.randomUUID();
    completionSubmission.current = submitKey;
    try {
      await post<{ run: { id: string } }>(
        `${path}/rounds`,
        { mode: "complete", expectedRevision: value!.task!.revision },
        submitKey,
      );
      completionSubmission.current = null;
      await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
      await data.refetch();
      onCreated(value!.task!.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspectDuplicates() {
    setBusy(true);
    setError("");
    try {
      setDedupPreview(
        await post<Deduplication>(`${path}/deduplication`, { resultIds: [...selected] }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
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
        submitted.current = {
          key,
          body: {
            resultIds: [...selected],
            target,
            expectedRevision: value!.task!.revision,
          },
        };
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
      setDeduplication(undefined);
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
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
  if (data.isPending && !value)
    return (
      <div className="space-y-4" aria-busy="true">
        <Card>
          <CardContent className="space-y-3 p-4">
            <LoadingBlock rows={2} />
            <QueryFeedback busy message="正在读取处理结果…" />
          </CardContent>
        </Card>
        <TableLoadingBlock
          columns={["选择", "问题 / 来源", "期望输出 / 变化", "Metadata / 变化"]}
        />
      </div>
    );
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
  const usableCount =
      value.task?.latestUsableCount ?? value.usableCount ?? run.outputCount ?? value.total,
    completionMissing = Math.max(0, (run.options.outputCount ?? 0) - usableCount);
  const stale = data.isPlaceholderData || !data.data;
  const saved = value.receipts?.length ? value.receipts : receipt ? [receipt] : [];
  const savedSelection = [...selected].filter((id) => value.adoptedIds?.includes(id));
  const sourceDraft = run.source.kind === "draft";
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{value.task?.title ?? "当前成果"}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                第 {value.task?.roundCount ?? 1} 轮 · {labels[run.options.operation]} · 当前成果{" "}
                {value.task?.currentCount ?? value.total} 条
              </p>
              <div
                role="status"
                className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              >
                <ProcessingStatus run={run} />
                <span>
                  {value.task
                    ? `本轮输入 ${run.inputCount} · 输出 ${run.outputCount ?? 0} · 当前未保存 ${value.task.unsavedCount} 条`
                    : run.options.operation === "augment"
                      ? `已获得 ${usableCount} / ${run.options.outputCount ?? run.inputCount} 条有效结果`
                      : `已产生 ${run.outputCount ?? value.stats?.all ?? value.total} / ${run.inputCount} 条结果`}
                  {(run.options.operation === "augment" ? completionMissing : run.missingCount)
                    ? ` · 尚缺 ${run.options.operation === "augment" ? completionMissing : run.missingCount} 条`
                    : ""}
                  {value.stats?.needsReview ? ` · ${value.stats.needsReview} 条自动检查问题` : ""}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setLinkedRound(undefined);
                  setRoundHistoryOpen(true);
                }}
              >
                轮次历史（{value.task?.roundCount ?? 1}）
              </Button>
              {terminal && value.task?.canContinueSaved && (
                <Button
                  variant="outline"
                  disabled={busy || unknownSave || stale || data.isError}
                  onClick={() => onFollowup("saved", [])}
                >
                  基于已保存草稿继续
                </Button>
              )}
              {terminal && value.recovery?.canContinue && (
                <Button
                  variant="outline"
                  disabled={busy || unknownSave || stale || data.isError}
                  onClick={() => void completeMissing()}
                >
                  {run.options.operation === "augment"
                    ? `补齐剩余 ${completionMissing} 条`
                    : "继续处理未完成部分"}
                </Button>
              )}
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
                value.recovery?.canRetry && (
                  <Button variant="outline" disabled={busy} onClick={() => void action("retry")}>
                    重试未完成部分
                  </Button>
                )
              )}
            </div>
          </div>
          {terminal && ((run.missingCount ?? 0) > 0 || run.status === "failed") && (
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>
                {diagnosticLabels[value.recovery?.reason ?? ""] ?? "本轮未全部完成，已有结果保留。"}
              </p>
              <details>
                <summary className="cursor-pointer">查看执行说明</summary>
                {value.diagnostics?.length ? (
                  <div className="mt-2 space-y-3">
                    {value.diagnostics.map((batch) => (
                      <div key={batch.batch}>
                        <p>
                          批次 {batch.batch + 1} · 最终有效 {batch.accepted} 条 · 缺少{" "}
                          {batch.missing} 条 · 已调用 {batch.attempts} 次
                        </p>
                        <ul className="mt-1 space-y-1">
                          {batch.calls.map((call) => (
                            <li key={call.attempt} className="break-words">
                              第 {call.attempt} 次：{diagnosticLabels[call.code] ?? "未记录"} ·{" "}
                              {(call.durationMs / 1000).toFixed(1)} 秒 · 返回 {call.generated} /
                              校验通过 {call.validated} / 重复剔除 {call.duplicates} / 其他无效{" "}
                              {call.invalid} / 接受 {call.accepted}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2">历史任务未记录具体原因。</p>
                )}
              </details>
            </div>
          )}
          {!value.task && run.parentRunId && (
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
      <ProcessingRoundHistory
        projectId={projectId}
        taskId={value.task?.id ?? runId}
        open={roundHistoryOpen}
        onOpenChange={setRoundHistoryOpen}
        initialRound={linkedRound}
      />
      {value.task?.incomplete && terminal && (
        <p role="status" className="text-sm text-muted-foreground">
          本轮未全部完成；未完成记录保留此前值。
        </p>
      )}
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
          ["duplicates", "只看重复"],
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
            {value.stats?.[
              key === "issues" ? "needsReview" : (key as "all" | "changed" | "duplicates")
            ] ?? (key === "all" ? value.total : "")}
          </Button>
        ))}
      </div>
      <Card className="min-w-0 overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              disabled={
                !terminal || busy || data.isError || stale || unknownSave || Boolean(deduplication)
              }
              onClick={() => {
                setSelected(
                  (old) =>
                    new Set([
                      ...old,
                      ...value.records.filter((r) => !r.unprocessed).map((r) => r.id),
                    ]),
                );
                setKey(crypto.randomUUID());
              }}
            >
              勾选本页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !terminal || busy || data.isError || stale || unknownSave || Boolean(deduplication)
              }
              onClick={() => {
                setSelected(
                  (old) =>
                    new Set([
                      ...old,
                      ...value.allIds.filter((id) => !value.unprocessedIds?.includes(id)),
                    ]),
                );
                setKey(crypto.randomUUID());
              }}
            >
              选择全部匹配结果
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || unknownSave || Boolean(deduplication)}
              onClick={() => {
                setSelected(new Set());
                setKey(crypto.randomUUID());
              }}
            >
              清空选择
            </Button>
            {(value.task?.excludedCount ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || unknownSave}
                onClick={() =>
                  void post<{ restoredIds: string[] }>(`${path}/deduplication`, {
                    action: "restore",
                    expectedRevision: value.task!.revision,
                  })
                    .then((response) => {
                      setSelected((old) => new Set([...old, ...response.restoredIds]));
                      return data.refetch();
                    })
                    .catch((e) => setError(errorText(e)))
                }
              >
                恢复排除（{value.task?.excludedCount ?? 0}）
              </Button>
            ) : (value.duplicateCount ?? value.stats?.duplicates ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !terminal || busy || unknownSave || stale || data.isError || !selected.size
                }
                onClick={() => void inspectDuplicates()}
              >
                去重
              </Button>
            ) : null}
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
              {sourceDraft
                ? "保存回原草稿"
                : run.missingCount
                  ? `采用现有 ${selected.size} 条`
                  : `保存所选 ${selected.size} 条`}
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
                value.recovery?.canRetry ? (
                  "暂无可用结果；可重试未完成部分。"
                ) : value.recovery?.canContinue ? (
                  "暂无可用结果；可继续未完成部分。"
                ) : (
                  "暂无可用结果。"
                )
              ) : (
                "请先选择要继续处理的结果。"
              )}
            </div>
          )}
          <div className="border-b px-4">
            <QueryFeedback
              busy={data.isFetching}
              message={stale ? "正在更新条件，读取完成后可选择。" : "正在更新任务状态…"}
            />
          </div>
          <ProcessingReview
            rows={value.records}
            selected={selected}
            disabled={
              !terminal || busy || data.isError || stale || unknownSave || Boolean(deduplication)
            }
            generated={value.rootOperation === "augment" || run.options.operation === "augment"}
            offset={stale ? (value.offset ?? (page - 1) * 20) : (page - 1) * 20}
            total={value.total}
            pageSize={20}
            onPageChange={setPage}
            loading={stale}
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
        open={Boolean(dedupPreview)}
        onOpenChange={(open) => {
          if (!open) setDedupPreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>检查重复内容</DialogTitle>
            <DialogDescription>
              检查 {dedupPreview?.inspected} 条，每组保留一条，排除{" "}
              {dedupPreview?.excludedIds.length} 条。仅比较问题、期望输出和 Metadata
              完全相同的内容。
            </DialogDescription>
          </DialogHeader>
          {dedupPreview?.removedRecordIds.length ? (
            <p className="text-sm text-muted-foreground">
              保存回原草稿时，将在确认后移除 {dedupPreview.removedRecordIds.length}{" "}
              条重复原记录；其他保存目标不删除原记录。
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDedupPreview(null)}>
              取消
            </Button>
            <Button
              disabled={!dedupPreview?.excludedIds.length}
              onClick={async () => {
                if (!dedupPreview) return;
                setBusy(true);
                try {
                  await post(`${path}/deduplication`, {
                    resultIds: dedupPreview.checkedIds,
                    action: "exclude",
                    expectedRevision: value.task!.revision,
                  });
                  setSelected(new Set(dedupPreview.keptIds));
                  setKey(crypto.randomUUID());
                  setDedupPreview(null);
                  await data.refetch();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              排除重复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
              {value.task
                ? `保存所选 ${selected.size} 条${destination === "draft" ? `：更新 ${[...selected].filter((id) => value.saveDisposition?.updateIds.includes(id)).length} 条，新增 ${[...selected].filter((id) => value.saveDisposition?.addIds.includes(id)).length} 条，移除 ${value.saveDisposition?.removeCount ?? 0} 条排除的原记录` : destination === "asset" ? "到原始数据" : "到草稿"}。当前仍有 ${Math.max(0, value.task.unsavedCount - selected.size)} 条未选择。`
                : destination === "draft" &&
                    value.rootOperation !== "augment" &&
                    run.options.operation !== "augment"
                  ? `更新 ${selected.size} 条记录的指定字段（${(value.adoptionFields ?? run.options.allowedFields)?.map((field) => ({ question: "问题", expectedOutput: "期望输出", metadata: "Metadata" })[field as "question"]).join("、") ?? "未记录"}）。`
                  : destination === "asset"
                    ? `保存 ${selected.size} 条到独立原始数据文件。`
                    : `向草稿追加 ${selected.size} 条记录。`}{" "}
              {destination === "draft" && deduplication
                ? `更新 ${value.rootOperation === "augment" ? 0 : selected.size} 条、新增 ${value.rootOperation === "augment" ? selected.size : 0} 条、移除 ${deduplication.removedRecordIds.length} 条重复原记录。`
                : ""}
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
