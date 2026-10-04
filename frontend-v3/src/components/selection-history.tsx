import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/workspace";
import type { SelectionConfig } from "@/services/selection";

type Entry = {
  id: string;
  configuration: SelectionConfig;
  actorName: string;
  at: string;
  scopeCount: number;
  candidateCount: number;
  selectedCount: number;
  added: number;
  skipped: number;
  selectedDigest: string;
};
const operators = { contains: "包含", equals: "等于", empty: "为空", filled: "不为空" };

export function SelectionHistory({
  path,
  revision = 0,
  enabled = true,
}: {
  path: string;
  revision?: number;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: ["selection-history", path, revision],
    queryFn: () => request<{ history: Entry[] }>(path),
    enabled,
    retry: false,
  });
  if (query.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        选取记录加载失败，请刷新后重试。
      </p>
    );
  if (!query.data?.history.length) return null;
  return (
    <details className="rounded-md border bg-card p-4 text-sm">
      <summary className="cursor-pointer font-medium">
        查看数据选取规则 · {query.data.history.length} 次
      </summary>
      <div className="mt-3 divide-y">
        {query.data.history.map((entry) => (
          <div key={entry.id} className="space-y-1 py-3 first:pt-0">
            <p className="font-medium">
              {entry.actorName} · {new Date(entry.at).toLocaleString()}
            </p>
            <p>
              {entry.scopeCount} 条来源 → 筛选后 {entry.candidateCount} 条 → 选中{" "}
              {entry.selectedCount} 条 → 新增 {entry.added} 条
            </p>
            <p className="text-xs text-muted-foreground">
              {entry.configuration.method === "all"
                ? "全部选取"
                : `随机抽取 ${entry.configuration.value}${entry.configuration.mode === "percent" ? "%" : " 条"} · 种子 ${entry.configuration.seed}`}{" "}
              · 已有 {entry.skipped} 条跳过
            </p>
            <p className="text-xs text-muted-foreground">
              {entry.configuration.conditions
                .map(
                  (rule) =>
                    `${rule.field === "metadata" ? `Metadata · ${rule.key}` : rule.field === "question" ? "问题" : "期望输出"} ${operators[rule.operator]} ${["empty", "filled"].includes(rule.operator) ? "" : (rule.value ?? "")}`,
                )
                .join("；") || "未设置筛选条件"}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
