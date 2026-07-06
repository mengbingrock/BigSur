import type { ReactNode } from "react";

import { AppSidebar } from "./AppSidebar";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "./ui/sidebar";

const SIDEBAR_WIDTH_STORAGE_KEY = "labee_sidebar_width";
const SIDEBAR_MIN_WIDTH = 13 * 16; // 13rem
const MAIN_CONTENT_MIN_WIDTH = 40 * 16; // 40rem

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-sidebar text-foreground"
        resizable={{
          minWidth: SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
          storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <AppSidebar />
        <SidebarRail />
      </Sidebar>
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
