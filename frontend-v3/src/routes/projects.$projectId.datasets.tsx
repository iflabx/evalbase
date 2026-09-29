import { useState } from "react";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Database, FileUp, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyBlock, PageHeader, StateView } from "@/components/state-view";
import { NameDialog } from "@/components/name-dialog";
import { ConfirmedUploadDialog } from "@/components/confirmed-upload-dialog";
import { createCollection, listCollections } from "@/services/workspace";
import { useProjectAccess } from "@/hooks/use-project-access";
import { Pagination } from "@/routes/index";

const PAGE_SIZE = 10;
export const Route = createFileRoute("/projects/$projectId/datasets")({ component: DatasetsRoute });

function DatasetsRoute() {
  const { projectId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === `/projects/${projectId}/datasets` ? <DatasetsPage /> : <Outlet />;
}

function DatasetsPage() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const access = useProjectAccess(projectId);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "dataset" | "system">("all");
  const [content, setContent] = useState<"all" | "populated" | "empty">("all");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const collections = useQuery({
    queryKey: ["collections", projectId, { search, type, content, descending, page }],
    queryFn: () =>
      listCollections(projectId, {
        name: search,
        type,
        content,
        sort: descending ? "updated_desc" : "updated_asc",
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });
  const uploadTargets = useQuery({
    queryKey: ["collection-upload-targets", projectId],
    queryFn: () => listCollections(projectId, { limit: 100, offset: 0 }),
    enabled: access.canWrite,
  });
  const rows = collections.data?.items ?? [];
  const total = collections.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="原始数据"
        actions={
          access.canWrite ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setUploading(true)}>
                <FileUp className="size-4" />
                上传文件
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                新建原始数据
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索原始数据"
            placeholder="搜索原始数据"
            className="pl-8"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={type}
          onValueChange={(value: "all" | "dataset" | "system") => {
            setType(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36" aria-label="按类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="dataset">原始数据</SelectItem>
            <SelectItem value="system">默认收纳区</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={content}
          onValueChange={(value: "all" | "populated" | "empty") => {
            setContent(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-36" aria-label="按内容筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部内容</SelectItem>
            <SelectItem value="populated">有文件</SelectItem>
            <SelectItem value="empty">无文件</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setDescending((value) => !value)}>
          <ArrowUpDown className="size-4" />
          更新时间 {descending ? "降序" : "升序"}
        </Button>
      </div>
      <StateView
        isLoading={collections.isLoading}
        error={collections.error}
        data={rows}
        isEmpty={(items) => items.length === 0}
        onRetry={() => void collections.refetch()}
        empty={
          <EmptyBlock
            title="没有符合条件的原始数据"
            action={
              access.canWrite ? (
                <Button onClick={() => setCreating(true)}>新建原始数据</Button>
              ) : undefined
            }
          />
        }
      >
        {(items) => (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-4xl text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">类型</th>
                    <th className="px-4 py-2 font-medium">文件数</th>
                    <th className="px-4 py-2 font-medium">统一记录数</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">最近更新</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-border hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Database className="size-4 text-primary" />
                          <div>
                            <span className="font-medium">{item.name}</span>
                            {item.description && (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {item.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">
                          {item.isUnfiled ? "默认收纳区" : "原始数据"}
                        </Badge>
                      </td>
                      <td className="mono px-4 py-3">{item.fileCount}</td>
                      <td className="mono px-4 py-3">{item.unifiedRecordCount}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className={
                            item.fileCount
                              ? "border-chart-2/30 bg-chart-2/10 text-chart-2"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                          }
                        >
                          {item.fileCount ? "可浏览" : "等待文件"}
                        </Badge>
                      </td>
                      <td className="mono px-4 py-3 text-muted-foreground">
                        {item.updatedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/projects/$projectId/datasets/$collectionId"
                            params={{ projectId, collectionId: item.id }}
                          >
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
      {total > 0 && (
        <Pagination
          total={total}
          current={current}
          pages={pages}
          onChange={setPage}
          unit="项原始数据"
        />
      )}
      {access.canWrite && (
        <NameDialog
          open={creating}
          onOpenChange={setCreating}
          title="新建原始数据"
          confirm="创建原始数据"
          intro="用一个简单名称把同一领域或方向的文件放在一起。"
          nameLabel="原始数据名称"
          descriptionLabel="说明（可选）"
          namePlaceholder="例如：客服公开资料"
          descriptionPlaceholder="例如：帮助中心和常见问题"
          note="用于归类当前项目中的原始文件。"
          onSubmit={async (input) => {
            await createCollection(projectId, input);
            await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
            await queryClient.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
      {access.canWrite && (
        <ConfirmedUploadDialog
          open={uploading}
          projectId={projectId}
          collections={(uploadTargets.data?.items ?? []).map(({ id, name }) => ({ id, name }))}
          defaultCollectionId={uploadTargets.data?.items.find((item) => item.isUnfiled)?.id ?? ""}
          onOpenChange={setUploading}
          onConfirmed={async () => {
            await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
            await queryClient.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
    </div>
  );
}
