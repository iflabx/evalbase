import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Link,
  Outlet,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">找不到这个页面</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          这个地址不属于当前的原始资料或测试集工作区。
        </p>
        <Link
          to="/materials"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          返回原始资料
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div role="alert" className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">页面暂时无法打开</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            重试
          </button>
          <Link
            to="/materials"
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            返回原始资料
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AgentBench · 单人资料工作区" },
      { name: "description", content: "管理原始资料和版本化测试集。" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <>
      <HeadContent />
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <div className="flex min-h-screen w-full bg-background">
            <AppSidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
                <SidebarTrigger />
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium text-foreground">AgentBench</span>
                  <span className="hidden text-muted-foreground sm:inline">/</span>
                  <span className="hidden truncate text-muted-foreground sm:inline">
                    单人资料工作区
                  </span>
                </div>
                <span className="ml-auto rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  非生产
                </span>
              </header>
              <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
                <Outlet />
              </main>
            </div>
          </div>
        </SidebarProvider>
      </QueryClientProvider>
    </>
  );
}
