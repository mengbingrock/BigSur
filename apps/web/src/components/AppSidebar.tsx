import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Boxes,
  Loader2,
  LogOut,
  MessagesSquare,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { useCurrentUser, useLogout } from "~/lib/auth";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Matches the active route when the pathname starts with this prefix. */
  match: (pathname: string) => boolean;
}

const WORKSPACE_ITEMS: NavItem[] = [
  {
    label: "Project",
    to: "/chat",
    icon: MessagesSquare,
    match: (p) => p === "/chat" || p.startsWith("/chat/"),
  },
  {
    label: "Artifacts",
    to: "/skills",
    icon: Boxes,
    match: (p) => p === "/skills" || p.startsWith("/skills"),
  },
];

export function AppSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  return (
    <>
      <SidebarHeader className="px-3 pt-4 pb-2">
        <button
          type="button"
          onClick={() => void navigate({ to: "/" })}
          className="flex items-center gap-2 text-left"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-ink" aria-hidden />
          <span className="as-brand-wordmark">Labee</span>
        </button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {WORKSPACE_ITEMS.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-2"
                    tooltip={item.label}
                    isActive={item.match(pathname)}
                    onClick={() => void navigate({ to: item.to })}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {user?.isAdmin ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-2"
                    tooltip="Admin"
                    isActive={pathname.startsWith("/admin")}
                    onClick={() => void navigate({ to: "/admin/users" })}
                  >
                    <ShieldCheck className="size-4" />
                    <span>Admin</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-2"
                  tooltip="Docs"
                  render={
                    <a
                      href="https://docs.anthropic.com/en/docs/claude-code"
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <BookOpen className="size-4" />
                  <span>Docs</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2 p-2">
        {user ? (
          <div className="flex flex-col gap-2 rounded-lg border border-sidebar-border bg-background/40 p-2">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={user.email}>
                {user.email}
              </span>
              {user.isAdmin ? (
                <span className="rounded-sm border border-rule px-1 text-[9px] uppercase tracking-[0.1em] text-ink-light">
                  admin
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="inline-flex items-center gap-1.5 text-xs text-ink-light transition hover:text-ink disabled:opacity-60"
            >
              {logout.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <LogOut size={12} />
              )}
              Sign out
            </button>
          </div>
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-2"
                onClick={() => void navigate({ to: "/login" })}
              >
                <LogOut className="size-4 rotate-180" />
                <span>Sign in</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>
    </>
  );
}
