import { useState, useRef, useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
  validateSearch: (value: Record<string, unknown>) => ({
    source:
      typeof value["source"] === "string" &&
      ["assets", "draft", "version"].includes(value["source"])
        ? (value["source"] as "assets" | "draft" | "version")
        : undefined,
    sourceId: typeof value["sourceId"] === "string" ? value["sourceId"] : undefined,
    run: typeof value["run"] === "string" ? value["run"] : undefined,
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
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-runs`;
  const runs = useQuery({
    queryKey: ["processing-runs", projectId],
    queryFn: () => request<{ runs: Run[] }>(path),
    enabled: access.canWrite && !search.run && !(search.source && search.sourceId),
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
    search.source && search.sourceId
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
                <Button onClick={() => setCreating(true)}>新建处理</Button>
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
              key={`${projectId}:${source.kind}:${search.sourceId}`}
              projectId={projectId}
              source={source}
              actorId={
                queryClient.getQueryData<{ actor: { id: string } }>(["session"])?.actor.id ?? ""
              }
              onCreated={async (id) => {
                await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
                await navigate({ search: { ...search, run: id } });
              }}
            />
          )}
          {runId && (
            <ProcessingResults
              key={`${projectId}:${runId}`}
              projectId={projectId}
              runId={runId}
              onBack={() => {
                void navigate({
                  search: { source: undefined, sourceId: undefined, run: undefined },
                });
              }}
            />
          )}
          {!source && !runId && (
            <section className="overflow-hidden rounded-md border bg-card shadow-sm">
              <div className="border-b px-5 py-4">
                <h2 className="font-semibold">处理任务</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  关闭页面后，已提交的任务仍会继续。最多显示最近 100 项。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
                <Input
                  aria-label="搜索处理任务"
                  placeholder="搜索来源或处理要求"
                  className="w-full sm:max-w-xs"
                  value={historySearch}
                  maxLength={200}
                  onChange={(event) => {
                    setHistorySearch(event.target.value);
                    setHistoryPage(1);
                  }}
                />
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
                    <thead className="bg-muted/60 text-left text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3">任务</th>
                        <th className="px-4 py-3">输入记录</th>
                        <th className="px-4 py-3">状态</th>
                        <th className="px-4 py-3">发起人 / 时间</th>
                        <th className="px-5 py-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.slice((historyPage - 1) * 20, historyPage * 20).map((run) => (
                        <tr key={run.id} className="border-t">
                          <td className="px-5 py-4 font-medium">
                            {run.sourceSummary?.name ?? "来源未记录"} ·{" "}
                            {labels[run.options.operation]}
                            <p className="mt-1 text-xs text-muted-foreground">
                              {run.sourceSummary?.kindLabel ?? "来源类型未记录"}
                            </p>
                            <p
                              className="mt-1 max-w-sm truncate text-xs font-normal text-muted-foreground"
                              title={run.options.instructions}
                            >
                              {run.options.instructions || "未记录处理要求"}
                            </p>
                          </td>
                          <td className="px-4 py-4">{run.inputCount} 条</td>
                          <td className="px-4 py-4">
                            {run.status === "succeeded" && run.executionComplete === false
                              ? "部分完成，需核对执行"
                              : statuses[run.status]}
                            {run.status === "running" ? ` ${run.progress}%` : ""}
                            <p className="mt-1 text-xs text-muted-foreground">
                              {run.hasSavedResult ? "有保存记录" : "暂无保存记录"}
                            </p>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">
                            <p>{run.actorName ?? "未记录"}</p>
                            {new Date(run.createdAt).toLocaleString()}
                          </td>
                          <td className="px-5 py-4 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void navigate({
                                  search: { run: run.id, source: undefined, sourceId: undefined },
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
              <div className="px-5 pb-4">
                <Pagination
                  current={historyPage}
                  total={history.length}
                  pages={Math.max(1, Math.ceil(history.length / 20))}
                  unit="项匹配任务（最近 100 项范围）"
                  onChange={setHistoryPage}
                />
              </div>
            </section>
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
  queryClient.setQueryDefaults(["processing-config"], { gcTime: Infinity });
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
    }>(cacheKey),
  ).current;
  const sourceRevision = useRef(saved?.sourceRevision);
  const submittedConfig = useRef(false);
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
    });
  });
  function change() {
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
    if (busy || reason || input.isError || input.isFetching || scopeChanged) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ run: Run }>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs`,
        {
          source: { ...source, recordIds: [...selected] },
          options: {
            operation,
            instructions,
            allowedFields,
            ...(operation === "augment" ? { outputCount: Number(count) } : {}),
          },
        },
        operationKey,
      );
      submittedConfig.current = true;
      queryClient.removeQueries({ queryKey: cacheKey, exact: true });
      await onCreated(result.run.id);
    } catch (e) {
      setError(errorText(e));
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
        description={`${visibleInput?.sourceSummary?.kindLabel ?? "来源读取中"} · 共 ${visibleInput?.sourceTotal ?? visibleInput?.total ?? 0} 条 · 已选 ${selected.size} 条`}
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link
                to="/projects/$projectId/processing"
                params={{ projectId }}
                search={{ source: undefined, sourceId: undefined, run: undefined }}
              >
                返回处理任务
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
      <div className="sticky top-12 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 text-sm xl:hidden">
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
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
          <div className="space-y-3 border-b px-5 py-4">
            <h2 className="font-semibold">选择输入记录</h2>
            <ProcessingFilters
              search={search}
              conditions={conditions}
              metadataKeys={visibleInput?.metadataKeys ?? []}
              disabled={busy}
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
                disabled={busy || !visibleInput || input.isFetching}
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
                disabled={busy || !visibleInput || input.isFetching}
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
                disabled={busy || !selected.size}
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
                  disabled={busy}
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
              {selected.size} 条{hidden > 0 && visibleInput ? `（${hidden} 条在当前筛选外）` : ""}
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
                <thead className="bg-muted/60 text-left text-muted-foreground">
                  <tr>
                    <th className="w-12 px-3 py-3">
                      <Checkbox
                        aria-label="选择本页记录"
                        disabled={
                          busy || input.isFetching || !visibleInput?.records.length || scopeChanged
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
                    <th className="px-3 py-3">问题 / 原始内容</th>
                    <th className="w-[22%] px-3 py-3">期望输出</th>
                    <th className="w-[30%] px-3 py-3">Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInput?.records.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="px-3 py-3">
                        <Checkbox
                          aria-label={`选择记录 ${row.id}`}
                          disabled={busy || input.isFetching || scopeChanged}
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
                      <td className="break-words px-3 py-3">
                        <details>
                          <summary className="cursor-pointer line-clamp-2">
                            {row.question || JSON.stringify(row.raw) || "（空问题）"}
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap break-words">
                            {row.raw ? JSON.stringify(row.raw, null, 2) : row.question}
                          </p>
                        </details>
                      </td>
                      <td className="px-3 py-3">
                        <details>
                          <summary className="cursor-pointer line-clamp-2 break-words">
                            {row.expectedOutput || "（空值）"}
                          </summary>
                          <p className="whitespace-pre-wrap break-words">
                            {row.expectedOutput || "（空值）"}
                          </p>
                        </details>
                      </td>
                      <td className="px-3 py-3">
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
        </section>
        <section
          id="processing-settings"
          className="scroll-mt-28 min-w-0 space-y-4 rounded-md border bg-card p-5 shadow-sm xl:sticky xl:top-20"
        >
          <h2 className="font-semibold">处理要求</h2>
          <div className="space-y-2 text-sm">
            <label>要做什么</label>
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
            <p className="text-xs text-muted-foreground">
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
              <p className="text-xs text-muted-foreground">请填写{labels[operation]}要求后开始。</p>
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
              {invalidCount && <p className="text-xs text-destructive">请输入 1–10,000 的整数。</p>}
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
        </section>
      </div>
    </div>
  );
}
function ProcessingResults({
  projectId,
  runId,
  onBack,
}: {
  projectId: string;
  runId: string;
  onBack: () => void;
}) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(runId)}`;
  const [view, setView] = useState("all");
  const [text, setText] = useState("");
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [destination, setDestination] = useState("asset"),
    [name, setName] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [receipt, setReceipt] = useState<Receipt | null>(null);
  const queryClient = useQueryClient();
  const [targetDraftId, setTargetDraftId] = useState("");
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
  const submitted = useRef<{ key: string; body: unknown } | null>(null);
  const [unknownSave, setUnknownSave] = useState(false);
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
      const result = await post<{
        receipt: Receipt;
      }>(`${path}/accept`, submitted.current!.body, key);
      setReceipt(result.receipt);
      setUnknownSave(false);
      setConfirm(false);
      setSelected(new Set());
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      await data.refetch();
    } catch (e) {
      setError(errorText(e));
      const code = e instanceof Error ? e.message : "";
      const rejected = [
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
  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">{labels[run.options.operation]}结果</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {run.sourceSummary?.name ?? "来源未记录"}
          </p>
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {run.status === "succeeded" && run.executionComplete === false
              ? "部分完成，仍需核对执行结果"
              : statuses[run.status]}{" "}
            · 已产生 {run.outputCount ?? value.stats?.all ?? value.total} /{" "}
            {run.options.outputCount ?? run.inputCount} 条结果
            {run.missingCount ? ` · 尚缺 ${run.missingCount} 条` : ""}
            {value.stats?.needsReview ? ` · ${value.stats.needsReview} 条自动检查问题` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
      {data.isError && (
        <div role="alert" className="border-b bg-muted/40 px-5 py-3 text-sm">
          状态读取中断，下面保留上次确认的结果；不能确认当前进度。
          <Button variant="ghost" size="sm" onClick={() => void data.refetch()}>
            重试读取
          </Button>
        </div>
      )}
      <details className="border-b px-5 py-3 text-sm">
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
      {(error || run.errorCode || value.issues.length > 0) && (
        <div role="alert" className="border-b bg-muted/40 px-5 py-3 text-sm">
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
        <div key={index} role="status" className="flex flex-wrap gap-2 border-b px-5 py-3 text-sm">
          <span>已保存 {item.adopted} 条处理结果，并建立独立文件。</span>
          {item.draftId && (
            <Link
              className="text-primary"
              to="/projects/$projectId/test-sets/drafts/$draftId"
              params={{ projectId, draftId: item.draftId }}
            >
              打开草稿
            </Link>
          )}
          {item.collectionId && (
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
      <div className="flex flex-wrap gap-2 border-b px-5 py-3" aria-label="结果筛选">
        <Input
          aria-label="搜索处理结果"
          placeholder="搜索问题、期望输出、Metadata 或来源"
          className="w-full sm:max-w-xs"
          value={text}
          maxLength={200}
          onChange={(event) => {
            setText(event.target.value);
            setPage(1);
          }}
        />
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
        <span className="ml-auto self-center text-xs text-muted-foreground">
          结构检查通过不代表内容正确，请审核后保存。
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
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
          className="ml-auto"
          disabled={!terminal || busy || !selected.size || data.isError || stale}
          onClick={() => setConfirm(true)}
        >
          保存所选 {selected.size} 条
        </Button>
      </div>
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
      <div className="px-5 pb-4">
        <Pagination
          current={page}
          total={value.total}
          unit="条结果"
          pages={Math.max(1, Math.ceil(value.total / 20))}
          onChange={setPage}
        />
      </div>
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
              {destination === "draft" && run.options.operation !== "augment"
                ? `更新 ${selected.size} 条记录的指定字段（${run.options.allowedFields?.map((field) => ({ question: "问题", expectedOutput: "期望输出", metadata: "Metadata" })[field as "question"]).join("、") ?? "未记录"}）。`
                : destination === "asset"
                  ? `保存 ${selected.size} 条到独立原始数据文件。`
                  : `向草稿追加 ${selected.size} 条记录。`}{" "}
              同时保留独立处理文件，原件与正式版本保持不变。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
                只采用本次允许修改的字段。同字段已被他人修改时会停止采用并保留其内容。
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
                (destination === "newDraft" && !name.trim()) ||
                (destination === "existingDraft" && !targetDraftId)
              }
              onClick={() => void accept()}
            >
              {busy ? "正在保存…" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
