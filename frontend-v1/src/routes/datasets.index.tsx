import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Database, Search, ArrowUpDown } from "lucide-react";
import { listDatasets } from "@/services/datasets";
import {
  DATASET_KIND_LABELS,
  DATASET_SOURCE_LABELS,
  type DatasetKind,
  type DatasetStatus,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyableId, EmptyBlock, PageHeader, StateView } from "@/components/state-view";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/datasets/")({
  head: () => ({
    meta: [
      { title: "数据集管理 · AgentEval Hub" },
      { name: "description", content: "管理可版本化的 Agent 评测数据集、测试集与评测结果集。" },
      { property: "og:title", content: "数据集管理 · AgentEval Hub" },
      { property: "og:description", content: "管理可版本化的 Agent 评测数据集与不可变版本。" },
    ],
  }),
  component: DatasetsPage,
});

function DatasetsPage() {
  const query = useQuery({ queryKey: ["datasets"], queryFn: listDatasets });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<DatasetKind | "all">("all");
  const [status, setStatus] = useState<DatasetStatus | "all">("ACTIVE");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const list = (query.data ?? [])
      .filter((d) => (kind === "all" ? true : d.kind === kind))
      .filter((d) => (status === "all" ? true : d.status === status))
      .filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) =>
        sortDesc ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt),
      );
    return list;
  }, [query.data, kind, status, q, sortDesc]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="数据集"
        description="test_set 用于发布到 Langfuse；evaluated_result 才能作为端到端计算输入。版本一旦固化即不可编辑。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/imports/new">从 Langfuse 导入</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/datasets/new">从文件导入</Link>
            </Button>
            <Button asChild>
              <Link to="/datasets/new">
                <Plus className="size-4" /> 新建数据集
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索数据集名称"
            placeholder="搜索数据集"
            className="pl-8"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as DatasetKind | "all");
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="按类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="test_set">测试集</SelectItem>
            <SelectItem value="evaluated_result">评测结果集</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v as DatasetStatus | "all");
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36" aria-label="按状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">使用中</SelectItem>
            <SelectItem value="ARCHIVED">已归档</SelectItem>
            <SelectItem value="all">全部状态</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setSortDesc((s) => !s)}>
          <ArrowUpDown className="size-4" /> 更新时间 {sortDesc ? "降序" : "升序"}
        </Button>
      </div>

      <StateView
        isLoading={query.isLoading}
        error={query.error}
        data={filtered}
        isEmpty={(d) => d.length === 0}
        onRetry={() => void query.refetch()}
        empty={
          <EmptyBlock
            title="没有符合条件的数据集"
            description="调整筛选条件，或从 CSV / JSONL / JSON / XLSX 文件导入第一个评测集。"
            action={
              <div className="flex gap-2">
                <Button asChild>
                  <Link to="/datasets/new">从文件导入</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to="/imports/new">从 Langfuse 导入</Link>
                </Button>
              </div>
            }
          />
        }
      >
        {() => (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-4xl text-sm">
                <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">类型</th>
                    <th className="px-4 py-2 font-medium">默认版本</th>
                    <th className="px-4 py-2 font-medium">记录数</th>
                    <th className="px-4 py-2 font-medium">来源</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">负责人</th>
                    <th className="px-4 py-2 font-medium">更新时间</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ds) => (
                    <tr key={ds.id} className="border-t border-border hover:bg-accent/40">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <Database className="size-4 text-primary" />
                          <Link
                            to="/datasets/$id"
                            params={{ id: ds.id }}
                            className="font-medium hover:underline"
                          >
                            {ds.name}
                          </Link>
                        </div>
                        <CopyableId value={ds.id} />
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={ds.kind === "test_set" ? "secondary" : "outline"}>
                          {DATASET_KIND_LABELS[ds.kind]}
                        </Badge>
                      </td>
                      <td className="mono px-4 py-2">{ds.currentVersion ?? "未固化"}</td>
                      <td className="mono px-4 py-2">{ds.sampleCount.toLocaleString()}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {DATASET_SOURCE_LABELS[ds.source]}
                      </td>
                      <td className="px-4 py-2">
                        {ds.status === "ACTIVE" ? (
                          <Badge
                            variant="outline"
                            className="border-chart-2/30 bg-chart-2/10 text-chart-2"
                          >
                            使用中
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            已归档
                          </Badge>
                        )}
                      </td>
                      <td className="mono px-4 py-2 text-muted-foreground">{ds.owner}</td>
                      <td className="mono px-4 py-2 text-muted-foreground">
                        {ds.updatedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link to="/datasets/$id" params={{ id: ds.id }}>
                            查看
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </StateView>

      {filtered.length > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            共 {filtered.length} 个数据集 · 第 {current}/{pageCount} 页
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={current >= pageCount}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
