import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { createImportJob, listExperiments, preflight } from "@/services/imports";
import { listProjects } from "@/services/langfuse";
import { DIMENSION_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyBlock,
  ErrorBlock,
  PageHeader,
  RunningBlock,
  StateView,
  WarningBlock,
} from "@/components/state-view";

export const Route = createFileRoute("/imports/new")({
  head: () => ({
    meta: [
      { title: "新建导入 · AgentEval Hub" },
      {
        name: "description",
        content: "选择已完成的 Langfuse Experiment，预检后固化评测结果版本。",
      },
      { property: "og:title", content: "新建导入 · AgentEval Hub" },
      { property: "og:description", content: "选择已完成 Experiment，预检后固化评测结果版本。" },
    ],
  }),
  component: NewImportPage,
});

function NewImportPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("lf-prod");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["lf-projects"], queryFn: listProjects });
  const experiments = useQuery({
    queryKey: ["experiments", projectId, q],
    queryFn: () => listExperiments(projectId, q),
    enabled: !!projectId,
  });
  const pre = useQuery({
    queryKey: ["preflight", selected],
    queryFn: () => preflight(selected!),
    enabled: !!selected,
    retry: false,
  });

  const importMutation = useMutation({
    mutationFn: createImportJob,
    onSuccess: async (job) => {
      await qc.invalidateQueries({ queryKey: ["imports"] });
      toast.success("导入任务已创建");
      void navigate({ to: "/imports/$jobId", params: { jobId: job.id } });
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="新建导入"
        description="只列出状态为「已完成」的 Experiment；导入后生成不可变 evaluated_result 版本。"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. 选择 Langfuse 项目与 Experiment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>项目</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（{p.region}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="exp-q">搜索 Experiment</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="exp-q"
                  className="pl-8"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="按名称过滤"
                />
              </div>
            </div>
          </div>

          <StateView
            isLoading={experiments.isLoading}
            error={experiments.error}
            data={experiments.data}
            isEmpty={(d) => d.length === 0}
            onRetry={() => void experiments.refetch()}
            loadingRows={3}
            empty={<EmptyBlock title="该项目下没有已完成的 Experiment" />}
          >
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12" />
                    <TableHead>名称</TableHead>
                    <TableHead className="w-24">Item</TableHead>
                    <TableHead className="w-24">Score</TableHead>
                    <TableHead className="w-28">量表</TableHead>
                    <TableHead className="w-40">完成时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer"
                      data-state={selected === e.id ? "selected" : undefined}
                      onClick={() => setSelected(e.id)}
                    >
                      <TableCell>
                        <input
                          type="radio"
                          checked={selected === e.id}
                          onChange={() => setSelected(e.id)}
                          aria-label={`选择 ${e.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-sm">
                        {e.name}
                        <div className="font-mono text-xs text-muted-foreground">{e.id}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.itemCount}</TableCell>
                      <TableCell className="font-mono text-xs">{e.scoreCount}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {e.scaleHint === "scale3" ? "3 级" : "5 级"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {e.completedAt.slice(0, 16).replace("T", " ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </StateView>
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. 预检</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {pre.isLoading && <RunningBlock label="正在检查字段覆盖率与量表…" />}
            {pre.error && (
              <ErrorBlock
                message={pre.error instanceof Error ? pre.error.message : "预检失败"}
                onRetry={() => void pre.refetch()}
              />
            )}
            {pre.data && (
              <>
                <div className="flex flex-wrap gap-3 text-sm">
                  <Badge variant="outline">
                    识别量表：{pre.data.detectedScale === "scale3" ? "3 级" : "5 级"}
                  </Badge>
                  <Badge variant="outline">
                    Trace 覆盖率：{(pre.data.traceCoverage * 100).toFixed(0)}%
                  </Badge>
                  <Badge variant="outline">
                    Observation 覆盖率：{(pre.data.observationCoverage * 100).toFixed(0)}%
                  </Badge>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>维度</TableHead>
                      <TableHead className="w-32">已覆盖</TableHead>
                      <TableHead className="w-32">缺失率</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pre.data.coverage.map((c) => (
                      <TableRow key={c.dimension}>
                        <TableCell className="text-sm">{DIMENSION_LABELS[c.dimension]}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {c.covered} / {c.total}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {(((c.total - c.covered) / c.total) * 100).toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {pre.data.issues.length > 0 && (
                  <WarningBlock title={`${pre.data.issues.length} 条预检提示`}>
                    {pre.data.issues.map((i) => (
                      <div key={`${i.row}-${i.field}`}>
                        第 {i.row} 行 · {i.field}：{i.message}
                      </div>
                    ))}
                  </WarningBlock>
                )}
                {importMutation.isError && <ErrorBlock message={importMutation.error.message} />}
                <Button
                  disabled={importMutation.isPending}
                  onClick={() => importMutation.mutate({ experimentId: selected, projectId })}
                >
                  开始导入并固化版本
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
