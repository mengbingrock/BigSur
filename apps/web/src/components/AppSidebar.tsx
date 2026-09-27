import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { Agent } from "@labee/contracts";
import {
  BookOpen,
  Bot,
  FileText,
  FlaskConical,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  type LucideIcon,
  Laptop,
} from "lucide-react";

import { apiGet } from "~/lib/api";
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
    label: "My Device",
    to: "/macs",
    icon: Laptop,
    match: (p) => p === "/macs" || p.startsWith("/macs/"),
  },
  {
    label: "Research",
    to: "/research",
    icon: FlaskConical,
    match: (p) => p === "/research" || p.startsWith("/research"),
  },
  // Your agents. There is no public listing any more — an agent belongs to its
  // owner and follows them to every device they sign in on.
  //
  // Skills have no nav entry of their own: an agent is what you run and skills
  // are what it is made of, so they live as a section of the Agents page. The
  // /skills routes are unchanged and still reachable from there.
  {
    label: "Agents",
    to: "/agents",
    icon: Bot,
    match: (p) => p.startsWith("/agents"),
  },
  {
    label: "Protocols",
    to: "/protocols",
    icon: FileText,
    match: (p) => p.startsWith("/protocols"),
  },
];

const EMPTY_SESSIONS: SessionMeta[] = [];

/** A chat that lives on one of the account's machines, as the box reports it. */
interface RemoteChat {
  id: string;
  title: string;
  updatedAt: string;
  hostId: string;
  hostName: string | null;
  hostOnline: boolean;
}

type ChatRow =
  | { kind: "local"; at: number; local: SessionMeta }
  | { kind: "remote"; at: number; remote: RemoteChat };

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

  // Chats from every machine on this account. The local list above is this
  // device's own index; without this, a chat started on the Mac never appeared
  // in the browser, or on another Mac. Anything already in the local index is
  // left to it (matched on the server session id), so a chat is listed once.
  const everywhereQ = useQuery({
    queryKey: ["link", "sessions"],
    queryFn: () => apiGet<{ sessions: RemoteChat[] }>("/api/link/sessions"),
    enabled: !!user,
    refetchInterval: 15_000,
    retry: false,
  });
  const localServerIds = new Set(sessions.map((s) => s.serverId).filter(Boolean));
  const remote = (everywhereQ.data?.sessions ?? []).filter((r) => !localServerIds.has(r.id));
  // One list, newest first, whichever machine a chat lives on.
  const chats: ChatRow[] = [
    ...sessions.map((s): ChatRow => ({ kind: "local", at: s.updatedAt, local: s })),
    ...remote.map((r): ChatRow => ({ kind: "remote", at: Date.parse(r.updatedAt) || 0, remote: r })),
  ].sort((a, b) => b.at - a.at);

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<{ agents: Agent[] }>("/api/agents"),
    enabled: !!user,
  });
  const agents = agentsQ.data?.agents ?? [];
  const [pickerOpen, setPickerOpen] = useState(false);

  // New chat is always agent-scoped: pick an agent, or require creating one.
  const startNewChat = () => {
    if (agentsQ.isLoading) return;
    if (agents.length === 0) {
      setPickerOpen(false);
      void navigate({ to: "/agents/new" });
      return;
    }
    setPickerOpen((v) => !v);
  };
  const startChatWith = (agentId: string) => {
    setPickerOpen(false);
    chatStore.newSession(agentId);
    void navigate({ to: "/chat", search: { agent: agentId } as never });
  };
  const openSession = (s: SessionMeta) => {
    chatStore.switchSession(s.id);
    void navigate({
      to: "/chat",
      search: (s.agentId ? { agent: s.agentId } : {}) as never,
    });
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
                  tooltip={
                    agents.length === 0 ? "Create an agent to start chatting" : "New chat"
                  }
                  onClick={startNewChat}
                >
                  <Plus className="size-4" />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

            {pickerOpen && agents.length > 0 ? (
              <div className="mt-1 flex flex-col gap-0.5 rounded-md border border-sidebar-border bg-background/40 p-1">
                <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                  Chat with agent
                </p>
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => startChatWith(a.id)}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink transition hover:bg-sidebar-accent"
                  >
                    <Bot className="size-4 shrink-0 text-ink-light" />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    void navigate({ to: "/agents/new" });
                  }}
                  className="mt-0.5 flex items-center gap-2 rounded border-t border-sidebar-border px-2 py-1.5 text-left text-xs text-ink-light transition hover:bg-sidebar-accent hover:text-ink"
                >
                  <Plus className="size-3.5 shrink-0" />
                  <span>New agent…</span>
                </button>
              </div>
            ) : null}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            {chats.length === 0 ? (
              <p className="px-2 py-1 text-xs text-ink-faint">No chats yet.</p>
            ) : (
              <SidebarMenu>
                {chats.map((row) =>
                  row.kind === "remote" ? (
                    <SidebarMenuItem key={`remote:${row.remote.hostId}:${row.remote.id}`}>
                      <SidebarMenuButton
                        size="sm"
                        className="gap-2 px-2 py-2"
                        tooltip={`${row.remote.title} — on ${row.remote.hostName ?? "another machine"}${row.remote.hostOnline ? "" : " (asleep)"}`}
                        isActive={pathname === `/macs/${row.remote.hostId}/${row.remote.id}`}
                        onClick={() =>
                          void navigate({
                            to: "/macs/$hostId/$sessionId",
                            params: { hostId: row.remote.hostId, sessionId: row.remote.id },
                          })
                        }
                      >
                        <Laptop
                          className={`size-4 shrink-0 ${row.remote.hostOnline ? "" : "text-ink-faint"}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{row.remote.title}</span>
                        <span className="shrink-0 text-[10px] text-ink-faint tabular-nums">
                          {relTime(row.at)}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : (
                    <SidebarMenuItem key={row.local.id} className="group/chat relative">
                      <SidebarMenuButton
                        size="sm"
                        className="gap-2 px-2 py-2 pr-7"
                        tooltip={row.local.title}
                        isActive={onChat && row.local.id === currentSessionId}
                        onClick={() => openSession(row.local)}
                      >
                        <MessageSquare className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{row.local.title}</span>
                        <span className="shrink-0 text-[10px] text-ink-faint tabular-nums group-hover/chat:opacity-0">
                          {relTime(row.local.updatedAt)}
                        </span>
                      </SidebarMenuButton>
                      <button
                        type="button"
                        aria-label="Delete chat"
                        title="Delete chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          chatStore.deleteSession(row.local.id);
                        }}
                        className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-ink-faint transition hover:text-destructive group-hover/chat:block"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </SidebarMenuItem>
                  ),
                )}
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
