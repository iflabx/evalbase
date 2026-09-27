import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { listPublishJobs } from "@/services/langfuse";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyBlock, PageHeader, StateView, StatusBadge } from "@/components/state-view";

export const Route = createFileRoute("/publishes/")({
  head: () => ({
    meta: [
      { title: "发布到 Langfuse · AgentEval Hub" },
      { name: "description", content: "查看数据集版本发布到 Langfuse Datasets 的任务与状态。" },
      { property: "og:title", content: "发布到 Langfuse · AgentEval Hub" },
      { property: "og:description", content: "查看数据集版本发布到 Langfuse 的任务与状态。" },
    ],
  }),
  component: PublishesPage,
});

function PublishesPage() {
  const query = useQuery({
    queryKey: ["publishes"],
    queryFn: () => listPublishJobs(),
    refetchInterval: 1500,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="发布到 Langfuse"
        description="发布只写入期望答案（expectedOutput），不写入模型实际输出。"
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyBlock
            title="还没有发布任务"
            description="在数据集版本上发起一次发布。"
            action={
              <Button asChild>
                <Link to="/datasets">前往数据集</Link>
              </Button>
            }
          />
        }
      >
        {(jobs) => (
          <div className="space-y-3">
            {jobs.map((j) => (
              <Card key={j.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {j.datasetName} · {j.version}
                      <StatusBadge status={j.status} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {j.langfuseProject} / {j.langfuseDatasetName} ·{" "}
                      {j.createdAt.slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">成功 / 总数</div>
                      <div className="font-mono">
                        {j.succeeded} / {j.total}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/publishes/$jobId" params={{ jobId: j.id }}>
                        详情
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
