import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
  useRouterState,
} from "@tanstack/react-router";

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
    queryKey: ["my-account"],
    queryFn: myAccount,
    enabled: Boolean(session.data),
    retry: false,
  });
  const queryClient = useQueryClient();
  const access = useProjectAccess(projectId, Boolean(session.data));
  const draftId = location.pathname.match(/\/test-sets\/drafts\/([^/]+)/)?.[1] ?? "";
  const presenceDraftId = access.canWrite ? draftId : "";
  const online = useQuery({
    queryKey: ["project-presence", projectId, presenceDraftId],
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
  if (status.isPending) return <div className="auth-loading">正在连接 EvalBase…</div>;
  if (status.isError)
    return (
      <div className="auth-loading" role="alert">
        无法获取初始化状态。请刷新重试。
      </div>
    );
  if (status.data.needsMigration)
    return (
      <div className="auth-loading" role="alert">
        检测到旧版实例。请管理员先执行账号绑定迁移，再刷新页面。
      </div>
    );
  if (status.data.needsAdministrator || session.isError)
    return <AccountGate setup={status.data.needsAdministrator} />;
  if (session.isPending) return <div className="auth-loading">正在恢复会话…</div>;
  const presenceRevoked =
    online.error instanceof Error && online.error.message === "project_not_found";
  const users: OnlineUser[] =
    !access.data?.capabilities.read || presenceRevoked ? [] : [...(online.data ?? [])];
  if (
    projectId &&
    profile.data &&
    access.data &&
    !users.some((user) => user.id === session.data.actor.id)
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
              <OnlineAvatars users={users} selfId={session.data.actor.id} className="ml-auto" />
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
              <Outlet />
            </main>
          </div>
        </div>
        <Toaster />
      </SidebarProvider>
    </RecordDensityProvider>
  );
}
