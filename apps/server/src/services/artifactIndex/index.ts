// The artifact retrieval index: keeping chunks, their words and their
// embeddings in step with the files, and answering queries from them.
//
// Two indexes over the same chunks:
//   - full-text (FTS5, BM25) — written the moment an artifact is seen, with no
//     credential needed, so search by words works on a cold library and a
//     parameter like "16,000 g" or "pUC19" is found exactly;
//   - embeddings — filled in by a background worker that embeds one artifact
//     at a time; anything queued twice before the worker reaches it is
//     embedded once.
// A query uses both when it can (hybrid) and the words alone when it must.
// Artifacts edited on disk outside the app are picked up by the reconcile pass
// that the search and status endpoints run.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Skill } from "@labee/contracts";
import { getDb } from "../db";
import { getAllSkills } from "../skills";
import {
  blobToVector,
  cosine,
  normalise,
  embedBatch,
  embedModel,
  resolveEmbedTarget,
  vectorToBlob,
  type EmbedTarget,
} from "./embed";
import { chunkArtifact, chunkProtocol, embeddingText, summaryText, type Chunk, type Grain } from "./chunk";

/** What identifies a version of an artifact for indexing purposes. The
 *  purpose-layer fields are part of it: they feed the summary chunk. */
function contentHash(s: Skill): string {
  return createHash("sha256")
    .update(
      [s.name, s.description, s.body, s.problem ?? "", s.method ?? "", s.application ?? "",
        (s.domains ?? []).join(","), (s.keywords ?? []).join(",")].join("\u0000"),
    )
    .digest("hex");
}

/** Chunks for an artifact: three grains for a protocol; for a skill, its
 *  sections plus a summary of name and description, so a skill is found by
 *  its name with words alone. */
function chunksFor(s: Skill): Chunk[] {
  if (s.artifactKind !== "protocol") {
    return [
      { heading: "", text: summaryText({ name: s.name, description: s.description, body: "" }), grain: "summary", path: "" },
      ...chunkArtifact(s.body),
    ];
  }
  return chunkProtocol({
    name: s.name,
    description: s.description,
    body: s.body,
    problem: s.problem,
    method: s.method,
    application: s.application,
    domains: s.domains,
    keywords: s.keywords,
  });
}

// ---------- in-memory chunk cache -------------------------------------------

interface CachedChunk {
  sourcePath: string;
  idx: number;
  heading: string;
  text: string;
  grain: Grain;
  path: string;
  /** Null until embedded with the current model. */
  vector: Float32Array | null;
}

let cache: CachedChunk[] | null = null;
let cacheModel = "";

function invalidateCache(): void {
  cache = null;
}

async function loadChunks(): Promise<CachedChunk[]> {
  if (cache && cacheModel === embedModel()) return cache;
  const db = await getDb();
  const model = embedModel();
  const rows = db
    .prepare(
      "SELECT c.source_path AS source_path, c.idx AS idx, c.heading AS heading, c.text AS text, " +
        "c.grain AS grain, c.path AS path, c.vector AS vector, i.model AS model " +
        "FROM artifact_chunks c JOIN artifact_index i ON i.source_path = c.source_path",
    )
    .all() as Array<Record<string, unknown>>;
  cache = rows.map((r) => {
    const blob = r.vector as Uint8Array | null;
    const embedded = String(r.model ?? "") === model && blob && blob.byteLength > 0;
    return {
      sourcePath: String(r.source_path),
      idx: Number(r.idx),
      heading: String(r.heading ?? ""),
      text: String(r.text ?? ""),
      grain: (String(r.grain ?? "section") as Grain) ?? "section",
      path: String(r.path ?? ""),
      vector: embedded ? blobToVector(blob) : null,
    };
  });
  cacheModel = model;
  return cache;
}

// ---------- writing rows -------------------------------------------------------

type Db = Awaited<ReturnType<typeof getDb>>;

function deleteRows(db: Db, sourcePath: string): void {
  db.prepare("DELETE FROM artifact_chunks WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM artifact_chunks_fts WHERE source_path = ?").run(sourcePath);
}

/** Write an artifact's chunks and words. Vectors are what the caller has —
 *  none for a text-only pass, one per chunk after embedding. */
function writeRows(db: Db, skill: Skill, chunks: readonly Chunk[], vectors: readonly Float32Array[] | null, model: string): void {
  const key = indexKey(skill);
  db.exec("BEGIN");
  try {
    deleteRows(db, key);
    const insert = db.prepare(
      "INSERT INTO artifact_chunks (source_path, idx, heading, text, grain, path, vector) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFts = db.prepare(
      "INSERT INTO artifact_chunks_fts (source_path, idx, heading, text) VALUES (?, ?, ?, ?)",
    );
    chunks.forEach((c, i) => {
      const vec = vectors ? vectorToBlob(vectors[i]!) : new Uint8Array(0);
      insert.run(key, i, c.heading, c.text, c.grain, c.path, vec);
      insertFts.run(key, i, c.heading, c.text);
    });
    db.prepare(
      "INSERT INTO artifact_index (source_path, slug, content_hash, model, chunk_count, indexed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_path) DO UPDATE SET slug = excluded.slug, " +
        "content_hash = excluded.content_hash, model = excluded.model, " +
        "chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at",
    ).run(key, skill.slug, contentHash(skill), model, chunks.length, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  invalidateCache();
}

/** Text-only pass: the chunks and their words, no vectors. Instant, needs no
 *  credential, and makes the artifact searchable by its words right away.
 *  The model column is left empty, which is what marks it as still to embed. */
function indexText(db: Db, skill: Skill): void {
  writeRows(db, skill, chunksFor(skill), null, "");
}

// ---------- the queue --------------------------------------------------------

/** Artifact keys awaiting embedding. */
const pending = new Set<string>();
let running = false;
/** Set when a pass could not get a credential, so callers can say why the
 *  index is empty rather than looking broken. */
let lastError: string | null = null;

/** Queue artifacts for re-embedding, by slug, resolved against `email`'s view. */
export function enqueueArtifacts(slugs: readonly string[], email?: string): void {
  const visible = getAllSkills(email);
  for (const slug of slugs) {
    const hit = visible.find((s) => s.slug === slug);
    if (hit) pending.add(indexKey(hit));
  }
}

/** Hash every visible artifact; write the words of any whose text is new or
 *  changed, and queue for embedding any whose vectors are missing, stale, or
 *  built with a different model. Cheap: reads files already on disk. */
export async function reconcile(email?: string): Promise<{ queued: number; total: number }> {
  const skills = getAllSkills(email);
  const db = await getDb();
  const rows = db
    .prepare("SELECT source_path, content_hash, model FROM artifact_index")
    .all() as Array<{ source_path: string; content_hash: string; model: string }>;
  const known = new Map(rows.map((r) => [r.source_path, r]));
  const model = embedModel();
  let queued = 0;
  for (const s of skills) {
    const row = known.get(indexKey(s));
    const hash = contentHash(s);
    if (!row || row.content_hash !== hash) indexText(db, s);
    if (!row || row.model !== model || row.content_hash !== hash) {
      pending.add(indexKey(s));
      queued += 1;
    }
  }
  // Drop rows whose artifact is gone. Judged by the filesystem, never by this
  // caller's visibility — another account's artifact is invisible here but
  // very much still indexed.
  const dead = rows.map((r) => r.source_path).filter((p) => !artifactExists(p));
  if (dead.length > 0) {
    for (const sp of dead) {
      deleteRows(db, sp);
      db.prepare("DELETE FROM artifact_index WHERE source_path = ?").run(sp);
    }
    invalidateCache();
  }
  return { queued, total: skills.length };
}

/** What an artifact is keyed by in the index. A skill is its folder; a
 *  protocol is its document file. Keying a document by its folder — which is
 *  what `sourcePath` holds for it — made every document in one folder share a
 *  single row, each overwriting the last, so search returned one protocol's
 *  text for all of its neighbours. */
export function indexKey(s: Skill): string {
  return s.artifactFile ?? s.sourcePath;
}

/** Is there still an artifact at this source path? A skill is a folder with
 *  a SKILL.md in it; a protocol is a plain document file. */
function artifactExists(sourcePath: string): boolean {
  try {
    const st = fs.statSync(sourcePath);
    if (st.isFile()) return true;
    return st.isDirectory() && fs.existsSync(path.join(sourcePath, "SKILL.md"));
  } catch {
    return false;
  }
}

/** Embed one artifact and replace its rows with vectored ones. */
async function indexOne(skill: Skill, target: EmbedTarget): Promise<void> {
  const chunks = chunksFor(skill);
  const db = await getDb();
  if (chunks.length === 0) {
    // Nothing to embed (an empty body). Record the hash so it is not retried
    // on every pass.
    writeRows(db, skill, [], [], embedModel());
    return;
  }
  const vectors = await embedBatch(
    chunks.map((c) => embeddingText(skill.name, c.heading, c.text, c.grain, c.path)),
    target,
  );
  writeRows(db, skill, chunks, vectors, embedModel());
}

/** Drain the queue. Safe to call concurrently: only one drain runs. Resolves
 *  when the queue is empty or no credential is available. */
export async function drain(email?: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const target = await resolveEmbedTarget(email);
    if (!target) {
      lastError = "No embedding credential available.";
      return;
    }
    lastError = null;
    while (pending.size > 0) {
      const sourcePath = pending.values().next().value as string;
      pending.delete(sourcePath);
      const skill = getAllSkills(email).find((s) => indexKey(s) === sourcePath);
      if (!skill) continue;
      try {
        await indexOne(skill, target);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        // Leave it unembedded; the next reconcile re-queues it. Stop the pass
        // so a provider outage does not burn through the whole library.
        return;
      }
    }
  } finally {
    running = false;
  }
}

/** Reconcile, then drain in the background. Callers that need results now
 *  (the first search on a cold index) can await the returned promise. */
export async function ensureIndexed(email?: string): Promise<void> {
  await reconcile(email);
  await drain(email);
}

export interface IndexStatus {
  total: number;
  indexed: number;
  pending: number;
  model: string;
  /** False when no credential resolves — the caller should say search is lexical. */
  available: boolean;
  error: string | null;
}

export async function indexStatus(email?: string): Promise<IndexStatus> {
  const skills = getAllSkills(email);
  const db = await getDb();
  const model = embedModel();
  const rows = db
    .prepare("SELECT source_path FROM artifact_index WHERE model = ?")
    .all(model) as Array<{ source_path: string }>;
  const indexed = new Set(rows.map((r) => r.source_path));
  const target = await resolveEmbedTarget(email);
  return {
    total: skills.length,
    indexed: skills.filter((s) => indexed.has(indexKey(s))).length,
    pending: pending.size,
    model,
    available: Boolean(target),
    error: lastError,
  };
}

/** Drop one artifact's rows right now — called when it is deleted, so search
 *  stops returning it immediately rather than at the next reconcile. */
export async function forgetArtifact(key: string): Promise<void> {
  const db = await getDb();
  deleteRows(db, key);
  db.prepare("DELETE FROM artifact_index WHERE source_path = ?").run(key);
  pending.delete(key);
  invalidateCache();
}

/** Drop every row and re-embed from scratch. */
export async function rebuild(email?: string): Promise<{ queued: number }> {
  const db = await getDb();
  db.exec("DELETE FROM artifact_chunks");
  db.exec("DELETE FROM artifact_chunks_fts");
  db.exec("DELETE FROM artifact_index");
  invalidateCache();
  const { queued } = await reconcile(email);
  await drain(email);
  return { queued };
}

// ---------- retrieval ---------------------------------------------------------

export interface RetrievalHit {
  slug: string;
  score: number;
  heading: string;
  snippet: string;
  /** Tree path of the chunk that matched ("2.3" for a step, "2" for a section). */
  path: string;
  grain: Grain;
}

export type SearchMode = "semantic" | "lexical";

/** A number on its own or with a unit — "50 C", "16,000 g", "0.2-0.5", "25%".
 *  Not a digit inside a name: "3D", "HEK293T", "pUC19", "T4" are identifiers,
 *  and a question that contains one is not thereby about a quantity. */
const QUANTITY =
  /(?:^|[\s(])\d+(?:[.,]\d+)?(?:\s?(?:-|to)\s?\d+(?:[.,]\d+)?)?\s*(?:%|ul|µl|ml|l|ug|µg|mg|ng|g|mm|um|µm|nm|cm|kb|bp|mm|um|nm|m|c|°c|°|rpm|min|mins|minutes?|h|hrs?|hours?|s|secs?|seconds?|x|v|kda|od)?(?=[\s,.;:)?!]|$)/i;

/** Which grain a question is after. A quantity, or a question about one,
 *  wants a step; a how-to wants a section; otherwise no preference. */
export function queryGrain(q: string): Grain | "any" {
  const s = q.toLowerCase();
  if (
    QUANTITY.test(s) ||
    /\b(how (long|much|many|hot|cold|fast|often)|what (temperature|temp|concentration|volume|speed|time|ratio|percent|percentage|dilution|od600|ph))\b/.test(s) ||
    /\b(rpm|mm|um|ul|ml|ug|ng|mg|nm|kb|bp|°c|degrees?|minutes?|hours?|seconds?|mins?|secs?)\b/.test(s)
  ) {
    return "step";
  }
  if (/\b(how (do|to|should|can) (i|we|you)|how to|walk me|step by step|steps|procedure|protocol for|adapt|plan|set ?up|prepare|make|perform|run)\b/.test(s)) {
    return "section";
  }
  return "any";
}

/** Tokens worth an exact-match boost: identifiers embeddings are weak on —
 *  anything containing a digit, or written in caps. "pUC19", "TAE", "16,000". */
function identifierTokens(q: string): string[] {
  return q
    .split(/[^A-Za-z0-9._-]+/)
    .filter((t) => t.length >= 2 && (/\d/.test(t) || (t === t.toUpperCase() && /[A-Z]/.test(t))))
    .map((t) => t.toLowerCase());
}

/** ~240 characters of the chunk centred on the densest run of query words. */
function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 240) return flat;
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const hay = flat.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < flat.length - 120; i += 40) {
    const window = hay.slice(i, i + 240);
    const score = words.reduce((n, w) => n + (window.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const start = Math.max(0, best);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 240).trim()}…`;
}

/** An FTS5 MATCH expression: every word of the query, quoted, OR-ed. Any word
 *  can match; BM25 does the ranking. Empty when the query has no words. */
function ftsExpression(q: string): string {
  const words = q
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  return [...new Set(words)].map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

const chunkKey = (sourcePath: string, idx: number) => `${sourcePath}\u0000${idx}`;

/** BM25 scores by chunk, normalised to 0..1 (best = 1). FTS5's bm25() is
 *  negative and lower is better; heading words count double. */
async function lexicalScores(q: string, limit = 300): Promise<Map<string, number>> {
  const expr = ftsExpression(q);
  const out = new Map<string, number>();
  if (!expr) return out;
  const db = await getDb();
  let rows: Array<{ source_path: string; idx: number; s: number }>;
  try {
    rows = db
      .prepare(
        "SELECT source_path, idx, bm25(artifact_chunks_fts, 0, 0, 2.0, 1.0) AS s " +
          "FROM artifact_chunks_fts WHERE artifact_chunks_fts MATCH ? ORDER BY s LIMIT ?",
      )
      .all(expr, limit) as Array<{ source_path: string; idx: number; s: number }>;
  } catch {
    // A query FTS5 cannot parse (unbalanced quotes it was handed, say) is not
    // worth failing a search over; the dense side still answers.
    return out;
  }
  if (rows.length === 0) return out;
  const best = -Number(rows[0]!.s) || 1;
  for (const r of rows) out.set(chunkKey(String(r.source_path), Number(r.idx)), Math.max(0, -Number(r.s)) / best);
  return out;
}

/** How much the words contribute beside the embedding when both are present.
 *  Enough to break a near-tie on an exact term, not enough to let a chunk
 *  that merely repeats a common word outrank a semantic match. */
const LEXICAL_WEIGHT = 0.25;
/** A small nudge for chunks of the grain the question is after. */
const GRAIN_BONUS = 0.05;

interface ScoredChunk {
  chunk: CachedChunk;
  score: number;
  /** True when the chunk cleared the "related" bar on either signal. */
  related: boolean;
}

/** Score every visible chunk against the query, by embedding and/or words.
 *  Returns null when there is nothing to search — no chunks at all. */
async function scoreChunks(
  q: string,
  email: string | undefined,
  opts: { kind?: "skill" | "protocol"; grain?: Grain | "any" },
): Promise<{ scored: ScoredChunk[]; mode: SearchMode; visible: Map<string, Skill> } | null> {
  const visible = new Map(
    getAllSkills(email)
      .filter((s) => !opts.kind || s.artifactKind === opts.kind)
      .map((s) => [indexKey(s), s]),
  );
  const chunks = (await loadChunks()).filter((c) => visible.has(c.sourcePath));
  if (chunks.length === 0) return null;

  const target = await resolveEmbedTarget(email);
  const queryVector = target ? (await embedBatch([q], target))[0] ?? null : null;
  const dense = queryVector !== null && chunks.some((c) => c.vector);
  const lexical = await lexicalScores(q);
  const want = opts.grain ?? queryGrain(q);

  const scored: ScoredChunk[] = chunks.map((c) => {
    const bm = lexical.get(chunkKey(c.sourcePath, c.idx)) ?? 0;
    const cos = dense && c.vector && queryVector ? cosine(queryVector, c.vector) : null;
    let score = cos !== null ? cos + LEXICAL_WEIGHT * bm : bm;
    // The grain the question is after moves up; for a how-to the summary
    // moves down too, since it is about the whole protocol and otherwise
    // outranks the section that actually says how.
    if (want !== "any" && c.grain === want) score += GRAIN_BONUS;
    if (want === "section" && c.grain === "summary") score -= GRAIN_BONUS;
    return { chunk: c, score, related: (cos ?? 0) > 0.5 || bm > 0.5 };
  });
  return { scored, mode: dense ? "semantic" : "lexical", visible };
}

/**
 * Search the artifacts visible to `email`: one row per artifact, ranked by
 * its best chunk — embedding similarity plus a share of BM25 when a credential
 * is available, BM25 alone when not — with a small bonus for matching in
 * several places and a boost when an identifier in the query appears verbatim.
 * Returns null when nothing is indexed at all, so the caller can fall back to
 * a plain substring scan.
 */
export async function search(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number; grain?: Grain | "any" },
): Promise<{ mode: SearchMode; hits: RetrievalHit[] } | null> {
  const q = query.trim();
  if (!q) return { mode: "lexical", hits: [] };
  const result = await scoreChunks(q, email, { ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.grain ? { grain: opts.grain } : {}) });
  if (!result) return null;
  const { scored, mode, visible } = result;
  const want = opts?.grain ?? queryGrain(q);

  // Per artifact: the best chunk of any grain decides the rank — the summary
  // is allowed to find the protocol — while the best chunk of the grain the
  // question asked for is what the hit shows, so a how-to lands on the
  // section that says how and a parameter question on the step that holds
  // the number. Plus how many chunks cleared the "related" bar.
  interface Best {
    any: ScoredChunk;
    wanted: ScoredChunk | null;
    supporting: number;
  }
  const best = new Map<string, Best>();
  for (const s of scored) {
    const cur = best.get(s.chunk.sourcePath);
    const isWanted = want !== "any" && s.chunk.grain === want;
    if (!cur) {
      best.set(s.chunk.sourcePath, { any: s, wanted: isWanted ? s : null, supporting: s.related ? 1 : 0 });
      continue;
    }
    cur.supporting += s.related ? 1 : 0;
    if (s.score > cur.any.score) cur.any = s;
    if (isWanted && (!cur.wanted || s.score > cur.wanted.score)) cur.wanted = s;
  }

  const ids = identifierTokens(q);
  const hits = [...best.entries()]
    .filter(([, v]) => v.any.score > 0)
    .map(([sourcePath, v]) => {
      const skill = visible.get(sourcePath)!;
      let score = v.any.score;
      // Several matching passages beat one, but only a little.
      score += Math.min(3, Math.max(0, v.supporting - 1)) * 0.02;
      if (ids.length > 0) {
        const hay = `${skill.name}\n${skill.description}\n${skill.body}`.toLowerCase();
        if (ids.some((t) => hay.includes(t))) score += 0.15;
      }
      const shown = (v.wanted && v.wanted.score > 0 ? v.wanted : v.any).chunk;
      return {
        slug: skill.slug,
        score,
        heading: shown.heading,
        snippet: snippetOf(shown.text, q),
        path: shown.path,
        grain: shown.grain,
      };
    });

  return {
    mode,
    hits: hits.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(opts?.limit ?? 20, 1), 100)),
  };
}

/** Semantic-only retrieval, kept for callers that want the old contract:
 *  null when no embedding credential is available. */
export async function retrieve(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number },
): Promise<RetrievalHit[] | null> {
  const target = await resolveEmbedTarget(email);
  if (!target) return null;
  const r = await search(query, email, opts);
  return r ? r.hits : [];
}

/** One unit vector per indexed artifact: the mean of its chunk vectors. Used
 *  by the categorisation agent for centroids and clustering. Keyed by the
 *  artifact directory, like the index itself. */
export async function artifactVectors(
  email?: string,
  opts?: { kind?: "skill" | "protocol" },
): Promise<Map<string, Float32Array>> {
  const visible = new Set(
    getAllSkills(email)
      .filter((s) => !opts?.kind || s.artifactKind === opts.kind)
      .map((s) => indexKey(s)),
  );
  // Section chunks only: that is the artifact's content, which is what a
  // category is about. The summary and the steps would pull every centroid
  // towards the same few words ("protocol", "incubate", "add").
  const sums = new Map<string, { v: Float32Array; n: number }>();
  for (const c of await loadChunks()) {
    if (!visible.has(c.sourcePath) || !c.vector || c.grain !== "section") continue;
    const cur = sums.get(c.sourcePath);
    if (!cur) {
      sums.set(c.sourcePath, { v: Float32Array.from(c.vector), n: 1 });
      continue;
    }
    for (let i = 0; i < cur.v.length; i++) cur.v[i] = (cur.v[i] ?? 0) + (c.vector[i] ?? 0);
    cur.n += 1;
  }
  const out = new Map<string, Float32Array>();
  for (const [sp, { v }] of sums) out.set(sp, normalise(v));
  return out;
}

export interface Passage {
  slug: string;
  name: string;
  heading: string;
  /** The whole chunk, not a snippet — this is what the model reads. */
  text: string;
  score: number;
  path: string;
  grain: Grain;
}

/**
 * Top chunks for a query, ungrouped. Search wants one row per protocol;
 * Ask wants passages, and more than one from the same protocol is normal when
 * an answer spans two sections. Hybrid like search; null when nothing is
 * indexed.
 */
export async function retrievePassages(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number; grain?: Grain | "any" },
): Promise<Passage[] | null> {
  const q = query.trim();
  if (!q) return [];
  const result = await scoreChunks(q, email, { ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.grain ? { grain: opts.grain } : {}) });
  if (!result) return null;
  const { scored, visible } = result;
  return scored
    .filter((s) => s.score > 0)
    .map((s) => {
      const skill = visible.get(s.chunk.sourcePath)!;
      return {
        slug: skill.slug,
        name: skill.name,
        heading: s.chunk.heading,
        text: s.chunk.text,
        score: s.score,
        path: s.chunk.path,
        grain: s.chunk.grain,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(opts?.limit ?? 8, 1), 30));
}
