import { useSyncExternalStore } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Bot,
  Boxes,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { useCurrentUser, useLogout } from "~/lib/auth";
import { chatStore, type SessionMeta } from "~/store/chat-store";
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
    label: "Agents",
    to: "/agents",
    icon: Bot,
    match: (p) => p === "/agents" || p.startsWith("/agents"),
  },
  {
    label: "Artifacts",
    to: "/skills",
    icon: Boxes,
    match: (p) => p === "/skills" || p.startsWith("/skills"),
  },
];

const EMPTY_SESSIONS: SessionMeta[] = [];

/** Compact relative time: now, 5m, 3h, 6d, 2w, 4mo, 1y. */
function relTime(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function AppSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  const sessions = useSyncExternalStore(
    chatStore.subscribe,
    () => chatStore.getState().sessions,
    () => EMPTY_SESSIONS,
  );
  const currentSessionId = useSyncExternalStore(
    chatStore.subscribe,
    () => chatStore.getState().currentSessionId,
    () => "",
  );
  const onChat = pathname === "/chat" || pathname.startsWith("/chat/");

  const startNewChat = () => {
    chatStore.newSession();
    void navigate({ to: "/chat" });
  };
  const openSession = (id: string) => {
    chatStore.switchSession(id);
    void navigate({ to: "/chat" });
  };

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
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-2 font-medium"
                  tooltip="New chat"
                  onClick={startNewChat}
                >
                  <Plus className="size-4" />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 py-1 text-xs text-ink-faint">No chats yet.</p>
            ) : (
              <SidebarMenu>
                {sessions.map((s) => (
                  <SidebarMenuItem key={s.id} className="group/chat relative">
                    <SidebarMenuButton
                      size="sm"
                      className="gap-2 px-2 py-2 pr-7"
                      tooltip={s.title}
                      isActive={onChat && s.id === currentSessionId}
                      onClick={() => openSession(s.id)}
                    >
                      <MessageSquare className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-faint tabular-nums group-hover/chat:opacity-0">
                        {relTime(s.updatedAt)}
                      </span>
                    </SidebarMenuButton>
                    <button
                      type="button"
                      aria-label="Delete chat"
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        chatStore.deleteSession(s.id);
                      }}
                      className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-ink-faint transition hover:text-destructive group-hover/chat:block"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

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
              {user ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-2"
                    tooltip="Settings"
                    isActive={pathname.startsWith("/settings")}
                    onClick={() => void navigate({ to: "/settings" })}
                  >
                    <Settings className="size-4" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
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
