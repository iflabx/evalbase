import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { RoutePage } from "./navigation.js";

export function AppShell({
  children,
  identityRole,
  activePage = "assets",
  onNavigate,
}: {
  children: ReactNode;
  identityRole?: string;
  activePage?: RoutePage;
  onNavigate?: (href: string) => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const navigation = [
    { label: "数据资产", href: "/assets", page: "assets" as const },
    { label: "测试集", href: "/test-sets", page: "test-sets" as const },
    { label: "交付记录", href: "/deliveries", page: "deliveries" as const },
  ];

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrowViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (navigationRef.current)
      navigationRef.current.inert = narrowViewport && !navigationOpen;
  }, [narrowViewport, navigationOpen]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (
      onNavigate &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      onNavigate(href);
      setNavigationOpen(false);
    }
  }

  return (
    <div className="shell">
      <aside
        ref={navigationRef}
        id="app-navigation"
        className={`app-sidebar${navigationOpen ? " open" : ""}`}
        aria-hidden={narrowViewport && !navigationOpen ? true : undefined}
      >
        <a
          className="brand"
          href="/assets"
          aria-label="AgentBench 数据资产"
          onClick={(event) => navigate(event, "/assets")}
        >
          AB
        </a>
        <h1>AgentBench</h1>
        <p>测试数据管理</p>
        <nav aria-label="主导航">
          {navigation.map((item) => {
            const active =
              activePage === item.page ||
              (item.page === "assets" &&
                ["asset-detail", "workbench"].includes(activePage)) ||
              (item.page === "test-sets" && activePage === "test-set-detail");
            return (
              <a
                key={item.href}
                className={active ? "active" : undefined}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={(event) => navigate(event, item.href)}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="scope">
          非生产
          <br />
          仅限非敏感数据
        </div>
      </aside>
      <main className="app-main" id="main-content">
        <header className="app-header">
          <button
            type="button"
            className="sidebar-trigger"
            aria-controls="app-navigation"
            aria-expanded={navigationOpen}
            aria-label={navigationOpen ? "关闭主导航" : "打开主导航"}
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <span aria-hidden>☰</span>
          </button>
          <span>{identityRole ? `当前身份：${identityRole}` : "未登录"}</span>
          <span className="badge">Tailscale 非生产环境</span>
        </header>
        {children}
      </main>
    </div>
  );
}

export type EvidenceStep = {
  label: string;
  detail: string;
  state: "done" | "current" | "todo" | "error";
};

// Selectively migrated from the donor's data-driven EvidenceTrack.
export function EvidenceTrack({ steps }: { steps: EvidenceStep[] }) {
  return (
    <ol className="evidence-track" aria-label="领域生命周期证据轨道">
      {steps.map((step) => (
        <li key={step.label} data-state={step.state}>
          <span className="evidence-dot" aria-hidden />
          <strong>{step.label}</strong>
          <small>{step.detail}</small>
          <span className="sr-only">
            {step.state === "done"
              ? "已完成"
              : step.state === "current"
                ? "进行中"
                : step.state === "error"
                  ? "失败"
                  : "未开始"}
          </span>
        </li>
      ))}
    </ol>
  );
}

// Directly adapted from frontend-v1's common loading/error/empty StateView.
export function StateView<T>({
  loading,
  error,
  data,
  empty,
  children,
}: {
  loading: boolean;
  error?: string;
  data: T;
  empty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (loading)
    return (
      <div className="state-view" aria-busy="true">
        正在加载…
      </div>
    );
  if (error)
    return (
      <div className="state-view error" role="alert">
        操作失败：{error}
      </div>
    );
  if (empty(data))
    return (
      <div className="state-view">暂无 Source Record，请先上传原始资产。</div>
    );
  return <>{children(data)}</>;
}
