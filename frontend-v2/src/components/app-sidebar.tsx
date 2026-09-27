import { Link, useRouterState } from "@tanstack/react-router";
import { ClipboardList, FolderOpen, PanelTop } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const items = [
  { title: "原始资料", url: "/materials", icon: FolderOpen },
  { title: "测试集", url: "/test-sets", icon: ClipboardList },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (router) => router.location.pathname });

  return (
    <Sidebar collapsible="icon" role="navigation" aria-label="主导航">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <PanelTop className="size-4" aria-hidden="true" />
          </div>
          <div className="leading-tight group-data-[collapsible=icon]:hidden">
            <div className="text-sm font-semibold">AgentBench</div>
            <div className="text-xs text-muted-foreground">单人资料工作区</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={pathname.startsWith(item.url)}>
                    <Link to={item.url} activeProps={{ "aria-current": "page" }}>
                      <item.icon className="size-4" aria-hidden="true" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
