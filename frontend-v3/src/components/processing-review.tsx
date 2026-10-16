import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  unprocessed?: boolean;
  contentReview?: {
    verdict: "conforms" | "nonconforms" | "uncertain" | "pending";
    reason: string;
    repaired?: boolean;
  };
  issues?: { code: string }[];
};
export type ContentStats = {
  all: number;
  changed: number;
  needsReview: number;
  duplicates?: number;
  structurallyValid?: number;
  modified?: number;
  unchanged?: number;
  unprocessed?: number;
  ineffectiveRewrite?: number;
  contentChecked?: number;
  contentPending?: number;
  contentProblems?: number;
};
export function ContentReviewSummary({ stats }: { stats?: ContentStats | undefined }) {
  if (!stats || stats.contentChecked === undefined) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" role="status">
      <p>
        当前范围 {stats.all} 条 · 结构有效 {stats.structurallyValid ?? 0} 条 · 内容已核对{" "}
        {stats.contentChecked} 条 · 待核对 {stats.contentPending ?? 0} 条 · 有问题或存疑{" "}
        {stats.contentProblems ?? 0} 条
      </p>
      {stats.modified || stats.unchanged || stats.unprocessed ? (
        <p>
          本轮修改 {stats.modified ?? 0} 条 · 未变化 {stats.unchanged ?? 0} 条 · 未处理{" "}
          {stats.unprocessed ?? 0} 条
          {stats.ineffectiveRewrite ? ` · 其中 ${stats.ineffectiveRewrite} 条改写未生效` : ""}
        </p>
      ) : null}
    </div>
  );
}
export const issueLabels: Record<string, string> = {
  ineffective_rewrite: "本轮改写未生效",
  content_nonconforms: "内容不符合要求",
  content_uncertain: "内容存疑",
  content_pending: "内容待核对",
  empty_question: "问题为空",
  question_collision: "问题相同，其他字段不同",
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
  const references = value.steps.filter(
    (step) => step.kind === "reference" || (!step.kind && !step.href?.includes("/processing?")),
  );
  const processing = value.steps.filter(
    (step) =>
      step.kind === "processing" ||
      (!step.kind && (step.href?.includes("/processing?") || !step.href)),
  );
  const saved = value.steps.filter((step) => step.kind === "saved");
  const badges = [...new Set(value.badges)].filter((badge) => !value.label.includes(badge));
  const stepList = (steps: SourcePresentation["steps"], reference = false) => (
    <ol className="space-y-2">
      {steps.map((step, index) => (
        <li key={`${step.href ?? step.label}:${index}`} className="break-words">
          {step.href ? (
            <a href={step.href} className="text-primary hover:underline">
              {reference && value.generated ? `参考位置：${step.label}` : step.label}
            </a>
          ) : (
            step.label
          )}
          {step.kind === "processing" && (
            <span className="ml-2 text-xs text-muted-foreground">
              {step.occurredAt ? new Date(step.occurredAt).toLocaleString() : "时间未记录"}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
  return (
    <div className="min-w-0 text-xs">
      <p className="line-clamp-2 break-words text-muted-foreground" title={value.label}>
        {value.label}
        {badges.length > 0 && <span className="ml-1">{badges.join(" · ")}</span>}
      </p>
      {value.steps.length > 0 && (
        <Dialog>
          <DialogTrigger asChild>
            <Button
              size="sm"
              variant="link"
              className="h-auto px-0 py-1 text-xs"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              查看来源
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle>数据来源</DialogTitle>
              <DialogDescription>
                {value.generated
                  ? "以下为任务参考范围，未记录本条内容与具体参考记录的一一对应关系。"
                  : "原始位置、处理过程与保存结果。"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 text-sm">
              <section>
                <h3 className="mb-2 font-medium">
                  {value.generated ? "任务参考范围" : "原始资料"}
                </h3>
                {value.generated && value.referenceGroups?.length ? (
                  <div className="space-y-2">
                    {value.referenceGroups.map((group) => (
                      <details key={group.href} className="rounded-md border px-3 py-2">
                        <summary className="cursor-pointer">
                          <span>{group.fileName}</span>
                          <span className="ml-2 text-muted-foreground">
                            {group.recordCount === null
                              ? "数量未完整记录"
                              : `${group.recordCount} 条参考记录`}
                          </span>
                        </summary>
                        <div className="mt-2 max-h-48 overflow-y-auto">
                          {stepList(group.positions, true)}
                        </div>
                        <a
                          className="mt-2 inline-block text-primary hover:underline"
                          href={group.href}
                        >
                          打开参考文件
                        </a>
                        {(group.recordCount === null ||
                          group.recordCount > group.positions.length) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            仅展开前 {group.positions.length} 个已记录位置。
                          </p>
                        )}
                      </details>
                    ))}
                  </div>
                ) : references.length ? (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      展开{value.generated ? "已记录的任务参考范围" : "原始位置"}
                    </summary>
                    <div className="mt-2 max-h-48 overflow-y-auto">
                      {stepList(references, true)}
                    </div>
                  </details>
                ) : (
                  <p className="text-muted-foreground">部分来源未记录</p>
                )}
              </section>
              <section>
                <h3 className="mb-2 font-medium">处理过程</h3>
                {processing.length ? (
                  stepList(processing)
                ) : (
                  <p className="text-muted-foreground">未记录处理操作</p>
                )}
              </section>
              {saved.length > 0 && (
                <section>
                  <h3 className="mb-2 font-medium">保存结果</h3>
                  {stepList(saved.slice(-1))}
                  {saved.length > 1 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-muted-foreground">
                        查看中间文件（{saved.length - 1}）
                      </summary>
                      <div className="mt-2">{stepList(saved.slice(0, -1))}</div>
                    </details>
                  )}
                </section>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
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
  disabledIds,
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
  disabledIds?: Set<string> | undefined;
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
    ((row.sourcePresentation?.generated ?? generated) || !row.original
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
                    disabled={disabled || row.unprocessed || disabledIds?.has(row.id)}
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
                    {row.unprocessed
                      ? "尚未处理，保留原值"
                      : changes(row)
                          .filter(
                            (field) =>
                              field !== "metadata" ||
                              !metadataChanges(row.original, row.result).length,
                          )
                          .map((field) => fieldLabels[field] ?? field)
                          .join("、") || (changes(row).length ? "" : "未改变")}
                  </p>
                  {row.contentReview && (
                    <p
                      className={`text-xs ${row.contentReview.verdict === "conforms" ? "text-muted-foreground" : "text-destructive"}`}
                    >
                      {row.contentReview.repaired ? "已局部修复 · " : ""}
                      {row.contentReview.verdict === "conforms"
                        ? "模型核对未发现问题"
                        : row.contentReview.verdict === "nonconforms"
                          ? "内容不符合要求"
                          : row.contentReview.verdict === "uncertain"
                            ? "内容存疑"
                            : "内容待核对"}
                    </p>
                  )}
                  {row.issues
                    ?.filter((issue) => !issue.code.startsWith("content_"))
                    .map((issue, i) => (
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
              {detail.contentReview && (
                <p className="rounded-md border bg-muted/30 p-3 text-sm">
                  {detail.contentReview.reason}。模型核对不代替人工审核。
                </p>
              )}
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
                    <h3 className="font-semibold">
                      {(detail.sourcePresentation?.generated ?? generated) ? "参考输入" : "修改前"}
                    </h3>
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
