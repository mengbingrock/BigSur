import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileText, FolderPlus, Loader2, MessagesSquare, Plus, Search, Sparkles } from "lucide-react";
import type { Skill } from "@labee/contracts";
import { Button } from "~/components/ui/button";
import { useCurrentUser } from "~/lib/auth";
import { apiGet, apiSend } from "~/lib/api";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/protocols")({
  component: ProtocolsPage,
});

const UNCATEGORISED = "Uncategorised";

interface SearchHit {
  slug: string;
  score: number;
  /** Heading path of the matching chunk, e.g. "Materials › Buffers". */
  heading?: string;
  snippet?: string;
}

interface SearchResponse {
  /** "lexical" when no embedding credential resolved on the server. */
  mode: "semantic" | "lexical";
  hits: SearchHit[];
}

interface CategoryProposal {
  slug: string;
  name: string;
  category: string | null;
  confidence: number;
  reason: string;
  isNew: boolean;
}

interface SuggestResult {
  proposals: CategoryProposal[];
  newCategories: string[];
  usedModel: boolean;
}

interface Citation {
  n: number;
  slug: string;
  name: string;
  heading: string;
  quote: string;
}

interface AskResult {
  answer: string;
  citations: Citation[];
  available: boolean;
}

interface IndexStatus {
  total: number;
  indexed: number;
  pending: number;
  available: boolean;
}

type Ownership = "all" | "mine" | "imported";

/** Which bucket a protocol falls in. Every protocol is the person's own; the
 *  only distinction worth a filter is whether it was written here or came in
 *  from GitHub, a registry or a file (it has an `origin`). */
function ownershipOf(p: Skill): Exclude<Ownership, "all"> {
  return p.origin ? "imported" : "mine";
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
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["skills"] });
    void qc.invalidateQueries({ queryKey: ["protocol-categories"] });
  };
  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
  });

  // Category folders the caller owns. Kept separate from the counts derived
  // from artifacts so an empty category still shows in the rail.
  const catsQ = useQuery({
    queryKey: ["protocol-categories"],
    queryFn: () => apiGet<{ categories: string[] }>("/api/skills/categories"),
    enabled: !!user,
  });
  const ownCategories = catsQ.data?.categories ?? [];

  const createCat = useMutation({
    mutationFn: (name: string) =>
      apiSend<{ name: string }>("POST", "/api/skills/categories", { name }),
    onSuccess: refresh,
  });
  const renameCat = useMutation({
    mutationFn: (v: { from: string; to: string }) =>
      apiSend<{ name: string }>("PATCH", `/api/skills/categories/${encodeURIComponent(v.from)}`, {
        name: v.to,
      }),
    onSuccess: (_d, v) => {
      setCategory((cur) => (cur === v.from ? v.to : cur));
      refresh();
    },
  });
  const deleteCat = useMutation({
    mutationFn: (name: string) =>
      apiSend<{ ok: true }>("DELETE", `/api/skills/categories/${encodeURIComponent(name)}`),
    onSuccess: (_d, name) => {
      setCategory((cur) => (cur === name ? null : cur));
      refresh();
    },
  });
  const moveOne = useMutation({
    mutationFn: (v: { slug: string; category: string | null }) =>
      apiSend<{ skill: Skill }>("POST", `/api/skills/${v.slug}/move`, { category: v.category }),
    onSuccess: refresh,
  });
  // The categorisation agent. Proposals are held in local state and nothing is
  // written until "Apply selected" — the server side never moves a file.
  const [proposals, setProposals] = useState<CategoryProposal[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const suggest = useMutation({
    mutationFn: () => apiSend<SuggestResult>("POST", "/api/skills/categories/suggest", {}),
    onSuccess: (d) => {
      setProposals(d.proposals);
      // Pre-tick the confident ones; the rest are a deliberate choice.
      setChosen(new Set(d.proposals.filter((p) => p.confidence >= 0.8).map((p) => p.slug)));
    },
  });
  const applySuggestions = useMutation({
    mutationFn: async (picked: CategoryProposal[]) => {
      // Create any new folders first, then move each protocol into place.
      for (const name of new Set(picked.filter((p) => p.isNew && p.category).map((p) => p.category!))) {
        await apiSend<{ name: string }>("POST", "/api/skills/categories", { name }).catch(() => null);
      }
      for (const p of picked) {
        if (!p.category) continue;
        await apiSend<unknown>("POST", `/api/skills/${p.slug}/move`, { category: p.category });
      }
      return picked.length;
    },
    onSuccess: () => {
      setProposals(null);
      setChosen(new Set());
      refresh();
    },
  });

  // Ask the library. A deliberate button, not something that fires while
  // typing: it costs a model call and takes a second or two.
  const askMut = useMutation({
    mutationFn: (question: string) =>
      apiSend<AskResult>("POST", "/api/skills/ask", { q: question, kind: "protocol" }),
  });

  const mutError =
    createCat.error ??
    renameCat.error ??
    deleteCat.error ??
    moveOne.error ??
    suggest.error ??
    applySuggestions.error ??
    null;

  const [q, setQ] = useState("");
  const [owner, setOwner] = useState<Ownership>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const protocols = useMemo(
    () => (data?.skills ?? []).filter((s) => s.artifactKind === "protocol"),
    [data],
  );

  // Server-side body search (phase 3). Debounced so typing does not hammer it;
  // bodies stay on the server and only a snippet comes back.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const searchQ = useQuery({
    queryKey: ["protocol-search", debounced],
    queryFn: () =>
      apiGet<SearchResponse>(
        `/api/skills/search?kind=protocol&q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length > 0,
    staleTime: 15_000,
  });

  // Indexing progress. Polled only while the index is still catching up, so a
  // warm library makes one request and stops.
  const statusQ = useQuery({
    queryKey: ["protocol-index-status"],
    queryFn: () => apiGet<IndexStatus>("/api/skills/index/status"),
    enabled: !!user,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && d.available && d.indexed < d.total ? 2000 : false;
    },
  });
  const indexing =
    statusQ.data && statusQ.data.available && statusQ.data.indexed < statusQ.data.total
      ? statusQ.data
      : null;
  const lexical = searchQ.data?.mode === "lexical";

  /** slug → hit, so a card can show why it matched. */
  const hits = useMemo(() => {
    const m = new Map<string, SearchHit>();
    for (const h of searchQ.data?.hits ?? []) m.set(h.slug, h);
    return m;
  }, [searchQ.data]);

  const searching = debounced.length > 0;

  /** Ownership + category + search, in that order. */
  const visible = useMemo(() => {
    let list = protocols;
    if (searching) {
      // Server order is by match quality; keep it.
      const order = [...hits.keys()];
      const bySlug = new Map(protocols.map((p) => [p.slug, p]));
      list = order.map((slug) => bySlug.get(slug)).filter((p): p is Skill => Boolean(p));
    }
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
  }, [protocols, hits, searching, owner, category, sort]);

  /** Category counts come from the ownership-filtered set, so the rail always
   *  adds up to what the chips are showing. */
  const categories = useMemo(() => {
    const base = owner === "all" ? protocols : protocols.filter((p) => ownershipOf(p) === owner);
    const counts = new Map<string, number>();
    for (const p of base) {
      const key = p.category ?? UNCATEGORISED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Folders with nothing in them still belong in the rail, otherwise a
    // category you just made vanishes until you put something in it.
    for (const name of ownCategories) if (!counts.has(name)) counts.set(name, 0);
    const named = [...counts.entries()]
      .filter(([name]) => name !== UNCATEGORISED)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const uncat = counts.get(UNCATEGORISED);
    // Uncategorised always sorts last so untidy protocols stay visible
    // instead of being buried alphabetically.
    return uncat ? [...named, [UNCATEGORISED, uncat] as const] : named;
  }, [protocols, owner, ownCategories]);

  /** What "All" in the rail shows: the sum of the category counts, so it
   *  stays put when a category or a search narrows the list. */
  const railTotal = useMemo(() => categories.reduce((n, [, count]) => n + count, 0), [categories]);

  const ownerCounts = useMemo(() => {
    let mine = 0;
    let imported = 0;
    for (const p of protocols) {
      if (ownershipOf(p) === "mine") mine += 1;
      else imported += 1;
    }
    return { all: protocols.length, mine, imported };
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
              : `${protocols.length} protocol${protocols.length === 1 ? "" : "s"} · ${categories.length} categor${categories.length === 1 ? "y" : "ies"}`}
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) askMut.mutate(q.trim());
            }}
            placeholder="Search protocols, steps, reagents…"
            className="min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!q.trim() || askMut.isPending}
            onClick={() => askMut.mutate(q.trim())}
            title="Answer this from your protocols, with citations"
          >
            {askMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessagesSquare className="size-4" />
            )}
            Ask
          </Button>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={owner === "all"} onClick={() => setOwner("all")}>
            All <Count>{ownerCounts.all}</Count>
          </Chip>
          <Chip active={owner === "mine"} onClick={() => setOwner("mine")}>
            Mine <Count>{ownerCounts.mine}</Count>
          </Chip>
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

      {indexing ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-light">
          <Loader2 className="size-3.5 animate-spin" />
          Indexing {indexing.indexed} of {indexing.total} protocols for search…
        </p>
      ) : lexical ? (
        <p className="mt-2 text-sm text-ink-light">
          Semantic search needs a model key — showing text matches instead.
        </p>
      ) : null}

      {askMut.data || askMut.isPending ? (
        <AskPanel
          result={askMut.data ?? null}
          pending={askMut.isPending}
          onDismiss={() => askMut.reset()}
        />
      ) : null}

      {proposals ? (
        <ProposalReview
          proposals={proposals}
          chosen={chosen}
          onToggle={(slug) =>
            setChosen((cur) => {
              const next = new Set(cur);
              if (next.has(slug)) next.delete(slug);
              else next.add(slug);
              return next;
            })
          }
          onDismiss={() => {
            setProposals(null);
            setChosen(new Set());
          }}
          onApply={() =>
            applySuggestions.mutate(proposals.filter((p) => chosen.has(p.slug) && p.category))
          }
          applying={applySuggestions.isPending}
        />
      ) : null}

      {mutError ? (
        <p className="mt-3 text-sm text-destructive">
          {mutError instanceof Error ? mutError.message : "Something went wrong."}
        </p>
      ) : null}

      <div className="mt-7 flex flex-col gap-7 lg:flex-row">
        {categories.length > 0 && (
          <aside aria-label="Categories" className="w-full shrink-0 lg:w-[200px]">
            <p className="px-2 pb-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              Categories
            </p>
            <div className="flex flex-wrap gap-1 lg:flex-col">
              <RailItem active={category === null} onClick={() => setCategory(null)} count={railTotal}>
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
            {user && (
              <div className="mt-2 flex flex-col gap-1">
                <button
                  type="button"
                  disabled={createCat.isPending}
                  onClick={() => {
                    const name = window.prompt("New category name");
                    if (name?.trim()) createCat.mutate(name.trim());
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm text-brand transition hover:bg-muted/60"
                >
                  <FolderPlus className="size-3.5" />
                  New category
                </button>
                <button
                  type="button"
                  disabled={suggest.isPending}
                  onClick={() => suggest.mutate()}
                  title="Propose a category for each unfiled protocol"
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-sm text-brand transition hover:bg-muted/60 disabled:opacity-50"
                >
                  {suggest.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  Suggest categories
                </button>
                {category && category !== UNCATEGORISED && (
                  <div className="flex items-center gap-2 px-2.5 text-xs text-ink-light">
                    <button
                      type="button"
                      onClick={() => {
                        const to = window.prompt(`Rename “${category}” to`, category);
                        if (to?.trim() && to.trim() !== category) {
                          renameCat.mutate({ from: category, to: to.trim() });
                        }
                      }}
                      className="underline underline-offset-2 hover:text-ink"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCat.mutate(category)}
                      title="Only an empty category can be deleted"
                      className="underline underline-offset-2 hover:text-destructive"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}
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
                <ProtocolCard
                  key={p.slug}
                  protocol={p}
                  hit={hits.get(p.slug)}
                  categories={ownCategories}
                  onMove={(slug, cat) => moveOne.mutate({ slug, category: cat })}
                  moving={moveOne.isPending && moveOne.variables?.slug === p.slug}
                />
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
                        <ProtocolCard
                          key={`${s.name}-${p.slug}`}
                          protocol={p}
                          categories={ownCategories}
                          onMove={(slug, cat) => moveOne.mutate({ slug, category: cat })}
                          moving={moveOne.isPending && moveOne.variables?.slug === p.slug}
                        />
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

function ProtocolCard({
  protocol,
  hit,
  categories,
  onMove,
  moving,
}: {
  protocol: Skill;
  hit?: SearchHit;
  categories: string[];
  onMove: (slug: string, category: string | null) => void;
  moving: boolean;
}) {
  const navigate = useNavigate();
  const owner = ownershipOf(protocol);
  const when = relTime(protocol.updatedAt);
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
      {hit?.heading ? (
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{hit.heading}</p>
      ) : null}
      <p className="line-clamp-2 text-sm leading-relaxed text-ink-light">
        {hit?.snippet ?? protocol.description}
      </p>
      <div className="mt-1 flex items-center gap-2 text-xs text-ink-light">
        <span className="capitalize">{owner}</span>
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
        <div className="flex-1" />
        {(
          <label className="flex items-center gap-1 text-xs text-ink-light">
            <span className="sr-only">Move {protocol.name} to a category</span>
            {moving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <select
                value={protocol.category ?? ""}
                onChange={(e) => onMove(protocol.slug, e.target.value || null)}
                title="Move to a category"
                className="h-7 max-w-[7.5rem] rounded-md border border-border bg-card px-1.5 text-xs text-ink-light focus:border-ink focus:outline-none"
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
      </div>
    </article>
  );
}

/** The answer to a question, with the passages it cited. Every claim is
 *  supposed to carry a [n] marker; the citations below are exactly the
 *  passages those markers point at, so a reader can check any of them. */
function AskPanel({
  result,
  pending,
  onDismiss,
}: {
  result: AskResult | null;
  pending: boolean;
  onDismiss: () => void;
}) {
  return (
    <section className="mt-5 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg text-ink">Answer</h2>
        {!pending && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      {pending ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-light">
          <Loader2 className="size-3.5 animate-spin" />
          Reading your protocols…
        </p>
      ) : !result?.available ? (
        <p className="mt-2 text-sm text-ink-light">
          Answering needs a model key. Add one in Settings, or use search instead.
        </p>
      ) : (
        <>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {result.answer}
          </p>
          {result.citations.length > 0 && (
            <ol className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
              {result.citations.map((c) => (
                <li key={c.n} className="flex gap-2 text-sm">
                  <span className="shrink-0 font-mono text-xs text-ink-faint">[{c.n}]</span>
                  <span className="min-w-0">
                    <Link
                      to="/skills/$slug"
                      params={{ slug: c.slug }}
                      className="font-medium text-ink hover:underline"
                    >
                      {c.name}
                    </Link>
                    {c.heading ? (
                      <span className="text-ink-light"> · {c.heading}</span>
                    ) : null}
                    <span className="mt-0.5 block line-clamp-2 text-ink-light">{c.quote}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

/** The agent's proposals, as a review list. Nothing has been written at this
 *  point: every row is a suggestion the person opts into. */
function ProposalReview({
  proposals,
  chosen,
  onToggle,
  onDismiss,
  onApply,
  applying,
}: {
  proposals: CategoryProposal[];
  chosen: Set<string>;
  onToggle: (slug: string) => void;
  onDismiss: () => void;
  onApply: () => void;
  applying: boolean;
}) {
  const placeable = proposals.filter((p) => p.category);
  return (
    <section className="mt-5 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-ink">Suggested categories</h2>
          <p className="mt-0.5 text-sm text-ink-light">
            {placeable.length === 0
              ? "Nothing to propose — every protocol is already filed."
              : `${placeable.length} protocol${placeable.length === 1 ? "" : "s"} could be filed. Nothing moves until you apply.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button size="sm" disabled={chosen.size === 0 || applying} onClick={onApply}>
            {applying ? <Loader2 className="size-4 animate-spin" /> : null}
            Apply {chosen.size > 0 ? chosen.size : ""}
          </Button>
        </div>
      </div>
      {placeable.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {placeable.map((p) => (
            <li key={p.slug} className="flex items-start gap-3 py-2.5">
              <input
                type="checkbox"
                id={`prop-${p.slug}`}
                checked={chosen.has(p.slug)}
                onChange={() => onToggle(p.slug)}
                className="mt-1 size-4 shrink-0"
              />
              <label htmlFor={`prop-${p.slug}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{p.name}</span>
                  <span className="text-ink-faint">→</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-ink">
                    {p.category}
                  </span>
                  {p.isNew && (
                    <span className="text-[11px] uppercase tracking-[0.12em] text-brand">new</span>
                  )}
                </span>
                <span className="mt-0.5 block text-sm text-ink-light">{p.reason}</span>
              </label>
              <span className="shrink-0 text-xs text-ink-faint">
                {Math.round(p.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
