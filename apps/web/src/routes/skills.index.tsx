import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw } from "lucide-react";
import Fuse from "fuse.js";
import type { Skill } from "@labee/contracts";
import { SkillCard } from "~/components/SkillCard";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useCurrentUser } from "~/lib/auth";
import { apiGet, apiSend } from "~/lib/api";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/skills/")({
  component: SkillsPage,
});

function SkillsPage() {
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[]; sources: string[] }>("/api/skills"),
  });
  const sync = useMutation({
    mutationFn: () =>
      apiSend<{ server: string; synced: number; skills: string[] }>("POST", "/api/skills/sync"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
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
    <div className="mx-auto w-full max-w-[1080px] px-6 py-10 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs uppercase tracking-[0.22em] text-ink-faint">Catalog</p>
          <h1 className="font-display text-3xl tracking-tight text-ink">Artifacts</h1>
        </div>
        {user && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              title="Pull the latest skills from the Labee server"
            >
              {sync.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync from server
            </Button>
            <Button render={<Link to="/skills/new" />}>New artifact</Button>
          </div>
        )}
      </div>
      {sync.isError ? (
        <p className="mt-2 text-sm text-destructive">
          {sync.error instanceof Error ? sync.error.message : "Sync failed."}
        </p>
      ) : sync.isSuccess ? (
        <p className="mt-2 text-sm text-ink-light">
          Synced {sync.data.synced} skill{sync.data.synced === 1 ? "" : "s"} from {sync.data.server}.
        </p>
      ) : null}

      <div className="mt-8 flex flex-col gap-4">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search artifacts…"
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
        <p className="mt-12 text-sm text-ink-light">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="mt-12 text-sm text-ink-light">No artifacts found.</p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        "rounded-md border px-3 py-1 text-xs transition",
        active
          ? "border-brand bg-brand text-white"
          : "border-border text-ink-light hover:border-ink hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
