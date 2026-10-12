import { installContextEmbeddings } from "./embeddings";
import type { SqlDb } from "../db";

// Derived index only: every hit points back to an original row. SQL triggers
// update it in the source transaction, including writes from old code paths.
const sources = [
  [
    "chat_sessions",
    "session",
    `t.email, '' host_id, t.id entity_id, -1 ordinal, t.title content, t.created_at ts`,
  ],
  [
    "chat_session_messages",
    "message",
    `(SELECT email FROM chat_sessions WHERE id=t.session_id) email, '' host_id, t.session_id entity_id, t.idx ordinal, t.content, t.created_at ts`,
  ],
  [
    "chat_session_events",
    "event",
    `(SELECT email FROM chat_sessions WHERE id=t.session_id) email, '' host_id, t.session_id entity_id, t.seq ordinal, t.type || ' ' || t.data content, t.created_at ts`,
  ],
  [
    "mirror_sessions",
    "session",
    `t.email, t.host_id, t.id entity_id, -1 ordinal, COALESCE(json_extract(t.summary,'$.title'),'') content, t.updated_at ts`,
  ],
  [
    "mirror_messages",
    "message",
    `t.email, t.host_id, t.session_id entity_id, t.idx ordinal, COALESCE(json_extract(t.data,'$.content'),'') content, COALESCE(json_extract(t.data,'$.createdAt'),'') ts`,
  ],
  [
    "mirror_events",
    "event",
    `t.email, t.host_id, t.session_id entity_id, t.seq ordinal, t.data content, COALESCE(json_extract(t.data,'$.ts'),'') ts`,
  ],
  [
    "protocol_runs",
    "run",
    `t.email, '' host_id, t.id entity_id, -1 ordinal, t.protocol_name || ' ' || t.protocol_slug || ' ' || t.snapshot content, t.started_at ts`,
  ],
  [
    "protocol_run_events",
    "run_event",
    `(SELECT email FROM protocol_runs WHERE id=t.run_id) email, '' host_id, t.run_id entity_id, t.seq ordinal, t.type || ' ' || t.data content, t.ts`,
  ],
] as const;

function select(
  table: string,
  kind: string,
  columns: string,
  where: string,
): string {
  return `SELECT '${table}' source, t.rowid source_rowid, '${kind}' kind, ${columns} FROM ${table} t WHERE ${where}`;
}
const fields =
  "source,source_rowid,kind,email,host_id,entity_id,ordinal,content,ts";

export function installContextSchema(db: SqlDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_documents (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_rowid INTEGER NOT NULL,
      kind TEXT NOT NULL, email TEXT, host_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, content TEXT NOT NULL, ts TEXT NOT NULL,
      UNIQUE(source,source_rowid));
    CREATE INDEX IF NOT EXISTS context_owner ON context_documents(email,host_id,entity_id,kind,ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(content,content='context_documents',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS context_backfill (source TEXT PRIMARY KEY, after_row INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS context_generation (email TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS context_doc_insert AFTER INSERT ON context_documents BEGIN
      INSERT INTO context_fts(rowid,content) VALUES(new.id,new.content);
      INSERT INTO context_generation(email,value) VALUES(new.email,1) ON CONFLICT(email) DO UPDATE SET value=value+1;
    END;
    CREATE TRIGGER IF NOT EXISTS context_doc_delete AFTER DELETE ON context_documents BEGIN
      INSERT INTO context_fts(context_fts,rowid,content) VALUES('delete',old.id,old.content);
      INSERT INTO context_generation(email,value) VALUES(old.email,1) ON CONFLICT(email) DO UPDATE SET value=value+1;
    END;
    CREATE TRIGGER IF NOT EXISTS context_doc_update AFTER UPDATE ON context_documents BEGIN
      INSERT INTO context_fts(context_fts,rowid,content) VALUES('delete',old.id,old.content);
      INSERT INTO context_fts(rowid,content) VALUES(new.id,new.content);
      INSERT INTO context_generation(email,value) VALUES(new.email,1) ON CONFLICT(email) DO UPDATE SET value=value+1;
    END;
    CREATE TABLE IF NOT EXISTS context_mirror_coverage (
      email TEXT NOT NULL, host_id TEXT NOT NULL, session_id TEXT NOT NULL,
      message_through INTEGER NOT NULL, event_through INTEGER NOT NULL,
      synced_at TEXT NOT NULL, PRIMARY KEY(email,host_id,session_id));
  `);
  installContextEmbeddings(db);
  for (const [table, kind, columns] of sources) {
    db.prepare("INSERT OR IGNORE INTO context_backfill(source) VALUES(?)").run(
      table,
    );
    for (const event of ["INSERT", "UPDATE"])
      db.exec(`
      CREATE TRIGGER IF NOT EXISTS context_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
        INSERT INTO context_documents(${fields}) ${select(table, kind, columns, "t.rowid=new.rowid")}
        ON CONFLICT(source,source_rowid) DO UPDATE SET kind=excluded.kind,email=excluded.email,host_id=excluded.host_id,
          entity_id=excluded.entity_id,ordinal=excluded.ordinal,content=excluded.content,ts=excluded.ts;
      END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS context_${table}_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM context_documents WHERE source='${table}' AND source_rowid=old.rowid;
    END;`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS context_session_cleanup AFTER DELETE ON chat_sessions BEGIN
    DELETE FROM context_documents WHERE host_id='' AND entity_id=old.id AND email=old.email;
  END;
  CREATE TRIGGER IF NOT EXISTS context_mirror_cleanup AFTER DELETE ON mirror_sessions BEGIN
    DELETE FROM context_documents WHERE host_id=old.host_id AND entity_id=old.id AND email=old.email;
    DELETE FROM context_mirror_coverage WHERE host_id=old.host_id AND session_id=old.id AND email=old.email;
  END;
  CREATE TRIGGER IF NOT EXISTS context_run_cleanup AFTER DELETE ON protocol_runs BEGIN
    DELETE FROM context_documents WHERE host_id='' AND entity_id=old.id AND email=old.email;
  END;
  CREATE TRIGGER IF NOT EXISTS context_account_cleanup AFTER DELETE ON users BEGIN
    DELETE FROM context_documents WHERE email=old.email;
    DELETE FROM context_mirror_coverage WHERE email=old.email;
    DELETE FROM context_generation WHERE email=old.email;
  END;`);
  // Yield between batches on a large existing DB. New writes are already
  // indexed by triggers; searches explicitly report incomplete backfill.
  const step = () => {
    try {
      if (!backfillContext(db)) setTimeout(step, 0).unref();
    } catch (e) {
      console.warn("[context] backfill paused", e);
    }
  };
  step();
}

export function backfillContext(db: SqlDb, batch = 500): boolean {
  for (const [table, kind, columns] of sources) {
    const state = db
      .prepare("SELECT * FROM context_backfill WHERE source=?")
      .get(table)!;
    if (state.complete) continue;
    const ids = db
      .prepare(
        `SELECT rowid id FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`,
      )
      .all(state.after_row, batch);
    const end = ids.length
      ? Number(ids[ids.length - 1]!.id)
      : Number(state.after_row);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT OR IGNORE INTO context_documents(${fields}) ${select(table, kind, columns, "t.rowid>? AND t.rowid<=?")}`,
      ).run(state.after_row, end);
      db.prepare(
        "UPDATE context_backfill SET after_row=?,complete=? WHERE source=?",
      ).run(end, ids.length < batch ? 1 : 0, table);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (ids.length >= batch) return false;
  }
  return true;
}
