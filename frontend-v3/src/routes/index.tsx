import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyBlock, PageHeader, StateView } from "@/components/state-view";
import { NameDialog } from "@/components/name-dialog";
import { createProject, listProjects } from "@/services/workspace";
import { currentSession } from "@/services/account";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/")({ component: ProjectsPage });

function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const account = useQuery({ queryKey: ["session"], queryFn: currentSession });
  const isAdmin = account.data?.actor.role === "admin";
  const projects = useQuery({
    queryKey: ["projects", { search, page }],
    queryFn: () => listProjects({ name: search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  });
  const rows = projects.data?.items ?? [];
  const total = projects.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="项目"
        actions={
          isAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              新建项目
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索项目"
            placeholder="搜索项目"
            className="pl-8"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>
      <StateView
        isLoading={projects.isLoading}
        error={projects.error}
        data={rows}
        isEmpty={(items) => items.length === 0}
        onRetry={() => void projects.refetch()}
        empty={
          search ? (
            <EmptyBlock title="没有符合条件的项目" />
          ) : isAdmin ? (
            <EmptyBlock title="暂无项目，可新建项目。" />
          ) : (
            <div className="project-invite-stack">
              <section className="member-card project-empty-card">
                <div className="member-card-head">
                  <h2>尚未加入任何项目</h2>
                  <p>请让管理员邀请注册时使用的邮箱，然后在「设置 → 信息」接受邀请。</p>
                  <Button asChild className="mt-4">
                    <Link to="/settings" search={{ project: "", section: "info" }}>
                      查看项目邀请
                    </Link>
                  </Button>
                </div>
              </section>
            </div>
          )
        }
      >
        {(items) => (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-3xl text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">数据集</th>
                    <th className="px-4 py-2 font-medium">测试集</th>
                    <th className="px-4 py-2 font-medium">最近更新</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((project) => (
                    <tr key={project.id} className="border-t border-border hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Database className="size-4 text-primary" />
                          <div>
                            <Link
                              to="/projects/$projectId/datasets"
                              params={{ projectId: project.id }}
                              className="font-medium hover:underline"
                            >
                              {project.name}
                            </Link>
                            {project.description && (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {project.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="mono px-4 py-3">{project.datasetCount}</td>
                      <td className="mono px-4 py-3">{project.testSetCount}</td>
                      <td className="mono px-4 py-3 text-muted-foreground">
                        {project.updatedAt.slice(0, 10)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/projects/$projectId/datasets"
                            params={{ projectId: project.id }}
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
          unit="个项目"
        />
      )}
      {isAdmin && (
        <NameDialog
          open={creating}
          onOpenChange={setCreating}
          title="新建项目"
          confirm="创建项目"
          intro="用一个项目把相关的数据集和测试集放在同一个工作区。"
          nameLabel="项目名称"
          descriptionLabel="说明（可选）"
          namePlaceholder="例如：客服体验评测"
          descriptionPlaceholder="例如：客服帮助和预约场景"
          note="创建后会自动包含一个“未整理”数据集。"
          onSubmit={async (input) => {
            const project = await createProject(input);
            await queryClient.invalidateQueries({ queryKey: ["projects"] });
            await navigate({
              to: "/projects/$projectId/datasets",
              params: { projectId: project.id },
            });
          }}
        />
      )}
    </div>
  );
}

export function Pagination({
  total,
  current,
  pages,
  onChange,
  unit,
}: {
  total: number;
  current: number;
  pages: number;
  onChange: (page: number) => void;
  unit: string;
}) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
      <span>
        共 {total} {unit} · 第 {current}/{pages} 页
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={current <= 1}
          onClick={() => onChange(current - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={current >= pages}
          onClick={() => onChange(current + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
