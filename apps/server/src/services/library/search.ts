// Search over the shared library.
//
// Words first, then meaning: BM25 picks a few hundred candidate chunks, and
// only those are scored by embedding. The library is too large to hold every
// vector in memory the way the personal index does, and the purpose-layer
// summary of each protocol makes word overlap with a goal-phrased question
// likely enough that the prefilter rarely hides the right protocol.
import { getDb } from "../db";
import { cosine, embedBatch, resolveEmbedTarget } from "../artifactIndex/embed";
import { ftsExpression, queryGrain, snippetOf, type SearchMode } from "../artifactIndex/index";
import type { Grain } from "../artifactIndex/chunk";
import { libraryHeaders, loadLibraryChunks } from "./store";

export interface LibraryHit {
  id: string;
  title: string;
  source: string;
  url: string;
  license: string;
  category?: string | undefined;
  score: number;
  heading: string;
  snippet: string;
  path: string;
  grain: Grain;
}

export interface LibraryPassage {
  id: string;
  title: string;
  source: string;
  url: string;
  license: string;
  heading: string;
  text: string;
  score: number;
  path: string;
  grain: Grain;
}

/** How many chunks the words shortlist for the embedding to rank. */
const CANDIDATES = 300;
const LEXICAL_WEIGHT = 0.25;
const GRAIN_BONUS = 0.05;

interface Scored {
  protocolId: string;
  idx: number;
  heading: string;
  text: string;
  grain: Grain;
  path: string;
  score: number;
  related: boolean;
}

async function scoreCandidates(q: string, email?: string, opts: { grain?: Grain | "any" } = {}): Promise<{ scored: Scored[]; mode: SearchMode } | null> {
  const expr = ftsExpression(q);
  if (!expr) return null;
  const db = await getDb();
  let rows: Array<{ protocol_id: string; idx: number; s: number }>;
  try {
    rows = db
      .prepare(
        "SELECT protocol_id, idx, bm25(library_chunks_fts, 0, 0, 2.0, 1.0) AS s " +
          "FROM library_chunks_fts WHERE library_chunks_fts MATCH ? ORDER BY s LIMIT ?",
      )
      .all(expr, CANDIDATES) as Array<{ protocol_id: string; idx: number; s: number }>;
  } catch {
    return null;
  }
  if (rows.length === 0) return { scored: [], mode: "lexical" };
  const best = -Number(rows[0]!.s) || 1;
  const bm = new Map(rows.map((r) => [`${r.protocol_id}\u0000${r.idx}`, Math.max(0, -Number(r.s)) / best]));
  const chunks = await loadLibraryChunks(rows.map((r) => ({ protocolId: String(r.protocol_id), idx: Number(r.idx) })));

  const target = await resolveEmbedTarget(email);
  const queryVector = target ? (await embedBatch([q], target))[0] ?? null : null;
  const dense = queryVector !== null && chunks.some((c) => c.vector);
  const want = opts.grain ?? queryGrain(q);

  const scored: Scored[] = chunks.map((c) => {
    const words = bm.get(`${c.protocolId}\u0000${c.idx}`) ?? 0;
    const cos = dense && c.vector && queryVector ? cosine(queryVector, c.vector) : null;
    let score = cos !== null ? cos + LEXICAL_WEIGHT * words : words;
    if (want !== "any" && c.grain === want) score += GRAIN_BONUS;
    if (want === "section" && c.grain === "summary") score -= GRAIN_BONUS;
    return { protocolId: c.protocolId, idx: c.idx, heading: c.heading, text: c.text, grain: c.grain, path: c.path, score, related: (cos ?? 0) > 0.5 || words > 0.5 };
  });
  return { scored, mode: dense ? "semantic" : "lexical" };
}

/** One row per library protocol, ranked. Null when the query has no words. */
export async function searchLibrary(
  query: string,
  opts: { limit?: number; email?: string; grain?: Grain | "any" } = {},
): Promise<{ mode: SearchMode; hits: LibraryHit[] } | null> {
  const q = query.trim();
  if (!q) return { mode: "lexical", hits: [] };
  const result = await scoreCandidates(q, opts.email, opts.grain ? { grain: opts.grain } : {});
  if (!result) return null;
  const want = opts.grain ?? queryGrain(q);

  interface Best { any: Scored; wanted: Scored | null; supporting: number }
  const best = new Map<string, Best>();
  for (const s of result.scored) {
    const cur = best.get(s.protocolId);
    const isWanted = want !== "any" && s.grain === want;
    if (!cur) {
      best.set(s.protocolId, { any: s, wanted: isWanted ? s : null, supporting: s.related ? 1 : 0 });
      continue;
    }
    cur.supporting += s.related ? 1 : 0;
    if (s.score > cur.any.score) cur.any = s;
    if (isWanted && (!cur.wanted || s.score > cur.wanted.score)) cur.wanted = s;
  }
  const headers = await libraryHeaders([...best.keys()]);
  const hits: LibraryHit[] = [];
  for (const [id, v] of best) {
    const h = headers.get(id);
    if (!h || v.any.score <= 0) continue;
    const shown = v.wanted && v.wanted.score > 0 ? v.wanted : v.any;
    hits.push({
      id,
      title: h.title,
      source: h.source,
      url: h.sourceUrl,
      license: h.license,
      category: h.category,
      score: v.any.score + Math.min(3, Math.max(0, v.supporting - 1)) * 0.02,
      heading: shown.heading,
      snippet: snippetOf(shown.text, q),
      path: shown.path,
      grain: shown.grain,
    });
  }
  return { mode: result.mode, hits: hits.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(opts.limit ?? 20, 1), 100)) };
}

/** Top library chunks for a question, for Ask. */
export async function libraryPassages(
  query: string,
  opts: { limit?: number; email?: string } = {},
): Promise<LibraryPassage[]> {
  const q = query.trim();
  if (!q) return [];
  const result = await scoreCandidates(q, opts.email);
  if (!result) return [];
  const top = result.scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(opts.limit ?? 4, 1), 30));
  const headers = await libraryHeaders(top.map((s) => s.protocolId));
  return top.flatMap((s) => {
    const h = headers.get(s.protocolId);
    if (!h) return [];
    return [{ id: s.protocolId, title: h.title, source: h.source, url: h.sourceUrl, license: h.license, heading: s.heading, text: s.text, score: s.score, path: s.path, grain: s.grain }];
  });
}
