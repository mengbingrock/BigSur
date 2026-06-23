import type { ReactNode } from "react";
import { SiteNav } from "./SiteNav";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <SiteNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-rule px-6 py-8 text-xs text-muted sm:px-8 lg:px-12">
        <div className="flex w-full items-center justify-between">
          <span className="font-serif">Labee</span>
          <span>Research skills, orchestrated.</span>
        </div>
      </footer>
    </div>
  );
}
