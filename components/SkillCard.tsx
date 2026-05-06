import Link from "next/link";
import type { Skill } from "@/lib/types";

interface Props {
  skill: Skill;
}

export default function SkillCard({ skill }: Props) {
  return (
    <Link
      href={`/skills/${skill.slug}`}
      className="group flex flex-col border border-rule bg-paper p-6 transition hover:border-ink"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-xl leading-snug tracking-tight text-ink">
          {skill.name}
        </h3>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          {skill.artifactKind === "protocol" && (
            <span className="border border-ink px-1.5 py-0.5 text-ink">
              Protocol
            </span>
          )}
          <span className="text-muted">{skill.sourceLabel}</span>
        </div>
      </div>

      <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-muted">
        {skill.description || "(no description)"}
      </p>

      <div className="mt-6 flex items-center justify-between text-xs text-muted">
        <span>
          {skill.allowedTools.length > 0
            ? `${skill.allowedTools.length} tool${skill.allowedTools.length === 1 ? "" : "s"}`
            : " "}
        </span>
        <span className="transition group-hover:text-ink">Open &rarr;</span>
      </div>
    </Link>
  );
}
