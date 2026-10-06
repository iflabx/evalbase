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
type Candidate = { id: string; original?: RecordValue; result: RecordValue };
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
      request<{ records: Candidate[]; total: number }>(
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
        <p role="alert" className="p-3 text-destructive">
          候选暂不可用。请检查权限或来源后重试。
        </p>
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
      {!data.isPending && !data.error && !rows.length && (
        <p className="p-3 text-muted-foreground">
          暂无有效候选。之前的处理结果仍保留在任务记录中。
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
        <span className="text-xs text-muted-foreground">
          共 {data.data?.total ?? 0} 条 · 第 {Math.floor(offset / 10) + 1} 页
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            aria-label="上一页候选"
            disabled={offset === 0 || data.isPending}
            onClick={() => setOffset(Math.max(0, offset - 10))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="下一页候选"
            disabled={offset + 10 >= (data.data?.total ?? 0) || data.isPending}
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
          <div className="grid min-w-0 gap-5 sm:grid-cols-2">
            <section className="min-w-0 rounded-md border p-4">
              <h4 className="mb-4 font-semibold">修改前</h4>
              {value(detail?.original)}
            </section>
            <section className="min-w-0 rounded-md border p-4">
              <h4 className="mb-4 font-semibold">候选结果</h4>
              {value(detail?.result)}
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
