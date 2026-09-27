import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { listRuns } from "@/services/runs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyBlock, PageHeader, StateView, StatusBadge } from "@/components/state-view";

export const Route = createFileRoute("/runs/")({
  head: () => ({
    meta: [
      { title: "端到端计算 · AgentEval Hub" },
      { name: "description", content: "查看七维端到端指标计算运行记录与总分。" },
      { property: "og:title", content: "端到端计算 · AgentEval Hub" },
      { property: "og:description", content: "查看七维端到端指标计算运行记录与总分。" },
    ],
  }),
  component: RunsPage,
});

function RunsPage() {
  const query = useQuery({ queryKey: ["runs"], queryFn: listRuns, refetchInterval: 1500 });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="端到端计算"
        description="基于固化的评测结果版本计算七维得分与加权总分。"
        actions={
          <Button asChild>
            <Link to="/runs/new" search={{ versionId: undefined }}>
              <Plus className="size-4" /> 新建计算
            </Link>
          </Button>
        }
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyBlock
            title="还没有计算运行"
            description="选择一个评测结果版本，配置量表与权重后开始计算。"
            action={
              <Button asChild>
                <Link to="/runs/new" search={{ versionId: undefined }}>
                  新建计算
                </Link>
              </Button>
            }
          />
        }
      >
        {(runs) => (
          <div className="space-y-3">
            {runs.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {r.name}
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {r.resultVersionLabel} · {r.params.calculatorVersion} ·{" "}
                      {r.createdAt.slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">总分</div>
                      <div className="font-mono text-lg">
                        {r.overallScore === null ? "—" : r.overallScore.toFixed(3)}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/runs/$id" params={{ id: r.id }}>
                        报告
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </StateView>
    </div>
  );
}
