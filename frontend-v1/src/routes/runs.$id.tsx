import { useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { getRun } from "@/services/runs";
import { requestReport } from "@/services/reporting";
import { DIMENSION_LABELS, type CalcRun, type DimensionKey } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ErrorBlock,
  EvidenceTrack,
  PageHeader,
  RunningBlock,
  StateView,
  StatusBadge,
  WarningBlock,
} from "@/components/state-view";

export const Route = createFileRoute("/runs/$id")({
  head: () => ({
    meta: [
      { title: "计算报告 · AgentEval Hub" },
      { name: "description", content: "查看七维得分、加权总分、相关性、延迟分布与样本 Reason。" },
      { property: "og:title", content: "计算报告 · AgentEval Hub" },
      { property: "og:description", content: "七维得分、总分、相关性、延迟与样本明细报告。" },
    ],
  }),
  component: RunReportPage,
});

function RunReportPage() {
  const { id } = useParams({ from: "/runs/$id" });
  const query = useQuery({
    queryKey: ["run", id],
    queryFn: () => getRun(id),
    refetchInterval: 1000,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
      >
        {(run) => <Report run={run} />}
      </StateView>
    </div>
  );
}

function Report({ run }: { run: CalcRun }) {
  const [detail, setDetail] = useState<CalcRun["samples"][number] | null>(null);

  const exportJson = () => {
    download(`${run.id}.json`, JSON.stringify(run, null, 2), "application/json");
    toast.success("已导出 JSON 报告");
  };
  const exportMarkdown = () => {
    const dims = run.dimensions
      .map(
        (d) =>
          `| ${DIMENSION_LABELS[d.dimension]} | ${d.score?.toFixed(3) ?? "N/A"} | ${d.validCount} | ${(d.missingRate * 100).toFixed(1)}% |`,
      )
      .join("\n");
    const md = [
      `# 端到端计算报告 · ${run.name}`,
      "",
      `- 运行 ID：${run.id}`,
      `- 输入版本：${run.resultVersionLabel}`,
      `- 计算器版本：${run.params.calculatorVersion}`,
      `- 量表：${run.params.scale === "scale3" ? "3 级" : "5 级"} · 评分来源：${run.params.scoreSource === "human" ? "人工" : "LLM Judge"}`,
      `- 生成时间：${new Date().toISOString()}`,
      "",
      `## 总体指标`,
      "",
      `加权总分 **${run.overallScore?.toFixed(3) ?? "N/A"}**，有效 ${run.counts.valid} 条，跳过 ${run.counts.skipped} 条，失败 ${run.counts.failed} 条。`,
      "",
      `## 七维得分`,
      "",
      "| 维度 | 得分 | 有效分母 | 缺失率 |",
      "|---|---|---|---|",
      dims,
      "",
      `## 问题摘要`,
      "",
      run.counts.skipped ? `- ${run.counts.skipped} 条样本因缺失评分被跳过，未计入均值。` : "- 无",
    ].join("\n");
    download(`${run.id}.md`, md, "text/markdown");
    void requestReport(run.id, "markdown");
    toast.success("已导出 Markdown 报告");
  };
  const exportCsv = () => {
    const dims = run.dimensions.map((d) => d.dimension);
    const header = ["sample_id", "trace_id", "status", "weighted_score", "latency_ms", ...dims];
    const lines = run.samples.map((s) =>
      [
        s.sampleId,
        s.traceId,
        s.status,
        s.weightedScore ?? "",
        s.latencyMs,
        ...dims.map((d) => s.dimensionValues[d] ?? ""),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    download(`${run.id}.csv`, [header.join(","), ...lines].join("\n"), "text/csv");
    toast.success("已导出 CSV 明细");
  };

  return (
    <>
      <PageHeader
        title={run.name}
        description={`${run.resultVersionLabel} · ${run.params.calculatorVersion} · ${
          run.params.scale === "scale3" ? "3 级量表" : "5 级量表"
        } · ${run.params.scoreSource === "human" ? "人工评分" : "LLM Judge"}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/runs">返回列表</Link>
            </Button>
            <Button variant="outline" disabled={run.status === "RUNNING"} onClick={exportCsv}>
              <Download className="size-4" /> CSV
            </Button>
            <Button variant="outline" disabled={run.status === "RUNNING"} onClick={exportMarkdown}>
              <Download className="size-4" /> Markdown
            </Button>
            <Button disabled={run.status === "RUNNING"} onClick={exportJson}>
              <Download className="size-4" /> JSON
            </Button>
          </div>
        }
      />

      <EvidenceTrack
        steps={[
          { label: "数据来源", detail: "Langfuse Experiment", state: "done" },
          { label: "导入草稿", detail: "已完成预检与映射", state: "done" },
          { label: "固化版本", detail: run.resultVersionLabel, state: "done" },
          {
            label: "实验结果导回",
            detail: `${run.params.scoreSource === "human" ? "人工评分" : "LLM Judge"}`,
            state: "done",
          },
          {
            label: "运行快照",
            detail: `${run.params.calculatorVersion} · ${run.id}`,
            state: run.status === "FAILED" ? "error" : "done",
          },
          {
            label: "指标结果与报告",
            detail:
              run.status === "SUCCEEDED" || run.status === "PARTIAL_SUCCEEDED"
                ? `加权总分 ${run.overallScore?.toFixed(3) ?? "N/A"}`
                : "计算进行中",
            state:
              run.status === "SUCCEEDED" || run.status === "PARTIAL_SUCCEEDED"
                ? "done"
                : run.status === "FAILED"
                  ? "error"
                  : "current",
          },
        ]}
      />

      <div className="mb-4 mt-4 flex items-center gap-3">
        <StatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          {run.createdAt.slice(0, 16).replace("T", " ")} · {run.createdBy}
        </span>
      </div>

      {(run.status === "QUEUED" || run.status === "RUNNING") && (
        <Card>
          <CardContent className="py-6">
            <RunningBlock label="正在计算七维得分与统计指标…" />
            <Progress className="mt-4" />
          </CardContent>
        </Card>
      )}

      {run.status === "FAILED" && <ErrorBlock message={run.error ?? "计算失败"} />}

      {(run.status === "SUCCEEDED" || run.status === "PARTIAL_SUCCEEDED") && (
        <div className="space-y-4">
          {run.status === "PARTIAL_SUCCEEDED" && (
            <WarningBlock title={`部分成功：${run.counts.skipped} 条样本因缺失评分被跳过`}>
              跳过的样本不计入维度均值与总分。
            </WarningBlock>
          )}

          <div className="grid gap-3 sm:grid-cols-4">
            <Metric label="加权总分" value={run.overallScore?.toFixed(3) ?? "—"} big />
            <Metric label="有效样本" value={`${run.counts.valid}`} />
            <Metric label="跳过 / 失败" value={`${run.counts.skipped} / ${run.counts.failed}`} />
            <Metric label="P95 延迟" value={`${run.totalLatency.p95} ms`} />
          </div>

          <Tabs defaultValue="dims">
            <TabsList>
              <TabsTrigger value="dims">七维得分</TabsTrigger>
              <TabsTrigger value="corr">相关性</TabsTrigger>
              <TabsTrigger value="latency">延迟</TabsTrigger>
              <TabsTrigger value="samples">样本明细</TabsTrigger>
            </TabsList>

            <TabsContent value="dims" className="mt-4">
              <Card>
                <CardContent className="space-y-4 py-5">
                  {run.dimensions.map((d) => (
                    <div key={d.dimension} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span>
                          {DIMENSION_LABELS[d.dimension]}
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            权重 {run.params.weights[d.dimension]}
                          </span>
                        </span>
                        <span className="font-mono">
                          {d.score === null ? "—" : d.score.toFixed(3)}
                        </span>
                      </div>
                      <Progress value={(d.score ?? 0) * 100} />
                      <div className="text-xs text-muted-foreground">
                        有效 {d.validCount} 条 · 缺失率 {(d.missingRate * 100).toFixed(1)}%
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="corr" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">人工评分 vs LLM Judge</CardTitle>
                </CardHeader>
                <CardContent>
                  {run.correlation.n < 3 ? (
                    <WarningBlock title="配对样本不足，无法计算相关性">
                      至少需要 3 条同时具备人工评分与 Judge 评分的样本。
                    </WarningBlock>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Metric label="Pearson r" value={fmt(run.correlation.pearson)} />
                      <Metric label="RMSE" value={fmt(run.correlation.rmse)} />
                      <Metric label="MAE" value={fmt(run.correlation.mae)} />
                      <Metric label="t 统计量" value={fmt(run.correlation.tStat)} />
                      <Metric label="p 值" value={fmt(run.correlation.pValue, 4)} />
                      <Metric label="配对样本数" value={String(run.correlation.n)} />
                    </div>
                  )}
                  {run.correlation.note && (
                    <p className="mt-3 text-xs text-muted-foreground">{run.correlation.note}</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="latency" className="mt-4">
              <Card>
                <CardContent className="py-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>阶段</TableHead>
                        <TableHead className="w-28">均值</TableHead>
                        <TableHead className="w-28">P50</TableHead>
                        <TableHead className="w-28">P95</TableHead>
                        <TableHead className="w-28">缺失率</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[run.totalLatency, ...run.stageLatency].map((s) => (
                        <TableRow key={s.stage}>
                          <TableCell className="text-sm">{s.stage}</TableCell>
                          <TableCell className="font-mono text-xs">{s.mean} ms</TableCell>
                          <TableCell className="font-mono text-xs">{s.p50} ms</TableCell>
                          <TableCell className="font-mono text-xs">{s.p95} ms</TableCell>
                          <TableCell className="font-mono text-xs">
                            {(s.missingRate * 100).toFixed(1)}%
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="samples" className="mt-4">
              <Card>
                <CardContent className="py-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-36">样本</TableHead>
                        <TableHead>问题</TableHead>
                        <TableHead className="w-24">总分</TableHead>
                        <TableHead className="w-24">延迟</TableHead>
                        <TableHead className="w-24">状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {run.samples.map((s) => (
                        <TableRow
                          key={s.sampleId}
                          className="cursor-pointer"
                          onClick={() => setDetail(s)}
                        >
                          <TableCell className="font-mono text-xs">{s.sampleId}</TableCell>
                          <TableCell className="max-w-md truncate text-sm">{s.question}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {s.weightedScore === null ? "—" : s.weightedScore.toFixed(3)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{s.latencyMs} ms</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                s.status === "valid"
                                  ? "secondary"
                                  : s.status === "skipped"
                                    ? "outline"
                                    : "destructive"
                              }
                            >
                              {s.status === "valid"
                                ? "有效"
                                : s.status === "skipped"
                                  ? "跳过"
                                  : "失败"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{detail?.sampleId}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4 text-sm">
              <Block title="问题">{detail.question}</Block>
              <Block title="期望答案">{detail.expectedOutput ?? "（未提供）"}</Block>
              <Block title="实际输出">{detail.actualOutput}</Block>
              <div>
                <div className="mb-2 text-xs text-muted-foreground">维度得分与 Reason</div>
                <div className="space-y-2">
                  {(Object.keys(detail.dimensionValues) as DimensionKey[]).map((d) => (
                    <div key={d} className="rounded-md border p-2">
                      <div className="flex items-center justify-between">
                        <span>{DIMENSION_LABELS[d]}</span>
                        <span className="font-mono text-xs">
                          {detail.dimensionValues[d] ?? "缺失"}
                        </span>
                      </div>
                      {detail.reasons[d] && (
                        <p className="mt-1 text-xs text-muted-foreground">{detail.reasons[d]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <Button variant="outline" size="sm" asChild>
                <a href={detail.traceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> 在 Langfuse 查看 Trace
                </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{title}</div>
      <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

function Metric({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`font-mono ${big ? "text-3xl" : "text-xl"}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function fmt(v: number | null, digits = 3) {
  return v === null ? "—" : v.toFixed(digits);
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
