import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { request, canRetainReadResult } from "@/services/workspace";
import {
  ProcessingReview,
  ContentReviewSummary,
  issueLabels,
  type ContentStats,
  type ReviewRow,
} from "@/components/processing-review";

export type CandidateSelection =
  | { runId: string; resultIds: string[] }
  | { scope: "task"; reviewRevision: string; resultIds: string[] };
type CandidatePage = {
  records: ReviewRow[];
  total: number;
  offset?: number;
  allIds?: string[];
  taskTotal?: number;
  reviewRevision?: string;
  savedIds?: string[];
  savedCount?: number;
  saveTarget?: { kind: "draft"; id: string };
  history?: { runId: string; round: number; operation: string; status: string; count: number }[];
  selection?: {
    scope: "task";
    reviewRevision: string;
    previousReviewRevision: string;
    resultIds: string[];
  };
  rootOperation?: string;
  stats?: ContentStats;
  ineffectiveIds?: string[];
  issues?: { code: string; count?: number; inputOrdinal?: number }[];
};
export function AssistantCandidates({
  base,
  sessionId,
  runId,
  scopeHash,
  actorId = "",
  active = true,
  readOnly = false,
  historical = false,
  selected,
  onSelect,
  onSave,
}: {
  base: string;
  sessionId: string;
  runId: string;
  scopeHash?: string | undefined;
  actorId?: string;
  active?: boolean;
  readOnly?: boolean;
  historical?: boolean;
  selected?: CandidateSelection | undefined;
  onSelect: (value: CandidateSelection) => void;
  onSave?: ((message: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0),
    [view, setView] = useState("all");
  const data = useQuery<CandidatePage>({
    queryKey: [
      "assistant-candidates",
      base,
      sessionId,
      runId,
      scopeHash,
      offset,
      view,
      text,
      actorId,
    ],
    placeholderData: (previous, query) =>
      query?.queryKey[2] === sessionId &&
      query?.queryKey[3] === runId &&
      query?.queryKey[4] === scopeHash &&
      query?.queryKey[8] === actorId &&
      canRetainReadResult(query?.state.error)
        ? previous
        : undefined,
    queryFn: ({ signal }) =>
      request<CandidatePage>(
        `${base}/sessions/${encodeURIComponent(sessionId)}/candidates?scope=task&offset=${offset}&limit=10&view=${view}&search=${encodeURIComponent(text)}`,
        { signal },
      ),
    enabled: active,
    retry: false,
  });
  const scope = JSON.stringify([base, sessionId, runId, scopeHash, actorId]);
  const lastConfirmed = useRef<{ scope: string; value: NonNullable<typeof data.data> } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!canRetainReadResult(data.error)) {
      lastConfirmed.current = undefined;
      queryClient.removeQueries({
        queryKey: ["assistant-candidates", base, sessionId, runId, scopeHash],
        type: "inactive",
      });
    } else if (data.isSuccess && !data.isPlaceholderData)
      lastConfirmed.current = { scope, value: data.data };
  }, [
    scope,
    base,
    sessionId,
    runId,
    scopeHash,
    queryClient,
    data.error,
    data.data,
    data.isSuccess,
    data.isPlaceholderData,
  ]);
  const transient = canRetainReadResult(data.error);
  const value = transient
    ? (data.data ??
      (lastConfirmed.current?.scope === scope ? lastConfirmed.current.value : undefined))
    : undefined;
  const revision = value?.reviewRevision;
  const renewal = value?.selection;
  useEffect(() => {
    if (
      !readOnly &&
      selected &&
      "scope" in selected &&
      renewal &&
      selected.reviewRevision === renewal.previousReviewRevision &&
      selected.reviewRevision !== renewal.reviewRevision &&
      JSON.stringify(selected.resultIds) === JSON.stringify(renewal.resultIds)
    ) {
      onSelect({
        scope: "task",
        reviewRevision: renewal.reviewRevision,
        resultIds: selected.resultIds,
      });
    }
  }, [selected, renewal, onSelect, readOnly]);
  const chosen = new Set(selected?.resultIds ?? []);
  const canRenew =
    selected &&
    "scope" in selected &&
    renewal &&
    selected.reviewRevision === renewal.previousReviewRevision &&
    JSON.stringify(selected.resultIds) === JSON.stringify(renewal.resultIds);
  const stale = Boolean(
    chosen.size &&
    (!selected || !("scope" in selected) || (selected.reviewRevision !== revision && !canRenew)),
  );
  const saved = new Set(value?.savedIds ?? []);
  const toggle = (ids: string[], checked: boolean) => {
    if (readOnly || !revision || stale) return;
    const next = new Set(chosen);
    for (const id of ids)
      if (checked && !saved.has(id)) next.add(id);
      else next.delete(id);
    onSelect({ scope: "task", reviewRevision: revision, resultIds: [...next] });
  };
  const rows = value?.records ?? [];
  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border bg-card text-sm shadow-sm"
      aria-label="候选结果"
    >
      <div className="space-y-2 border-b p-3">
        <div className="flex flex-wrap justify-between gap-2">
          <h4 className="font-semibold">{historical ? "历史候选" : "当前任务成果"}</h4>
          <span className="text-muted-foreground">已选 {chosen.size} 条候选</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {data.isSuccess
            ? `共 ${data.data.taskTotal ?? data.data.total} 条 · 已保存 ${data.data.savedCount ?? 0} 条 · 待保存 ${(data.data.taskTotal ?? data.data.total) - (data.data.savedCount ?? 0)} 条`
            : "候选数量读取后显示；已有成果保留。"}
        </p>
        <ContentReviewSummary stats={value?.stats} />
        {!readOnly && (
          <p className="text-xs text-muted-foreground">
            内容待审核；勾选后可在对话中调整或确认采用。
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 p-3">
        <Input
          aria-label="搜索候选结果"
          placeholder="搜索问题、期望输出、Metadata 或来源"
          className="w-full"
          value={text}
          maxLength={200}
          onChange={(event) => {
            setText(event.target.value);
            setOffset(0);
          }}
        />
        {text && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText("");
              setOffset(0);
            }}
          >
            清除搜索
          </Button>
        )}
        {[
          ["all", "全部"],
          ["changed", "有变化"],
          ["issues", "只看需核对"],
        ].map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={view === key ? "default" : "outline"}
            onClick={() => {
              setView(key!);
              setOffset(0);
            }}
          >
            {label}{" "}
            {data.data?.stats?.[key === "issues" ? "needsReview" : (key as "all" | "changed")] ??
              ""}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 border-t p-3">
        <Button
          size="sm"
          variant="outline"
          disabled={
            readOnly ||
            stale ||
            !rows.length ||
            !data.isSuccess ||
            data.isFetching ||
            data.isPlaceholderData
          }
          onClick={() =>
            toggle(
              rows.map((row) => row.id),
              true,
            )
          }
        >
          勾选本页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            readOnly ||
            !data.isSuccess ||
            stale ||
            !data.data?.allIds?.length ||
            data.isFetching ||
            data.isPlaceholderData
          }
          onClick={() => toggle(data.data!.allIds!, true)}
        >
          选择全部匹配结果
        </Button>
        {(value?.ineffectiveIds?.length ?? 0) > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || stale || !data.isSuccess || data.isFetching}
            onClick={() =>
              onSelect({
                scope: "task",
                reviewRevision: revision ?? "",
                resultIds: value!.ineffectiveIds!.filter((id) => !value!.savedIds?.includes(id)),
              })
            }
          >
            只选改写未生效
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={readOnly || !chosen.size}
          onClick={() => onSelect({ scope: "task", reviewRevision: revision ?? "", resultIds: [] })}
        >
          清空选择
        </Button>
      </div>
      {stale && (
        <p role="alert" className="border-t p-3 text-destructive">
          成果已更新，原勾选范围已失效。请清空选择后重新核对。
        </p>
      )}
      {!readOnly && onSave && (
        <div className="flex flex-wrap gap-2 border-t p-3">
          <Button
            size="sm"
            disabled={stale || data.isFetching || !data.isSuccess || chosen.size === 0}
            onClick={() =>
              onSave(value?.saveTarget ? "将勾选成果保存回原草稿" : "将勾选成果保存为新测试集草稿")
            }
          >
            {value?.saveTarget ? "保存所选回原草稿" : "保存所选为草稿"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={stale || data.isFetching || !data.isSuccess || chosen.size === 0}
              >
                另存为…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onSave("将勾选成果保存为新测试集草稿")}>
                新测试集草稿
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSave("将勾选成果保存为原始数据")}>
                原始数据
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="self-center text-xs text-muted-foreground">
            采用前确认；发布单独确认。
          </span>
        </div>
      )}
      {data.isPending && !value ? (
        <p className="p-3 text-muted-foreground">正在读取候选…</p>
      ) : !value ? (
        <div className="space-y-2 p-3">
          <p role="alert" className="text-destructive">
            候选范围变化或来源不可用。已有成果保留，请核对当前任务。
          </p>
          <Button size="sm" variant="outline" onClick={() => void data.refetch()}>
            重试读取候选
          </Button>
        </div>
      ) : (
        <>
          {data.isError && (
            <div role="alert" className="p-3 text-destructive">
              读取中断，显示上次结果。请重试读取后操作。
              <Button size="sm" variant="ghost" onClick={() => void data.refetch()}>
                重试读取候选
              </Button>
            </div>
          )}
          {data.isFetching && (
            <p role="status" className="p-3 text-xs text-muted-foreground">
              正在读取候选，下面保留上次内容；请等读取完成后选择。
            </p>
          )}
          {[...chosen].some((id) => !value.allIds?.includes(id)) && (
            <p className="p-3 text-xs text-muted-foreground">
              {[...chosen].filter((id) => !value.allIds?.includes(id)).length}{" "}
              条已选候选在当前筛选外。
            </p>
          )}
          <ProcessingReview
            rows={rows}
            selected={chosen}
            onToggle={(id, checked) => toggle([id], checked)}
            offset={data.isPlaceholderData || !data.data ? (value.offset ?? offset) : offset}
            total={value.total}
            pageSize={10}
            onPageChange={(page) => setOffset((page - 1) * 10)}
            loading={data.isFetching || data.isPlaceholderData}
            error={data.isError}
            onRetry={() => void data.refetch()}
            generated={["augment", "generate"].includes(value.rootOperation ?? "")}
            disabled={
              readOnly || stale || data.isError || data.isFetching || data.isPlaceholderData
            }
            disabledIds={saved}
          />
          {Boolean(value.issues?.length) && (
            <details className="border-t p-3 text-xs">
              <summary>任务级校验说明</summary>
              <ul className="mt-2 space-y-1">
                {value.issues!.map((issue, index) => (
                  <li key={index}>
                    {issueLabels[issue.code] ?? "处理问题需要核对"}
                    {issue.count ? `：${issue.count} 条` : ""}
                    {issue.inputOrdinal ? ` · 输入第 ${issue.inputOrdinal} 条` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
        <span className="text-xs text-muted-foreground">
          {data.data
            ? `共 ${data.data.total} 条匹配 · 第 ${Math.floor(offset / 10) + 1} 页`
            : "候选数量尚未读取"}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            aria-label="上一页候选"
            disabled={!offset || !data.isSuccess || data.isFetching}
            onClick={() => setOffset(Math.max(0, offset - 10))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="下一页候选"
            disabled={offset + 10 >= (data.data?.total ?? 0) || !data.isSuccess || data.isFetching}
            onClick={() => setOffset(offset + 10)}
          >
            下一页
          </Button>
        </div>
      </div>
      {Boolean(value?.history?.length) && (
        <details className="border-t p-3 text-xs">
          <summary>处理历史（{value!.history!.length} 批）</summary>
          <ul className="mt-2 space-y-2">
            {value!.history!.map((item, index) => (
              <li key={item.runId}>
                <a
                  className="text-primary underline"
                  href={
                    base.replace("/api", "").replace("/assistant", "") +
                    `/processing?run=${encodeURIComponent(item.runId)}`
                  }
                >
                  批次 {index + 1} · 第 {item.round} 轮 ·{" "}
                  {(
                    {
                      clean: "清洗",
                      rewrite: "改写",
                      augment: "扩充",
                      generate: "依据文档生成",
                    } as Record<string, string>
                  )[item.operation] ?? "处理"}{" "}
                  · {item.count} 条
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
