import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Calculator, Clock } from "lucide-react";
import { listCalculators } from "@/services/reporting";
import { listRuns } from "@/services/runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StateView, StatusBadge } from "@/components/state-view";

export const Route = createFileRoute("/calculators")({
  head: () => ({
    meta: [
      { title: "计算器目录 · AgentEval Hub" },
      {
        name: "description",
        content: "查看端到端计算器的输入要求、可用版本、指标口径与最近运行。",
      },
      { property: "og:title", content: "计算器目录 · AgentEval Hub" },
      { property: "og:description", content: "查看端到端计算器的输入要求、可用版本与指标口径。" },
    ],
  }),
  component: CalculatorsPage,
});

function CalculatorsPage() {
  const query = useQuery({ queryKey: ["calculators"], queryFn: listCalculators });
  const runs = useQuery({ queryKey: ["runs"], queryFn: listRuns });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="计算器"
        description="MVP 仅提供端到端计算器。多计算器与对比能力将在后续版本在此入口扩展。"
      />
      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
      >
        {(items) => (
          <div className="space-y-4">
            {items.map((c) => (
              <Card key={c.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Calculator className="size-4 text-primary" /> {c.name}
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>
                  </div>
                  <Button asChild>
                    <Link to="/runs/new" search={{ versionId: undefined }}>
                      新建计算
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm md:grid-cols-3">
                  <div>
                    <div className="text-xs text-muted-foreground">输入要求</div>
                    <p className="mt-1">
                      仅接受类型为 <span className="mono">evaluated_result</span> 且状态为{" "}
                      <span className="mono">READY</span> 的不可变版本。
                    </p>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">可用版本</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.versions.map((v) => (
                        <Badge key={v} variant="secondary" className="mono">
                          {v}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">指标口径</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.metrics.map((m) => (
                        <Badge key={m} variant="outline">
                          {m}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="size-4 text-muted-foreground" /> 最近运行
                </CardTitle>
              </CardHeader>
              <CardContent>
                <StateView
                  isLoading={runs.isLoading}
                  error={runs.error}
                  data={runs.data}
                  loadingRows={3}
                  isEmpty={(d) => d.length === 0}
                  onRetry={() => void runs.refetch()}
                >
                  {(list) => (
                    <ul className="divide-y divide-border">
                      {list.slice(0, 5).map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                          <Link
                            to="/runs/$id"
                            params={{ id: r.id }}
                            className="truncate text-sm hover:underline"
                          >
                            {r.name}
                          </Link>
                          <div className="flex items-center gap-3">
                            <span className="mono text-xs text-muted-foreground">
                              {r.createdAt.slice(0, 16).replace("T", " ")}
                            </span>
                            <StatusBadge status={r.status} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </StateView>
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              Text2SQL、意图识别、实体提取与工具调用计算器属于后续版本，本页不提供可执行入口。
            </p>
          </div>
        )}
      </StateView>
    </div>
  );
}
