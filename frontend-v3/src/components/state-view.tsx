import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertTriangle, Copy, Inbox, Loader2, XCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { JobStatus } from "@/types";
import { canRetainReadResult } from "@/services/workspace";

function useDelayedBusy(busy: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, [busy]);
  return busy && visible;
}

/** Fixed-height feedback avoids pushing the table on each background read. */
export function QueryFeedback({
  busy,
  error,
  onRetry,
  message = "正在更新…",
}: {
  busy: boolean;
  error?: unknown;
  onRetry?: () => void;
  message?: string;
}) {
  const visible = useDelayedBusy(busy);
  if (!busy && !error) return null;
  return (
    <div
      className="query-feedback flex min-h-6 items-center gap-2 text-xs text-muted-foreground"
      aria-busy={busy}
    >
      {error ? (
        <>
          <span role="alert">读取失败，已保留上次结果。</span>
          {onRetry && (
            <button className="text-primary hover:underline" onClick={onRetry}>
              重试
            </button>
          )}
        </>
      ) : visible ? (
        <span>{message}</span>
      ) : null}
    </div>
  );
}

export function TableLoadingBlock({
  columns,
  rows = 5,
  minWidth = "640px",
  framed = true,
  widths,
  busy = true,
  content,
}: {
  columns: string[];
  rows?: number;
  minWidth?: string;
  framed?: boolean;
  widths?: string[];
  busy?: boolean;
  content?: ReactNode;
}) {
  const visible = useDelayedBusy(busy);
  return (
    <div
      className={
        framed
          ? "overflow-hidden rounded-lg border border-border bg-card shadow-sm"
          : "overflow-hidden"
      }
      aria-busy={busy}
    >
      <div className="overflow-x-auto">
        <table
          className="w-full text-sm"
          style={{ minWidth, tableLayout: widths ? "fixed" : "auto" }}
        >
          {widths && (
            <colgroup>
              {widths.map((width, i) => (
                <col key={i} style={{ width }} />
              ))}
            </colgroup>
          )}
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              {columns.map((name) => (
                <th
                  key={name}
                  className={`px-4 py-2 font-medium ${name === "操作" ? "text-right" : ""}`}
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody aria-label={visible ? "加载中" : undefined}>
            {!busy ? (
              <tr>
                <td colSpan={columns.length} className="p-4">
                  {content}
                </td>
              </tr>
            ) : (
              Array.from({ length: rows }, (_, row) => (
                <tr key={row} className="h-16 border-t">
                  {columns.map((name) => (
                    <td key={name} className="px-4 py-3">
                      <Skeleton
                        className={`loading-skeleton h-4 w-3/4 bg-muted/70 ${visible ? "" : "invisible"}`}
                      />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  const visible = useDelayedBusy(true);
  return (
    <div className="space-y-3" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className={`loading-skeleton h-14 w-full bg-muted/70 ${visible ? "" : "invisible"}`}
        />
      ))}
    </div>
  );
}

export function EmptyBlock({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-8 text-center">
      <Inbox className="mb-3 size-8 text-muted-foreground" />
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4"
    >
      <div className="flex items-center gap-2 text-destructive">
        <XCircle className="size-4" />
        <span className="text-sm font-medium">操作失败</span>
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

export function WarningBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-chart-5/40 bg-chart-5/10 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-chart-5" />
        {title}
      </div>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function RunningBlock({ label, progress }: { label: string; progress?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-4">
      <Loader2 className="size-4 animate-spin text-primary" />
      <div>
        <div className="text-sm font-medium">{label}</div>
        {progress && <div className="text-xs text-muted-foreground">{progress}</div>}
      </div>
    </div>
  );
}

export function SuccessBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-chart-2/40 bg-chart-2/10 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-chart-2" />
        {title}
      </div>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

const STATUS_META: Record<JobStatus, { label: string; className: string }> = {
  CREATED: { label: "已创建", className: "bg-muted text-muted-foreground" },
  QUEUED: { label: "排队中", className: "bg-muted text-muted-foreground" },
  RUNNING: { label: "运行中", className: "bg-primary/10 text-primary border-primary/30" },
  SUCCEEDED: { label: "成功", className: "bg-chart-2/10 text-chart-2 border-chart-2/30" },
  PARTIAL_SUCCEEDED: {
    label: "部分成功",
    className: "bg-chart-5/10 text-chart-5 border-chart-5/30",
  },
  FAILED: { label: "失败", className: "bg-destructive/10 text-destructive border-destructive/30" },
  CANCEL_REQUESTED: { label: "取消中", className: "bg-muted text-muted-foreground" },
  CANCELLED: { label: "已取消", className: "bg-muted text-muted-foreground" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status];
  const spinning = status === "RUNNING" || status === "QUEUED" || status === "CANCEL_REQUESTED";
  return (
    <Badge variant="outline" className={meta.className}>
      {spinning ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
      {meta.label}
    </Badge>
  );
}

/** 等宽 ID / Hash，一键复制 */
export function CopyableId({ value, className }: { value: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const active = document.activeElement as HTMLElement | null;
            const field = document.createElement("textarea");
            field.value = value;
            field.readOnly = true;
            field.style.position = "fixed";
            field.style.opacity = "0";
            document.body.appendChild(field);
            try {
              field.select();
              if (!document.execCommand("copy")) throw new Error("copy_failed");
            } finally {
              field.remove();
              active?.focus?.({ preventScroll: true });
            }
          }
          toast.success("已复制", { description: value });
        } catch {
          toast.error("复制失败，请手动选择并复制。");
        }
      }}
      title="点击复制"
      className={`mono inline-flex max-w-full items-center gap-1 truncate rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground ${className ?? ""}`}
    >
      <span className="truncate">{value}</span>
      <Copy className="size-3 shrink-0" />
    </button>
  );
}

export type EvidenceStep = {
  label: string;
  detail?: string;
  state: "done" | "current" | "todo" | "error";
};

/** 证据链轨道：数据来源 → 导入草稿 → 固化版本 → 发布/导回 → 运行快照 → 报告 */
export function EvidenceTrack({ steps }: { steps: EvidenceStep[] }) {
  return (
    <ol className="flex flex-wrap items-stretch gap-0 rounded-lg border border-border bg-card p-3">
      {steps.map((s, i) => (
        <li key={s.label} className="flex min-w-40 flex-1 items-start gap-2">
          <div className="flex flex-col items-center pt-1">
            <span
              aria-hidden
              className={
                "size-2.5 rounded-full " +
                (s.state === "done"
                  ? "bg-chart-2"
                  : s.state === "current"
                    ? "bg-primary ring-4 ring-primary/15"
                    : s.state === "error"
                      ? "bg-destructive"
                      : "bg-border")
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">{s.label}</span>
              <span className="sr-only">
                {s.state === "done"
                  ? "已完成"
                  : s.state === "current"
                    ? "进行中"
                    : s.state === "error"
                      ? "失败"
                      : "未开始"}
              </span>
              {i < steps.length - 1 && (
                <span aria-hidden className="hidden h-px flex-1 bg-border sm:block" />
              )}
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {s.detail ?? "—"}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 统一的查询状态包装：加载 / 失败 / 空 / 成功 */
export function StateView<T>({
  isLoading,
  error,
  data,
  isEmpty,
  empty,
  onRetry,
  children,
  loadingRows,
  loading,
  isRefreshing = false,
  isPlaceholder = false,
  retainDataOnError = false,
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
  loadingRows?: number;
  loading?: ReactNode;
  isRefreshing?: boolean;
  isPlaceholder?: boolean;
  retainDataOnError?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [confirmedHeight, setHeight] = useState(344);
  const hasFrame = Boolean(loading);
  useLayoutEffect(() => {
    if (hasFrame && !isLoading && panel.current)
      setHeight(panel.current.getBoundingClientRect().height);
  }, [data, hasFrame, isLoading]);
  const retain = retainDataOnError && canRetainReadResult(error) && data !== undefined;
  const body = isLoading ? (
    (loading ?? <LoadingBlock {...(loadingRows ? { rows: loadingRows } : {})} />)
  ) : error && !retain ? (
    <ErrorBlock
      message={error instanceof Error ? error.message : "未知错误"}
      {...(onRetry ? { onRetry } : {})}
    />
  ) : data === undefined ? (
    <EmptyBlock title="暂无数据" />
  ) : isEmpty?.(data) ? (
    (empty ?? <EmptyBlock title="暂无数据" />)
  ) : (
    children(data)
  );
  // Existing callers retain their compact layout; stable read panels opt in with a table skeleton.
  if (!loading) return <>{body}</>;
  const fallback = !isLoading && (data === undefined || (error && !retain) || isEmpty?.(data));
  const framedBody =
    fallback && isValidElement(loading) && loading.type === TableLoadingBlock
      ? cloneElement(loading as ReactElement<{ busy?: boolean; content?: ReactNode }>, {
          busy: false,
          content: body,
        })
      : body;
  return (
    <div
      ref={panel}
      style={{ minHeight: isLoading ? confirmedHeight : undefined }}
      aria-busy={isLoading || isRefreshing}
    >
      <QueryFeedback
        busy={isRefreshing && !isLoading}
        error={retain ? error : undefined}
        {...(onRetry ? { onRetry } : {})}
      />
      <div
        className={isLoading ? "" : "content-enter"}
        inert={isPlaceholder || Boolean(error && retain)}
      >
        {framedBody}
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        {eyebrow ? <p className="mb-1 text-sm text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
