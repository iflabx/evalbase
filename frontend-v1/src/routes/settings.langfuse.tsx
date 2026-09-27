import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plug, ShieldCheck } from "lucide-react";
import {
  createConnection,
  listConnections,
  setConnectionEnabled,
  testConnection,
  type ConnectionStatus,
} from "@/services/connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBlock, PageHeader, StateView } from "@/components/state-view";

const STATUS_META: Record<ConnectionStatus, { label: string; className: string }> = {
  ACTIVE: { label: "可用", className: "bg-chart-2/10 text-chart-2 border-chart-2/30" },
  DISABLED: { label: "已停用", className: "bg-muted text-muted-foreground" },
  ERROR: { label: "异常", className: "bg-destructive/10 text-destructive border-destructive/30" },
};

export const Route = createFileRoute("/settings/langfuse")({
  head: () => ({
    meta: [
      { title: "Langfuse 连接设置 · AgentEval Hub" },
      {
        name: "description",
        content: "管理 Langfuse 连接：新建、测试、停用，Secret 保存后不回显。",
      },
      { property: "og:title", content: "Langfuse 连接设置 · AgentEval Hub" },
      { property: "og:description", content: "管理 Langfuse 连接与能力检测结果。" },
    ],
  }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["connections"], queryFn: listConnections });
  const [form, setForm] = useState({
    name: "",
    host: "https://cloud.langfuse.com",
    projectId: "",
    secret: "",
  });
  const [formError, setFormError] = useState<Record<string, string>>({});

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["connections"] });

  const test = useMutation({
    mutationFn: testConnection,
    onSuccess: (c) => {
      invalidate();
      if (c.status === "ERROR")
        toast.error("连接测试失败", { description: c.lastTestMessage ?? "" });
      else toast.success("连接测试通过");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => setConnectionEnabled(v.id, v.enabled),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const create = useMutation({
    mutationFn: createConnection,
    onSuccess: () => {
      setForm({ name: "", host: "https://cloud.langfuse.com", projectId: "", secret: "" });
      setFormError({});
      invalidate();
      toast.success("连接已创建，请执行一次测试");
    },
    onError: (e: Error) => setFormError({ form: e.message }),
  });

  function submit() {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs["name"] = "请输入连接名称";
    if (!/^https?:\/\//.test(form.host)) errs["host"] = "Host 需要以 http(s):// 开头";
    if (!form.projectId.trim()) errs["projectId"] = "请输入 Langfuse Project ID";
    if (!form.secret.trim()) errs["secret"] = "请输入 Secret Key";
    setFormError(errs);
    if (Object.keys(errs).length) return;
    create.mutate(form);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Langfuse 连接设置"
        description="连接用于发布数据集与导入已完成 Experiment。Secret 仅可填写或替换，保存后不回显。"
      />

      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={query.data}
        onRetry={() => void query.refetch()}
      >
        {(items) => (
          <div className="space-y-3">
            {items.map((c) => (
              <Card key={c.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Plug className="size-4 text-primary" />
                      <span className="text-sm font-medium">{c.name}</span>
                      <Badge variant="outline" className={STATUS_META[c.status].className}>
                        {STATUS_META[c.status].label}
                      </Badge>
                    </div>
                    <div className="mono mt-1 text-xs text-muted-foreground">
                      {c.host} · {c.projectId}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      最近测试：
                      {c.lastTestedAt ? c.lastTestedAt.slice(0, 16).replace("T", " ") : "从未测试"}
                      {c.lastTestMessage ? ` · ${c.lastTestMessage}` : ""}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(["datasets", "experiments", "scores"] as const).map((k) => (
                        <Badge key={k} variant={c.capabilities[k] ? "secondary" : "outline"}>
                          {k} {c.capabilities[k] ? "可用" : "不可用"}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={test.isPending}
                      onClick={() => test.mutate(c.id)}
                    >
                      测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggle.mutate({ id: c.id, enabled: c.status === "DISABLED" })}
                    >
                      {c.status === "DISABLED" ? "启用" : "停用"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </StateView>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" /> 新建连接
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="conn-name">连接名称</Label>
            <Input
              id="conn-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              aria-invalid={!!formError["name"]}
            />
            {formError["name"] && (
              <p className="mt-1 text-xs text-destructive">{formError["name"]}</p>
            )}
          </div>
          <div>
            <Label htmlFor="conn-host">Host</Label>
            <Input
              id="conn-host"
              className="mono"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              aria-invalid={!!formError["host"]}
            />
            {formError["host"] && (
              <p className="mt-1 text-xs text-destructive">{formError["host"]}</p>
            )}
          </div>
          <div>
            <Label htmlFor="conn-project">Project ID</Label>
            <Input
              id="conn-project"
              className="mono"
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              aria-invalid={!!formError["projectId"]}
            />
            {formError["projectId"] && (
              <p className="mt-1 text-xs text-destructive">{formError["projectId"]}</p>
            )}
          </div>
          <div>
            <Label htmlFor="conn-secret">Secret Key</Label>
            <Input
              id="conn-secret"
              type="password"
              placeholder="保存后不会回显"
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
              aria-invalid={!!formError["secret"]}
            />
            {formError["secret"] && (
              <p className="mt-1 text-xs text-destructive">{formError["secret"]}</p>
            )}
          </div>
          {formError["form"] && (
            <div className="md:col-span-2">
              <ErrorBlock message={formError["form"]} />
            </div>
          )}
          <div className="md:col-span-2">
            <Button onClick={submit} disabled={create.isPending}>
              {create.isPending ? "创建中…" : "创建连接"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
