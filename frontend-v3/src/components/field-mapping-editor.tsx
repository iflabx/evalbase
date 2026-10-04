import { useState, type DragEvent } from "react";
import { Check, GripVertical, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DisplayMapping } from "@/services/workspace";
type MappingTarget = "question" | "expectedOutput" | "metadata";
export function FieldMappingEditor({
  fields,
  mapping,
  pending,
  onChange,
}: {
  fields: Array<{ path: string; sample: unknown }>;
  mapping: DisplayMapping;
  pending: boolean;
  onChange: (mapping: DisplayMapping) => void | Promise<void>;
}) {
  const [draggedPath, setDraggedPath] = useState<string>();
  const [dropTarget, setDropTarget] = useState<MappingTarget>();
  function setTarget(path: string, target: MappingTarget | undefined) {
    const nextMapping = {
      question:
        target === "question" ? path : mapping.question === path ? undefined : mapping.question,
      expectedOutput:
        target === "expectedOutput"
          ? path
          : mapping.expectedOutput === path
            ? undefined
            : mapping.expectedOutput,
      metadata:
        target === "metadata"
          ? [...new Set([...mapping.metadata, path])]
          : mapping.metadata.filter((value) => value !== path),
    };
    if (target === "question")
      nextMapping.expectedOutput =
        nextMapping.expectedOutput === path ? undefined : nextMapping.expectedOutput;
    if (target === "expectedOutput")
      nextMapping.question = mapping.question === path ? undefined : nextMapping.question;
    void onChange(nextMapping);
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

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section className="min-w-0 overflow-hidden rounded-md border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
          <h3 className="text-sm font-semibold">原始字段</h3>
          <span className="text-xs text-muted-foreground">{fields.length} 个字段</span>
        </div>
        <div className="grid max-h-[348px] gap-2 overflow-y-auto p-3" role="list">
          {fields.map((field) => {
            const mapped = isMapped(mapping, field.path);
            return (
              <div
                key={field.path}
                role="listitem"
                aria-label={`${displayFieldPath(field.path)}，样例：${sampleValue(field.sample)}`}
                draggable={!pending}
                onDragStart={(event) => startMappingDrag(event, field.path)}
                onDragEnd={endMappingDrag}
                className={`flex min-w-0 items-start gap-2 rounded-md border bg-background p-2.5 transition-colors ${
                  draggedPath === field.path ? "opacity-40" : "hover:border-ring hover:bg-accent"
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
                <Select
                  disabled={pending}
                  value={
                    mapping.question === field.path
                      ? "question"
                      : mapping.expectedOutput === field.path
                        ? "expectedOutput"
                        : mapping.metadata.includes(field.path)
                          ? "metadata"
                          : "none"
                  }
                  onValueChange={(value) =>
                    setTarget(field.path, value === "none" ? undefined : (value as MappingTarget))
                  }
                >
                  <SelectTrigger
                    className="w-28 shrink-0"
                    aria-label={`映射 ${displayFieldPath(field.path)}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未映射</SelectItem>
                    <SelectItem value="question">问题</SelectItem>
                    <SelectItem value="expectedOutput">期望输出</SelectItem>
                    <SelectItem value="metadata">Metadata</SelectItem>
                  </SelectContent>
                </Select>
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
            const paths = mappingPaths(mapping, target);
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
                  <span className="mt-2.5 block text-xs text-muted-foreground">拖到这里</span>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
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
