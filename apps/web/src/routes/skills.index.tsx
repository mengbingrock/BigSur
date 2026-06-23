import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import Fuse from "fuse.js";
import type { Skill } from "@labee/contracts";
import { SkillCard } from "~/components/SkillCard";
import { useCurrentUser } from "~/lib/auth";
import { apiGet } from "~/lib/api";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/skills/")({
  component: SkillsPage,
});

function SkillsPage() {
  const { data: user } = useCurrentUser();
  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[]; sources: string[] }>("/api/skills"),
  });
  const [q, setQ] = useState("");
  const [source, setSource] = useState<string | null>(null);

  const skills = data?.skills ?? [];
  const sources = data?.sources ?? [];
  const fuse = useMemo(
    () =>
      new Fuse(skills, {
        keys: ["name", "description", "sourceLabel", "allowedTools"],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [skills],
  );
  const filtered = useMemo(() => {
    let list = q.trim() ? fuse.search(q).map((r) => r.item) : skills;
    if (source) list = list.filter((s) => s.sourceLabel === source);
    return list;
  }, [q, source, skills, fuse]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs uppercase tracking-[0.22em] text-muted">Catalog</p>
          <h1 className="font-serif text-4xl tracking-tight text-ink">Artifacts</h1>
        </div>
        {user && (
          <Link
            to="/skills/new"
            className="border border-ink bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:opacity-90"
          >
            New artifact
          </Link>
        )}
      </div>

      <div className="mt-8 flex flex-col gap-4">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search artifacts…"
          className="w-full border border-rule bg-paper px-4 py-2.5 text-sm text-ink focus:border-ink focus:outline-none"
        />
        {sources.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <FilterChip active={source === null} onClick={() => setSource(null)}>
              All
            </FilterChip>
            {sources.map((s) => (
              <FilterChip key={s} active={source === s} onClick={() => setSource(s)}>
                {s}
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <p className="mt-12 text-sm text-muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="mt-12 text-sm text-muted">No artifacts found.</p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {filtered.map((skill) => (
            <SkillCard key={skill.slug} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border px-3 py-1 text-xs transition",
        active ? "border-ink bg-ink text-paper" : "border-rule text-muted hover:border-ink hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
