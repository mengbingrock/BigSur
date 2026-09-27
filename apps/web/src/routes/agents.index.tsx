import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent, Skill } from "@labee/contracts";
import { Bot, Boxes, Folder, Loader2, Pencil, Play, Plus, Trash2, Users } from "lucide-react";

import { ApiError, apiGet, apiSend } from "~/lib/api";
import { chatStore } from "~/store/chat-store";
import { Button } from "~/components/ui/button";
import { SkillCard } from "~/components/SkillCard";
import { Badge } from "~/components/ui/badge";
import { useCurrentUser } from "~/lib/auth";
import { RefreshCw } from "lucide-react";

export const Route = createFileRoute("/agents/")({
  component: AgentsPage,
});

interface LabeeDesktop {
  isDesktop?: boolean;
  connectToLabee?: () => Promise<boolean>;
}
function desktopBridge(): LabeeDesktop | undefined {
  return (window as unknown as { labeeDesktop?: LabeeDesktop }).labeeDesktop;
}

interface AgentSyncResult {
  server: string;
  synced: number;
  agents: string[];
  needsFolder: string[];
}

function AgentsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/agents" } });
  }, [authLoading, user, navigate]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<{ agents: Agent[] }>("/api/agents"),
    enabled: !!user,
  });

  // Pull the user's hosted agents into this local instance. If not connected to
  // Labee yet, prompt the desktop connect flow and retry once.
  const sync = useMutation({
    mutationFn: async (): Promise<AgentSyncResult> => {
      const doSync = () => apiSend<AgentSyncResult>("POST", "/api/agents/sync");
      try {
        return await doSync();
      } catch (e) {
        const d = desktopBridge();
        if (
          d?.isDesktop &&
          d.connectToLabee &&
          e instanceof ApiError &&
          /connect|expired/i.test(e.message)
        ) {
          const ok = await d.connectToLabee();
          if (ok) return await doSync();
        }
        throw e;
      }
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setSyncMsg({
        ok: true,
        text:
          `Synced ${r.synced} agent${r.synced === 1 ? "" : "s"} from ${r.server}.` +
          (r.needsFolder.length
            ? ` Re-pick a local folder (Edit) for: ${r.needsFolder.join(", ")}.`
            : ""),
      });
    },
    onError: (e) =>
      setSyncMsg({ ok: false, text: e instanceof Error ? e.message : "Sync failed." }),
  });

  const isDesktop = Boolean(desktopBridge()?.isDesktop);

  const agents = data?.agents ?? [];

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 py-10 sm:px-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-ink tracking-tight">Agents</h1>
          <p className="mt-1 text-ink-light text-sm">
            Saved presets bundling skills, a working directory, and reference folders.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDesktop ? (
            <Button
              variant="outline"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              title="Pull your agents from your hosted Labee account into this app"
            >
              {sync.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync from Labee
            </Button>
          ) : null}
          <Button render={<Link to="/agents/new" />}>
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      </div>
      {syncMsg ? (
        <p className={`mt-2 text-sm ${syncMsg.ok ? "text-ink-light" : "text-destructive"}`}>
          {syncMsg.text}
        </p>
      ) : null}

      <div className="mt-8">
        {isLoading || authLoading ? (
          <div className="flex items-center gap-2 text-ink-light text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading agents…
          </div>
        ) : isError ? (
          <p className="text-destructive text-sm">
            {error instanceof Error ? error.message : "Failed to load agents."}
          </p>
        ) : agents.length === 0 ? (
          <EmptyState />
        ) : (
          <AgentList agents={agents} />
        )}
        <SkillsSection />
      </div>
    </div>
  );
}

/** Skills, shown here rather than in the nav: an agent is what you run and a
 *  skill is what it is made of, so this is where people look for them. Links
 *  go to the unchanged /skills routes. */
function SkillsSection() {
  const { data: user } = useCurrentUser();
  const skillsQ = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
  });
  // Protocols have their own page; this section is skills only.
  const skills = (skillsQ.data?.skills ?? []).filter((s) => s.artifactKind !== "protocol");

  return (
    <section className="mt-14 border-t border-border pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-display text-2xl text-ink tracking-tight">
            <Boxes className="size-5 text-ink-faint" />
            Skills
          </h2>
          <p className="mt-1 max-w-2xl text-ink-light text-sm">
            The capabilities an agent is assembled from. Attach them to an agent, or open one to
            read what it does.
          </p>
        </div>
        {user ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" render={<Link to="/skills" />}>
              Browse all
            </Button>
            <Button render={<Link to="/skills/new" />}>New skill</Button>
          </div>
        ) : null}
      </div>

      {skillsQ.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-ink-light text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading skills…
        </div>
      ) : skills.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-ink-light text-sm">
          No skills yet.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.slice(0, 6).map((s) => (
              <SkillCard key={s.slug} skill={s} />
            ))}
          </div>
          {skills.length > 6 ? (
            <p className="mt-4 text-sm">
              <Link to="/skills" className="text-brand hover:underline">
                See all {skills.length} skills →
              </Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}


/** Agents, with pipeline teams kept together.
 *
 *  A team is a set of agents that hand off to each other — one's output is the
 *  next one's input — so showing them in hand-off order, boxed together, is the
 *  only way the set reads as a pipeline rather than four unrelated presets.
 *  Everything else follows underneath, most recently edited first. */
function AgentList({ agents }: { agents: Agent[] }) {
  // The server returns teams contiguous and in hand-off order; preserve that.
  const teams: Array<{ name: string; members: Agent[] }> = [];
  const loners: Agent[] = [];
  for (const agent of agents) {
    if (!agent.team) {
      loners.push(agent);
      continue;
    }
    const existing = teams.find((t) => t.name === agent.team);
    if (existing) existing.members.push(agent);
    else teams.push({ name: agent.team, members: [agent] });
  }
  return (
    <div className="flex flex-col gap-8">
      {teams.map((team) => (
        <section key={team.name} className="rounded-xl border-2 border-border bg-surface/40 p-5">
          <h2 className="flex flex-wrap items-center gap-2 font-medium text-ink text-lg">
            <Users className="size-5 shrink-0 text-ink-faint" />
            {team.name}
            <Badge variant="secondary">team of {team.members.length}</Badge>
          </h2>
          <p className="mt-1 max-w-2xl text-ink-light text-sm">
            These agents work together as a pipeline — each one&apos;s output is the next
            one&apos;s input. They are shown in hand-off order.
          </p>
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {team.members.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </ul>
        </section>
      ))}

      {loners.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {loners.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed bg-card px-6 py-16 text-center">
      <Bot className="size-8 text-ink-faint" />
      <p className="font-medium text-ink">No agents yet</p>
      <p className="max-w-sm text-ink-light text-sm">
        Create an agent to save a reusable set of skills, a working directory, and reference
        protocol folders.
      </p>
      <Button render={<Link to="/agents/new" />} className="mt-1">
        <Plus className="size-4" />
        New agent
      </Button>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const del = useMutation({
    mutationFn: () => apiSend<{ ok: true }>("DELETE", "/api/agents/" + agent.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-medium text-ink">{agent.name}</h2>
          {agent.description ? (
            <p className="mt-0.5 line-clamp-2 text-ink-light text-sm">{agent.description}</p>
          ) : null}
        </div>
        <Bot className="size-5 shrink-0 text-ink-faint" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">
          {agent.skillSlugs.length} skill{agent.skillSlugs.length === 1 ? "" : "s"}
        </Badge>
        <Badge variant="outline">
          <Folder className="size-3" />
          {agent.referenceFolders.length} ref folder
          {agent.referenceFolders.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="flex items-center gap-1.5 rounded-md bg-surface px-2 py-1">
        <Folder className="size-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-ink-light text-xs" title={agent.workingDir}>
          {agent.workingDir}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            // Start a fresh chat session bound to this agent so the sidebar's
            // Chats list stays consistent with the open conversation.
            chatStore.newSession(agent.id);
            navigate({ to: "/chat", search: { agent: agent.id } as never });
          }}
        >
          <Play className="size-4" />
          Open
        </Button>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/agents/$id/edit" params={{ id: agent.id }} />}
        >
          <Pencil className="size-4" />
          Edit
        </Button>
        <div className="ml-auto">
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <span className="text-ink-light text-xs">Delete?</span>
              <Button
                size="xs"
                variant="destructive"
                disabled={del.isPending}
                onClick={() => del.mutate()}
              >
                {del.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Yes"}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                No
              </Button>
            </div>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete agent"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="text-destructive" />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
