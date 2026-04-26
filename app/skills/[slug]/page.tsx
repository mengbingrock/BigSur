import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { getAllSkills, getSkillBySlug } from "@/lib/skills";
import Markdown from "@/components/Markdown";

interface Props {
  params: { slug: string };
}

export function generateStaticParams() {
  return getAllSkills().map((s) => ({ slug: s.slug }));
}

export function generateMetadata({ params }: Props) {
  const skill = getSkillBySlug(params.slug);
  if (!skill) return { title: "Skill not found — Monterey" };
  return {
    title: `${skill.name} — Monterey`,
    description: skill.description,
  };
}

export default function SkillDetailPage({ params }: Props) {
  const skill = getSkillBySlug(params.slug);
  if (!skill) notFound();

  return (
    <article className="mx-auto max-w-3xl px-6 pb-24 pt-12">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/skills"
          className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          All skills
        </Link>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 border border-ink px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-ink hover:text-paper"
        >
          <MessageSquare size={13} />
          Try in chat
        </Link>
      </div>

      <header className="mt-8 border-b border-rule pb-8">
        <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
          <span className="font-mono">{skill.sourceLabel}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{skill.slug}</span>
        </div>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink">
          {skill.name}
        </h1>
        {skill.description && (
          <p className="mt-5 text-lg leading-relaxed text-muted">
            {skill.description}
          </p>
        )}

        {skill.allowedTools.length > 0 && (
          <div className="mt-8">
            <p className="mb-3 text-xs uppercase tracking-[0.18em] text-muted">
              Allowed tools
            </p>
            <div className="flex flex-wrap gap-2">
              {skill.allowedTools.map((tool) => (
                <span
                  key={tool}
                  className="border border-rule bg-paper px-2.5 py-1 font-mono text-[11px] text-ink"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}
      </header>

      <div className="mt-10">
        {skill.body ? (
          <Markdown>{skill.body}</Markdown>
        ) : (
          <p className="text-muted">(SKILL.md body is empty.)</p>
        )}
      </div>
    </article>
  );
}
