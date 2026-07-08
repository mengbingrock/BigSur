import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight, DownloadCloud, Loader2, Pencil, RefreshCw } from "lucide-react";
import type { Agent, Skill, SkillFile } from "@labee/contracts";
import { Markdown } from "~/components/Markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { apiGet, apiSend } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";
import { cn } from "~/lib/utils";

interface UpdateStatus {
  updatable: boolean;
  updateAvailable: boolean;
  origin?: string;
  current?: string;
  latest?: string;
  detail?: string;
}

export const Route = createFileRoute("/skills/$slug")({
  component: SkillDetail,
});

function SkillDetail() {
  const { slug } = Route.useParams();
  const { data: user } = useCurrentUser();
  const { data, isLoading, error } = useQuery({
    queryKey: ["skill", slug],
    queryFn: () =>
      apiGet<{ skill: Skill; files: SkillFile[] }>(`/api/skills/${encodeURIComponent(slug)}`),
  });

  if (isLoading) {
    return (
      <p className="mx-auto w-full max-w-[var(--content-width)] px-6 py-16 text-sm text-ink-light">
        Loading…
      </p>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto w-full max-w-[var(--content-width)] px-6 py-16">
        <p className="text-sm text-ink-light">Artifact not found.</p>
        <Button variant="link" size="sm" className="mt-4 px-0" render={<Link to="/skills" />}>
          ← Back to artifacts
        </Button>
      </div>
    );
  }

  const { skill, files } = data;
  const owned = skill.source.kind === "user";

  return (
    <article className="mx-auto w-full max-w-[var(--content-width)] px-6 py-10">
      <Button
        variant="link"
        size="xs"
        className="px-0 text-ink-light"
        render={<Link to="/skills" />}
      >
        ← Artifacts
      </Button>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight text-ink">{skill.name}</h1>
          <p className="mt-2 font-mono text-xs uppercase tracking-wider text-ink-faint">
            {skill.artifactKind === "protocol" ? "Protocol · " : ""}
            {skill.sourceLabel}
          </p>
        </div>
        {user && owned && (
          <Button
            variant="outline"
            size="sm"
            render={<Link to="/skills/$slug/edit" params={{ slug: skill.slug }} />}
          >
            <Pencil />
            Edit
          </Button>
        )}
      </header>

      {skill.description && <p className="mt-4 text-base text-ink-light">{skill.description}</p>}

      {skill.allowedTools.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {skill.allowedTools.map((tool) => (
            <Badge key={tool} variant="outline" className="font-mono text-[11px] text-ink-light">
              {tool}
            </Badge>
          ))}
        </div>
      )}

      {user && <SkillActions skill={skill} />}

      <div className="mt-10 border-t border-border pt-8">
        <Markdown>{skill.body}</Markdown>
      </div>

      {files.length > 0 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-display text-xl text-ink">Reference files</h2>
          <div className="mt-4 flex flex-col gap-2">
            {files.map((file) => (
              <FileRow key={file.relPath} file={file} />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function SkillActions({ skill }: { skill: Skill }) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const [installed, setInstalled] = useState<string | null>(null);

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<{ agents: Agent[] }>("/api/agents"),
  });
  const agents = agentsQ.data?.agents ?? [];
  const effectiveAgentId = agentId || agents[0]?.id || "";

  const install = useMutation({
    mutationFn: () =>
      apiSend<{ target: string; mode: "local" | "remote"; path: string }>(
        "POST",
        `/api/skills/${encodeURIComponent(skill.slug)}/install`,
        { agentId: effectiveAgentId },
      ),
    onSuccess: (r) => {
      const agent = agents.find((a) => a.id === effectiveAgentId);
      setInstalled(
        r.mode === "local"
          ? `Installed to ${agent?.name ?? "agent"} → ${r.path} (${r.target}).`
          : `Added to ${agent?.name ?? "agent"} — installs into ${r.path} when it runs on its own machine.`,
      );
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const canUpdate = Boolean(skill.origin);
  const updateCheck = useQuery({
    queryKey: ["skill-update", skill.slug],
    queryFn: () =>
      apiGet<UpdateStatus>(`/api/skills/${encodeURIComponent(skill.slug)}/update-check`),
    enabled: canUpdate,
    staleTime: 60_000,
  });
  const update = useMutation({
    mutationFn: () =>
      apiSend<{ skill: Skill }>("POST", `/api/skills/${encodeURIComponent(skill.slug)}/update`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["skill", skill.slug] });
      void qc.invalidateQueries({ queryKey: ["skill-update", skill.slug] });
    },
  });

  return (
    <div className="mt-8 flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      {/* Install to an agent */}
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Install to agent
        </p>
        {agents.length === 0 ? (
          <p className="text-sm text-ink-light">
            No agents yet.{" "}
            <Link to="/agents" className="text-brand hover:underline">
              Create one
            </Link>{" "}
            to install this skill into its runtime.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={effectiveAgentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3 text-sm text-ink"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.engine ?? "claude"}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!effectiveAgentId || install.isPending}
              onClick={() => {
                setInstalled(null);
                install.mutate();
              }}
            >
              {install.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <DownloadCloud className="size-4" />
              )}
              Install
            </Button>
            {installed && <span className="text-sm text-ink-light">{installed}</span>}
            {install.isError && (
              <span className="text-sm text-destructive">
                {install.error instanceof Error ? install.error.message : "Install failed."}
              </span>
            )}
          </div>
        )}
        <p className="text-xs text-ink-faint">
          Copies into the agent's <span className="font-mono">.claude/skills</span> or{" "}
          <span className="font-mono">.codex/skills</span> and adds it to the agent's skill group —
          every session from that agent inherits it.
        </p>
      </div>

      {/* Update from origin */}
      {canUpdate && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">Origin</p>
          <span className="text-sm text-ink-light">{updateCheck.data?.detail ?? skill.origin?.kind}</span>
          {updateCheck.isLoading ? (
            <span className="text-xs text-ink-faint">checking…</span>
          ) : updateCheck.data?.updateAvailable ? (
            <Badge variant="outline" className="text-[11px] text-brand">
              update available
            </Badge>
          ) : updateCheck.data ? (
            <Badge variant="outline" className="text-[11px] text-ink-faint">
              up to date
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Update
          </Button>
          {update.isError && (
            <span className="text-sm text-destructive">
              {update.error instanceof Error ? update.error.message : "Update failed."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ file }: { file: SkillFile }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(file.text);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm",
          expandable ? "hover:bg-surface" : "cursor-default",
        )}
      >
        <span className="flex items-center gap-2 font-mono text-xs text-ink">
          {expandable && (
            <ChevronRight
              size={14}
              className={cn("text-ink-faint transition", open && "rotate-90")}
            />
          )}
          {file.relPath}
        </span>
        <span className="text-[11px] text-ink-faint">
          {file.binary ? "binary" : file.truncated ? "truncated" : `${file.size} B`}
        </span>
      </button>
      {open && file.text && (
        <pre className="overflow-x-auto border-t border-border bg-surface px-4 py-3 font-mono text-xs leading-relaxed text-ink">
          {file.text}
        </pre>
      )}
    </div>
  );
}
