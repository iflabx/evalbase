import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { getPublishJob, retryPublishJob } from "@/services/langfuse";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ErrorBlock,
  PageHeader,
  RunningBlock,
  StateView,
  StatusBadge,
  SuccessBlock,
  WarningBlock,
} from "@/components/state-view";

export const Route = createFileRoute("/publishes/$jobId")({
  head: () => ({
    meta: [
      { title: "发布状态 · AgentEval Hub" },
      { name: "description", content: "查看单个 Langfuse 发布任务的进度、失败条目与外链。" },
      { property: "og:title", content: "发布状态 · AgentEval Hub" },
      { property: "og:description", content: "查看发布任务进度、失败条目与 Langfuse 外链。" },
    ],
  }),
  component: PublishDetailPage,
});

function PublishDetailPage() {
  const { jobId } = useParams({ from: "/publishes/$jobId" });
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["publish", jobId],
    queryFn: () => getPublishJob(jobId),
    refetchInterval: 1000,
  });
  const retry = useMutation({
    mutationFn: () => retryPublishJob(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["publish", jobId] }),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="发布状态"
        description="Langfuse Dataset 的 expectedOutput 仅保存期望答案。"
        actions={
          <Button variant="outline" asChild>
            <Link to="/publishes">返回列表</Link>
          </Button>
        }
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
      >
        {(job) => (
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">
                  {job.datasetName} · {job.version}
                </CardTitle>
                <StatusBadge status={job.status} />
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Field label="Langfuse 项目" value={job.langfuseProject} />
                  <Field label="Dataset 名称" value={job.langfuseDatasetName} />
                  <Field label="样本总数" value={String(job.total)} />
                  <Field label="发起时间" value={job.createdAt.slice(0, 16).replace("T", " ")} />
                </dl>

                {(job.status === "QUEUED" || job.status === "RUNNING") && (
                  <>
                    <RunningBlock
                      label={job.status === "QUEUED" ? "排队中…" : "正在写入 Langfuse…"}
                      progress={`${job.progress} / ${job.total}`}
                    />
                    <Progress value={(job.progress / Math.max(1, job.total)) * 100} />
                  </>
                )}

                {job.status === "SUCCEEDED" && (
                  <SuccessBlock title={`全部 ${job.succeeded} 条样本发布成功`} />
                )}

                {job.status === "PARTIAL_SUCCEEDED" && (
                  <WarningBlock title={`部分成功：${job.succeeded} 条成功，${job.failed} 条失败`}>
                    失败条目可在下方查看原因，修复后重试。
                  </WarningBlock>
                )}

                {job.status === "FAILED" && (
                  <ErrorBlock message={job.error ?? "发布失败"} onRetry={() => retry.mutate()} />
                )}

                <div className="flex gap-2">
                  {job.externalUrl && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={job.externalUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-4" /> 在 Langfuse 中打开
                      </a>
                    </Button>
                  )}
                  {(job.status === "PARTIAL_SUCCEEDED" || job.status === "FAILED") && (
                    <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
                      重试失败条目
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {job.items.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">失败条目（{job.items.length}）</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-48">样本 ID</TableHead>
                        <TableHead>失败原因</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {job.items.map((it) => (
                        <TableRow key={it.sampleId}>
                          <TableCell className="font-mono text-xs">{it.sampleId}</TableCell>
                          <TableCell className="text-sm">{it.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </StateView>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
