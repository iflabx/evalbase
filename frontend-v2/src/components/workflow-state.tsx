import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  actionIcon: LucideIcon;
  actionDisabled?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionIcon: ActionIcon,
  actionDisabled = false,
}: EmptyStateProps) {
  return (
    <div className="relative flex min-h-[26rem] flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center shadow-sm">
      <div
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,oklch(0.92_0.01_250)_1px,transparent_1px),linear-gradient(to_bottom,oklch(0.92_0.01_250)_1px,transparent_1px)] [background-size:32px_32px]"
        aria-hidden="true"
      />
      <div className="relative z-10 flex max-w-md flex-col items-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-8 ring-primary/5">
          <Icon className="size-7" aria-hidden="true" />
        </div>
        <h2
          id={title.includes("原始") ? "materials-empty-title" : "test-sets-empty-title"}
          className="text-xl font-semibold"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        <Button className="mt-6" disabled={actionDisabled}>
          <ActionIcon className="size-4" aria-hidden="true" />
          {actionLabel}
        </Button>
        {actionDisabled ? (
          <p className="mt-3 text-xs text-muted-foreground">下一步功能将在后续工作流中启用</p>
        ) : null}
      </div>
    </div>
  );
}
