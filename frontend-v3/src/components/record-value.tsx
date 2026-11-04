import { useState, type SyntheticEvent } from "react";
import { ChevronDown } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Structure = Record<string, unknown> | unknown[];

function isStructure(value: unknown): value is Structure {
  return value !== null && typeof value === "object";
}

function readStructure(value: string): Structure | undefined {
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    // Preserve numeric text such as IDs larger than Number.MAX_SAFE_INTEGER.
    const parsed: unknown = JSON.parse(
      value,
      (_key, child: unknown, context?: { source?: string }) =>
        typeof child === "number" ? (context?.source ?? child) : child,
    );
    return isStructure(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function structureLabel(value: Structure) {
  return Array.isArray(value)
    ? `数组 · ${value.length} 项`
    : `对象 · ${Object.keys(value).length} 个字段`;
}

function valueText(value: unknown) {
  if (isStructure(value)) return structureLabel(value);
  if (value === "") return "（空字符串）";
  return String(value);
}

export function RecordValue({
  value,
  className,
  empty = "未填写",
  prefix = "",
  title,
}: {
  value: string;
  className?: string;
  empty?: string;
  prefix?: string;
  title?: string;
}) {
  const structure = readStructure(value);
  if (!structure)
    return (
      <span className={className} title={title}>
        {prefix}
        {value || empty}
      </span>
    );

  const label = structureLabel(structure);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="record-structured-trigger block w-full min-w-0 max-w-80 rounded-md border bg-background px-2 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span className="record-structured-label flex items-center justify-between gap-2 text-muted-foreground">
            {prefix}
            {label}
            <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
          </span>
          {(Array.isArray(structure)
            ? Object.entries(structure.slice(0, 2))
            : Object.entries(structure).slice(0, 2)
          ).map(([key, child]) => (
            <span
              key={key}
              className="record-structured-preview mt-0.5 block truncate text-foreground"
            >
              <span className="font-medium text-muted-foreground">
                {Array.isArray(structure) ? Number(key) + 1 : key || "（空字段名）"}
              </span>
              <span className="ml-1.5">{valueText(child).slice(0, 160)}</span>
            </span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="结构化值"
        className="w-96 max-w-[calc(100vw-2rem)] max-h-[min(65vh,var(--radix-popover-content-available-height))] overflow-auto text-sm"
      >
        <h3 className="mb-2 font-medium">{label}</h3>
        <StructureEntries value={structure} />
        <details className="mt-3 border-t pt-2">
          <summary className="cursor-pointer text-muted-foreground">查看原始值</summary>
          <pre className="mt-2 whitespace-pre-wrap wrap-anywhere rounded-md bg-muted p-2 text-xs">
            {value}
          </pre>
        </details>
      </PopoverContent>
    </Popover>
  );
}

function StructureEntries({ value }: { value: Structure }) {
  const [visible, setVisible] = useState(50);
  const entries = Array.isArray(value)
    ? Object.entries(value.slice(0, visible))
    : Object.entries(value);
  const total = Array.isArray(value) ? value.length : entries.length;
  if (!entries.length) return <p className="text-muted-foreground">没有内容</p>;
  return (
    <>
      <dl className="divide-y rounded-md border">
        {entries.slice(0, visible).map(([key, child]) => (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 px-2 py-1.5">
            <dt className="wrap-anywhere font-medium text-muted-foreground">
              {Array.isArray(value) ? Number(key) + 1 : key || "（空字段名）"}
            </dt>
            <dd className="min-w-0">
              {isStructure(child) ? (
                <NestedStructure value={child} />
              ) : (
                <span className="whitespace-pre-wrap wrap-anywhere">{valueText(child)}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {visible < total && (
        <button
          type="button"
          className="mt-2 text-primary underline"
          onClick={() => setVisible(visible + 50)}
        >
          显示更多（还有 {total - visible} 项）
        </button>
      )}
    </>
  );
}

function NestedStructure({ value }: { value: Structure }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-muted-foreground">{structureLabel(value)}</summary>
      {open && (
        <div className="mt-1">
          <StructureEntries value={value} />
        </div>
      )}
    </details>
  );
}
