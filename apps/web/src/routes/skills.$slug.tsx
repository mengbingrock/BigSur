import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight, DownloadCloud, ExternalLink, Loader2, Pencil, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type { Agent, Skill, SkillFile } from "@labee/contracts";
import { Markdown } from "~/components/Markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { apiGet, apiSend } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";
import { cn } from "~/lib/utils";

interface LintFinding {
  ruleId: string;
  severity: "warn" | "halt";
  path: string;
  message: string;
  excerpt: string;
}
interface LintReport {
  findings: LintFinding[];
  halts: number;
  warns: number;
}
interface ReviewFinding {
  path: string;
  class: "operation" | "reagent" | "parameter";
  message: string;
  suggestion: string;
  confidence: number;
  excerpt: string;
}
interface ReviewReport {
  findings: ReviewFinding[];
  steps: number;
  available: boolean;
}
interface PurposeProposal {
  slug: string;
  problem: string;
  method: string;
  application: string;
  domains: string[];
  keywords: string[];
  confidence: number;
}

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
  // A protocol and a skill are different things that happen to share a page.
  // The way back, and what can be done here, follow the kind: a protocol
  // belongs to the Protocols library and is used by choosing it in a chat —
  // it is not installed into an agent's runtime the way a skill is.
  const isProtocol = skill.artifactKind === "protocol";

  return (
    <article className="mx-auto w-full max-w-[var(--content-width)] px-6 py-10">
      <Button
        variant="link"
        size="xs"
        className="px-0 text-ink-light"
        render={isProtocol ? <Link to="/protocols" /> : <Link to="/skills" />}
      >
        {isProtocol ? "← Protocols" : "← Skills"}
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

      {skill.origin?.kind === "library" && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-ink-light">
          <span>Saved from the library · {skill.origin.source}</span>
          <Badge variant="outline" className="text-[11px]">{skill.origin.license}</Badge>
          {skill.origin.url && (
            <a href={skill.origin.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
              Source <ExternalLink className="size-3" />
            </a>
          )}
        </p>
      )}

      {isProtocol && (skill.problem || skill.method || skill.application || (skill.domains?.length ?? 0) > 0) && (
        <dl className="mt-5 grid gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-[auto_1fr]">
          {skill.problem && (<><dt className="text-ink-faint">Problem</dt><dd className="text-ink">{skill.problem}</dd></>)}
          {skill.method && (<><dt className="text-ink-faint">Method</dt><dd className="text-ink">{skill.method}</dd></>)}
          {skill.application && (<><dt className="text-ink-faint">Use it for</dt><dd className="text-ink">{skill.application}</dd></>)}
          {(skill.domains?.length ?? 0) > 0 && (
            <>
              <dt className="text-ink-faint">Domains</dt>
              <dd className="flex flex-wrap gap-1.5">
                {skill.domains!.map((d) => (
                  <Badge key={d} variant="outline" className="text-[11px]">{d}</Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

      {user && !isProtocol && <SkillActions skill={skill} />}
      {user && isProtocol && owned && <ProtocolChecks skill={skill} />}

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

/** The two verification layers and the purpose layer, for one's own
 *  protocol. Lint runs on open — it is mechanical and instant. Review is a
 *  model call, so it is a button. Purpose fields are proposed on request and
 *  applied through the ordinary save, so what lands is what was shown. */
function ProtocolChecks({ skill }: { skill: Skill }) {
  const qc = useQueryClient();
  const lint = useQuery({
    queryKey: ["lint", skill.slug, skill.updatedAt],
    queryFn: () => apiSend<LintReport>("POST", `/api/skills/${encodeURIComponent(skill.slug)}/lint`, {}),
  });
  const review = useMutation({
    mutationFn: () => apiSend<ReviewReport>("POST", `/api/skills/${encodeURIComponent(skill.slug)}/review`, {}),
  });
  const purpose = useMutation({
    mutationFn: () =>
      apiSend<{ proposals: PurposeProposal[]; available: boolean }>("POST", "/api/skills/purpose/suggest", { slugs: [skill.slug] }),
  });
  const applyPurpose = useMutation({
    mutationFn: (p: PurposeProposal) =>
      apiSend<{ skill: Skill }>("PUT", `/api/skills/${encodeURIComponent(skill.slug)}`, {
        name: skill.name,
        description: skill.description,
        allowedTools: skill.allowedTools,
        license: skill.license,
        body: skill.body,
        kind: "protocol",
        problem: p.problem,
        method: p.method,
        application: p.application,
        domains: p.domains,
        keywords: p.keywords,
      }),
    onSuccess: () => {
      purpose.reset();
      void qc.invalidateQueries({ queryKey: ["skill", skill.slug] });
      void qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const proposal = purpose.data?.proposals[0];
  const hasPurpose = Boolean(skill.problem || skill.method || skill.application);

  return (
    <div className="mt-8 flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">Checks</p>
          {lint.isLoading ? (
            <span className="text-xs text-ink-faint">checking…</span>
          ) : lint.data ? (
            lint.data.findings.length === 0 ? (
              <Badge variant="outline" className="text-[11px] text-ink-faint">
                <ShieldCheck className="mr-1 size-3" /> nothing mechanical to fix
              </Badge>
            ) : (
              <>
                {lint.data.halts > 0 && (
                  <Badge variant="outline" className="text-[11px] text-destructive">
                    {lint.data.halts} must fix
                  </Badge>
                )}
                {lint.data.warns > 0 && (
                  <Badge variant="outline" className="text-[11px] text-ink-light">
                    {lint.data.warns} to look at
                  </Badge>
                )}
              </>
            )
          ) : null}
          <div className="flex-1" />
          <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate()} title="Judge each step against your other protocols">
            {review.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Review steps
          </Button>
        </div>
        {lint.data && lint.data.findings.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {lint.data.findings.map((f, i) => (
              <li key={`${f.ruleId}-${f.path}-${i}`} className="flex gap-2">
                <span className={cn("shrink-0 font-mono text-xs", f.severity === "halt" ? "text-destructive" : "text-ink-faint")}>
                  {f.path || "file"}
                </span>
                <span className="min-w-0 text-ink-light">
                  {f.message}
                  {f.excerpt && f.excerpt !== f.message ? <span className="ml-1 text-ink-faint">— “{f.excerpt}”</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {review.data && (
          <div className="mt-1 border-t border-border pt-3">
            {!review.data.available ? (
              <p className="text-sm text-ink-light">Reviewing needs a model key. Add one in Settings.</p>
            ) : review.data.findings.length === 0 ? (
              <p className="text-sm text-ink-light">
                {review.data.steps} step{review.data.steps === 1 ? "" : "s"} reviewed against your other protocols — nothing found.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {review.data.findings.map((f, i) => (
                  <li key={`${f.path}-${i}`} className="flex gap-2">
                    <span className="shrink-0 font-mono text-xs text-ink-faint">{f.path}</span>
                    <span className="min-w-0">
                      <span className="mr-2 rounded-full border border-border px-1.5 py-px text-[11px] text-ink-light">{f.class}</span>
                      <span className="text-ink">{f.message}</span>
                      {f.suggestion ? <span className="text-ink-light"> → {f.suggestion}</span> : null}
                      <span className="ml-2 text-xs text-ink-faint">{Math.round(f.confidence * 100)}%</span>
                      <span className="mt-0.5 block line-clamp-1 text-ink-faint">“{f.excerpt}”</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {review.isError && (
          <p className="text-sm text-destructive">{review.error instanceof Error ? review.error.message : "Review failed."}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">Purpose</p>
          <span className="text-sm text-ink-light">
            {hasPurpose ? "What this protocol is for, as search sees it." : "Not filled in yet — goal-phrased questions find a protocol through this."}
          </span>
          <div className="flex-1" />
          {!proposal && (
            <Button size="sm" variant="ghost" disabled={purpose.isPending} onClick={() => purpose.mutate()}>
              {purpose.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {hasPurpose ? "Propose again" : "Propose"}
            </Button>
          )}
        </div>
        {purpose.data && !purpose.data.available && (
          <p className="text-sm text-ink-light">Proposing needs a model key. Add one in Settings, or fill the fields in the editor.</p>
        )}
        {proposal && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-surface p-3 text-sm">
            <p><span className="text-ink-faint">Problem</span> <span className="text-ink">{proposal.problem}</span></p>
            <p><span className="text-ink-faint">Method</span> <span className="text-ink">{proposal.method}</span></p>
            <p><span className="text-ink-faint">Use it for</span> <span className="text-ink">{proposal.application}</span></p>
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-ink-faint">Domains</span>
              {proposal.domains.map((d) => (
                <Badge key={d} variant="outline" className="text-[11px]">{d}</Badge>
              ))}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" disabled={applyPurpose.isPending} onClick={() => applyPurpose.mutate(proposal)}>
                {applyPurpose.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Apply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => purpose.reset()}>
                Dismiss
              </Button>
              <span className="text-xs text-ink-faint">{Math.round(proposal.confidence * 100)}% · editable afterwards</span>
            </div>
          </div>
        )}
      </div>
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
