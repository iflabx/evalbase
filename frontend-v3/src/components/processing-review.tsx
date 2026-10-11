import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MetadataSummary } from "@/components/material-record-table";
import type { MetadataEntry, SourcePresentation } from "@/services/workspace";

export type ProcessingValue = {
  question: string;
  expectedOutput: string;
  metadata: MetadataEntry[];
  raw?: unknown;
};
export type ReviewRow = {
  id: string;
  original?: ProcessingValue & { baseline?: ProcessingValue };
  result: ProcessingValue;
  sourcePresentation?: SourcePresentation;
  sourceLabel?: string;
  changedFields?: string[];
  issues?: { code: string }[];
};
export const issueLabels: Record<string, string> = {
  empty_question: "问题为空",
  duplicate_content: "内容重复",
  missing_output: "缺少结果",
  excess_output: "已忽略超量结果",
  invalid_output: "格式无效",
  unknown_source: "来源不匹配",
  duplicate_source: "同一来源重复返回",
  processing_batch_failed: "批次调用失败",
  protected_field_changed: "受保护字段变化",
};
const fieldLabels: Record<string, string> = {
  question: "问题",
  expectedOutput: "期望输出",
  metadata: "Metadata",
  new: "新增记录",
};
export function SourceInfo({ value }: { value?: SourcePresentation | undefined }) {
  if (!value) return <span className="text-muted-foreground">来源未记录</span>;
  return (
    <details className="min-w-0 text-xs">
      <summary className="cursor-pointer break-words text-muted-foreground">
        {value.label}{" "}
        {value.badges.map((badge) => (
          <Badge key={badge} variant="secondary" className="ml-1 font-normal">
            {badge}
          </Badge>
        ))}
      </summary>
      <ol className="mt-2 space-y-1 border-l pl-3">
        {value.steps.map((step, index) => (
          <li key={index}>
            {step.href ? (
              <a href={step.href} className="break-words text-primary hover:underline">
                {step.label}
              </a>
            ) : (
              step.label
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
function FullValue({
  value,
  foldedFields = [],
}: {
  value?: ProcessingValue | undefined;
  foldedFields?: string[];
}) {
  return value ? (
    <div className="space-y-4 text-sm">
      {["question", "expectedOutput"].map((field) => (
        <div key={field}>
          <h4 className="mb-1 font-medium text-muted-foreground">{fieldLabels[field]}</h4>
          {foldedFields.includes(field) &&
          value[field as "question" | "expectedOutput"].length > 200 ? (
            <details>
              <summary className="cursor-pointer text-primary">未变化，展开完整内容</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">
                {value[field as "question" | "expectedOutput"]}
              </p>
            </details>
          ) : (
            <p className="whitespace-pre-wrap break-words">
              {value[field as "question" | "expectedOutput"] || "（空值）"}
            </p>
          )}
        </div>
      ))}
      <div>
        <h4 className="mb-1 font-medium text-muted-foreground">Metadata</h4>
        {value.metadata.length
          ? value.metadata.map((entry, index) => (
              <p className="whitespace-pre-wrap break-words" key={index}>
                {entry.key}：{entry.value || "（空值）"}
              </p>
            ))
          : "没有 Metadata 项"}
      </div>
      {value.raw !== undefined && (
        <details>
          <summary className="cursor-pointer text-primary">原始字段</summary>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(value.raw, null, 2)}
          </pre>
        </details>
      )}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">原始内容未记录</p>
  );
}
function metadataChanges(original: ProcessingValue | undefined, result: ProcessingValue): string[] {
  if (!original) return [];
  return [
    ...result.metadata.flatMap((entry, index) => {
      const priorIndex = original.metadata.findIndex((item) => item.key === entry.key),
        prior = original.metadata[priorIndex];
      return !prior
        ? [`新增 ${entry.key}：${entry.value || "（空值）"}`]
        : prior.value !== entry.value
          ? [`修改 ${entry.key}：${prior.value || "（空值）"} → ${entry.value || "（空值）"}`]
          : priorIndex !== index
            ? [`顺序变化 ${entry.key}：第 ${priorIndex + 1} 项 → 第 ${index + 1} 项`]
            : [];
    }),
    ...original.metadata
      .filter((entry) => !result.metadata.some((item) => item.key === entry.key))
      .map((entry) => `删除 ${entry.key}：${entry.value || "（空值）"}`),
  ];
}
export function ProcessingReview({
  rows,
  selected,
  onToggle,
  disabled = false,
  generated = false,
  offset = 0,
  total,
  pageSize = 20,
  onPageChange,
  loading = false,
  error = false,
  onRetry,
}: {
  rows: ReviewRow[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  disabled?: boolean;
  generated?: boolean;
  offset?: number;
  total?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const [detail, setDetail] = useState<ReviewRow>();
  const [position, setPosition] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    if (!detail || loading || error) return;
    const next = rows[position - offset];
    if (next) {
      setDetail(next);
      returnFocus.current = rowRefs.current.get(next.id) ?? null;
    }
  }, [rows, position, offset, loading, error, detail]);
  function move(delta: number) {
    const next = position + delta;
    if (loading || error || next < 0 || next >= (total ?? offset + rows.length)) return;
    setPosition(next);
    if (next < offset || next >= offset + rows.length)
      onPageChange?.(Math.floor(next / pageSize) + 1);
  }
  const returnFocus = useRef<HTMLTableRowElement | null>(null);
  const changes = (row: ReviewRow) =>
    row.changedFields ??
    (generated || !row.original
      ? ["new"]
      : ["question", "expectedOutput", "metadata"].filter(
          (field) =>
            JSON.stringify(row.original![field as keyof ProcessingValue]) !==
            JSON.stringify(row.result[field as keyof ProcessingValue]),
        ));
  const original = detail?.original;
  const metadataDiff = detail ? metadataChanges(original, detail.result) : [];
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] table-fixed text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-12 px-4 py-2 font-medium">
                <span className="sr-only">选择</span>
              </th>
              <th className="w-[35%] px-4 py-2 font-medium">问题 / 来源</th>
              <th className="w-[18%] px-4 py-2 font-medium">期望输出</th>
              <th className="px-4 py-2 font-medium">Metadata / 变化</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(row.id, node);
                  else rowRefs.current.delete(row.id);
                }}
                tabIndex={0}
                aria-label={`查看记录 ${offset + index + 1}`}
                className="cursor-pointer border-t align-top hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-primary"
                onClick={(event) => {
                  returnFocus.current = event.currentTarget;
                  setPosition(offset + index);
                  setDetail(row);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    returnFocus.current = event.currentTarget;
                    setPosition(offset + index);
                    setDetail(row);
                  }
                }}
              >
                <td
                  className="px-4 py-3"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Checkbox
                    aria-label={`选择结果 ${offset + index + 1}`}
                    checked={selected.has(row.id)}
                    disabled={disabled}
                    onCheckedChange={(value) => onToggle(row.id, value === true)}
                  />
                </td>
                <td className="px-4 py-3">
                  <p className="line-clamp-2 break-words">{row.result.question || "（空问题）"}</p>
                  <div
                    className="mt-1"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <SourceInfo
                      value={
                        row.sourcePresentation ??
                        (row.sourceLabel
                          ? { label: row.sourceLabel, badges: [], steps: [] }
                          : undefined)
                      }
                    />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <p className="line-clamp-2 break-words">
                    {row.result.expectedOutput || "（空值）"}
                  </p>
                </td>
                <td className="space-y-2 px-4 py-3">
                  {metadataChanges(row.original, row.result).length ? (
                    <>
                      {metadataChanges(row.original, row.result)
                        .slice(0, 3)
                        .map((line, i) => (
                          <p key={i} className="line-clamp-2 break-words text-xs text-primary">
                            {line}
                          </p>
                        ))}
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          查看完整 Metadata
                        </summary>
                        <MetadataSummary entries={row.result.metadata} />
                      </details>
                    </>
                  ) : (
                    <MetadataSummary entries={row.result.metadata} />
                  )}
                  <p className="text-xs text-primary">
                    {changes(row)
                      .filter(
                        (field) =>
                          field !== "metadata" || !metadataChanges(row.original, row.result).length,
                      )
                      .map((field) => fieldLabels[field] ?? field)
                      .join("、") || (changes(row).length ? "" : "未改变")}
                  </p>
                  {row.issues?.map((issue, i) => (
                    <p key={i} className="text-xs text-destructive">
                      自动检查：{issueLabels[issue.code] ?? "此结果需要核对"}
                    </p>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            没有匹配结果，可切换筛选条件。
          </p>
        )}
      </div>
      <Sheet
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) {
              returnFocus.current.focus();
              returnFocus.current.scrollIntoView({ block: "nearest" });
            }
          }}
        >
          <SheetHeader>
            <SheetTitle>记录变化对照</SheetTitle>
            <SheetDescription>
              {generated
                ? "新增记录；原始输入仅作参考。"
                : "核对完整内容后再保存；结构检查通过不代表内容正确。"}
            </SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="mt-4 flex items-center justify-between gap-2 border-b pb-3 text-sm">
              <span>
                {loading || error ? "正在核对目标位置：" : ""}第 {position + 1} 条，共{" "}
                {total ?? rows.length} 条
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || error || position <= 0}
                  onClick={() => move(-1)}
                >
                  上一条
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || error || position + 1 >= (total ?? rows.length)}
                  onClick={() => move(1)}
                >
                  下一条
                </Button>
              </div>
            </div>
          )}
          {detail && loading && (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              正在读取下一条，下面保留上次内容…
            </p>
          )}
          {detail && error && (
            <div role="alert" className="mt-3 text-sm text-destructive">
              读取失败，下面仍是上次确认的记录。
              <Button size="sm" variant="ghost" onClick={onRetry}>
                重试读取记录
              </Button>
            </div>
          )}
          {detail && (
            <div className="mt-5 min-w-0 space-y-5">
              <SourceInfo
                value={
                  detail.sourcePresentation ??
                  (detail.sourceLabel
                    ? { label: detail.sourceLabel, badges: [], steps: [] }
                    : undefined)
                }
              />
              <Card className="bg-muted/30 text-sm">
                <CardContent className="p-4">
                  <h3 className="mb-2 font-semibold">
                    本次变化：
                    {changes(detail)
                      .map((field) => fieldLabels[field] ?? field)
                      .join("、") || "未改变"}
                  </h3>
                  {metadataDiff.map((line, index) => (
                    <p key={index} className="whitespace-pre-wrap break-words">
                      {line}
                    </p>
                  ))}
                </CardContent>
              </Card>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Card className="min-w-0 overflow-hidden">
                  <CardHeader className="border-b bg-muted/60 px-4 py-3">
                    <h3 className="font-semibold">{generated ? "参考输入" : "修改前"}</h3>
                  </CardHeader>
                  <CardContent className="p-4">
                    <FullValue
                      value={original}
                      foldedFields={["question", "expectedOutput"].filter(
                        (field) => !changes(detail).includes(field),
                      )}
                    />
                  </CardContent>
                </Card>
                <Card className="min-w-0 overflow-hidden">
                  <CardHeader className="border-b bg-muted/60 px-4 py-3">
                    <h3 className="font-semibold">处理结果</h3>
                  </CardHeader>
                  <CardContent className="p-4">
                    <FullValue
                      value={detail.result}
                      foldedFields={["question", "expectedOutput"].filter(
                        (field) => !changes(detail).includes(field),
                      )}
                    />
                  </CardContent>
                </Card>
              </div>
              {original?.baseline && (
                <details className="rounded-md border p-4">
                  <summary className="cursor-pointer text-sm text-primary">最初输入</summary>
                  <div className="mt-3">
                    <FullValue value={original.baseline} />
                  </div>
                </details>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
