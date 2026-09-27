import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { reportLovableError } from "../lib/lovable-error-reporting";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
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
      { title: "AgentEval Hub · Agent 评测数据与计算控制台" },
      {
        name: "description",
        content:
          "管理可版本化评测数据集，发布到 Langfuse，导入已完成 Experiment，并执行端到端七维指标计算。",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:title", content: "AgentEval Hub · Agent 评测数据与计算控制台" },
      { name: "twitter:title", content: "AgentEval Hub · Agent 评测数据与计算控制台" },
      {
        property: "og:description",
        content:
          "管理可版本化评测数据集，发布到 Langfuse，导入已完成 Experiment，并执行端到端七维指标计算。",
      },
      {
        name: "twitter:description",
        content:
          "管理可版本化评测数据集，发布到 Langfuse，导入已完成 Experiment，并执行端到端七维指标计算。",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/534b9ef7-223e-4403-b671-4af095893f14/id-preview-678fa14b--5ae4e6d5-ad45-4e9b-b86d-f6fab322c985.lovable.app-1785889220669.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/534b9ef7-223e-4403-b671-4af095893f14/id-preview-678fa14b--5ae4e6d5-ad45-4e9b-b86d-f6fab322c985.lovable.app-1785889220669.png",
      },
    ],
    links: [{ rel: "icon", href: "/favicon.ico", type: "image/x-icon" }],
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
              <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur">
                <SidebarTrigger />
                <span className="text-sm text-muted-foreground">
                  Agent 评测数据与计算控制面 · MVP
                </span>
              </header>
              <main className="min-w-0 flex-1 px-6 py-6">
                {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
                <Outlet />
              </main>
            </div>
          </div>
          <Toaster />
        </SidebarProvider>
      </QueryClientProvider>
    </>
  );
}
