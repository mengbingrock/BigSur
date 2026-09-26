import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileText, Plus, Search } from "lucide-react";
import Fuse from "fuse.js";
import type { Skill } from "@labee/contracts";
import { Button } from "~/components/ui/button";
import { useCurrentUser } from "~/lib/auth";
import { apiGet } from "~/lib/api";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/protocols")({
  component: ProtocolsPage,
});

const UNCATEGORISED = "Uncategorised";

type Ownership = "all" | "mine" | "shared" | "imported";

/** Which ownership bucket a protocol falls in. `sourceLabel` is "user" /
 *  "workspace" for the caller's own, "public" for the lab's shared folder;
 *  anything with an `origin` came in from GitHub, a registry or a file. */
function ownershipOf(p: Skill): Exclude<Ownership, "all"> {
  if (p.sourceLabel === "public") return "shared";
  if (p.origin) return "imported";
  return "mine";
}

/** "2 days ago", "3 weeks ago". Empty when the server sent no mtime. */
function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(days / 365)} year${days < 730 ? "" : "s"} ago`;
}

function ProtocolsPage() {
  const { data: user } = useCurrentUser();
  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
  });

  const [q, setQ] = useState("");
  const [owner, setOwner] = useState<Ownership>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const protocols = useMemo(
    () => (data?.skills ?? []).filter((s) => s.artifactKind === "protocol"),
    [data],
  );

  const fuse = useMemo(
    () =>
      new Fuse(protocols, {
        // `body` is included so a search finds a reagent or a step, not just a
        // title. Until the server-side search endpoint exists this is the
        // full-text search, and it works because bodies are already loaded.
        keys: [
          { name: "name", weight: 3 },
          { name: "description", weight: 2 },
          { name: "category", weight: 2 },
          { name: "body", weight: 1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [protocols],
  );

  const searching = q.trim().length > 0;

  /** Ownership + category + search, in that order. */
  const visible = useMemo(() => {
    let list = searching ? fuse.search(q.trim()).map((r) => r.item) : protocols;
    if (owner !== "all") list = list.filter((p) => ownershipOf(p) === owner);
    if (category) list = list.filter((p) => (p.category ?? UNCATEGORISED) === category);
    if (!searching) {
      list = [...list].sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      );
    }
    return list;
  }, [protocols, fuse, q, searching, owner, category, sort]);

  /** Category counts come from the ownership-filtered set, so the rail always
   *  adds up to what the chips are showing. */
  const categories = useMemo(() => {
    const base = owner === "all" ? protocols : protocols.filter((p) => ownershipOf(p) === owner);
    const counts = new Map<string, number>();
    for (const p of base) {
      const key = p.category ?? UNCATEGORISED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const named = [...counts.entries()]
      .filter(([name]) => name !== UNCATEGORISED)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const uncat = counts.get(UNCATEGORISED);
    // Uncategorised always sorts last so untidy protocols stay visible
    // instead of being buried alphabetically.
    return uncat ? [...named, [UNCATEGORISED, uncat] as const] : named;
  }, [protocols, owner]);

  const ownerCounts = useMemo(() => {
    let mine = 0;
    let shared = 0;
    let imported = 0;
    for (const p of protocols) {
      const o = ownershipOf(p);
      if (o === "mine") mine += 1;
      else if (o === "shared") shared += 1;
      else imported += 1;
    }
    return { all: protocols.length, mine, shared, imported };
  }, [protocols]);

  /** Sections: recently updated first, then one per category in rail order.
   *  A section is capped at one row until it is expanded. */
  const sections = useMemo(() => {
    if (searching || category) return [];
    const recent = visible.slice(0, 3);
    const byCategory = categories.map(([name]) => ({
      name,
      items: visible.filter((p) => (p.category ?? UNCATEGORISED) === name),
    }));
    return [{ name: "Recently updated", items: recent, recent: true }, ...byCategory.map((s) => ({ ...s, recent: false }))];
  }, [visible, categories, searching, category]);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight text-ink">Protocols</h1>
          <p className="mt-1 text-sm text-ink-light">
            {isLoading
              ? "Loading…"
              : `${protocols.length} protocol${protocols.length === 1 ? "" : "s"} · ${categories.length} categor${categories.length === 1 ? "y" : "ies"}${ownerCounts.shared ? ` · ${ownerCounts.shared} shared` : ""}`}
          </p>
        </div>
        {user && (
          <Button render={<Link to="/skills/new" />}>
            <Plus className="size-4" />
            New protocol
          </Button>
        )}
      </header>

      <div className="mt-7 flex flex-col gap-3">
        <label className="relative flex h-12 items-center gap-3 rounded-xl border border-border bg-card px-4 focus-within:border-ink">
          <Search className="size-[18px] shrink-0 text-ink-light" />
          <span className="sr-only">Search protocols</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search protocols, steps, reagents…"
            className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={owner === "all"} onClick={() => setOwner("all")}>
            All <Count>{ownerCounts.all}</Count>
          </Chip>
          <Chip active={owner === "mine"} onClick={() => setOwner("mine")}>
            Mine <Count>{ownerCounts.mine}</Count>
          </Chip>
          {ownerCounts.shared > 0 && (
            <Chip active={owner === "shared"} onClick={() => setOwner("shared")}>
              Shared <Count>{ownerCounts.shared}</Count>
            </Chip>
          )}
          {ownerCounts.imported > 0 && (
            <Chip active={owner === "imported"} onClick={() => setOwner("imported")}>
              Imported <Count>{ownerCounts.imported}</Count>
            </Chip>
          )}
          <div className="flex-1" />
          {!searching && (
            <label className="flex items-center gap-2 text-sm text-ink-light">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "updated" | "name")}
                className="h-8 rounded-md border border-border bg-card px-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
              </select>
            </label>
          )}
          {searching && (
            <span className="text-sm text-ink-light">
              {visible.length} result{visible.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div className="mt-7 flex flex-col gap-7 lg:flex-row">
        {categories.length > 0 && (
          <aside aria-label="Categories" className="w-full shrink-0 lg:w-[200px]">
            <p className="px-2 pb-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              Categories
            </p>
            <div className="flex flex-wrap gap-1 lg:flex-col">
              <RailItem active={category === null} onClick={() => setCategory(null)} count={visible.length}>
                All
              </RailItem>
              {categories.map(([name, count]) => (
                <RailItem
                  key={name}
                  active={category === name}
                  onClick={() => setCategory(category === name ? null : name)}
                  count={count}
                  muted={name === UNCATEGORISED}
                >
                  {name}
                </RailItem>
              ))}
            </div>
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {isLoading ? (
            <p className="text-sm text-ink-light">Loading…</p>
          ) : protocols.length === 0 ? (
            <EmptyState />
          ) : visible.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-ink-light">
              {searching ? `No protocol mentions “${q.trim()}”.` : "Nothing here yet."}{" "}
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setOwner("all");
                  setCategory(null);
                }}
                className="underline underline-offset-2 hover:text-ink"
              >
                Clear filters
              </button>
            </p>
          ) : searching || category ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((p) => (
                <ProtocolCard key={p.slug} protocol={p} query={q.trim()} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {sections.map((s) => {
                if (s.items.length === 0) return null;
                const isOpen = expanded.has(s.name);
                const shown = s.recent || isOpen ? s.items : s.items.slice(0, 3);
                return (
                  <section key={s.name} className="flex flex-col gap-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <h2 className="font-display text-xl text-ink">
                        {s.name}
                        {!s.recent && (
                          <span className="ml-2 font-sans text-sm font-normal text-ink-light">
                            {s.items.length}
                          </span>
                        )}
                      </h2>
                      {!s.recent && s.items.length > 3 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((cur) => {
                              const next = new Set(cur);
                              if (next.has(s.name)) next.delete(s.name);
                              else next.add(s.name);
                              return next;
                            })
                          }
                          className="text-sm text-brand underline-offset-2 hover:underline"
                        >
                          {isOpen ? "Show less" : `See all ${s.items.length}`}
                        </button>
                      )}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {shown.map((p) => (
                        <ProtocolCard key={`${s.name}-${p.slug}`} protocol={p} query="" />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Up to ~160 characters of body around the first match, so a search result
 *  shows why it matched rather than just the description. */
function snippet(body: string, query: string): string | null {
  if (!query) return null;
  const i = body.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 70);
  const text = body.slice(start, start + 160).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}…`;
}

/** Chat hydrates its selected-artifact set from this localStorage key on mount
 *  (Chat.tsx SELECTED_KEY), so adding the slug here and navigating is all that
 *  is needed to open the chat with the protocol attached. */
const CHAT_SELECTED_KEY = "monterey.selectedSkills.v1";

function rememberForChat(slug: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CHAT_SELECTED_KEY);
    const current = raw ? (JSON.parse(raw) as string[]) : [];
    const next = Array.isArray(current) ? current : [];
    if (!next.includes(slug)) next.push(slug);
    window.localStorage.setItem(CHAT_SELECTED_KEY, JSON.stringify(next));
  } catch {
    // A blocked or full store just means the chat opens without it
    // preselected; navigating there is still the useful half.
  }
}

function ProtocolCard({ protocol, query }: { protocol: Skill; query: string }) {
  const navigate = useNavigate();
  const owner = ownershipOf(protocol);
  const when = relTime(protocol.updatedAt);
  const hit = snippet(protocol.body, query);
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <Link
        to="/skills/$slug"
        params={{ slug: protocol.slug }}
        className="font-medium leading-snug text-ink hover:underline"
      >
        {protocol.name}
      </Link>
      <p className="text-xs text-ink-light">
        {protocol.category ?? UNCATEGORISED}
        {when ? ` · updated ${when}` : ""}
      </p>
      <p className="line-clamp-2 text-sm leading-relaxed text-ink-light">
        {hit ?? protocol.description}
      </p>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-light">
        <span className="capitalize">{owner === "shared" ? "Shared" : owner}</span>
        {protocol.fileCount ? <span>· {protocol.fileCount} files</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" render={<Link to="/skills/$slug" params={{ slug: protocol.slug }} />}>
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            rememberForChat(protocol.slug);
            void navigate({ to: "/chat" });
          }}
          title="Open the chat with this protocol attached"
        >
          Use in chat
        </Button>
      </div>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border p-8">
      <FileText className="size-6 text-ink-faint" />
      <h2 className="font-display text-xl text-ink">No protocols yet</h2>
      <p className="max-w-lg text-sm leading-relaxed text-ink-light">
        A protocol is a document an agent treats as an authoritative reference — a bench procedure, a
        checklist, a standard operating procedure. Unlike a skill it is never executed; its text is
        quoted to the model as-is.
      </p>
      <Button render={<Link to="/skills/new" />} className="mt-1">
        <Plus className="size-4" />
        New protocol
      </Button>
    </div>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return <span className="opacity-60">{children}</span>;
}

function Chip({
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
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition",
        active
          ? "border-ink bg-ink text-paper"
          : "border-border text-ink hover:border-ink",
      )}
    >
      {children}
    </button>
  );
}

function RailItem({
  active,
  onClick,
  count,
  muted,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition",
        active ? "bg-muted font-medium text-ink" : muted ? "text-ink-light hover:bg-muted/60" : "text-ink hover:bg-muted/60",
      )}
    >
      <span className="truncate">{children}</span>
      <span className="shrink-0 text-xs text-ink-light">{count}</span>
    </button>
  );
}
