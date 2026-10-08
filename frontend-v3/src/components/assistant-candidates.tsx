import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { request } from "@/services/workspace";

export type CandidateSelection = { runId: string; resultIds: string[] };
type RecordValue = {
  question: string;
  expectedOutput: string;
  metadata: { key: string; value: string }[];
};
type Candidate = {
  id: string;
  sourceLabel?: string;
  original?: RecordValue & { baseline?: RecordValue; raw?: unknown };
  result: RecordValue;
};
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
    [detail, setDetail] = useState<Candidate>();
  const data = useQuery({
    queryKey: ["assistant-candidates", base, sessionId, runId, scopeHash, offset],
    queryFn: () =>
      request<{
        records: Candidate[];
        total: number;
        rootOperation?: string;
        issues?: {
          code: string;
          count?: number;
          batch?: number;
          inputOrdinal?: number;
          sourceQuestion?: string;
        }[];
      }>(
        `${base}/sessions/${encodeURIComponent(sessionId)}/candidates?run=${encodeURIComponent(runId)}&offset=${offset}&limit=10`,
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
  const rows = data.error ? [] : (data.data?.records ?? []);
  const changes = (row: Candidate) =>
    data.data?.rootOperation === "augment" || !row.original
      ? "新增记录"
      : (["question", "expectedOutput", "metadata"] as const)
          .filter(
            (field) => JSON.stringify(row.original![field]) !== JSON.stringify(row.result[field]),
          )
          .map(
            (field) =>
              ({ question: "问题", expectedOutput: "期望输出", metadata: "Metadata" })[field],
          )
          .join("、") || "未改变";
  const value = (record: RecordValue | undefined) =>
    record ? (
      <div className="space-y-4 text-sm">
        <div>
          <h5 className="mb-1 font-medium text-muted-foreground">问题</h5>
          <p className="whitespace-pre-wrap break-words">{record.question || "（空）"}</p>
        </div>
        <div>
          <h5 className="mb-1 font-medium text-muted-foreground">期望输出</h5>
          <p className="whitespace-pre-wrap break-words">{record.expectedOutput || "（空）"}</p>
        </div>
        <div>
          <h5 className="mb-1 font-medium text-muted-foreground">Metadata</h5>
          {record.metadata.length ? (
            record.metadata.map((entry) => (
              <p className="whitespace-pre-wrap break-words" key={entry.key}>
                {entry.key}：{entry.value || "（空）"}
              </p>
            ))
          ) : (
            <p>无</p>
          )}
        </div>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">没有原文</p>
    );
  return (
    <section className="min-w-0 rounded-md border bg-card text-sm shadow-sm" aria-label="候选结果">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h4 className="font-semibold">候选结果</h4>
        <span className="text-muted-foreground">已选 {chosen.size} 条候选</span>
      </div>
      <div className="flex flex-wrap gap-2 p-3">
        <p className="w-full text-xs text-muted-foreground">
          {data.isSuccess
            ? `当前批次共 ${data.data.total} 条候选；翻页不改变范围。`
            : "候选数量读取后显示；已有成果保留。"}
        </p>
        <p className="w-full text-xs text-muted-foreground">内容待你审核</p>
        <p className="w-full text-xs text-muted-foreground">
          勾选需要调整的记录，在对话中说明修改要求。部分采用只提交所选记录。
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={!rows.length}
          onClick={() =>
            toggle(
              rows.map((r) => r.id),
              !rows.every((r) => chosen.has(r.id)),
            )
          }
        >
          {rows.length && rows.every((r) => chosen.has(r.id)) ? "取消本页选择" : "选择本页候选"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!chosen.size}
          onClick={() => onSelect({ runId, resultIds: [] })}
        >
          清除选择
        </Button>
      </div>
      {data.isPending ? (
        <p className="p-3 text-muted-foreground">正在读取候选…</p>
      ) : data.error ? (
        <div className="space-y-2 p-3">
          <p role="alert" className="text-destructive">
            {data.error.message === "assistant_candidate_selection_changed"
              ? "候选范围已变化，请核对当前任务后重新选择。"
              : "候选暂不可用。请检查权限或来源后重试；已有结果保留。"}
          </p>
          <Button size="sm" variant="outline" onClick={() => void data.refetch()}>
            重试读取候选
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <span className="sr-only">选择</span>
              </TableHead>
              <TableHead>问题</TableHead>
              <TableHead className="w-24">期望输出</TableHead>
              <TableHead className="w-16">详情</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Checkbox
                    aria-label={`选择候选 ${offset + index + 1}`}
                    checked={chosen.has(row.id)}
                    onCheckedChange={(checked) => toggle([row.id], checked === true)}
                  />
                </TableCell>
                <TableCell className="max-w-64">
                  <p className="truncate" title={row.result.question}>
                    {row.result.question || "（空问题）"}
                  </p>
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={row.sourceLabel}
                  >
                    {row.sourceLabel ?? "来源未记录"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {changes(row) === "新增记录" || changes(row) === "未改变"
                      ? changes(row)
                      : `本次变化：${changes(row)}`}
                  </p>
                </TableCell>
                <TableCell className="max-w-24">
                  <p className="truncate" title={row.result.expectedOutput}>
                    {row.result.expectedOutput || "—"}
                  </p>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`查看候选 ${offset + index + 1}`}
                    onClick={() => setDetail(row)}
                  >
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {Boolean(data.data?.issues?.length) && (
        <details className="border-t p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            处理问题（{data.data!.issues!.length}）
          </summary>
          <ul className="mt-2 space-y-1">
            {data.data!.issues!.slice(0, 20).map((issue, index) => (
              <li key={index}>
                {(
                  {
                    missing_output: "缺少输出",
                    empty_question: "问题为空",
                    duplicate_content: "内容重复",
                    excess_output: "输出数量超出要求",
                    unknown_source: "来源不匹配",
                    duplicate_source: "同一来源重复返回",
                    invalid_output: "输出格式不完整",
                    protected_field_changed: "受保护字段变化",
                  } as Record<string, string>
                )[issue.code] ?? "此批结果需要核对"}
                {issue.count ? `：${issue.count} 条` : ""}
                {issue.batch !== undefined ? ` · 第 ${issue.batch + 1} 批` : ""}
                {issue.inputOrdinal ? ` · 输入第 ${issue.inputOrdinal} 条` : ""}
                {issue.sourceQuestion ? `：${issue.sourceQuestion.slice(0, 80)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!data.isPending && !data.error && !rows.length && (
        <p className="p-3 text-muted-foreground">
          暂无有效候选。之前的处理结果仍保留在任务记录中。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
        <span className="text-xs text-muted-foreground">
          {data.isSuccess
            ? `共 ${data.data.total} 条 · 第 ${Math.floor(offset / 10) + 1} 页`
            : "候选数量尚未读取"}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            aria-label="上一页候选"
            disabled={offset === 0 || !data.isSuccess}
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
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>候选修改对照</DialogTitle>
            <DialogDescription>核对完整内容后再决定是否采用。</DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
            <p className="break-words">来源：{detail?.sourceLabel ?? "未记录"}</p>
            {detail && (
              <p className="mt-1 text-muted-foreground">
                {data.data?.rootOperation === "augment"
                  ? "由参考资料扩写新增；下方原文仅供参考。"
                  : `本次变化：${changes(detail)}`}
              </p>
            )}
          </div>
          <div className="grid min-w-0 gap-5 sm:grid-cols-2">
            <section className="min-w-0 rounded-md border p-4">
              <h4 className="mb-4 font-semibold">修改前</h4>
              {value(detail?.original?.baseline ?? detail?.original)}
              {detail?.original?.raw !== undefined && (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-primary">原始字段</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words">
                    {JSON.stringify(detail.original.raw, null, 2)}
                  </pre>
                </details>
              )}
            </section>
            <section className="min-w-0 rounded-md border p-4">
              <h4 className="mb-4 font-semibold">候选结果</h4>
              {value(detail?.result)}
            </section>
          </div>
          {detail?.original?.baseline && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                本次调整前的候选
              </summary>
              <div className="mt-3">{value(detail.original)}</div>
            </details>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
