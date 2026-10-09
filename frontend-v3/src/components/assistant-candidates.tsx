import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { request } from "@/services/workspace";
import { ProcessingReview, issueLabels, type ReviewRow } from "@/components/processing-review";

export type CandidateSelection = { runId: string; resultIds: string[] };
export function AssistantCandidates({
  base,
  sessionId,
  runId,
  scopeHash,
  selected,
  onSelect,
}: {
  base: string;
  sessionId: string;
  runId: string;
  scopeHash?: string | undefined;
  selected?: CandidateSelection | undefined;
  onSelect: (value: CandidateSelection) => void;
}) {
  const [offset, setOffset] = useState(0),
    [view, setView] = useState("all");
  const data = useQuery({
    queryKey: ["assistant-candidates", base, sessionId, runId, scopeHash, offset, view],
    queryFn: () =>
      request<{
        records: ReviewRow[];
        total: number;
        allIds?: string[];
        taskTotal?: number;
        rootOperation?: string;
        stats?: { all: number; changed: number; needsReview: number };
        issues?: { code: string; count?: number; inputOrdinal?: number }[];
      }>(
        `${base}/sessions/${encodeURIComponent(sessionId)}/candidates?run=${encodeURIComponent(runId)}&offset=${offset}&limit=10&view=${view}`,
      ),
    retry: false,
  });
  const chosen = new Set(selected?.runId === runId ? selected.resultIds : []);
  const toggle = (ids: string[], checked: boolean) => {
    const next = new Set(chosen);
    for (const id of ids)
      if (checked) next.add(id);
      else next.delete(id);
    onSelect({ runId, resultIds: [...next] });
  };
  const rows = data.data?.records ?? [];
  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border bg-card text-sm shadow-sm"
      aria-label="候选结果"
    >
      <div className="space-y-2 border-b p-3">
        <div className="flex flex-wrap justify-between gap-2">
          <h4 className="font-semibold">候选结果</h4>
          <span className="text-muted-foreground">已选 {chosen.size} 条候选</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {data.isSuccess
            ? `本任务共 ${data.data.taskTotal ?? data.data.total} 条当前有效候选；本批 ${data.data.stats?.all ?? data.data.total} 条。`
            : "候选数量读取后显示；已有成果保留。"}
        </p>
        <p className="text-xs text-muted-foreground">
          内容待你审核。勾选后可在原会话调整或确认采用；翻页不改变选择。
        </p>
      </div>
      <div className="flex flex-wrap gap-2 p-3">
        {[
          ["all", "全部"],
          ["changed", "有变化"],
          ["issues", "需核对"],
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
          disabled={!rows.length || !data.isSuccess}
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
          disabled={!data.isSuccess || !data.data?.allIds?.length}
          onClick={() => toggle(data.data!.allIds!, true)}
        >
          选择全部匹配结果
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!chosen.size}
          onClick={() => onSelect({ runId, resultIds: [] })}
        >
          清空选择
        </Button>
      </div>
      {data.isPending ? (
        <p className="p-3 text-muted-foreground">正在读取候选…</p>
      ) : !data.data ? (
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
          <ProcessingReview
            rows={rows}
            selected={chosen}
            onToggle={(id, checked) => toggle([id], checked)}
            offset={offset}
            generated={data.data.rootOperation === "augment"}
            disabled={data.isError}
          />
          {Boolean(data.data.issues?.length) && (
            <details className="border-t p-3 text-xs">
              <summary>任务级校验说明</summary>
              <ul className="mt-2 space-y-1">
                {data.data.issues!.map((issue, index) => (
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
            disabled={!offset || !data.isSuccess}
            onClick={() => setOffset(Math.max(0, offset - 10))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="下一页候选"
            disabled={offset + 10 >= (data.data?.total ?? 0) || !data.isSuccess}
            onClick={() => setOffset(offset + 10)}
          >
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
