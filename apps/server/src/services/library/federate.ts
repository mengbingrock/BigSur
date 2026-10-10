// One search over two pools: the person's own protocols on this machine and
// the shared library on the box.
//
// Where each pool lives decides who answers. On the box, both are local. On a
// desktop, the person's protocols are here and the library is a call to the
// box with the session the desktop keeps for its account — so the phone, the
// web page and the agent all ask one endpoint and get one ranked list, and
// `scope=library` still answers when the library is the only pool reachable.
//
// Two lists are fused by reciprocal rank, since a cosine-plus-BM25 score from
// one index is not on the same scale as the other's. A protocol the person
// saved from the library shadows its original: one row, theirs, marked.
import { getAllSkills } from "../skills";
import { isDesktop, remoteLabeeSession } from "../llmSettings";
import { search, type RetrievalHit, type SearchMode } from "../artifactIndex/index";
import type { Grain } from "../artifactIndex/chunk";
import { libraryPassages, searchLibrary, type LibraryHit, type LibraryPassage } from "./search";

export type Scope = "mine" | "library" | "all";

export function parseScope(raw: string | null | undefined): Scope {
  return raw === "library" || raw === "all" ? raw : "mine";
}

export interface UnifiedHit {
  pool: "mine" | "library";
  /** Own protocol: its slug. Library protocol: "library:<id>". */
  slug: string;
  /** Library id, when pool is library or the hit shadows one. */
  id?: string | undefined;
  name: string;
  score: number;
  heading: string;
  snippet: string;
  path: string;
  grain: Grain;
  source?: string | undefined;
  url?: string | undefined;
  license?: string | undefined;
  category?: string | undefined;
  /** Set on an own protocol that was saved from the library: the original's id. */
  shadows?: string | undefined;
}

/** Library hits from wherever the library is. Null when unreachable. */
export async function libraryHits(q: string, opts: { limit: number; email?: string }): Promise<{ mode: SearchMode; hits: LibraryHit[] } | null> {
  if (!isDesktop()) {
    return (await searchLibrary(q, { limit: opts.limit, ...(opts.email ? { email: opts.email } : {}) })) ?? { mode: "lexical", hits: [] };
  }
  const remote = remoteLabeeSession();
  if (!remote) return null;
  try {
    const res = await fetch(`${remote.base}/api/library/search?q=${encodeURIComponent(q)}&limit=${opts.limit}`, {
      headers: { accept: "application/json", cookie: remote.cookie },
    });
    if (!res.ok) return null;
    return (await res.json()) as { mode: SearchMode; hits: LibraryHit[] };
  } catch {
    return null;
  }
}

/** Library passages from wherever the library is; empty when unreachable. */
export async function libraryPassagesAnywhere(q: string, opts: { limit: number; email?: string }): Promise<LibraryPassage[]> {
  if (!isDesktop()) return libraryPassages(q, { limit: opts.limit, ...(opts.email ? { email: opts.email } : {}) });
  const remote = remoteLabeeSession();
  if (!remote) return [];
  try {
    const res = await fetch(`${remote.base}/api/library/passages?q=${encodeURIComponent(q)}&limit=${opts.limit}`, {
      headers: { accept: "application/json", cookie: remote.cookie },
    });
    if (!res.ok) return [];
    return ((await res.json()) as { passages: LibraryPassage[] }).passages ?? [];
  } catch {
    return [];
  }
}

function fromMine(h: RetrievalHit, name: string, origin: { kind: string; id?: string } | undefined): UnifiedHit {
  return {
    pool: "mine",
    slug: h.slug,
    name,
    score: h.score,
    heading: h.heading,
    snippet: h.snippet,
    path: h.path,
    grain: h.grain,
    ...(origin?.kind === "library" && origin.id ? { shadows: origin.id, id: origin.id } : {}),
  };
}

function fromLibrary(h: LibraryHit): UnifiedHit {
  return {
    pool: "library",
    slug: `library:${h.id}`,
    id: h.id,
    name: h.title,
    score: h.score,
    heading: h.heading,
    snippet: h.snippet,
    path: h.path,
    grain: h.grain,
    source: h.source,
    url: h.url,
    license: h.license,
    category: h.category,
  };
}

/** Reciprocal-rank fusion of ranked lists. */
export function fuse(lists: ReadonlyArray<ReadonlyArray<UnifiedHit>>, k = 60): UnifiedHit[] {
  const score = new Map<string, number>();
  const hit = new Map<string, UnifiedHit>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      score.set(h.slug, (score.get(h.slug) ?? 0) + 1 / (k + rank + 1));
      if (!hit.has(h.slug)) hit.set(h.slug, h);
    });
  }
  return [...hit.values()]
    .map((h) => ({ ...h, score: score.get(h.slug) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Search `scope`, as `email`. `mine` is the personal index as before; `library`
 * is the shared library; `all` fuses them, with a saved copy shadowing its
 * original. Null only when `mine` has nothing indexed and the caller should
 * fall back to a file scan.
 */
export async function searchScoped(
  q: string,
  email: string | undefined,
  opts: { scope: Scope; kind?: "skill" | "protocol"; limit?: number },
): Promise<{ mode: SearchMode; hits: UnifiedHit[]; libraryReachable: boolean } | null> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  let mine: UnifiedHit[] | null = null;
  let mode: SearchMode = "lexical";
  if (opts.scope !== "library") {
    const r = await search(q, email, { ...(opts.kind ? { kind: opts.kind } : {}), limit });
    if (opts.scope === "mine" && !r) return null;
    if (r) {
      mode = r.mode;
      const skills = new Map(getAllSkills(email).map((s) => [s.slug, s]));
      mine = r.hits.map((h) => {
        const s = skills.get(h.slug);
        return fromMine(h, s?.name ?? h.slug, s?.origin as { kind: string; id?: string } | undefined);
      });
    } else {
      mine = [];
    }
  }
  if (opts.scope === "mine") return { mode, hits: mine!, libraryReachable: true };

  const lib = await libraryHits(q, { limit, ...(email ? { email } : {}) });
  const library = (lib?.hits ?? []).map(fromLibrary);
  if (opts.scope === "library") return { mode: lib?.mode ?? "lexical", hits: library, libraryReachable: lib !== null };

  // all: fuse, then let a saved copy stand for its original.
  const shadowed = new Set((mine ?? []).map((h) => h.shadows).filter((x): x is string => Boolean(x)));
  const fused = fuse([mine ?? [], library.filter((h) => !shadowed.has(h.id!))]);
  return { mode: lib?.mode === "semantic" || mode === "semantic" ? "semantic" : "lexical", hits: fused.slice(0, limit), libraryReachable: lib !== null };
}
