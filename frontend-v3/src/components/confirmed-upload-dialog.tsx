import { useEffect, useState, type DragEvent } from "react";
import { Check, CloudUpload, FileText, GripVertical, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createRequestId } from "@/lib/request-id";
import { Label } from "@/components/ui/label";
import { MetadataSummary } from "@/components/material-record-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  cancelPendingUploads,
  confirmPendingUploads,
  previewPendingUpload,
  startPendingUpload,
  type DisplayMapping,
  type PendingUpload,
} from "@/services/workspace";

type QueueItem = {
  file: File;
  pending: PendingUpload;
  mapping: DisplayMapping;
  preview: Array<{
    question: string;
    expectedOutput: string;
    metadata: Array<{ key: string; value: string }>;
  }>;
};

type MappingTarget = "question" | "expectedOutput" | "metadata";

export function ConfirmedUploadDialog({
  open,
  projectId,
  collections,
  defaultCollectionId,
  onOpenChange,
  onConfirmed,
}: {
  open: boolean;
  projectId: string;
  collections: Array<{ id: string; name: string }>;
  defaultCollectionId: string;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [current, setCurrent] = useState(0);
  const [step, setStep] = useState<"select" | "preview">("select");
  const [confirmationKey, setConfirmationKey] = useState(createRequestId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [ignoredLocalCount, setIgnoredLocalCount] = useState(0);
  const [skippedDuplicates, setSkippedDuplicates] = useState<string[]>([]);
  const [draggedPath, setDraggedPath] = useState<string>();
  const [dropTarget, setDropTarget] = useState<MappingTarget>();

  useEffect(() => {
    if (open) setCollectionId(defaultCollectionId);
  }, [open, defaultCollectionId]);

  function close() {
    if (pending) return;
    const ids = queue.map((item) => item.pending.id);
    if (ids.length) void cancelPendingUploads(projectId, ids).catch(() => undefined);
    setFiles([]);
    setQueue([]);
    setStep("select");
    setError("");
    setIgnoredLocalCount(0);
    setSkippedDuplicates([]);
    onOpenChange(false);
  }

  function appendFiles(input: HTMLInputElement) {
    const selected = Array.from(input.files ?? []);
    const known = new Set(files.map(fileKey));
    const added = selected.filter((file) => {
      const key = fileKey(file);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    setFiles((current) => [...current, ...added]);
    setIgnoredLocalCount((count) => count + selected.length - added.length);
    input.value = "";
  }

  function removeFile(file: File) {
    setFiles((current) => current.filter((item) => fileKey(item) !== fileKey(file)));
  }

  async function start() {
    if (!files.length || !collectionId) return;
    setPending(true);
    setError("");
    const pendingIds: string[] = [];
    try {
      const next: QueueItem[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        let uploaded: PendingUpload;
        try {
          uploaded = await startPendingUpload(projectId, file);
        } catch (cause) {
          const message = duplicateMessage(file, cause);
          if (message) {
            skipped.push(message);
            continue;
          }
          throw cause;
        }
        pendingIds.push(uploaded.id);
        const mapping = suggestedMapping(uploaded);
        const preview = await previewPendingUpload(projectId, uploaded.id, mapping);
        next.push({ file, pending: preview, mapping, preview: preview.preview });
      }
      setSkippedDuplicates(skipped);
      setFiles(next.map((item) => item.file));
      if (!next.length) return;
      setQueue(next);
      setCurrent(0);
      setConfirmationKey(createRequestId());
      setStep("preview");
    } catch (cause) {
      if (pendingIds.length)
        await cancelPendingUploads(projectId, pendingIds).catch(() => undefined);
      setError(cause instanceof Error ? cause.message : "文件无法解析，请检查后重试。");
    } finally {
      setPending(false);
    }
  }

  async function setTarget(path: string, target: MappingTarget | undefined) {
    const item = queue[current];
    if (!item) return;
    const mapping = {
      question:
        target === "question"
          ? path
          : item.mapping.question === path
            ? undefined
            : item.mapping.question,
      expectedOutput:
        target === "expectedOutput"
          ? path
          : item.mapping.expectedOutput === path
            ? undefined
            : item.mapping.expectedOutput,
      metadata:
        target === "metadata"
          ? [...new Set([...item.mapping.metadata, path])]
          : item.mapping.metadata.filter((value) => value !== path),
    };
    if (target === "question")
      mapping.expectedOutput =
        item.mapping.expectedOutput === path ? undefined : mapping.expectedOutput;
    if (target === "expectedOutput")
      mapping.question = item.mapping.question === path ? undefined : mapping.question;
    setError("");
    setPending(true);
    try {
      const preview = await previewPendingUpload(projectId, item.pending.id, mapping);
      setQueue((items) =>
        items.map((entry, index) =>
          index === current
            ? { ...entry, pending: preview, mapping, preview: preview.preview }
            : entry,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新预览。");
    } finally {
      setPending(false);
    }
  }

  function startMappingDrag(event: DragEvent<HTMLElement>, path: string) {
    if (pending) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", path);
    setDraggedPath(path);
  }

  function endMappingDrag() {
    setDraggedPath(undefined);
    setDropTarget(undefined);
  }

  function dragOverMapping(event: DragEvent<HTMLElement>, target: MappingTarget) {
    if (pending) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  }

  function leaveMapping(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(undefined);
  }

  function dropMapping(event: DragEvent<HTMLElement>, target: MappingTarget) {
    event.preventDefault();
    const path = event.dataTransfer.getData("text/plain") || draggedPath;
    endMappingDrag();
    if (path && !pending) void setTarget(path, target);
  }

  async function confirm() {
    setPending(true);
    setError("");
    try {
      await confirmPendingUploads(
        projectId,
        collectionId,
        queue.map((item) => item.pending.id),
        confirmationKey,
      );
      await onConfirmed();
      setFiles([]);
      setQueue([]);
      setConfirmationKey(createRequestId());
      setStep("select");
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  const item = queue[current];
  return (
    <Dialog open={open} onOpenChange={(value) => (value ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(1180px,calc(100vw-2rem))] max-w-none gap-0 overflow-y-auto p-0">
        {step === "select" ? (
          <div>
            <DialogHeader className="px-6 pb-5 pt-6">
              <DialogTitle>上传文件</DialogTitle>
              <DialogDescription>选择文件后核对字段映射和统一记录，再确认保存。</DialogDescription>
            </DialogHeader>
            <div className="px-6 pt-5">
              <UploadSteps current={step} />
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="grid min-h-43 place-items-center rounded-md border border-dashed bg-secondary text-center">
                <div className="px-4 py-6">
                  <CloudUpload className="mx-auto mb-2 size-7 text-muted-foreground" />
                  <p className="text-sm font-semibold">选择要上传的本地文件</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    支持 CSV、JSON 和 JSONL，可一次选择多个文件。
                  </p>
                  <Label
                    htmlFor="upload-files"
                    className="mt-4 inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
                  >
                    选择文件
                  </Label>
                  <Input
                    id="upload-files"
                    className="sr-only"
                    type="file"
                    multiple
                    accept=".csv,.json,.jsonl"
                    onChange={(event) => appendFiles(event.currentTarget)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>保存到</Label>
                <Select value={collectionId} onValueChange={setCollectionId}>
                  <SelectTrigger aria-label="选择原始数据">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((collection) => (
                      <SelectItem key={collection.id} value={collection.id}>
                        {collection.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {files.length > 0 && (
                <section className="overflow-hidden rounded-md border">
                  <h3 className="bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground">
                    已选择 {files.length} 个文件
                  </h3>
                  {files.map((file) => (
                    <div
                      key={`${file.name}-${file.lastModified}`}
                      className="flex items-center gap-2 border-t px-3 py-2 text-sm first:border-t-0"
                    >
                      <FileText className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0 truncate font-medium">{file.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {(file.name.split(".").pop() ?? "文件").toUpperCase()} ·{" "}
                        {formatFileSize(file.size)} · 等待解析
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={`移除 ${file.name}`}
                        title={`移除 ${file.name}`}
                        onClick={() => removeFile(file)}
                        disabled={pending}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              {ignoredLocalCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  已忽略重复选择的 {ignoredLocalCount} 个文件。
                </p>
              )}
              {skippedDuplicates.map((message) => (
                <p key={message} className="text-xs text-destructive">
                  {message}
                </p>
              ))}
              <p className="text-xs leading-5 text-muted-foreground">
                文件会先解析和预览；确认前不会保存。上传到“未整理”后，仍可移动到其他原始数据。
              </p>
            </div>
            {error && (
              <p role="alert" className="px-6 pb-4 text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter className="flex-row justify-between space-x-0 px-6 pb-6 pt-4 sm:space-x-0">
              <Button type="button" variant="outline" onClick={close} disabled={pending}>
                取消
              </Button>
              <div>
                <Button
                  disabled={!files.length || !collectionId || pending}
                  onClick={() => void start()}
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  下一步
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : item ? (
          <div>
            <DialogHeader className="px-6 pb-5 pt-6">
              <DialogTitle>字段映射与预览</DialogTitle>
              <DialogDescription>
                {item.pending.fileName} · {item.pending.recordCount} 条记录 · 文件 {current + 1}/
                {queue.length}
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pt-5">
              <UploadSteps current={step} />
            </div>
            <div className="space-y-4 px-6 py-5">
              {skippedDuplicates.map((message) => (
                <p key={message} className="text-xs text-destructive">
                  {message}
                </p>
              ))}
              <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
                  <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
                    <h3 className="text-sm font-semibold">原始字段</h3>
                    <span className="text-xs text-muted-foreground">
                      {item.pending.fields.length} 个字段
                    </span>
                  </div>
                  <div className="grid max-h-[348px] gap-2 overflow-y-auto p-3" role="list">
                    {item.pending.fields.map((field) => {
                      const mapped = isMapped(item.mapping, field.path);
                      return (
                        <div
                          key={field.path}
                          role="listitem"
                          aria-label={`${displayFieldPath(field.path)}，样例：${sampleValue(field.sample)}`}
                          draggable={!pending}
                          onDragStart={(event) => startMappingDrag(event, field.path)}
                          onDragEnd={endMappingDrag}
                          className={`flex min-w-0 items-start gap-2 rounded-md border bg-background p-2.5 transition-colors ${
                            draggedPath === field.path
                              ? "opacity-40"
                              : "hover:border-ring hover:bg-accent"
                          } ${pending ? "cursor-not-allowed" : "cursor-grab"}`}
                        >
                          <GripVertical
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <span className="mono block truncate text-[13px] font-semibold">
                              {displayFieldPath(field.path)}
                            </span>
                            <span className="mono mt-1 block truncate text-xs text-muted-foreground">
                              样例：{sampleValue(field.sample)}
                            </span>
                          </div>
                          {mapped && (
                            <span
                              className="grid size-[18px] shrink-0 self-center place-items-center rounded-full border border-primary/60 bg-transparent text-primary"
                              aria-label={`${displayFieldPath(field.path)} 已映射`}
                            >
                              <Check className="size-3" aria-hidden="true" />
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
                <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
                  <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
                    <h3 className="text-sm font-semibold">映射后的统一记录</h3>
                    <span className="text-xs text-muted-foreground">拖入字段完成映射</span>
                  </div>
                  <div className="grid gap-2.5 p-3">
                    {(
                      [
                        ["question", "问题", "仅一个字段"],
                        ["expectedOutput", "期望输出", "可选 · 仅一个字段"],
                        ["metadata", "Metadata", "可多个字段"],
                      ] as const
                    ).map(([target, label, hint]) => {
                      const paths = mappingPaths(item.mapping, target);
                      return (
                        <section
                          key={target}
                          role="region"
                          aria-label={label}
                          onDragOver={(event) => dragOverMapping(event, target)}
                          onDragLeave={leaveMapping}
                          onDrop={(event) => dropMapping(event, target)}
                          className={`min-h-[76px] rounded-md border border-dashed p-2.5 transition-colors ${
                            dropTarget === target
                              ? "border-solid border-primary bg-accent"
                              : paths.length > 0
                                ? "border-solid border-primary/45 bg-primary/[0.06]"
                                : "border-border bg-background"
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <strong className="text-[13px]">{label}</strong>
                            <span className="text-xs text-muted-foreground">{hint}</span>
                          </div>
                          {paths.length ? (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {paths.map((path) => (
                                <span
                                  key={path}
                                  aria-label={`已映射字段 ${displayFieldPath(path)}`}
                                  draggable={!pending}
                                  onDragStart={(event) => startMappingDrag(event, path)}
                                  onDragEnd={endMappingDrag}
                                  className={`inline-flex max-w-full items-center gap-1 rounded-sm bg-primary py-1 pl-2 pr-1 text-xs font-semibold text-primary-foreground ${
                                    draggedPath === path ? "opacity-40" : "cursor-grab"
                                  }`}
                                >
                                  <span className="truncate">{displayFieldPath(path)}</span>
                                  <button
                                    type="button"
                                    className="grid size-4 shrink-0 place-items-center rounded-sm hover:bg-primary-foreground/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-foreground"
                                    aria-label={`取消 ${displayFieldPath(path)} 的映射`}
                                    title="取消映射"
                                    onClick={() => void setTarget(path, undefined)}
                                    disabled={pending}
                                  >
                                    <X className="size-3" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="mt-2.5 block text-xs text-muted-foreground">
                              拖到这里
                            </span>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </section>
              </div>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                已映射 {item.preview.length} 条统一记录 / 共 {item.pending.recordCount} 条原始记录
              </div>
              {item.pending.issues.length > 0 && (
                <div className="space-y-1 text-sm text-destructive">
                  <p>发现 {item.pending.issues.length} 个解析问题。</p>
                  <ul className="list-disc pl-5">
                    {item.pending.issues.slice(0, 5).map((issue, index) => (
                      <li key={`${issue.reason ?? "issue"}-${index}`}>
                        {issue.reason ?? "无法解析记录"}
                        {issue.location ? `（位置：${JSON.stringify(issue.location)}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <p className="mb-2 text-sm font-medium">映射后的数据预览</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">问题</th>
                        <th className="px-3 py-2">期望输出</th>
                        <th className="px-3 py-2">Metadata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.preview.map((row, index) => (
                        <tr key={index} className="border-t">
                          <td className="px-3 py-2">{row.question}</td>
                          <td className="px-3 py-2">{row.expectedOutput}</td>
                          <td className="px-3 py-2">
                            <MetadataSummary entries={row.metadata} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className="flex-row justify-between space-x-0 px-6 pb-6 pt-4 sm:space-x-0">
              <Button type="button" variant="outline" onClick={close}>
                取消
              </Button>
              <div className="flex gap-2">
                {current > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCurrent((value) => value - 1)}
                  >
                    上一个文件
                  </Button>
                )}
                {current + 1 < queue.length ? (
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => setCurrent((value) => value + 1)}
                  >
                    下一个文件
                  </Button>
                ) : (
                  <Button disabled={pending} onClick={() => void confirm()}>
                    {pending && <Loader2 className="size-4 animate-spin" />}确认保存
                  </Button>
                )}
              </div>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UploadSteps({ current }: { current: "select" | "preview" }) {
  const steps = [
    { key: "select", label: "选择文件" },
    { key: "preview", label: "字段映射与预览" },
  ] as const;
  return (
    <ol className="flex gap-0 border-b pb-4 text-xs" aria-label="上传步骤">
      {steps.map((step, index) => {
        const active = current === step.key;
        return (
          <li
            key={step.key}
            className={
              active
                ? "flex items-center gap-1.5 pr-3 font-medium text-foreground"
                : "flex items-center gap-1.5 pr-3 text-muted-foreground"
            }
          >
            <span
              className={
                active
                  ? "grid size-5 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
                  : "grid size-5 place-items-center rounded-md bg-muted text-[11px]"
              }
            >
              {index + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function suggestedMapping(upload: PendingUpload): DisplayMapping {
  const paths = upload.fields.map((field) => field.path);
  const first = (names: string[]) =>
    paths.find((path) => names.some((name) => path.toLowerCase().endsWith(`/${name}`)));
  const question = first(["question", "prompt", "input"]);
  const expectedOutput = first(["answer", "expected", "output"]);
  return {
    ...(question ? { question } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    metadata: [],
  };
}

function mappingPaths(mapping: DisplayMapping, target: MappingTarget) {
  if (target === "question") return mapping.question ? [mapping.question] : [];
  if (target === "expectedOutput") return mapping.expectedOutput ? [mapping.expectedOutput] : [];
  return mapping.metadata;
}

function isMapped(mapping: DisplayMapping, path: string) {
  return Boolean(
    mapping.question === path || mapping.expectedOutput === path || mapping.metadata.includes(path),
  );
}

function sampleValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "未填写";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function displayFieldPath(path: string) {
  return path.replace(/^\/+/, "") || path;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fileKey(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function duplicateMessage(file: File, cause: unknown) {
  const error = cause as Error & {
    code?: string;
    existingFileName?: string;
    existingCollectionName?: string | null;
  };
  if (error.code !== "duplicate_upload") return undefined;
  if (error.existingCollectionName)
    return `已跳过“${file.name}”：内容已在“${error.existingCollectionName}”中的“${error.existingFileName}”。`;
  return `已跳过“${file.name}”：与本次选择的“${error.existingFileName}”内容相同。`;
}
