import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { AccountGate } from "@/components/account-gate";
import { AppSidebar } from "@/components/app-sidebar";
import { RecordDensityProvider } from "@/components/record-density";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { currentSession, installation, logout } from "@/services/account";

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
  const queryClient = useQueryClient();
  useEffect(() => {
    const expired = () => {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    };
    window.addEventListener("evalbase:session-expired", expired);
    return () => window.removeEventListener("evalbase:session-expired", expired);
  }, [queryClient]);
  const status = useQuery({ queryKey: ["installation"], queryFn: installation, retry: false });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: currentSession,
    enabled: status.data?.needsAdministrator === false && !status.data?.needsMigration,
    retry: false,
  });
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
  return (
    <RecordDensityProvider>
      <SidebarProvider>
        <div className="flex min-h-screen w-full bg-background">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur">
              <SidebarTrigger />
              <span className="text-sm text-muted-foreground">团队测试资料库</span>
              <button
                className="ml-auto text-sm hover:text-primary"
                onClick={async () => {
                  await logout();
                  queryClient.removeQueries({ queryKey: ["projects"] });
                  await queryClient.invalidateQueries({ queryKey: ["session"] });
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
