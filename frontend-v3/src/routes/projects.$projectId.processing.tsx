import { useState, useRef } from "react";
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
import { MetadataSummary } from "@/components/material-record-table";
import { request, type MetadataEntry } from "@/services/workspace";
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
type Run = {
  id: string;
  source: { kind: string; id?: string };
  options: { operation: "clean" | "rewrite" | "augment"; instructions: string };
  status: string;
  partial?: boolean;
  missingCount?: number;
  progress: number;
  inputCount: number;
  createdAt: string;
  errorCode: string | null;
  result?: { partial?: boolean };
};
type ResultPage = {
  run: Run;
  records: { id: string; original: InputRecord; result: RecordValue }[];
  total: number;
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
  const path = `/api/projects/${encodeURIComponent(projectId)}/processing-runs`;
  const runs = useQuery({
    queryKey: ["processing-runs", projectId],
    queryFn: () => request<{ runs: Run[] }>(path),
    enabled: access.canWrite,
    refetchInterval: 5000,
  });
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
      <PageHeader
        title="数据处理"
        description="选择记录、提交处理，核对结果后再采用。原件和正式版本保持不变。"
        actions={
          <Button variant="outline" asChild>
            <Link to="/projects/$projectId/test-sets" params={{ projectId }}>
              返回测试集
            </Link>
          </Button>
        }
      />
      {access.isPending ? (
        <p>正在读取权限…</p>
      ) : !access.canWrite ? (
        <p role="alert">编辑权限才能运行处理和查看未发布结果。</p>
      ) : (
        <>
          {source && !runId && (
            <ProcessingForm
              key={`${source.kind}:${search.sourceId}`}
              projectId={projectId}
              source={source}
              onCreated={async (id) => {
                await queryClient.invalidateQueries({ queryKey: ["processing-runs", projectId] });
                await navigate({ search: { ...search, run: id } });
              }}
            />
          )}
          {runId && (
            <ProcessingResults
              key={runId}
              projectId={projectId}
              runId={runId}
              onBack={() => {
                void navigate({ search: { ...search, run: undefined } });
              }}
            />
          )}
          <section className="overflow-hidden rounded-md border bg-card shadow-sm">
            <div className="border-b px-5 py-4">
              <h2 className="font-semibold">处理任务</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                关闭页面后，已提交的任务仍会继续。最多显示最近 100 项。
              </p>
            </div>
            {runs.error ? (
              <div className="p-5" role="alert">
                <p>{errorText(runs.error)}</p>
                <Button variant="outline" onClick={() => void runs.refetch()}>
                  重试
                </Button>
              </div>
            ) : !runs.data?.runs.length ? (
              <p className="p-5 text-sm text-muted-foreground">
                暂无处理任务。打开原始文件、版本或草稿，点击“处理数据”开始。
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/60 text-left text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3">任务</th>
                      <th className="px-4 py-3">输入记录</th>
                      <th className="px-4 py-3">状态</th>
                      <th className="px-4 py-3">创建时间</th>
                      <th className="px-5 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.data.runs.map((run) => (
                      <tr key={run.id} className="border-t">
                        <td className="px-5 py-4 font-medium">
                          {labels[run.options.operation]} · {run.inputCount} 条输入
                        </td>
                        <td className="px-4 py-4">{run.inputCount} 条</td>
                        <td className="px-4 py-4">
                          {run.partial ? "部分成功，待核对" : statuses[run.status]}
                          {run.status === "running" ? ` ${run.progress}%` : ""}
                        </td>
                        <td className="px-4 py-4 text-muted-foreground">
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
          </section>
        </>
      )}
    </div>
  );
}
function ProcessingForm({
  projectId,
  source,
  onCreated,
}: {
  projectId: string;
  source: Record<string, unknown>;
  onCreated: (id: string) => Promise<void>;
}) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [operation, setOperation] = useState<"clean" | "rewrite" | "augment">("clean");
  const [instructions, setInstructions] = useState(""),
    [allowedFields, setAllowedFields] = useState(["question"]),
    [count, setCount] = useState("20"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [operationKey, setOperationKey] = useState(() => crypto.randomUUID());
  const input = useQuery({
    queryKey: ["processing-inputs", projectId, source, page],
    queryFn: () =>
      post<{ records: InputRecord[]; allIds: string[]; total: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-inputs`,
        { source, offset: (page - 1) * 20, limit: 20 },
      ),
    refetchOnWindowFocus: false,
  });
  function change() {
    setOperationKey(crypto.randomUUID());
    setError("");
  }
  async function submit() {
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
      await onCreated(result.run.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
      <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
        <div className="space-y-3 border-b px-5 py-4">
          <h2 className="font-semibold">选择输入记录</h2>
          <p className="text-sm text-muted-foreground">
            已选 {selected.size} / {input.data?.total ?? 0} 条。可先选少量记录验证效果。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !input.data}
              onClick={() => {
                setSelected(new Set(input.data?.records.map((r) => r.id)));
                change();
              }}
            >
              仅选择本页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !input.data}
              onClick={() => {
                setSelected(new Set(input.data?.allIds));
                change();
              }}
            >
              选择全部记录
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(new Set());
                change();
              }}
            >
              清空选择
            </Button>
          </div>
        </div>
        {input.error ? (
          <p className="p-5" role="alert">
            {errorText(input.error)}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/60 text-left text-muted-foreground">
                <tr>
                  <th className="w-12 px-4 py-3">
                    <span className="sr-only">选择</span>
                  </th>
                  <th className="px-4 py-3">问题 / 原始内容</th>
                  <th className="px-4 py-3">期望输出</th>
                </tr>
              </thead>
              <tbody>
                {input.data?.records.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-4 py-3">
                      <Checkbox
                        aria-label={`选择记录 ${row.id}`}
                        disabled={busy}
                        checked={selected.has(row.id)}
                        onCheckedChange={(checked) => {
                          setSelected((old) => {
                            const next = new Set(old);
                            if (checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          });
                          change();
                        }}
                      />
                    </td>
                    <td className="max-w-md break-words px-4 py-3">
                      <details>
                        <summary className="cursor-pointer line-clamp-2">
                          {row.question || JSON.stringify(row.raw) || "空问题"}
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap break-all font-sans">
                          {row.raw ? JSON.stringify(row.raw, null, 2) : row.question}
                        </pre>
                        <MetadataSummary entries={row.metadata} />
                      </details>
                    </td>
                    <td className="max-w-xs break-words px-4 py-3">{row.expectedOutput || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 pb-3">
          <Pagination
            current={page}
            total={input.data?.total ?? 0}
            unit="条记录"
            pages={Math.max(1, Math.ceil((input.data?.total ?? 0) / 20))}
            onChange={setPage}
          />
        </div>
      </section>
      <section className="min-w-0 space-y-5 rounded-md border bg-card p-5 shadow-sm">
        <h2 className="font-semibold">处理要求</h2>
        <label className="block space-y-2 text-sm">
          <span>处理方式</span>
          <Select
            value={operation}
            disabled={busy}
            onValueChange={(v) => {
              setOperation(v as typeof operation);
              change();
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(labels).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="block space-y-2 text-sm">
          <span>{operation === "clean" ? "补充要求（选填）" : "处理要求"}</span>
          <Textarea
            disabled={busy}
            value={instructions}
            maxLength={8000}
            rows={5}
            placeholder={
              operation === "augment"
                ? "例如：围绕这些问题的意图，生成不同措辞和场景，保持测试类型一致。"
                : "例如：保留原意，改写为清晰、独立的问题。"
            }
            onChange={(e) => {
              setInstructions(e.target.value);
              change();
            }}
          />
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          清洗不填补充要求时，只整理首尾空白并提示空值、重复内容。填写要求、改写和扩充会调用管理员配置的模型。
        </p>
        <fieldset className="space-y-3">
          <legend className="mb-3 text-sm font-medium">允许修改的字段</legend>
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
                    yes ? [...old, field!] : old.filter((v) => v !== field),
                  );
                  change();
                }}
              />
              {label}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">未勾选的字段保留对应输入记录的原值。</p>
        </fieldset>
        {operation === "augment" && (
          <label className="block space-y-2 text-sm">
            <span>生成记录数量</span>
            <Input
              type="number"
              min={1}
              max={10000}
              value={count}
              disabled={busy}
              onChange={(e) => {
                setCount(e.target.value);
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
        <Button
          className="w-full"
          disabled={
            busy ||
            !selected.size ||
            !allowedFields.length ||
            (operation !== "clean" && !instructions.trim())
          }
          onClick={() => void submit()}
        >
          {busy ? "正在提交…" : `开始${labels[operation]} · ${selected.size} 条输入`}
        </Button>
      </section>
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
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [destination, setDestination] = useState("asset"),
    [name, setName] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [receipt, setReceipt] = useState<{
      assetId: string;
      draftId: string | null;
      adopted: number;
    } | null>(null);
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
    queryKey: ["processing-run", projectId, runId, page],
    queryFn: () => request<ResultPage>(`${path}?offset=${(page - 1) * 20}&limit=20`),
    refetchInterval: (q) =>
      ["queued", "running", "retry_wait", "cancel_requested"].includes(
        q.state.data?.run.status ?? "",
      )
        ? 3000
        : false,
  });
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
  async function accept() {
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
        receipt: { assetId: string; draftId: string | null; adopted: number };
      }>(`${path}/accept`, submitted.current!.body, key);
      setReceipt(result.receipt);
      setConfirm(false);
      setSelected(new Set());
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (data.isPending) return <p>正在读取处理结果…</p>;
  if (data.error || !data.data)
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
  const value = data.data,
    run = value.run,
    terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">{labels[run.options.operation]}结果</h2>
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {run.partial ? "部分成功，待核对" : statuses[run.status]} · {run.progress}% · 已产生{" "}
            {value.total} 条结果
            {run.missingCount ? ` · 尚缺 ${run.missingCount} 条` : ""}
            {value.issues.length ? ` · ${value.issues.length} 项需核对` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onBack}>
            返回任务
          </Button>
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
                    {(
                      {
                        empty_question: "问题为空",
                        duplicate_content: "内容重复",
                        missing_output: "缺少结果",
                        excess_output: "已忽略超量结果",
                        invalid_output: "格式无效",
                        unknown_source: "来源不匹配",
                        duplicate_source: "同一来源重复返回",
                        processing_batch_failed: "批次调用失败",
                      } as Record<string, string>
                    )[issue.code] ?? "结果需要核对"}
                    {issue.count ? `：${issue.count}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {receipt && (
        <div role="status" className="border-b px-5 py-3 text-sm">
          已采用 {receipt.adopted} 条结果并保存派生文件。
          {receipt.draftId && (
            <Link
              className="ml-2 text-primary"
              to="/projects/$projectId/test-sets/drafts/$draftId"
              params={{ projectId, draftId: receipt.draftId }}
            >
              打开草稿
            </Link>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!terminal || busy}
          onClick={() => {
            setSelected((old) => new Set([...old, ...value.records.map((r) => r.id)]));
            setKey(crypto.randomUUID());
          }}
        >
          选择本页有效结果
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!terminal || busy}
          onClick={() => {
            setSelected(new Set(value.allIds));
            setKey(crypto.randomUUID());
          }}
        >
          选择全部有效结果
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setSelected(new Set());
            setKey(crypto.randomUUID());
          }}
        >
          清空选择
        </Button>
        <span className="text-sm text-muted-foreground">已选 {selected.size} 条</span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!terminal || busy || !selected.size}
          onClick={() => setConfirm(true)}
        >
          采用选中结果
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-muted/60 text-left text-muted-foreground">
            <tr>
              <th className="w-12 px-4 py-3">
                <span className="sr-only">选择</span>
              </th>
              <th className="px-4 py-3">原文</th>
              <th className="px-4 py-3">处理结果</th>
            </tr>
          </thead>
          <tbody>
            {value.records.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="px-4 py-4">
                  <Checkbox
                    aria-label={`采用结果 ${row.id}`}
                    disabled={!terminal || busy}
                    checked={selected.has(row.id)}
                    onCheckedChange={(yes) => {
                      setSelected((old) => {
                        const next = new Set(old);
                        if (yes) next.add(row.id);
                        else next.delete(row.id);
                        return next;
                      });
                      setKey(crypto.randomUUID());
                    }}
                  />
                </td>
                {[row.original, row.result].map((record, i) => (
                  <td key={i} className="space-y-2 break-words px-4 py-4">
                    <p className="whitespace-pre-wrap">{record.question || "空问题"}</p>
                    <details>
                      <summary className="cursor-pointer text-xs text-primary">
                        期望输出与 Metadata
                      </summary>
                      <p className="my-2 whitespace-pre-wrap">{record.expectedOutput || "—"}</p>
                      <MetadataSummary entries={record.metadata} />
                    </details>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
            <DialogTitle>采用 {selected.size} 条处理结果</DialogTitle>
            <DialogDescription>
              确认后保存独立派生文件，并按所选方式写入草稿。正式版本不会被覆盖。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-2 text-sm">
              <span>保存到</span>
              <Select
                value={destination}
                disabled={busy}
                onValueChange={(v) => {
                  setDestination(v);
                  setKey(crypto.randomUUID());
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asset">仅保存为派生原始文件</SelectItem>
                  <SelectItem value="newDraft">保存并建立新测试集草稿</SelectItem>
                  <SelectItem value="existingDraft">追加到已有草稿</SelectItem>
                  {run.source.kind === "draft" && (
                    <SelectItem value="draft">
                      {run.options.operation === "augment"
                        ? "追加到来源草稿"
                        : "更新来源草稿的对应字段"}
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
                  disabled={busy}
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
                  disabled={busy}
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
              {busy ? "正在采用…" : "确认采用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
