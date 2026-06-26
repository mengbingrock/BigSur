import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent } from "@labee/contracts";
import { Bot, Folder, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { apiGet, apiSend } from "~/lib/api";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/agents/")({
  component: AgentsPage,
});

function AgentsPage() {
  const navigate = useNavigate();
  const { data: user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/agents" } });
  }, [authLoading, user, navigate]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<{ agents: Agent[] }>("/api/agents"),
    enabled: !!user,
  });

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
        <Button render={<Link to="/agents/new" />}>
          <Plus className="size-4" />
          New agent
        </Button>
      </div>

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
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </ul>
        )}
      </div>
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
          onClick={() =>
            // TODO: chat route doesn't declare the `agent` search param yet; cast
            // until the chat launch wiring lands (handled separately).
            navigate({ to: "/chat", search: { agent: agent.id } as never })
          }
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
