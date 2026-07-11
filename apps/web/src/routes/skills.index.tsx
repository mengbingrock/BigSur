import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Github, Loader2, RefreshCw } from "lucide-react";
import Fuse from "fuse.js";
import type { Skill } from "@labee/contracts";
import { SkillCard } from "~/components/SkillCard";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
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
  const [kind, setKind] = useState<"all" | "skill" | "protocol">("all");

  const skills = data?.skills ?? [];
  const sources = data?.sources ?? [];
  const hasProtocols = useMemo(
    () => skills.some((s) => s.artifactKind === "protocol"),
    [skills],
  );
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
    if (kind !== "all") list = list.filter((s) => s.artifactKind === kind);
    if (source) list = list.filter((s) => s.sourceLabel === source);
    return list;
  }, [q, source, kind, skills, fuse]);

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
            <ImportDialog />
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
        {hasProtocols && (
          <div className="flex flex-wrap gap-2">
            <FilterChip active={kind === "all"} onClick={() => setKind("all")}>
              All
            </FilterChip>
            <FilterChip active={kind === "skill"} onClick={() => setKind("skill")}>
              Skills
            </FilterChip>
            <FilterChip active={kind === "protocol"} onClick={() => setKind("protocol")}>
              Protocols
            </FilterChip>
          </div>
        )}
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

type ImportMode = "github" | "registry" | "claude" | "codex";

interface MarketplaceEntry {
  name: string;
  description: string;
  subpath: string;
}

const IMPORT_MODES: { id: ImportMode; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "registry", label: "ClawHub" },
  { id: "claude", label: "Claude Skills" },
  { id: "codex", label: "Codex Plugins" },
];

function ImportDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ImportMode>("github");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [mq, setMq] = useState("");

  const finish = () => {
    void qc.invalidateQueries({ queryKey: ["skills"] });
    setOpen(false);
  };

  const ghImp = useMutation({
    mutationFn: () =>
      apiSend<{ skill: Skill }>("POST", "/api/skills/import/github", {
        url: url.trim(),
        token: token.trim() || undefined,
      }),
    onSuccess: () => {
      setUrl("");
      setToken("");
      finish();
    },
  });
  const regImp = useMutation({
    mutationFn: () =>
      apiSend<{ skill: Skill }>("POST", "/api/skills/import/registry", {
        pkg: pkg.trim(),
        version: version.trim() || undefined,
      }),
    onSuccess: () => {
      setPkg("");
      setVersion("");
      finish();
    },
  });
  const mpImp = useMutation({
    mutationFn: (subpath: string) =>
      apiSend<{ skill: Skill }>("POST", "/api/skills/import/marketplace", {
        marketplace: mode,
        subpath,
      }),
    onSuccess: finish,
  });

  const isMarket = mode === "claude" || mode === "codex";
  const market = useQuery({
    queryKey: ["marketplace", mode],
    queryFn: () =>
      apiGet<{ label: string; entries: MarketplaceEntry[] }>(`/api/skills/marketplace/${mode}`),
    enabled: open && isMarket,
    staleTime: 5 * 60_000,
  });
  const entries = market.data?.entries ?? [];
  const filtered = mq.trim()
    ? entries.filter((e) =>
        `${e.name} ${e.description}`.toLowerCase().includes(mq.trim().toLowerCase()),
      )
    : entries;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <Github className="size-4" />
        Import
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a skill</DialogTitle>
          <DialogDescription>
            Pull a skill from GitHub, the ClawHub registry, or a curated Claude / Codex marketplace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {IMPORT_MODES.map((m) => (
              <FilterChip key={m.id} active={mode === m.id} onClick={() => setMode(m.id)}>
                {m.label}
              </FilterChip>
            ))}
          </div>

          {mode === "github" && (
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="github.com/anthropics/skills/tree/main/skills/pdf"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim() && !ghImp.isPending) ghImp.mutate();
                }}
              />
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Personal access token — only for private repos (optional)"
              />
              {ghImp.isError && <ErrorLine error={ghImp.error} />}
            </div>
          )}

          {mode === "registry" && (
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="@acme/pdf-fill"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pkg.trim() && !regImp.isPending) regImp.mutate();
                }}
              />
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="version or range — e.g. ^1.2 (optional, defaults to latest)"
              />
              {regImp.isError && <ErrorLine error={regImp.error} />}
            </div>
          )}

          {isMarket && (
            <div className="flex flex-col gap-3">
              <Input
                value={mq}
                onChange={(e) => setMq(e.target.value)}
                placeholder={`Search ${market.data?.label ?? "marketplace"}…`}
              />
              {market.isLoading ? (
                <p className="py-6 text-center text-sm text-ink-light">
                  <Loader2 className="mr-2 inline size-4 animate-spin" />
                  Loading catalog…
                </p>
              ) : market.isError ? (
                <ErrorLine error={market.error} />
              ) : filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-light">No skills found.</p>
              ) : (
                <div className="flex max-h-[46vh] flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {filtered.map((e) => (
                    <div key={e.subpath} className="flex items-start gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{e.name}</p>
                        {e.description && (
                          <p className="mt-0.5 line-clamp-2 text-xs text-ink-light">
                            {e.description}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mpImp.isPending}
                        onClick={() => mpImp.mutate(e.subpath)}
                      >
                        {mpImp.isPending && mpImp.variables === e.subpath ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                        Import
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {mpImp.isError && <ErrorLine error={mpImp.error} />}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          {mode === "github" && (
            <Button disabled={!url.trim() || ghImp.isPending} onClick={() => ghImp.mutate()}>
              {ghImp.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Import
            </Button>
          )}
          {mode === "registry" && (
            <Button disabled={!pkg.trim() || regImp.isPending} onClick={() => regImp.mutate()}>
              {regImp.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  return (
    <p className="text-sm text-destructive">
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
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
