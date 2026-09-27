import { useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { getDataset, listVersions } from "@/services/datasets";
import {
  checkIdempotency,
  createPublishJob,
  listProjects,
  listPublishJobs,
} from "@/services/langfuse";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  EvidenceTrack,
  PageHeader,
  StateView,
  StatusBadge,
  WarningBlock,
} from "@/components/state-view";
import type { DatasetVersion } from "@/types";

export const Route = createFileRoute("/datasets/$id")({
  head: () => ({
    meta: [
      { title: "数据集详情 · AgentEval Hub" },
      { name: "description", content: "查看数据集版本时间线、样本明细与 Langfuse 发布记录。" },
      { property: "og:title", content: "数据集详情 · AgentEval Hub" },
      { property: "og:description", content: "查看版本时间线、样本明细与 Langfuse 发布记录。" },
    ],
  }),
  component: DatasetDetailPage,
});

function DatasetDetailPage() {
  const { id } = useParams({ from: "/datasets/$id" });
  const qc = useQueryClient();
  const dataset = useQuery({ queryKey: ["dataset", id], queryFn: () => getDataset(id) });
  const versions = useQuery({ queryKey: ["versions", id], queryFn: () => listVersions(id) });
  const publishes = useQuery({
    queryKey: ["publishes", id],
    queryFn: () => listPublishJobs(id),
    refetchInterval: 1500,
  });
  const projects = useQuery({ queryKey: ["lf-projects"], queryFn: listProjects });

  const [target, setTarget] = useState<DatasetVersion | null>(null);
  const [projectId, setProjectId] = useState("");
  const [lfName, setLfName] = useState("");
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const publishMutation = useMutation({
    mutationFn: createPublishJob,
    onSuccess: async (job) => {
      await qc.invalidateQueries({ queryKey: ["publishes"] });
      setTarget(null);
      toast.success("发布任务已创建", { description: job.id });
    },
  });

  async function openPublish(v: DatasetVersion) {
    setTarget(v);
    setDuplicate(null);
    const name = `${dataset.data?.name ?? "dataset"}-${v.version}`
      .replace(/\s+/g, "-")
      .toLowerCase();
    setLfName(name);
    setProjectId(projects.data?.[0]?.id ?? "");
    const dup = await checkIdempotency(v.id, name);
    if (dup) setDuplicate(dup.id);
  }

  const activeVersion =
    versions.data?.find((v) => v.id === selectedVersion) ?? versions.data?.[0] ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <StateView
        isLoading={dataset.isLoading}
        error={dataset.error}
        data={dataset.data}
        onRetry={() => void dataset.refetch()}
      >
        {(ds) => (
          <PageHeader
            title={ds.name}
            description={ds.description}
            actions={
              <Button variant="outline" asChild>
                <Link to="/datasets">返回列表</Link>
              </Button>
            }
          />
        )}
      </StateView>

      <div className="mb-4">
        <EvidenceTrack
          steps={[
            { label: "数据来源", detail: dataset.data?.name ?? "—", state: "done" },
            { label: "导入草稿", detail: "映射与校验已完成", state: "done" },
            {
              label: "固化版本",
              detail: dataset.data?.currentVersion
                ? `当前默认版本 ${dataset.data.currentVersion}`
                : "尚未固化",
              state: dataset.data?.currentVersion ? "done" : "current",
            },
            {
              label: "Langfuse 发布",
              detail: publishes.data?.length ? `${publishes.data.length} 条发布记录` : "尚未发布",
              state: publishes.data?.length ? "done" : "todo",
            },
            { label: "运行快照", detail: "在端到端计算中创建", state: "todo" },
            { label: "指标结果与报告", detail: "计算完成后生成", state: "todo" },
          ]}
        />
      </div>

      <Tabs defaultValue="versions">
        <TabsList>
          <TabsTrigger value="versions">版本时间线</TabsTrigger>
          <TabsTrigger value="samples">样本</TabsTrigger>
          <TabsTrigger value="publishes">发布记录</TabsTrigger>
        </TabsList>

        <TabsContent value="versions" className="mt-4">
          <StateView
            isLoading={versions.isLoading}
            error={versions.error}
            data={versions.data}
            isEmpty={(v) => v.length === 0}
            onRetry={() => void versions.refetch()}
            empty={
              <EmptyBlock
                title="尚未固化任何版本"
                description="该数据集仍为草稿，先完成导入与校验后固化版本。"
                action={
                  <Button asChild>
                    <Link to="/datasets/new">去导入</Link>
                  </Button>
                }
              />
            }
          >
            {(list) => (
              <div className="space-y-3">
                {list.map((v) => (
                  <Card key={v.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium">{v.version}</span>
                          <Badge variant="secondary">只读</Badge>
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">
                          {v.contentHash}
                        </div>
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div>
                          <div className="text-xs text-muted-foreground">样本数</div>
                          <div className="font-mono">{v.sampleCount}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">固化时间</div>
                          <div className="font-mono">
                            {v.createdAt.slice(0, 16).replace("T", " ")}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedVersion(v.id)}
                        >
                          查看样本
                        </Button>
                        <Button
                          size="sm"
                          disabled={v.status !== "READY" || dataset.data?.kind !== "test_set"}
                          title={
                            dataset.data?.kind !== "test_set"
                              ? "仅测试集（test_set）版本可发布到 Langfuse"
                              : v.status !== "READY"
                                ? "仅 READY 版本可发布"
                                : undefined
                          }
                          onClick={() => void openPublish(v)}
                        >
                          <UploadCloud className="size-4" /> 发布到 Langfuse
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </StateView>
        </TabsContent>

        <TabsContent value="samples" className="mt-4">
          {!activeVersion ? (
            <EmptyBlock title="没有可展示的样本" description="请先固化一个数据集版本。" />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {activeVersion.version} · {activeVersion.sampleCount} 条样本
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">ID</TableHead>
                      <TableHead>question</TableHead>
                      <TableHead>expected_output</TableHead>
                      <TableHead className="w-48">metadata</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeVersion.samples.slice(0, 20).map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs">{s.id}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">{s.question}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">
                          {s.expected_output}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {Object.entries(s.metadata)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" · ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {activeVersion.samples.length > 20 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    仅展示前 20 条，共 {activeVersion.samples.length} 条。
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="publishes" className="mt-4">
          <StateView
            isLoading={publishes.isLoading}
            error={publishes.error}
            data={publishes.data}
            isEmpty={(p) => p.length === 0}
            onRetry={() => void publishes.refetch()}
            empty={<EmptyBlock title="尚未发布过" description="从版本时间线发起一次发布。" />}
          >
            {(jobs) => (
              <div className="space-y-3">
                {jobs.map((j) => (
                  <Card key={j.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {j.langfuseDatasetName}
                          <StatusBadge status={j.status} />
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {j.langfuseProject} · 版本 {j.version} ·{" "}
                          {j.createdAt.slice(0, 16).replace("T", " ")}
                        </div>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link to="/publishes/$jobId" params={{ jobId: j.id }}>
                          查看发布状态
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

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布 {target?.version} 到 Langfuse Datasets</DialogTitle>
            <DialogDescription>
              只写入 question 与 expected_output（期望答案），不会写入模型实际输出。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {duplicate && (
              <WarningBlock title="该版本已发布到同名 Dataset">
                幂等保护：重复发布将覆盖同名条目。已存在任务 {duplicate}。
              </WarningBlock>
            )}
            <div className="space-y-2">
              <Label>Langfuse 项目</Label>
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
              <Label htmlFor="lf-name">Langfuse Dataset 名称</Label>
              <Input id="lf-name" value={lfName} onChange={(e) => setLfName(e.target.value)} />
            </div>
            {publishMutation.isError && <ErrorBlock message={publishMutation.error.message} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button
              disabled={!target || !projectId || !lfName.trim() || publishMutation.isPending}
              onClick={() => {
                if (!target || !dataset.data) return;
                const project = projects.data?.find((p) => p.id === projectId);
                publishMutation.mutate({
                  datasetId: dataset.data.id,
                  datasetName: dataset.data.name,
                  versionId: target.id,
                  version: target.version,
                  sampleCount: target.sampleCount,
                  projectName: project?.name ?? projectId,
                  langfuseDatasetName: lfName,
                });
              }}
            >
              开始发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
