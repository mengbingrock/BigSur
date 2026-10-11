// The shared protocol library's store on the box.
//
// Rows are written by an operator's ingest, never by a request. Each
// protocol's chunks and words are written with the row, at once and without
// a credential, so it is searchable by words the moment it lands; vectors are
// filled in by `embedLibraryPending` as a separate, resumable pass, because
// embedding thousands of protocols is a job, not a side effect.
import { createHash } from "node:crypto";
import { getDb } from "../db";
import { chunkProtocol, embeddingText, type Chunk, type Grain } from "../artifactIndex/chunk";
import { blobToVector, embedBatch, embedModel, vectorToBlob, type EmbedTarget } from "../artifactIndex/embed";

export interface LibraryRecord {
  /** "protocol-io:Protocol.io-0" — source-prefixed so ids never collide. */
  id: string;
  source: string;
  sourceUrl: string;
  doi?: string | undefined;
  license: string;
  title: string;
  description: string;
  category?: string | undefined;
  domains: string[];
  keywords: string[];
  problem?: string | undefined;
  method?: string | undefined;
  application?: string | undefined;
  /** Markdown body in Labee's format: sections and numbered steps. */
  body: string;
}

export interface LibraryRow extends LibraryRecord {
  contentHash: string;
  /** Embedding model the vectors were made with; "" while still to embed. */
  model: string;
  ingestedAt: string;
}

export interface LibraryChunk {
  protocolId: string;
  idx: number;
  heading: string;
  text: string;
  grain: Grain;
  path: string;
}

function contentHash(r: LibraryRecord): string {
  return createHash("sha256")
    .update([r.title, r.description, r.body, r.problem ?? "", r.method ?? "", r.application ?? "", r.domains.join(","), r.keywords.join(",")].join("\u0000"))
    .digest("hex");
}

function chunksFor(r: LibraryRecord): Chunk[] {
  return chunkProtocol({
    name: r.title,
    description: r.description,
    body: r.body,
    problem: r.problem,
    method: r.method,
    application: r.application,
    domains: r.domains,
    keywords: r.keywords,
  });
}

type Db = Awaited<ReturnType<typeof getDb>>;

function parseList(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRow(r: Record<string, unknown>): LibraryRow {
  return {
    id: String(r.id),
    source: String(r.source ?? ""),
    sourceUrl: String(r.source_url ?? ""),
    doi: r.doi ? String(r.doi) : undefined,
    license: String(r.license ?? ""),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    category: r.category ? String(r.category) : undefined,
    domains: parseList(r.domains),
    keywords: parseList(r.keywords),
    problem: r.problem ? String(r.problem) : undefined,
    method: r.method ? String(r.method) : undefined,
    application: r.application ? String(r.application) : undefined,
    body: String(r.body_md ?? ""),
    contentHash: String(r.content_hash ?? ""),
    model: String(r.model ?? ""),
    ingestedAt: String(r.ingested_at ?? ""),
  };
}

function writeChunks(db: Db, id: string, chunks: readonly Chunk[], vectors: readonly Float32Array[] | null): void {
  db.prepare("DELETE FROM library_chunks WHERE protocol_id = ?").run(id);
  db.prepare("DELETE FROM library_chunks_fts WHERE protocol_id = ?").run(id);
  const insert = db.prepare(
    "INSERT INTO library_chunks (protocol_id, idx, heading, text, grain, path, vector) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO library_chunks_fts (protocol_id, idx, heading, text) VALUES (?, ?, ?, ?)");
  chunks.forEach((c, i) => {
    insert.run(id, i, c.heading, c.text, c.grain, c.path, vectors ? vectorToBlob(vectors[i]!) : new Uint8Array(0));
    insertFts.run(id, i, c.heading, c.text);
  });
}

/**
 * Insert or update one protocol. Unchanged content is left alone (and keeps
 * its vectors); changed content is rewritten with its words and marked to
 * embed. Returns what happened.
 */
export async function upsertLibraryProtocol(r: LibraryRecord): Promise<"inserted" | "updated" | "unchanged"> {
  const db = await getDb();
  const hash = contentHash(r);
  const existing = db.prepare("SELECT content_hash FROM library_protocols WHERE id = ?").get(r.id) as { content_hash: string } | undefined;
  if (existing && existing.content_hash === hash) return "unchanged";
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO library_protocols (id, source, source_url, doi, license, title, description, category, domains, keywords, " +
        "problem, method, application, body_md, content_hash, model, ingested_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?) " +
        "ON CONFLICT(id) DO UPDATE SET source = excluded.source, source_url = excluded.source_url, doi = excluded.doi, " +
        "license = excluded.license, title = excluded.title, description = excluded.description, category = excluded.category, " +
        "domains = excluded.domains, keywords = excluded.keywords, problem = excluded.problem, method = excluded.method, " +
        "application = excluded.application, body_md = excluded.body_md, content_hash = excluded.content_hash, " +
        "model = '', ingested_at = excluded.ingested_at",
    ).run(
      r.id, r.source, r.sourceUrl, r.doi ?? null, r.license, r.title, r.description, r.category ?? null,
      JSON.stringify(r.domains), JSON.stringify(r.keywords), r.problem ?? null, r.method ?? null, r.application ?? null,
      r.body, hash, now,
    );
    writeChunks(db, r.id, chunksFor(r), null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return existing ? "updated" : "inserted";
}

export async function getLibraryProtocol(id: string): Promise<LibraryRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM library_protocols WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

export async function deleteLibraryProtocol(id: string): Promise<void> {
  const db = await getDb();
  db.prepare("DELETE FROM library_chunks WHERE protocol_id = ?").run(id);
  db.prepare("DELETE FROM library_chunks_fts WHERE protocol_id = ?").run(id);
  db.prepare("DELETE FROM library_protocols WHERE id = ?").run(id);
}

export interface LibraryStatus {
  total: number;
  /** Rows whose vectors were made with the current model. */
  embedded: number;
  model: string;
  sources: Array<{ source: string; count: number; license: string }>;
}

export async function libraryStatus(): Promise<LibraryStatus> {
  const db = await getDb();
  const model = embedModel();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM library_protocols").get() as { n: number }).n;
  const embedded = (db.prepare("SELECT COUNT(*) AS n FROM library_protocols WHERE model = ?").get(model) as { n: number }).n;
  const sources = db
    .prepare("SELECT source, license, COUNT(*) AS n FROM library_protocols GROUP BY source, license ORDER BY source")
    .all() as Array<{ source: string; license: string; n: number }>;
  return { total: Number(total), embedded: Number(embedded), model, sources: sources.map((s) => ({ source: s.source, license: s.license, count: Number(s.n) })) };
}

/**
 * Embed protocols whose vectors are missing or made with another model, a
 * few at a time. Safe to call repeatedly; each call does at most `limit`
 * protocols and returns how many it did, so an operator can run it until it
 * returns 0 and a provider outage costs one batch, not the job.
 */
export async function embedLibraryPending(target: EmbedTarget, opts: { limit?: number } = {}): Promise<number> {
  const db = await getDb();
  const model = embedModel();
  const limit = Math.max(1, opts.limit ?? 20);
  const rows = db
    .prepare("SELECT * FROM library_protocols WHERE model != ? ORDER BY ingested_at LIMIT ?")
    .all(model, limit) as Array<Record<string, unknown>>;
  let done = 0;
  for (const raw of rows) {
    const r = toRow(raw);
    const chunks = chunksFor(r);
    const vectors = chunks.length
      ? await embedBatch(chunks.map((c) => embeddingText(r.title, c.heading, c.text, c.grain, c.path)), target)
      : [];
    db.exec("BEGIN");
    try {
      writeChunks(db, r.id, chunks, vectors);
      db.prepare("UPDATE library_protocols SET model = ? WHERE id = ?").run(model, r.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    done += 1;
  }
  return done;
}

/** Chunks by (protocol, idx), with vectors when embedded with the current
 *  model. Used by search to score only the candidates the words found. */
export async function loadLibraryChunks(
  keys: ReadonlyArray<{ protocolId: string; idx: number }>,
): Promise<Array<LibraryChunk & { vector: Float32Array | null }>> {
  if (keys.length === 0) return [];
  const db = await getDb();
  const model = embedModel();
  const stmt = db.prepare(
    "SELECT c.protocol_id AS protocol_id, c.idx AS idx, c.heading AS heading, c.text AS text, c.grain AS grain, " +
      "c.path AS path, c.vector AS vector, p.model AS model FROM library_chunks c " +
      "JOIN library_protocols p ON p.id = c.protocol_id WHERE c.protocol_id = ? AND c.idx = ?",
  );
  const out: Array<LibraryChunk & { vector: Float32Array | null }> = [];
  for (const k of keys) {
    const r = stmt.get(k.protocolId, k.idx) as Record<string, unknown> | undefined;
    if (!r) continue;
    const blob = r.vector as Uint8Array | null;
    const embedded = String(r.model ?? "") === model && blob && blob.byteLength > 0;
    out.push({
      protocolId: String(r.protocol_id),
      idx: Number(r.idx),
      heading: String(r.heading ?? ""),
      text: String(r.text ?? ""),
      grain: String(r.grain ?? "section") as Grain,
      path: String(r.path ?? ""),
      vector: embedded ? blobToVector(blob) : null,
    });
  }
  return out;
}

/** Title, source and licence for a set of ids, for hits and citations. */
export async function libraryHeaders(ids: ReadonlyArray<string>): Promise<Map<string, Pick<LibraryRow, "id" | "title" | "source" | "sourceUrl" | "license" | "category">>> {
  const out = new Map<string, Pick<LibraryRow, "id" | "title" | "source" | "sourceUrl" | "license" | "category">>();
  if (ids.length === 0) return out;
  const db = await getDb();
  const stmt = db.prepare("SELECT id, title, source, source_url, license, category FROM library_protocols WHERE id = ?");
  for (const id of new Set(ids)) {
    const r = stmt.get(id) as Record<string, unknown> | undefined;
    if (r) {
      out.set(id, {
        id,
        title: String(r.title ?? ""),
        source: String(r.source ?? ""),
        sourceUrl: String(r.source_url ?? ""),
        license: String(r.license ?? ""),
        category: r.category ? String(r.category) : undefined,
      });
    }
  }
  return out;
}
