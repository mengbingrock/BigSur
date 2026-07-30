// Deterministic citation-graph client against OpenAlex (keyless, has both
// referenced_works and cites: — the protocols MCP has neither). Every HTTP
// response is cached into the evidence chain, so references discovered here
// are citable downstream. Throttled politely; caps keep the crawl bounded.
import { cacheEvidence, type EvidenceCtx } from "./evidence";

const OPENALEX = "https://api.openalex.org";
const THROTTLE_MS = 120;

export interface CandidatePaper {
  /** Stable citable id: doi:… when available, else openalex:W…. */
  refId: string;
  openalexId: string; // "W…"
  title: string;
  year: number | null;
  abstract: string;
  citedByCount: number;
  /** 0 = seed, 1 = one hop, 2 = two hops. */
  hop: number;
}

let lastCall = 0;
async function throttled(): Promise<void> {
  const wait = lastCall + THROTTLE_MS - Date.now();
  lastCall = Math.max(Date.now(), lastCall + THROTTLE_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function openAlexGet(ctx: EvidenceCtx, pathAndQuery: string): Promise<unknown> {
  await throttled();
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const mailto = process.env.OPENALEX_MAILTO ?? "labee-research@labee.online";
  const url = `${OPENALEX}${pathAndQuery}${sep}mailto=${encodeURIComponent(mailto)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OpenAlex ${res.status} for ${pathAndQuery}`);
  const payload = (await res.json()) as unknown;
  await cacheEvidence(ctx, {
    sourceTool: "openalex",
    request: { path: pathAndQuery },
    payload,
  });
  return payload;
}

/** Reconstruct plain-text abstract from OpenAlex's inverted index. */
export function abstractFromInvertedIndex(idx: unknown): string {
  if (!idx || typeof idx !== "object") return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(idx as Record<string, number[]>)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) words.push([pos, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ");
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number;
  abstract_inverted_index?: unknown;
  referenced_works?: string[];
}

function shortId(openalexUrl: string): string {
  // "https://openalex.org/W123" → "W123"
  const m = /W\d+$/.exec(openalexUrl);
  return m ? m[0] : openalexUrl;
}

export function workToCandidate(work: OpenAlexWork, hop: number): CandidatePaper {
  const wid = shortId(work.id ?? "");
  const doi = work.doi?.replace(/^https:\/\/doi\.org\//, "");
  return {
    refId: doi ? `doi:${doi}` : `openalex:${wid}`,
    openalexId: wid,
    title: work.title ?? work.display_name ?? "(untitled)",
    year: work.publication_year ?? null,
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index).slice(0, 2400),
    citedByCount: work.cited_by_count ?? 0,
    hop,
  };
}

/** Resolve one seed ref (doi:/pmid:/pmcid:/openalex:/url:) to an OpenAlex work. */
export async function resolveSeed(ctx: EvidenceCtx, refId: string): Promise<OpenAlexWork | null> {
  let selector: string | null = null;
  if (refId.startsWith("doi:")) selector = `doi:${refId.slice(4)}`;
  else if (refId.startsWith("pmid:")) selector = `pmid:${refId.slice(5)}`;
  else if (refId.startsWith("pmcid:")) selector = `pmcid:${refId.slice(6)}`;
  else if (refId.startsWith("openalex:")) selector = refId.slice("openalex:".length);
  if (!selector) return null;
  try {
    return (await openAlexGet(ctx, `/works/${encodeURIComponent(selector)}`)) as OpenAlexWork;
  } catch {
    return null;
  }
}

async function fetchWorksByIds(ctx: EvidenceCtx, ids: string[]): Promise<OpenAlexWork[]> {
  const works: OpenAlexWork[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const payload = (await openAlexGet(
        ctx,
        `/works?filter=openalex_id:${batch.join("|")}&per-page=50`,
      )) as { results?: OpenAlexWork[] };
      works.push(...(payload.results ?? []));
    } catch {
      // skip failed batch — the crawl is best-effort within caps
    }
  }
  return works;
}

async function fetchCiting(ctx: EvidenceCtx, wid: string, cap: number): Promise<OpenAlexWork[]> {
  try {
    const payload = (await openAlexGet(
      ctx,
      `/works?filter=cites:${wid}&per-page=${Math.min(cap, 200)}&sort=cited_by_count:desc`,
    )) as { results?: OpenAlexWork[] };
    return (payload.results ?? []).slice(0, cap);
  } catch {
    return [];
  }
}

/** Cache a candidate's metadata keyed by its citable ref id. This is what
 *  makes the work CITABLE downstream: the retrieval-only rule checks for an
 *  evidence row per ref id, and the entailment judge reads this payload.
 *  (The raw HTTP responses cached by openAlexGet are the request-level audit
 *  trail; they carry no ref_id.) */
async function cacheWorkEvidence(ctx: EvidenceCtx, cand: CandidatePaper): Promise<void> {
  await cacheEvidence(ctx, {
    sourceTool: "openalex_work",
    request: { work: cand.openalexId },
    refId: cand.refId,
    payload: {
      text:
        `title: ${cand.title}\nyear: ${cand.year ?? "n.d."}\n` +
        `cited_by_count: ${cand.citedByCount}\nabstract: ${cand.abstract}`,
    },
  });
}

/** 2-hop crawl from the seeds: references + top citations per work, deduped,
 *  capped at maxCandidates. Seeds that don't resolve are skipped (the caller
 *  gates on how much survives). */
export async function crawlCitationGraph(
  ctx: EvidenceCtx,
  seedRefIds: string[],
  opts: { maxCandidates: number; onProgress?: (found: number) => void },
): Promise<{ seeds: CandidatePaper[]; candidates: CandidatePaper[] }> {
  const seen = new Map<string, CandidatePaper>();
  const seeds: CandidatePaper[] = [];
  const seedWorks: OpenAlexWork[] = [];

  for (const refId of seedRefIds) {
    const work = await resolveSeed(ctx, refId);
    if (!work?.id) continue;
    const cand = workToCandidate(work, 0);
    seedWorks.push(work);
    seeds.push(cand);
    seen.set(cand.openalexId, cand);
    await cacheWorkEvidence(ctx, cand);
  }

  const perWorkCiteCap = 100;
  let frontier = seedWorks;
  for (let hop = 1; hop <= 2 && seen.size < opts.maxCandidates; hop++) {
    const nextFrontier: OpenAlexWork[] = [];
    for (const work of frontier) {
      if (seen.size >= opts.maxCandidates) break;
      const wid = shortId(work.id ?? "");
      // references
      const refIds = (work.referenced_works ?? []).map(shortId).filter((w) => !seen.has(w));
      const refWorks = await fetchWorksByIds(
        ctx,
        refIds.slice(0, Math.max(0, opts.maxCandidates - seen.size)),
      );
      // citations
      const citing = await fetchCiting(ctx, wid, perWorkCiteCap);
      for (const w of [...refWorks, ...citing]) {
        const cand = workToCandidate(w, hop);
        if (seen.has(cand.openalexId) || seen.size >= opts.maxCandidates) continue;
        seen.set(cand.openalexId, cand);
        await cacheWorkEvidence(ctx, cand);
        if (hop === 1) nextFrontier.push(w);
      }
      opts.onProgress?.(seen.size);
    }
    // Hop 2 explodes fast: only expand the most-cited hop-1 works.
    frontier = nextFrontier
      .sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0))
      .slice(0, 40);
  }

  const candidates = [...seen.values()].filter((c) => c.hop > 0);
  return { seeds, candidates };
}
