import { useState } from "react";
import { Activity, ChevronDown, Database, FileText, Settings } from "lucide-react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { NameDialog } from "@/components/name-dialog";
import { createProject, listProjects } from "@/services/workspace";
import { currentSession } from "@/services/account";

function projectIdAt(pathname: string) {
  return pathname.match(/^\/projects\/([^/]+)/)?.[1];
}

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useRouterState({ select: (router) => router.location });
  const pathname = location.pathname;
  const requestedProjectId =
    projectIdAt(pathname) ??
    (pathname === "/settings" && typeof location.search.project === "string"
      ? location.search.project
      : undefined);
  const projects = useQuery({
    queryKey: ["projects", "switcher"],
    queryFn: () => listProjects({ limit: 100, offset: 0 }),
  });
  const projectId =
    pathname === "/settings"
      ? (projects.data?.items.find((item) => item.id === requestedProjectId)?.id ??
        projects.data?.items[0]?.id)
      : requestedProjectId;
  const [creating, setCreating] = useState(false);
  const account = useQuery({ queryKey: ["session"], queryFn: currentSession });
  const isAdmin = account.data?.actor.role === "admin";
  const project = projects.data?.items.find((item) => item.id === projectId);

  function selectProject(value: string) {
    if (value === "new" && isAdmin) return setCreating(true);
    void navigate({ to: "/projects/$projectId/datasets", params: { projectId: value } });
  }

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-3 py-4">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="size-4" />
            </div>
            {!collapsed && (
              <div className="leading-tight">
                <div className="text-sm font-semibold">EvalBase</div>
                <div className="text-xs text-muted-foreground">团队测试资料库</div>
              </div>
            )}
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {projectId ? (
            <SidebarGroup>
              {!collapsed && (
                <SidebarGroupContent className="px-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                        aria-label="切换项目"
                      >
                        <Database className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-normal text-muted-foreground">
                            当前项目
                          </span>
                          <span className="block truncate text-sm font-medium">
                            {project?.name ?? "当前项目"}
                          </span>
                        </span>
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {projects.data?.items.map((item) => (
                        <DropdownMenuItem key={item.id} onSelect={() => selectProject(item.id)}>
                          {item.name}
                        </DropdownMenuItem>
                      ))}
                      {isAdmin && (
                        <DropdownMenuItem
                          onSelect={() => selectProject("new")}
                          className="text-primary"
                        >
                          + 新建项目
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarGroupContent>
              )}
              <SidebarGroupContent
                data-testid="project-nav-children"
                className={collapsed ? undefined : "mt-1 ml-4 border-l border-sidebar-border pl-2"}
              >
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={pathname.includes("/datasets")}>
                      <Link to="/projects/$projectId/datasets" params={{ projectId }}>
                        <Database className="size-4" />
                        {!collapsed && <span>数据集</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={pathname.includes("/test-sets")}>
                      <Link to="/projects/$projectId/test-sets" params={{ projectId }}>
                        <FileText className="size-4" />
                        {!collapsed && <span>测试集</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : (
            <SidebarGroup>
              <SidebarGroupLabel>资料库</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive>
                      <Link to="/">
                        <Database className="size-4" />
                        {!collapsed && <span>项目</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === "/settings"}>
                <Link
                  to="/settings"
                  search={{
                    project: projectId ?? "",
                    section:
                      pathname === "/settings" &&
                      (location.search.section === "profile" ||
                        location.search.section === "info" ||
                        location.search.section === "members")
                        ? location.search.section
                        : projects.isSuccess && !projectId
                          ? "info"
                          : undefined,
                  }}
                >
                  <Settings className="size-4" />
                  {!collapsed && <span>设置</span>}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {isAdmin && (
        <NameDialog
          open={creating}
          onOpenChange={setCreating}
          title="新建项目"
          confirm="创建项目"
          intro="用一个项目把相关的数据集和测试集放在同一个工作区。"
          nameLabel="项目名称"
          descriptionLabel="项目说明"
          namePlaceholder="例如：客服体验评测"
          descriptionPlaceholder="例如：客服帮助和预约场景"
          note="创建后会自动包含一个“未整理”数据集。"
          onSubmit={async (input) => {
            const created = await createProject(input);
            await queryClient.invalidateQueries({ queryKey: ["projects"] });
            await navigate({
              to: "/projects/$projectId/datasets",
              params: { projectId: created.id },
            });
          }}
        />
      )}
    </>
  );
}
