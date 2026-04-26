"use client";

import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { Search } from "lucide-react";
import type { Skill } from "@/lib/types";
import SkillCard from "./SkillCard";
import SourceFilter from "./SourceFilter";

interface Props {
  skills: Skill[];
  sources: string[];
}

export default function SkillSearch({ skills, sources }: Props) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);

  const fuse = useMemo(
    () =>
      new Fuse(skills, {
        keys: [
          { name: "name", weight: 0.5 },
          { name: "description", weight: 0.4 },
          { name: "allowedTools", weight: 0.1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [skills],
  );

  const filtered = useMemo(() => {
    const base = query.trim() ? fuse.search(query.trim()).map((r) => r.item) : skills;
    return source ? base.filter((s) => s.sourceLabel === source) : base;
  }, [fuse, query, skills, source]);

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="w-full border border-rule bg-paper py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none"
          />
        </div>
        <SourceFilter sources={sources} selected={source} onChange={setSource} />
      </div>

      <p className="mb-4 text-xs uppercase tracking-[0.18em] text-muted">
        {filtered.length} skill{filtered.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <div className="border border-dashed border-rule p-10 text-center text-sm text-muted">
          No skills match these filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <SkillCard key={s.slug} skill={s} />
          ))}
        </div>
      )}
    </div>
  );
}
