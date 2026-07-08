import { Link } from "@tanstack/react-router";
import type { Skill } from "@labee/contracts";
import { Badge } from "~/components/ui/badge";

export function SkillCard({ skill }: { skill: Skill }) {
  return (
    <Link
      to="/skills/$slug"
      params={{ slug: skill.slug }}
      className="group flex flex-col rounded-lg border border-border bg-card p-4 transition hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-xl leading-snug tracking-tight text-ink">{skill.name}</h3>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          {skill.artifactKind === "protocol" && (
            <Badge variant="outline" size="sm">
              Protocol
            </Badge>
          )}
          {skill.origin?.kind === "github" && (
            <Badge variant="outline" size="sm" title={`Imported from github.com/${skill.origin.repo}`}>
              GitHub
            </Badge>
          )}
          <span className="text-ink-faint">{skill.sourceLabel}</span>
        </div>
      </div>

      <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-ink-light">
        {skill.description || "(no description)"}
      </p>

      <div className="mt-6 flex items-center justify-between text-xs text-ink-faint">
        <span>
          {skill.allowedTools.length > 0
            ? `${skill.allowedTools.length} tool${skill.allowedTools.length === 1 ? "" : "s"}`
            : " "}
        </span>
        <span className="transition group-hover:text-brand">Open &rarr;</span>
      </div>
    </Link>
  );
}
