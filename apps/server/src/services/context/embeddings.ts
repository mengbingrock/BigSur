/** Rebuildable semantic index over canonical context documents. Original rows
 * remain authoritative. Chunk offsets permit exact reopening of long sources. */
import { snapshotHierarchy } from "../protocolHierarchy";
import { chunkProtocol } from "../artifactIndex/chunk";
import { getDb, type SqlDb } from "../db";
import {
  embedBatch,
  embedModel,
  resolveEmbedTarget,
  cosine,
  blobToVector,
  vectorToBlob,
} from "../artifactIndex/embed";
export function installContextEmbeddings(db: SqlDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS context_embedding_state(document_id INTEGER PRIMARY KEY,model TEXT NOT NULL,completed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS context_vectors(document_id INTEGER NOT NULL,chunk_idx INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(document_id,chunk_idx));
    CREATE INDEX IF NOT EXISTS context_vector_model ON context_vectors(model,document_id);
    CREATE TABLE IF NOT EXISTS context_vector_generation(email TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS context_vector_delete AFTER DELETE ON context_documents BEGIN
      DELETE FROM context_vectors WHERE document_id=old.id;
      DELETE FROM context_embedding_state WHERE document_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS context_vector_invalidate AFTER UPDATE ON context_documents WHEN old.content!=new.content OR old.email IS NOT new.email BEGIN
      DELETE FROM context_vectors WHERE document_id=old.id;
      DELETE FROM context_embedding_state WHERE document_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS context_vector_account_delete AFTER DELETE ON users BEGIN
      DELETE FROM context_vector_generation WHERE email=old.email;
    END;`);
  const columns = db.prepare("PRAGMA table_info(context_vectors)").all();
  if (!columns.some((c) => c.name === "node_id")) {
    db.exec("ALTER TABLE context_vectors ADD COLUMN node_id TEXT");
    db.exec(
      "DELETE FROM context_embedding_state WHERE document_id IN (SELECT id FROM context_documents WHERE kind='run'); DELETE FROM context_vectors WHERE document_id IN (SELECT id FROM context_documents WHERE kind='run')",
    );
  }
}
export function embeddingChunks(
  text: string,
): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < text.length; ) {
    const end = Math.min(start + 1800, text.length);
    out.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - 200;
  }
  return out;
}
export async function contextEmbeddingStatus(email: string) {
  const db = await getDb();
  const model = embedModel();
  const row = db
    .prepare(
      "SELECT COUNT(*) total,SUM(CASE WHEN s.model=? THEN 1 ELSE 0 END) embedded FROM context_documents d LEFT JOIN context_embedding_state s ON s.document_id=d.id WHERE d.email=?",
    )
    .get(model, email)!;
  const total = Number(row.total),
    embedded = Number(row.embedded ?? 0);
  const indexing = !!db
    .prepare("SELECT 1 FROM context_backfill WHERE complete=0 LIMIT 1")
    .get();
  return {
    model,
    total,
    embedded,
    pending: total - embedded,
    indexing,
    available: !!(await resolveEmbedTarget(email)),
    ready: !indexing && total === embedded,
  };
}
const builds = new Map<
  string,
  Promise<
    Awaited<ReturnType<typeof contextEmbeddingStatus>> & { built: number }
  >
>();
/** A bounded, restartable build batch. Failed or changed documents remain pending. */
export function buildContextEmbeddings(email: string, limit = 20) {
  const pending = builds.get(email);
  if (pending) return pending;
  const work = (async () => {
    const db = await getDb();
    const target = await resolveEmbedTarget(email);
    const model = embedModel();
    if (!target) return { ...(await contextEmbeddingStatus(email)), built: 0 };
    const rows = db
      .prepare(
        "SELECT d.* FROM context_documents d LEFT JOIN context_embedding_state s ON s.document_id=d.id WHERE d.email=? AND (s.document_id IS NULL OR s.model!=?) ORDER BY d.id LIMIT ?",
      )
      .all(email, model, Math.max(1, Math.min(limit, 50)));
    let built = 0;
    for (const row of rows) {
      const run =
        row.kind === "run"
          ? db
              .prepare(
                "SELECT snapshot,protocol_name FROM protocol_runs WHERE id=? AND email=?",
              )
              .get(row.entity_id, email)
          : null;
      const chunks: Array<{
        start: number;
        end: number;
        text: string;
        nodeId?: string;
      }> = run
        ? chunkProtocol({
            name: String(run.protocol_name),
            description: "Frozen protocol revision",
            body: "",
            hierarchy: snapshotHierarchy(JSON.parse(String(run.snapshot))),
          }).map((c) => ({
            start: 0,
            end: String(row.content).length,
            text: `${run.protocol_name} — ${c.heading} — ${c.path}\n${c.text}`,
            nodeId: `${c.grain}:${c.path}`,
          }))
        : embeddingChunks(String(row.content));
      const vectors: Float32Array[] = [];
      for (let start = 0; start < chunks.length; start += 32)
        vectors.push(
          ...(await embedBatch(
            chunks.slice(start, start + 32).map((c) => c.text),
            target,
          )),
        );
      if (
        vectors.some(
          (v) => !v?.length || [...v].some((n) => !Number.isFinite(n)),
        )
      )
        throw new Error("Embedding provider returned an invalid vector.");
      const current = db
        .prepare("SELECT content,email FROM context_documents WHERE id=?")
        .get(row.id);
      if (
        !current ||
        current.email !== email ||
        current.content !== row.content ||
        embedModel() !== model
      )
        continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM context_vectors WHERE document_id=?").run(
          row.id,
        );
        const insert = db.prepare(
          "INSERT INTO context_vectors(document_id,chunk_idx,start_offset,end_offset,model,dimensions,vector,node_id) VALUES(?,?,?,?,?,?,?,?)",
        );
        chunks.forEach((c, i) =>
          insert.run(
            row.id,
            i,
            c.start,
            c.end,
            model,
            vectors[i]!.length,
            vectorToBlob(vectors[i]!),
            c.nodeId ?? null,
          ),
        );
        db.prepare(
          "INSERT INTO context_embedding_state VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET model=excluded.model,completed_at=excluded.completed_at",
        ).run(row.id, model, new Date().toISOString());
        db.prepare(
          "INSERT INTO context_vector_generation VALUES(?,1) ON CONFLICT(email) DO UPDATE SET value=value+1",
        ).run(email);
        db.exec("COMMIT");
        built++;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    return { ...(await contextEmbeddingStatus(email)), built };
  })().finally(() => builds.delete(email));
  builds.set(email, work);
  return work;
}
export async function semanticCandidates(
  email: string,
  query: string,
  where: string,
  args: unknown[],
  join: string,
) {
  const db = await getDb();
  const target = await resolveEmbedTarget(email);
  if (!target) return null;
  const model = embedModel();
  const vector = (await embedBatch([query], target))[0];
  if (!vector?.length || [...vector].some((n) => !Number.isFinite(n)))
    throw new Error("Query embedding missing or invalid.");
  const scores = new Map<
    number,
    { id: number; score: number; offset: number; nodeId?: string }
  >();
  // Scan in pages across the entire authorized corpus. No lexical prefilter:
  // a synonymous query can retrieve a document sharing no literal words.
  let afterDoc = 0,
    afterChunk = -1;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT v.document_id,v.chunk_idx,v.start_offset,v.vector,v.node_id FROM context_vectors v JOIN context_documents d ON d.id=v.document_id ${join} WHERE ${where} AND v.model=? AND v.dimensions=? AND (v.document_id>? OR (v.document_id=? AND v.chunk_idx>?)) ORDER BY v.document_id,v.chunk_idx LIMIT 256`,
      )
      .all(...args, model, vector.length, afterDoc, afterDoc, afterChunk);
    if (!rows.length) break;
    for (const r of rows) {
      const score = cosine(vector, blobToVector(r.vector as Uint8Array));
      const id = Number(r.document_id);
      if (score > (scores.get(id)?.score ?? -Infinity))
        scores.set(id, {
          id,
          score,
          offset: Number(r.start_offset),
          ...(r.node_id ? { nodeId: String(r.node_id) } : {}),
        });
    }
    const last = rows.at(-1)!;
    afterDoc = Number(last.document_id);
    afterChunk = Number(last.chunk_idx);
  }
  const version = `${model}:${db.prepare("SELECT value FROM context_vector_generation WHERE email=?").get(email)?.value ?? 0}`;
  return {
    version,
    hits: [...scores.values()].toSorted(
      (a, b) => b.score - a.score || a.id - b.id,
    ),
  };
}
