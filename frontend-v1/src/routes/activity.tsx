import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ACTIVITY_TYPE_LABELS, listActivity, type ActivityType } from "@/services/reporting";
import type { JobStatus } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CopyableId,
  EmptyBlock,
  PageHeader,
  StateView,
  StatusBadge,
} from "@/components/state-view";

const STATUSES: (JobStatus | "all")[] = [
  "all",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL_SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "活动记录 · AgentEval Hub" },
      { name: "description", content: "统一查看最近的导入、发布、计算与导出事件及其状态。" },
      { property: "og:title", content: "活动记录 · AgentEval Hub" },
      { property: "og:description", content: "统一查看最近的导入、发布、计算与导出事件。" },
    ],
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const [type, setType] = useState<ActivityType | "all">("all");
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const query = useQuery({
    queryKey: ["activity", type, status],
    queryFn: () => listActivity({ type, status }),
    refetchInterval: 2000,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="活动记录"
        description="导入、发布、计算与导出事件的统一时间线，可按类型和状态筛选。"
        actions={
          <div className="flex items-center gap-2">
            <Select value={type} onValueChange={(v) => setType(v as ActivityType | "all")}>
              <SelectTrigger className="w-36" aria-label="按类型筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                {(Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACTIVITY_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as JobStatus | "all")}>
              <SelectTrigger className="w-40" aria-label="按状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "全部状态" : s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void query.refetch()}
        empty={<EmptyBlock title="没有符合条件的活动" description="调整筛选条件后重试。" />}
      >
        {(items) => (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">
                      {ACTIVITY_TYPE_LABELS[e.type]}
                    </span>
                    <Link to={e.href} className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {e.title}
                    </Link>
                    <CopyableId value={e.target} />
                    <span className="mono text-xs text-muted-foreground">{e.actor}</span>
                    <span className="mono text-xs text-muted-foreground">
                      {e.createdAt.slice(0, 16).replace("T", " ")}
                    </span>
                    <StatusBadge status={e.status} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </StateView>
    </div>
  );
}
