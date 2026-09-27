import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listEvaluatedVersions } from "@/services/imports";
import { CALCULATOR_VERSIONS, createRun, defaultParams } from "@/services/runs";
import {
  DEFAULT_WEIGHTS,
  DIMENSIONS,
  DIMENSION_LABELS,
  SCALE_MAPS,
  type DimensionKey,
  type RunParams,
  type ScaleType,
} from "@/types";
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
  EmptyBlock,
  ErrorBlock,
  PageHeader,
  StateView,
  WarningBlock,
} from "@/components/state-view";

export const Route = createFileRoute("/runs/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    versionId:
      typeof search["versionId"] === "string" ? (search["versionId"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "配置端到端计算 · AgentEval Hub" },
      { name: "description", content: "选择评测结果版本，配置量表映射与七维权重后执行计算。" },
      { property: "og:title", content: "配置端到端计算 · AgentEval Hub" },
      { property: "og:description", content: "配置量表映射与七维权重后执行端到端计算。" },
    ],
  }),
  component: NewRunPage,
});

function NewRunPage() {
  const { versionId } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ["evaluated-versions"], queryFn: listEvaluatedVersions });
  const [params, setParams] = useState<RunParams>(() => defaultParams(versionId ?? ""));

  useEffect(() => {
    if (!params.resultVersionId && versions.data?.length) {
      setParams((p) => ({ ...p, resultVersionId: versionId ?? versions.data[0]!.id }));
    }
  }, [versions.data, versionId, params.resultVersionId]);

  const weightSum = Object.values(params.weights).reduce((a, b) => a + b, 0);
  const weightValid = Math.abs(weightSum - 1) < 0.001;

  const run = useMutation({
    mutationFn: () => createRun(params),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["runs"] });
      toast.success("计算已开始");
      void navigate({ to: "/runs/$id", params: { id: r.id } });
    },
  });

  const setWeight = (k: DimensionKey, v: number) =>
    setParams((p) => ({ ...p, weights: { ...p.weights, [k]: v } }));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="配置端到端计算"
        description="量表映射与权重会随运行一并记录，保证结果可复现。"
      />

      <StateView
        isLoading={versions.isLoading}
        error={versions.error}
        data={versions.data}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void versions.refetch()}
        empty={
          <EmptyBlock
            title="没有可用的评测结果版本"
            description="请先从 Langfuse 导入一个已完成的 Experiment。"
          />
        }
      >
        {(list) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">运行配置</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>评测结果版本</Label>
                  <Select
                    value={params.resultVersionId}
                    onValueChange={(v) => setParams((p) => ({ ...p, resultVersionId: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择版本" />
                    </SelectTrigger>
                    <SelectContent>
                      {list.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}（{v.sampleCount} 条）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>计算器版本</Label>
                  <Select
                    value={params.calculatorVersion}
                    onValueChange={(v) => setParams((p) => ({ ...p, calculatorVersion: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CALCULATOR_VERSIONS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>量表</Label>
                  <Select
                    value={params.scale}
                    onValueChange={(v) => setParams((p) => ({ ...p, scale: v as ScaleType }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="scale3">3 级量表</SelectItem>
                      <SelectItem value="scale5">5 级量表</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {Object.entries(SCALE_MAPS[params.scale]).map(([label, value]) => (
                      <Badge key={label} variant="outline" className="font-mono text-xs">
                        {label} = {value}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>评分来源</Label>
                  <Select
                    value={params.scoreSource}
                    onValueChange={(v) =>
                      setParams((p) => ({ ...p, scoreSource: v as "human" | "judge" }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="judge">LLM Judge 评分</SelectItem>
                      <SelectItem value="human">人工评分</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">七维权重</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant={weightValid ? "secondary" : "destructive"} className="font-mono">
                    合计 {weightSum.toFixed(3)}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setParams((p) => ({ ...p, weights: { ...DEFAULT_WEIGHTS } }))}
                  >
                    恢复默认
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {DIMENSIONS.map((d) => (
                  <div key={d} className="grid grid-cols-[1fr_120px] items-center gap-3">
                    <Label htmlFor={`w-${d}`} className="text-sm">
                      {DIMENSION_LABELS[d]}
                    </Label>
                    <Input
                      id={`w-${d}`}
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="font-mono"
                      value={params.weights[d]}
                      onChange={(e) => setWeight(d, Number(e.target.value))}
                    />
                  </div>
                ))}
                {!weightValid && <WarningBlock title="权重合计必须等于 1，才能开始计算" />}
                {run.isError && <ErrorBlock message={run.error.message} />}
                <Button
                  className="w-full"
                  disabled={!weightValid || !params.resultVersionId || run.isPending}
                  onClick={() => run.mutate()}
                >
                  开始计算
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </StateView>
    </div>
  );
}
