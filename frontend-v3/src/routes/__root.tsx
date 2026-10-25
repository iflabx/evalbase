import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  Link,
  HeadContent,
  Outlet,
  createRootRouteWithContext,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router";

import { handoffInputContext } from "@/services/assistant-input-context";
import { type AssistantPageContext } from "@/components/project-assistant";
import { AccountGate } from "@/components/account-gate";
import { useProjectAccess } from "@/hooks/use-project-access";
import { AppSidebar } from "@/components/app-sidebar";
import { OnlineAvatars } from "@/components/online-avatars";
import {
  heartbeat,
  leavePresence,
  projectPresence,
  type OnlineUser,
} from "@/services/collaboration";
import { RecordDensityProvider } from "@/components/record-density";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { currentSession, installation, logout, myAccount } from "@/services/account";
import { LoadingBlock } from "@/components/state-view";
import { Activity, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canRetainReadResult } from "@/services/workspace";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "EvalBase · 测试数据管理" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <>
      <HeadContent />
      <QueryClientProvider client={queryClient}>
        <AuthenticatedApp />
      </QueryClientProvider>
    </>
  );
}

function AuthenticatedApp() {
  const location = useRouterState({ select: (state) => state.location });
  const projectId =
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ??
    (location.pathname === "/settings" && typeof location.search.project === "string"
      ? location.search.project
      : "");
  useEffect(() => {
    const expired = () => window.location.replace("/");
    window.addEventListener("evalbase:session-expired", expired);
    return () => window.removeEventListener("evalbase:session-expired", expired);
  }, []);
  const status = useQuery({ queryKey: ["installation"], queryFn: installation, retry: false });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: currentSession,
    enabled: status.data?.needsAdministrator === false && !status.data?.needsMigration,
    retry: false,
  });
  const profile = useQuery({
    queryKey: ["my-account", session.data?.actor.id],
    queryFn: myAccount,
    enabled: Boolean(session.data),
    retry: false,
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const access = useProjectAccess(projectId, Boolean(session.data));
  const draftId = location.pathname.match(/\/test-sets\/drafts\/([^/]+)/)?.[1] ?? "";
  const presenceDraftId = access.canWrite ? draftId : "";
  const assetId = location.pathname.match(/\/files\/([^/]+)/)?.[1];
  const testSetId = location.pathname.match(/\/test-sets\/([^/]+)$/)?.[1];
  const pageContext: AssistantPageContext | undefined = draftId
    ? access.canWrite
      ? { kind: "draft", id: draftId }
      : undefined
    : assetId
      ? { kind: "asset", id: assetId }
      : testSetId
        ? typeof location.search.version === "string"
          ? { kind: "version", id: location.search.version }
          : { kind: "testSet", id: testSetId }
        : undefined;
  const online = useQuery({
    queryKey: ["project-presence", projectId, presenceDraftId, session.data?.actor.id],
    queryFn: () => projectPresence(projectId, presenceDraftId || undefined),
    enabled: Boolean(projectId) && Boolean(session.data) && access.data?.capabilities.read === true,
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    if (online.isError)
      void queryClient.invalidateQueries({ queryKey: ["project-access", projectId] });
  }, [online.isError, online.error, projectId, queryClient]);
  useEffect(() => {
    if (!projectId || !session.data) return;
    void heartbeat(projectId)
      .then(() => online.refetch())
      .catch(() => undefined);
    const timer = window.setInterval(() => void heartbeat(projectId).catch(() => undefined), 5000);
    return () => {
      window.clearInterval(timer);
      void leavePresence(projectId).catch(() => undefined);
    };
  }, [projectId, session.data, online.refetch]);
  if (status.isPending) return <ConnectionShell message="正在连接 EvalBase…" />;
  if (!status.data || (status.isError && !canRetainReadResult(status.error)))
    return (
      <ConnectionShell
        message="无法获取初始化状态。请重试。"
        onRetry={() => void status.refetch()}
      />
    );
  if (status.data.needsMigration)
    return (
      <div className="auth-loading" role="alert">
        检测到旧版实例。请管理员先执行账号绑定迁移，再刷新页面。
      </div>
    );
  if (
    status.data.needsAdministrator ||
    session.data === null ||
    (session.isError && !canRetainReadResult(session.error))
  )
    return <AccountGate setup={status.data.needsAdministrator} />;
  if (session.isPending) return <ConnectionShell message="正在恢复会话…" />;
  if (!session.data)
    return (
      <ConnectionShell
        message="暂时无法恢复会话。请重试。"
        onRetry={() => void session.refetch()}
      />
    );
  const actor = session.data.actor;
  const presenceRevoked =
    online.error instanceof Error && online.error.message === "project_not_found";
  const users: OnlineUser[] = !access.canRead || presenceRevoked ? [] : [...(online.data ?? [])];
  if (
    projectId &&
    profile.data &&
    access.canRead &&
    access.data &&
    !users.some((user) => user.id === actor.id)
  ) {
    users.unshift({
      id: profile.data.id,
      name: profile.data.displayName,
      avatarColor: profile.data.avatarColor,
      role:
        access.data.role === "admin"
          ? "admin"
          : access.data.role === "viewer"
            ? "viewer"
            : "editor",
    });
  }
  return (
    <RecordDensityProvider>
      <SidebarProvider>
        <div className="flex min-h-screen w-full bg-background">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur">
              <SidebarTrigger />
              <span className="text-sm text-muted-foreground">团队测试资料库</span>
              {(status.isError || session.isError) && (
                <button
                  className="text-xs text-muted-foreground hover:text-primary"
                  onClick={() => {
                    void status.refetch();
                    void session.refetch();
                  }}
                >
                  连接暂时中断，重试
                </button>
              )}
              {projectId && access.canRead && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="打开项目助手"
                  onClick={() => {
                    const handoff = location.pathname.endsWith("/processing")
                      ? handoffInputContext(queryClient, projectId, actor.id)
                      : undefined;
                    const context = handoff?.context ?? pageContext;
                    void navigate({
                      to: "/projects/$projectId/assistant",
                      params: { projectId },
                      search: {
                        sourceKind: context?.kind,
                        sourceId: context?.id,
                        selection: handoff?.token,
                      },
                    });
                  }}
                >
                  <MessageSquare className="size-4" />
                  <span className="hidden sm:inline">项目助手</span>
                </Button>
              )}
              <OnlineAvatars users={users} selfId={actor.id} className="ml-auto" />
              <button
                className="text-sm hover:text-primary"
                onClick={async () => {
                  if (projectId) await leavePresence(projectId).catch(() => undefined);
                  await logout();
                  window.location.assign("/");
                }}
              >
                登出
              </button>
            </header>
            <main className="min-w-0 flex-1 px-6 py-6">
              <div key={location.pathname} className="content-enter min-w-0">
                {projectId && !access.canRead ? (
                  access.isPending ? (
                    <LoadingBlock rows={5} />
                  ) : (
                    <div role="alert" className="text-sm text-muted-foreground">
                      当前项目不可访问，请返回项目列表核对权限。
                    </div>
                  )
                ) : (
                  <Outlet />
                )}
              </div>
            </main>
          </div>
        </div>
        <Toaster />
      </SidebarProvider>
    </RecordDensityProvider>
  );
}

/** Public layout only: project names, members and data wait for authenticated queries. */
function ConnectionShell({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-screen w-full bg-background" aria-busy="true">
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar p-4 md:block">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="size-5" />
          </span>
          <div>
            <p className="font-semibold">EvalBase</p>
            <p className="text-xs text-muted-foreground">团队测试资料库</p>
          </div>
        </div>
        <LoadingBlock rows={3} />
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex h-12 items-center border-b px-6 text-sm text-muted-foreground">
          团队测试资料库
        </div>
        <main className="mx-auto max-w-7xl px-6 py-6">
          <p className="mb-6 text-sm text-muted-foreground" role="status">
            {message}
          </p>
          {onRetry && (
            <button className="mb-6 text-sm text-primary hover:underline" onClick={onRetry}>
              重试
            </button>
          )}
          <LoadingBlock rows={5} />
        </main>
      </div>
    </div>
  );
}
