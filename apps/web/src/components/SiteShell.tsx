import type { ReactNode } from "react";

import { AppSidebarLayout } from "./AppSidebarLayout";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <AppSidebarLayout>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </AppSidebarLayout>
  );
}
