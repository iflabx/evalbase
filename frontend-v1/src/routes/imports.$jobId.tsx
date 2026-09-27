import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getImportJob } from "@/services/imports";
import { Button } from "@/components/ui/button";
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
  EvidenceTrack,
} from "@/components/state-view";

export const Route = createFileRoute("/imports/$jobId")({
  head: () => ({
    meta: [
      { title: "导入任务详情 · AgentEval Hub" },
      { name: "description", content: "查看 Langfuse Experiment 导入任务的覆盖率与失败条目。" },
      { property: "og:title", content: "导入任务详情 · AgentEval Hub" },
      { property: "og:description", content: "查看导入任务的覆盖率、失败条目与结果版本。" },
    ],
  }),
  component: ImportDetailPage,
});

function ImportDetailPage() {
  const { jobId } = useParams({ from: "/imports/$jobId" });
  const query = useQuery({
    queryKey: ["import", jobId],
    queryFn: () => getImportJob(jobId),
    refetchInterval: 1000,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="导入任务详情"
        actions={
          <Button variant="outline" asChild>
            <Link to="/imports">返回列表</Link>
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
          <>
            <EvidenceTrack
              steps={[
                { label: "数据来源", detail: `Langfuse · ${job.projectName}`, state: "done" },
                { label: "导入草稿", detail: job.experimentName, state: "done" },
                {
                  label: "固化版本",
                  detail: job.resultVersionId ?? "生成中",
                  state: job.resultVersionId
                    ? "done"
                    : job.status === "FAILED"
                      ? "error"
                      : "current",
                },
                {
                  label: "实验结果导回",
                  detail: `${job.sampleCount} 条样本`,
                  state: job.sampleCount ? "done" : "todo",
                },
                { label: "运行快照", detail: "在端到端计算中创建", state: "todo" },
                { label: "指标结果与报告", detail: "计算完成后生成", state: "todo" },
              ]}
            />
            <div className="mt-4" />
            <div className="space-y-4">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">{job.experimentName}</CardTitle>
                  <StatusBadge status={job.status} />
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Field label="来源项目" value={job.projectName} />
                    <Field label="Experiment ID" value={job.experimentId} />
                    <Field label="导入样本" value={String(job.sampleCount)} />
                    <Field label="失败条目" value={String(job.failedCount)} />
                  </dl>

                  {job.status === "RUNNING" && <RunningBlock label="正在拉取 Experiment 数据…" />}
                  {job.status === "SUCCEEDED" && (
                    <SuccessBlock title="导入完成，已固化 evaluated_result 版本" />
                  )}
                  {job.status === "PARTIAL_SUCCEEDED" && (
                    <WarningBlock title={`部分成功：${job.failedCount} 条样本未能导入`} />
                  )}
                  {job.status === "FAILED" && (
                    <ErrorBlock message="导入失败：score 名称无法映射到任何七维字段。" />
                  )}

                  {job.resultVersionId && (
                    <Button size="sm" asChild>
                      <Link to="/runs/new" search={{ versionId: job.resultVersionId }}>
                        用该版本执行端到端计算
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>

              {job.failures.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">失败条目</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-48">样本 ID</TableHead>
                          <TableHead>原因</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {job.failures.map((f) => (
                          <TableRow key={f.sampleId}>
                            <TableCell className="font-mono text-xs">{f.sampleId}</TableCell>
                            <TableCell className="text-sm">{f.reason}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </div>
          </>
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
