// The artifact retrieval index: keeping embeddings in step with the files, and
// answering queries from them.
//
// Indexing is incremental and never blocks a request for more than the work of
// hashing. A single in-process worker embeds one artifact at a time; anything
// queued twice before the worker reaches it is embedded once. Artifacts edited
// on disk outside the app (which `_public` always is) are picked up by the
// reconcile pass that the search and status endpoints run.
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
import { chunkArtifact, embeddingText } from "./chunk";

/** What identifies a version of an artifact for indexing purposes. */
function contentHash(s: Skill): string {
  return createHash("sha256")
    .update(`${s.name}\u0000${s.description}\u0000${s.body}`)
    .digest("hex");
}

// ---------- in-memory vector cache ------------------------------------------

interface CachedChunk {
  sourcePath: string;
  idx: number;
  heading: string;
  text: string;
  vector: Float32Array;
}

let cache: CachedChunk[] | null = null;
let cacheModel = "";

function invalidateCache(): void {
  cache = null;
}

async function loadChunks(): Promise<CachedChunk[]> {
  if (cache && cacheModel === embedModel()) return cache;
  const db = await getDb();
  const rows = db
    .prepare(
      "SELECT c.source_path AS source_path, c.idx AS idx, c.heading AS heading, " +
        "c.text AS text, c.vector AS vector FROM artifact_chunks c " +
        "JOIN artifact_index i ON i.source_path = c.source_path WHERE i.model = ?",
    )
    .all(embedModel()) as Array<Record<string, unknown>>;
  cache = rows.map((r) => ({
    sourcePath: String(r.source_path),
    idx: Number(r.idx),
    heading: String(r.heading ?? ""),
    text: String(r.text ?? ""),
    vector: blobToVector(r.vector as Uint8Array),
  }));
  cacheModel = embedModel();
  return cache;
}

// ---------- the queue --------------------------------------------------------

/** Artifact directories awaiting embedding. */
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

/** Hash every visible artifact and queue the ones whose row is missing, stale,
 *  or built with a different model. Cheap: reads files already on disk. */
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
    if (!row || row.model !== model || row.content_hash !== contentHash(s)) {
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
      db.prepare("DELETE FROM artifact_chunks WHERE source_path = ?").run(sp);
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
 *  a SKILL.md in it; a protocol is a plain document file. The check used to
 *  look only for `<path>/SKILL.md`, which no document can satisfy — so every
 *  protocol's row was judged dead and deleted on each reconcile, then queued
 *  and re-embedded on the next, forever. The library looked permanently
 *  half-indexed and paid for the other half on every pass. */
function artifactExists(sourcePath: string): boolean {
  try {
    const st = fs.statSync(sourcePath);
    if (st.isFile()) return true;
    return st.isDirectory() && fs.existsSync(path.join(sourcePath, "SKILL.md"));
  } catch {
    return false;
  }
}

/** Embed one artifact and replace its rows. */
async function indexOne(skill: Skill, target: EmbedTarget): Promise<void> {
  const chunks = chunkArtifact(skill.body);
  const db = await getDb();
  if (chunks.length === 0) {
    // Nothing to embed (an empty body). Record the hash so it is not retried
    // on every pass.
    db.prepare("DELETE FROM artifact_chunks WHERE source_path = ?").run(indexKey(skill));
    db.prepare(
      "INSERT INTO artifact_index (source_path, slug, content_hash, model, chunk_count, indexed_at) " +
        "VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(source_path) DO UPDATE SET slug = excluded.slug, " +
        "content_hash = excluded.content_hash, model = excluded.model, chunk_count = 0, " +
        "indexed_at = excluded.indexed_at",
    ).run(indexKey(skill), skill.slug, contentHash(skill), embedModel(), new Date().toISOString());
    return;
  }
  const vectors = await embedBatch(
    chunks.map((c) => embeddingText(skill.name, c.heading, c.text)),
    target,
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM artifact_chunks WHERE source_path = ?").run(indexKey(skill));
    const insert = db.prepare(
      "INSERT INTO artifact_chunks (source_path, idx, heading, text, vector) VALUES (?, ?, ?, ?, ?)",
    );
    chunks.forEach((c, i) => {
      insert.run(indexKey(skill), i, c.heading, c.text, vectorToBlob(vectors[i]!));
    });
    db.prepare(
      "INSERT INTO artifact_index (source_path, slug, content_hash, model, chunk_count, indexed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_path) DO UPDATE SET slug = excluded.slug, " +
        "content_hash = excluded.content_hash, model = excluded.model, " +
        "chunk_count = excluded.chunk_count, indexed_at = excluded.indexed_at",
    ).run(indexKey(skill), skill.slug, contentHash(skill), embedModel(), chunks.length, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  invalidateCache();
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
        // Leave it unindexed; the next reconcile re-queues it. Stop the pass
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

/** Drop every row and re-embed from scratch. */
export async function rebuild(email?: string): Promise<{ queued: number }> {
  const db = await getDb();
  db.exec("DELETE FROM artifact_chunks");
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

/**
 * Semantic retrieval over the artifacts visible to `email`.
 *
 * Chunks are scored by cosine; a protocol takes its best chunk's score, plus a
 * small bonus for matching in several places, plus a boost when an identifier
 * in the query appears verbatim. Returns null when no credential is available
 * so the caller can fall back to lexical search.
 */
export async function retrieve(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number },
): Promise<RetrievalHit[] | null> {
  const q = query.trim();
  if (!q) return [];
  const target = await resolveEmbedTarget(email);
  if (!target) return null;

  const [queryVector] = await embedBatch([q], target);
  if (!queryVector) return null;

  const visible = new Map(
    getAllSkills(email)
      .filter((s) => !opts?.kind || s.artifactKind === opts.kind)
      .map((s) => [indexKey(s), s]),
  );
  const chunks = (await loadChunks()).filter((c) => visible.has(c.sourcePath));

  // Best chunk per artifact, plus how many chunks cleared the "related" bar.
  const best = new Map<string, { chunk: CachedChunk; score: number; supporting: number }>();
  for (const c of chunks) {
    const score = cosine(queryVector, c.vector);
    const cur = best.get(c.sourcePath);
    const supporting = (cur?.supporting ?? 0) + (score > 0.5 ? 1 : 0);
    if (!cur || score > cur.score) best.set(c.sourcePath, { chunk: c, score, supporting });
    else cur.supporting = supporting;
  }

  const ids = identifierTokens(q);
  const scored = [...best.entries()].map(([sourcePath, v]) => {
    const skill = visible.get(sourcePath)!;
    let score = v.score;
    // Several matching passages beat one, but only a little.
    score += Math.min(3, Math.max(0, v.supporting - 1)) * 0.02;
    if (ids.length > 0) {
      const hay = `${skill.name}\n${skill.description}\n${skill.body}`.toLowerCase();
      if (ids.some((t) => hay.includes(t))) score += 0.15;
    }
    return {
      slug: skill.slug,
      score,
      heading: v.chunk.heading,
      snippet: snippetOf(v.chunk.text, q),
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(opts?.limit ?? 20, 1), 100));
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
  const sums = new Map<string, { v: Float32Array; n: number }>();
  for (const c of await loadChunks()) {
    if (!visible.has(c.sourcePath)) continue;
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
}

/**
 * Top chunks for a query, ungrouped. Search wants one row per protocol;
 * Ask wants passages, and more than one from the same protocol is normal when
 * an answer spans two sections. Returns null when no credential resolves.
 */
export async function retrievePassages(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number },
): Promise<Passage[] | null> {
  const q = query.trim();
  if (!q) return [];
  const target = await resolveEmbedTarget(email);
  if (!target) return null;
  const [queryVector] = await embedBatch([q], target);
  if (!queryVector) return null;

  const visible = new Map(
    getAllSkills(email)
      .filter((s) => !opts?.kind || s.artifactKind === opts.kind)
      .map((s) => [indexKey(s), s]),
  );
  const scored: Passage[] = [];
  for (const c of await loadChunks()) {
    const skill = visible.get(c.sourcePath);
    if (!skill) continue;
    scored.push({
      slug: skill.slug,
      name: skill.name,
      heading: c.heading,
      text: c.text,
      score: cosine(queryVector, c.vector),
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(opts?.limit ?? 8, 1), 30));
}
