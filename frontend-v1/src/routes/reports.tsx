import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { listReports, type ReportState } from "@/services/reporting";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyableId, EmptyBlock, PageHeader, StateView } from "@/components/state-view";

const STATE_META: Record<ReportState, { label: string; className: string }> = {
  GENERATING: { label: "生成中", className: "bg-primary/10 text-primary border-primary/30" },
  READY: { label: "可下载", className: "bg-chart-2/10 text-chart-2 border-chart-2/30" },
  FAILED: {
    label: "生成失败",
    className: "bg-destructive/10 text-destructive border-destructive/30",
  },
  EXPIRED: { label: "已过期", className: "bg-muted text-muted-foreground" },
};

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "报告中心 · AgentEval Hub" },
      {
        name: "description",
        content: "查看端到端计算运行产生的报告状态、来源运行、格式与下载入口。",
      },
      { property: "og:title", content: "报告中心 · AgentEval Hub" },
      { property: "og:description", content: "查看端到端运行报告的状态、格式与下载入口。" },
    ],
  }),
  component: ReportsPage,
});

function ReportsPage() {
  const query = useQuery({ queryKey: ["reports"], queryFn: listReports, refetchInterval: 1500 });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="报告"
        description="报告由端到端计算运行生成，包含数据集版本、运行参数、指标口径与生成时间。"
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyBlock
            title="还没有报告"
            description="完成一次端到端计算后，在运行详情页导出 CSV / JSON / Markdown 报告。"
            action={
              <Button asChild>
                <Link to="/runs">前往计算运行</Link>
              </Button>
            }
          />
        }
      >
        {(items) => (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">报告</th>
                    <th className="px-4 py-2 font-medium">来源运行</th>
                    <th className="px-4 py-2 font-medium">格式</th>
                    <th className="px-4 py-2 font-medium">生成时间</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 text-muted-foreground" />
                          <CopyableId value={r.id} />
                        </div>
                      </td>
                      <td className="max-w-64 truncate px-4 py-2">
                        <Link to="/runs/$id" params={{ id: r.runId }} className="hover:underline">
                          {r.runName}
                        </Link>
                      </td>
                      <td className="mono px-4 py-2 uppercase">{r.format}</td>
                      <td className="mono px-4 py-2 text-muted-foreground">
                        {r.createdAt.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={STATE_META[r.state].className}>
                          {STATE_META[r.state].label}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={r.state !== "READY"}
                          asChild={r.state === "READY"}
                        >
                          {r.state === "READY" ? (
                            <Link to="/runs/$id" params={{ id: r.runId }}>
                              <Download className="size-4" /> 下载
                            </Link>
                          ) : (
                            <span>
                              <Download className="size-4" /> 下载
                            </span>
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </StateView>
    </div>
  );
}
