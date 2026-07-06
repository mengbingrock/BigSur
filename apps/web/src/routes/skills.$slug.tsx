import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight, Pencil } from "lucide-react";
import type { Skill, SkillFile } from "@labee/contracts";
import { Markdown } from "~/components/Markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { apiGet } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";
import { cn } from "~/lib/utils";

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
