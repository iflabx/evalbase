import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { listEvaluatedVersions, listImportJobs } from "@/services/imports";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyBlock, PageHeader, StateView, StatusBadge } from "@/components/state-view";

export const Route = createFileRoute("/imports/")({
  head: () => ({
    meta: [
      { title: "导入评测结果 · AgentEval Hub" },
      { name: "description", content: "从 Langfuse 导入已完成 Experiment，并固化评测结果版本。" },
      { property: "og:title", content: "导入评测结果 · AgentEval Hub" },
      { property: "og:description", content: "导入已完成 Experiment 并固化不可变结果版本。" },
    ],
  }),
  component: ImportsPage,
});

function ImportsPage() {
  const jobs = useQuery({
    queryKey: ["imports"],
    queryFn: listImportJobs,
    refetchInterval: 1500,
  });
  const versions = useQuery({
    queryKey: ["evaluated-versions"],
    queryFn: listEvaluatedVersions,
    refetchInterval: 1500,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="导入评测结果"
        description="只导入 Langfuse 中已完成的 Experiment；导入结果固化为不可变 evaluated_result 版本。"
        actions={
          <Button asChild>
            <Link to="/imports/new">
              <Plus className="size-4" /> 新建导入
            </Link>
          </Button>
        }
      />
      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs">导入任务</TabsTrigger>
          <TabsTrigger value="versions">结果版本</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="mt-4">
          <StateView
            isLoading={jobs.isLoading}
            error={jobs.error}
            data={jobs.data}
            isEmpty={(d) => d.length === 0}
            onRetry={() => void jobs.refetch()}
            empty={
              <EmptyBlock
                title="还没有导入任务"
                description="选择一个已完成的 Langfuse Experiment 开始导入。"
                action={
                  <Button asChild>
                    <Link to="/imports/new">新建导入</Link>
                  </Button>
                }
              />
            }
          >
            {(list) => (
              <div className="space-y-3">
                {list.map((j) => (
                  <Card key={j.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {j.experimentName}
                          <StatusBadge status={j.status} />
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">
                          {j.projectName} · {j.experimentId} ·{" "}
                          {j.createdAt.slice(0, 16).replace("T", " ")}
                        </div>
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div>
                          <div className="text-xs text-muted-foreground">样本 / 失败</div>
                          <div className="font-mono">
                            {j.sampleCount} / {j.failedCount}
                          </div>
                        </div>
                        <Button variant="outline" size="sm" asChild>
                          <Link to="/imports/$jobId" params={{ jobId: j.id }}>
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
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <StateView
            isLoading={versions.isLoading}
            error={versions.error}
            data={versions.data}
            isEmpty={(d) => d.length === 0}
            onRetry={() => void versions.refetch()}
            empty={<EmptyBlock title="还没有评测结果版本" />}
          >
            {(list) => (
              <div className="space-y-3">
                {list.map((v) => (
                  <Card key={v.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {v.label}
                          <Badge variant="secondary">只读</Badge>
                          <Badge variant="outline">
                            {v.scale === "scale3" ? "3 级量表" : "5 级量表"}
                          </Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {v.experimentName} · {v.sampleCount} 条 ·{" "}
                          {v.createdAt.slice(0, 16).replace("T", " ")}
                        </div>
                      </div>
                      <Button size="sm" asChild>
                        <Link to="/runs/new" search={{ versionId: v.id }}>
                          用于计算
                        </Link>
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </StateView>
        </TabsContent>
      </Tabs>
    </div>
  );
}
