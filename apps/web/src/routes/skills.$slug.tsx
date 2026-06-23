import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { Skill, SkillFile } from "@labee/contracts";
import { Markdown } from "~/components/Markdown";
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
    return <p className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted">Loading…</p>;
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted">Artifact not found.</p>
        <Link to="/skills" className="mt-4 inline-block text-sm text-ink underline">
          ← Back to artifacts
        </Link>
      </div>
    );
  }

  const { skill, files } = data;
  const owned = skill.source.kind === "user";

  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-12 sm:px-8">
      <Link to="/skills" className="text-xs text-muted underline-offset-2 hover:underline">
        ← Artifacts
      </Link>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl tracking-tight text-ink">{skill.name}</h1>
          <p className="mt-2 font-mono text-xs uppercase tracking-wider text-muted">
            {skill.artifactKind === "protocol" ? "Protocol · " : ""}
            {skill.sourceLabel}
          </p>
        </div>
        {user && owned && (
          <Link
            to="/skills/$slug/edit"
            params={{ slug: skill.slug }}
            className="border border-ink px-4 py-2 text-sm font-medium text-ink transition hover:bg-ink hover:text-paper"
          >
            Edit
          </Link>
        )}
      </header>

      {skill.description && <p className="mt-4 text-base text-muted">{skill.description}</p>}

      {skill.allowedTools.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {skill.allowedTools.map((tool) => (
            <span
              key={tool}
              className="border border-rule px-2 py-0.5 font-mono text-[11px] text-muted"
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      <div className="mt-10 border-t border-rule pt-8">
        <Markdown>{skill.body}</Markdown>
      </div>

      {files.length > 0 && (
        <section className="mt-12 border-t border-rule pt-8">
          <h2 className="font-serif text-xl text-ink">Reference files</h2>
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
    <div className="border border-rule">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm",
          expandable ? "hover:bg-ink/5" : "cursor-default",
        )}
      >
        <span className="flex items-center gap-2 font-mono text-xs text-ink">
          {expandable && (
            <ChevronRight
              size={14}
              className={cn("transition", open && "rotate-90")}
            />
          )}
          {file.relPath}
        </span>
        <span className="text-[11px] text-muted">
          {file.binary ? "binary" : file.truncated ? "truncated" : `${file.size} B`}
        </span>
      </button>
      {open && file.text && (
        <pre className="overflow-x-auto border-t border-rule bg-[#f1efe9] px-4 py-3 font-mono text-xs leading-relaxed text-ink">
          {file.text}
        </pre>
      )}
    </div>
  );
}
