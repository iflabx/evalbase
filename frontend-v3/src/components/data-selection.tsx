import { useState } from "react";
import { SelectionHistory } from "@/components/selection-history";
import { MetadataSummary } from "@/components/material-record-table";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listDraftSourceFiles, type DraftSourceFile } from "@/services/drafts";
import {
  createSelection,
  previewSelection,
  applySelection,
  selectionKey,
  type SelectionCondition,
  type SelectionPreview,
  type PreviewRecord,
} from "@/services/selection";

function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={!!disabled}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const operators = [
  { value: "contains", label: "包含" },
  { value: "equals", label: "等于" },
  { value: "empty", label: "为空" },
  { value: "filled", label: "不为空" },
];
const messages: Record<string, string> = {
  selection_invalid: "请检查筛选条件与选取数量。",
  test_set_capacity_exceeded:
    "范围或草稿超过容量限制：最多 5 个文件、10,000 条记录及 100 MB。请缩小范围。",
  selection_source_changed: "来源已变化，请更新预览后再确认。",
  selection_source_unavailable: "部分来源已不可用，请重新选择文件。",
  draft_revision_conflict: "草稿已被修改；预览仍保留，请核对当前草稿后重新确认。",
  selection_no_additions: "选中的记录已在草稿中，无需重复加入。",
  draft_not_editable: "当前草稿已暂停或结束，暂时不能加入记录。",
  project_not_found: "当前项目不可访问，请检查成员权限。",
};

export function DataSelection({
  projectId,
  draftId,
  revision,
  parentLabel,
  canEdit,
  active,
  existing,
  onApplied,
  onViewDraft,
}: {
  projectId: string;
  draftId: string;
  revision: number;
  parentLabel: string | null;
  canEdit: boolean;
  active: boolean;
  existing: { assetId: string; ordinal: number }[];
  onApplied: () => Promise<void>;
  onViewDraft: () => void;
}) {
  const [scope, setScope] = useState<DraftSourceFile[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [rules, setRules] = useState<(SelectionCondition & { id: number })[]>([]);
  const [nextRule, setNextRule] = useState(1);
  const [method, setMethod] = useState<"all" | "random">("random");
  const [mode, setMode] = useState<"count" | "percent">("count");
  const [count, setCount] = useState("500");
  const [percent, setPercent] = useState("5");
  const [seed, setSeed] = useState("evalbase-2026");
  const [preview, setPreview] = useState<SelectionPreview>();
  const [previewFiles, setPreviewFiles] = useState<DraftSourceFile[]>([]);
  const [stale, setStale] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [included, setIncluded] = useState<string[]>([]);
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [view, setView] = useState("selected");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ added: number; skipped: number }>();
  const [detail, setDetail] = useState<PreviewRecord>();
  const files = useQuery({
    queryKey: ["selection-files", projectId, fileSearch, filePage],
    queryFn: () =>
      listDraftSourceFiles(projectId, { search: fileSearch, limit: 10, offset: filePage * 10 }),
    enabled: active,
  });
  const rows = useQuery({
    queryKey: ["selection-preview", projectId, draftId, preview?.id, view, search, page, included],
    queryFn: () =>
      previewSelection(projectId, draftId, preview!.id, {
        view,
        search,
        offset: String(page * 20),
        limit: "20",
        includeIds: included,
      }),
    enabled: active && !!preview,
    retry: false,
  });
  const existingKeys = new Set(existing.map(selectionKey));
  const skipped = [...picked].filter((id) => existingKeys.has(id)).length;
  const additions = picked.size - skipped;
  const currentRevision = Math.max(revision, rows.data?.currentDraftRevision ?? revision);
  const changed = !!preview && currentRevision !== expectedRevision && !receipt;
  const sourceIds = new Set(scope.map((file) => file.id));
  const fits = (files: DraftSourceFile[]) =>
    new Set([
      ...existing.map((source) => source.assetId),
      ...scope.map((file) => file.id),
      ...files.map((file) => file.id),
    ]).size <= 5;
  const invalidate = () => {
    if (preview) setStale(true);
    setReceipt(undefined);
    setError("");
  };
  const fail = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? (messages[cause.message] ?? "操作失败，请重试；当前预览和选择已保留。")
        : "操作失败，请重试。",
    );
  function choose(files: DraftSourceFile[], selected: boolean) {
    if (selected && !fits(files)) {
      setError(messages["test_set_capacity_exceeded"]!);
      return;
    }
    invalidate();
    setScope(
      selected
        ? [...new Map([...scope, ...files].map((file) => [file.id, file])).values()]
        : scope.filter((file) => !files.some((item) => item.id === file.id)),
    );
  }
  function updateRule(id: number, patch: Partial<SelectionCondition>) {
    invalidate();
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }
  async function generate(reroll = false) {
    setBusy(true);
    setError("");
    try {
      const configuration = {
        assetIds: scope.map((file) => file.id),
        conditions: rules.map(({ id: _id, ...condition }) => condition),
        method,
        ...(method === "random"
          ? { mode, value: Number(mode === "count" ? count : percent), seed: reroll ? "" : seed }
          : {}),
      };
      const result = await createSelection(projectId, draftId, configuration);
      setPreview(result.preview);
      setPreviewFiles(scope);
      setPicked(new Set(result.preview.selectedIds));
      setIncluded([]);
      setExpectedRevision(result.preview.draftRevision);
      setStale(false);
      setReceipt(undefined);
      setPage(0);
      setSearch("");
      setView("selected");
      if (result.preview.seed) setSeed(result.preview.seed);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview || stale || changed || !additions) return;
    setBusy(true);
    setError("");
    try {
      const result = await applySelection(
        projectId,
        draftId,
        preview.id,
        [...picked],
        expectedRevision,
      );
      setReceipt(result);
      await onApplied();
    } catch (cause) {
      fail(cause);
      await rows.refetch();
    } finally {
      setBusy(false);
    }
  }
  const fields = [
    { value: "question", label: "问题" },
    { value: "expectedOutput", label: "期望输出" },
    ...[...new Set(scope.flatMap((file) => file.metadataKeys ?? []))].map((key) => ({
      value: `metadata:${key}`,
      label: `Metadata · ${key}`,
    })),
  ];
  const issue =
    error || (rows.error ? (messages[rows.error.message] ?? "无法读取预览，请重试。") : "");
  const disabled = !canEdit || busy;
  return (
    <div className="space-y-5 min-w-0">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle role="heading" aria-level={2} className="text-base">
              选择资料范围
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              已选 {scope.length} / 5 个文件 ·{" "}
              {scope.reduce((total, file) => total + file.recordCount, 0).toLocaleString()}{" "}
              条记录。勾选文件不会直接加入草稿。
            </p>
          </div>
          <Input
            className="w-60"
            aria-label="搜索资料文件"
            placeholder="搜索文件"
            value={fileSearch}
            onChange={(event) => {
              setFileSearch(event.target.value);
              setFilePage(0);
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex flex-wrap gap-3 border-t px-5 py-4">
            {files.isPending ? (
              <p className="text-sm text-muted-foreground">正在加载文件…</p>
            ) : files.error ? (
              <p role="alert">文件加载失败，请重试。</p>
            ) : !files.data?.files.length ? (
              <p className="text-sm text-muted-foreground">没有匹配的文件。</p>
            ) : (
              files.data.files.map((file) => (
                <label
                  key={file.id}
                  className={`flex min-w-0 basis-64 flex-1 cursor-pointer items-start gap-3 rounded-md border p-3 ${sourceIds.has(file.id) ? "border-primary bg-accent" : ""}`}
                >
                  <Checkbox
                    className="mt-0.5"
                    aria-label={`选择 ${file.fileName}`}
                    checked={sourceIds.has(file.id)}
                    disabled={disabled || (!sourceIds.has(file.id) && !fits([file]))}
                    onCheckedChange={(checked) => choose([file], checked === true)}
                  />
                  <span className="min-w-0">
                    <strong className="break-all text-sm font-medium">{file.fileName}</strong>
                    <small className="mt-1 block text-xs text-muted-foreground">
                      {file.recordCount.toLocaleString()} 条记录 · {file.collectionName}
                    </small>
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
            <span className="mr-auto text-xs text-muted-foreground">
              范围覆盖所选文件的全部记录
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !files.data?.files.length || !fits(files.data.files)}
              onClick={() => choose(files.data!.files, true)}
            >
              选择本页文件
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !files.data?.total || files.data.total > 5}
              onClick={async () => {
                try {
                  const all = await listDraftSourceFiles(projectId, {
                    search: fileSearch,
                    limit: 5,
                  });
                  choose(all.files, true);
                } catch (cause) {
                  fail(cause);
                }
              }}
            >
              选择全部结果中的文件
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => choose(files.data?.files ?? [], false)}
            >
              取消这些文件
            </Button>
          </div>
          {(files.data?.total ?? 0) > 10 && (
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!filePage}
                onClick={() => setFilePage(filePage - 1)}
              >
                上一页文件
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(filePage + 1) * 10 >= (files.data?.total ?? 0)}
                onClick={() => setFilePage(filePage + 1)}
              >
                下一页文件
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      {parentLabel && (
        <p className="text-xs text-muted-foreground">
          只选取新增资料；从 {parentLabel} 继承的记录不参与抽样。
        </p>
      )}
      {issue && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {issue}
        </div>
      )}
      <div className="grid min-w-0 items-start gap-5 min-[1081px]:grid-cols-[300px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-base">
              筛选与选取
            </CardTitle>
            <p className="text-xs text-muted-foreground">先确定范围，再控制选取数量。</p>
          </CardHeader>
          <CardContent className="space-y-4 border-t p-5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm">筛选条件</strong>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || rules.length >= 20}
                onClick={() => {
                  invalidate();
                  setRules([
                    ...rules,
                    { id: nextRule, field: "question", operator: "contains", value: "" },
                  ]);
                  setNextRule(nextRule + 1);
                }}
              >
                <Plus className="size-3" />
                添加条件
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              所有条件同时满足；不添加条件时保留全部记录。
            </p>
            {!rules.length && (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                暂无条件 · 使用全部来源记录
              </p>
            )}
            {rules.map((rule, index) => (
              <div key={rule.id} className="space-y-2">
                <Choice
                  label={`条件 ${index + 1} 的字段`}
                  value={rule.field === "metadata" ? `metadata:${rule.key}` : rule.field}
                  options={fields}
                  disabled={disabled}
                  onChange={(value) =>
                    updateRule(
                      rule.id,
                      value.startsWith("metadata:")
                        ? { field: "metadata", key: value.slice(9) }
                        : { field: value as "question" | "expectedOutput", key: "" },
                    )
                  }
                />
                <div className="grid grid-cols-[80px_minmax(0,1fr)_28px] items-center gap-1.5">
                  <Choice
                    label={`条件 ${index + 1} 的运算符`}
                    value={rule.operator}
                    options={operators}
                    disabled={disabled}
                    onChange={(value) =>
                      updateRule(rule.id, { operator: value as SelectionCondition["operator"] })
                    }
                  />
                  <Input
                    aria-label={`条件 ${index + 1} 的值`}
                    value={rule.value ?? ""}
                    disabled={disabled || ["empty", "filled"].includes(rule.operator)}
                    placeholder={
                      ["empty", "filled"].includes(rule.operator) ? "无需填写" : "筛选值"
                    }
                    onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`删除条件 ${index + 1}`}
                    disabled={disabled}
                    onClick={() => {
                      invalidate();
                      setRules(rules.filter((item) => item.id !== rule.id));
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <div className="border-t pt-4">
              <strong className="text-sm">选取方式</strong>
              <div className="my-3 grid gap-3 text-sm">
                {(
                  [
                    ["all", "全部选取"],
                    ["random", "随机抽取"],
                  ] as const
                ).map(([value, label]) => (
                  <Label key={value} className="flex items-center gap-2 font-normal">
                    <input
                      type="radio"
                      className="accent-primary"
                      name={`selection-method-${draftId}`}
                      checked={method === value}
                      disabled={disabled}
                      onChange={() => {
                        invalidate();
                        setMethod(value);
                      }}
                    />
                    {label}
                  </Label>
                ))}
              </div>
              {method === "all" ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  选取筛选后的全部记录；未设置筛选条件时选取全部记录。
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-[95px_minmax(0,1fr)_20px] items-center gap-2">
                    <Choice
                      label="选取数量或比例"
                      value={mode}
                      options={[
                        { value: "count", label: "按数量" },
                        { value: "percent", label: "按比例" },
                      ]}
                      disabled={disabled}
                      onChange={(value) => {
                        invalidate();
                        setMode(value as "count" | "percent");
                      }}
                    />
                    <Input
                      aria-label={mode === "count" ? "抽取数量" : "抽取比例"}
                      type="number"
                      min={mode === "count" ? 1 : 0.01}
                      max={mode === "count" ? 10000 : 100}
                      step={mode === "count" ? 1 : 0.01}
                      value={mode === "count" ? count : percent}
                      disabled={disabled}
                      onChange={(event) => {
                        invalidate();
                        (mode === "count" ? setCount : setPercent)(event.target.value);
                      }}
                    />
                    <span className="text-sm">{mode === "count" ? "条" : "%"}</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {mode === "percent"
                      ? preview && !stale
                        ? `${preview.candidateCount} × ${percent}% → ${Math.floor((preview.candidateCount * Number(percent)) / 100)} 条，向下取整。`
                        : "按筛选后的候选数计算比例，向下取整。"
                      : "候选不足时选取全部候选。"}
                  </p>
                  <details className="mt-4 text-xs">
                    <summary className="cursor-pointer">复现设置</summary>
                    <Label className="mt-3 grid gap-2">
                      随机种子
                      <Input
                        aria-label="随机种子"
                        value={seed}
                        disabled={disabled}
                        onChange={(event) => {
                          invalidate();
                          setSeed(event.target.value);
                        }}
                      />
                    </Label>
                    <p className="mt-2 leading-relaxed text-muted-foreground">
                      同一来源、规则和种子可复现结果；留空会生成新种子。
                    </p>
                  </details>
                </>
              )}
            </div>
            <Button
              className="w-full"
              disabled={disabled || !scope.length}
              onClick={() => void generate()}
            >
              {busy
                ? "正在处理…"
                : !preview
                  ? "生成预览"
                  : stale || receipt
                    ? "更新预览"
                    : "重新生成预览"}
            </Button>
          </CardContent>
        </Card>
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle role="heading" aria-level={2} className="text-base">
              选取预览
            </CardTitle>
            {preview && (
              <span className="text-xs text-muted-foreground">
                固定预览 · 翻页与搜索不会重新抽取
              </span>
            )}
          </CardHeader>
          {!preview ? (
            <CardContent className="border-t px-5 py-16 text-center">
              <Search className="mx-auto mb-3 size-8 text-muted-foreground" />
              <h3 className="font-medium">先生成预览</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                选择资料范围，设置筛选条件和数量，再核对要加入草稿的记录。
              </p>
            </CardContent>
          ) : (
            <CardContent className="p-0">
              <div className="grid grid-cols-2 border-y sm:grid-cols-4">
                {[
                  ["来源记录", preview.scopeCount],
                  ["筛选后", preview.candidateCount],
                  ["目标数量", preview.targetCount],
                  ["当前已选", picked.size],
                ].map(([label, value]) => (
                  <div key={label} className="border-r p-4 last:border-r-0">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <strong className="mt-1.5 block text-xl tabular-nums">{value}</strong>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-5 py-3 text-xs text-muted-foreground">
                {previewFiles.map((file) => (
                  <span key={file.id}>
                    {file.fileName}{" "}
                    <b className="text-foreground">
                      {
                        [...picked].filter((id) => {
                          try {
                            return JSON.parse(id)[0] === file.id;
                          } catch {
                            return false;
                          }
                        }).length
                      }
                    </b>
                  </span>
                ))}
              </div>
              {preview.configuration.method === "random" &&
                preview.targetCount > preview.candidateCount && (
                  <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">
                    目标为 {preview.targetCount} 条，但筛选后只有 {preview.candidateCount}{" "}
                    条，已选取全部候选。
                  </p>
                )}
              {preview.configuration.method === "random" &&
                preview.configuration.mode === "percent" &&
                preview.targetCount === 0 &&
                preview.candidateCount > 0 && (
                  <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">
                    当前比例按 {preview.candidateCount} 条候选向下取整为 0
                    条，请提高比例或改为按数量抽取。
                  </p>
                )}
              {stale && (
                <p role="status" className="border-b bg-amber-50 px-5 py-3 text-sm text-amber-800">
                  配置已修改，旧预览和人工选择已保留；请先更新预览。
                </p>
              )}
              {changed && (
                <div
                  role="status"
                  className="border-b bg-amber-50 px-5 py-3 text-sm text-amber-800"
                >
                  <p>草稿已变化（当前修订 {currentRevision}），请核对当前草稿后重新确认。</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={onViewDraft}>
                      查看当前草稿
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setExpectedRevision(currentRevision)}
                    >
                      已核对，使用最新修订
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
                <p className="text-sm">
                  {receipt
                    ? `已加入 ${receipt.added} 条 · 已有 ${receipt.skipped} 条跳过`
                    : `已选 ${picked.size} 条 · 已在草稿 ${skipped} 条 · 本次新增 ${additions} 条`}
                </p>
                {receipt ? (
                  <Button onClick={onViewDraft}>查看草稿</Button>
                ) : (
                  <Button
                    disabled={disabled || stale || changed || !additions || !!rows.error}
                    onClick={() => void confirm()}
                  >
                    确认加入草稿（{additions}）
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2 border-b px-5 py-3">
                <Button
                  variant={view === "selected" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setView("selected");
                    setPage(0);
                  }}
                >
                  已选结果
                </Button>
                <Button
                  variant={view === "candidates" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setView("candidates");
                    setPage(0);
                  }}
                >
                  全部候选
                </Button>
                <Input
                  className="min-w-36 flex-1"
                  aria-label="搜索预览记录"
                  placeholder="搜索问题、输出或文件"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || stale || !!receipt}
                  onClick={() => {
                    setPicked(new Set(preview.selectedIds));
                    setIncluded([]);
                    setPage(0);
                  }}
                >
                  恢复原{method === "random" ? "抽样" : "选取"}结果
                </Button>
                {method === "random" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || stale || !!receipt}
                    onClick={() => void generate(true)}
                  >
                    重新抽一批
                  </Button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] table-fixed text-sm">
                  <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-14 px-3 py-3">选择</th>
                      <th className="w-[24%] px-3 py-3">问题</th>
                      <th className="w-[22%] px-3 py-3">期望输出</th>
                      <th className="w-[22%] px-3 py-3">来源 / 位置</th>
                      <th className="px-3 py-3">Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rows.data?.records ?? []).map((record) => (
                      <tr
                        key={record.id}
                        tabIndex={0}
                        className={`cursor-pointer border-t hover:bg-accent/40 focus-visible:outline-2 ${picked.has(record.id) ? "" : "text-muted-foreground"}`}
                        onClick={() => setDetail(record)}
                        onKeyDown={(event) => {
                          if (
                            event.target === event.currentTarget &&
                            ["Enter", " "].includes(event.key)
                          ) {
                            event.preventDefault();
                            setDetail(record);
                          }
                        }}
                      >
                        <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            aria-label={`选择 ${record.fileName} 第 ${record.ordinal} 条`}
                            checked={picked.has(record.id)}
                            disabled={disabled || stale || !!receipt}
                            onCheckedChange={(checked) => {
                              setPicked((current) => {
                                const next = new Set(current);
                                if (checked) next.add(record.id);
                                else next.delete(record.id);
                                return next;
                              });
                              if (
                                checked &&
                                !included.includes(record.id) &&
                                !preview.selectedIds.includes(record.id)
                              )
                                setIncluded([...included, record.id]);
                            }}
                          />
                        </td>
                        <td className="truncate px-3 py-3">{record.question || "未填写"}</td>
                        <td className="truncate px-3 py-3">{record.expectedOutput || "未填写"}</td>
                        <td className="px-3 py-3">
                          <p className="truncate">{record.fileName}</p>
                          <small className="text-muted-foreground">第 {record.ordinal} 条</small>
                          {existingKeys.has(record.id) && (
                            <small className="block text-muted-foreground">已在草稿</small>
                          )}
                        </td>
                        <td
                          className="px-3 py-3 text-xs"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MetadataSummary entries={record.metadata} />
                        </td>
                      </tr>
                    ))}
                    {!rows.data?.records.length && (
                      <tr>
                        <td colSpan={5} className="px-5 py-12 text-center text-muted-foreground">
                          {rows.isPending
                            ? "正在加载预览…"
                            : rows.error
                              ? "预览加载失败"
                              : "没有匹配的记录"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
                <span>
                  共 {rows.data?.total ?? 0} 条 · 第 {page + 1}/
                  {Math.max(1, Math.ceil((rows.data?.total ?? 0) / 20))} 页 · 排除后不会自动补足
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!page}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={(page + 1) * 20 >= (rows.data?.total ?? 0)}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
      <SelectionHistory
        path={`/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts/${encodeURIComponent(draftId)}/selection-history`}
        revision={revision}
        enabled={active}
      />
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>查看完整记录</DialogTitle>
            <DialogDescription>
              {detail?.fileName} · 第 {detail?.ordinal} 条
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="grid gap-5 sm:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-medium">问题</h3>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {detail.question || "未填写"}
                </p>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">期望输出</h3>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {detail.expectedOutput || "未填写"}
                </p>
              </section>
              <section className="sm:col-span-2">
                <h3 className="mb-2 text-sm font-medium">Metadata</h3>
                {detail.metadata.length ? (
                  <dl className="space-y-2 text-sm">
                    {detail.metadata.map((entry) => (
                      <div
                        key={entry.key}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-3"
                      >
                        <dt className="break-words text-muted-foreground">{entry.key}</dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {entry.value || "（空值）"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">未填写</p>
                )}
              </section>
            </div>
          )}
          <Button className="justify-self-end" onClick={() => setDetail(undefined)}>
            返回预览
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
