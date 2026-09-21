// Box-side mirror of desktop sessions (design §5.4): summaries, durable
// events and messages written through by the host, served read-only to
// phones while the Mac is offline.
import { getDb } from "../db";

const now = () => new Date().toISOString();

export async function upsertMirrorSession(email: string, hostId: string, session: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const id = String(session.id ?? "");
  if (!id) return;
  db.prepare(
    "INSERT INTO mirror_sessions (email, host_id, id, summary, last_seq, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(email, host_id, id) DO UPDATE SET summary = excluded.summary, last_seq = MAX(mirror_sessions.last_seq, excluded.last_seq), updated_at = excluded.updated_at",
  ).run(email, hostId, id, JSON.stringify(session), Number(session.lastSeq ?? 0), now());
}

export async function insertMirrorEvent(email: string, hostId: string, event: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const sessionId = String(event.sessionId ?? "");
  const seq = Number(event.seq ?? 0);
  if (!sessionId || !seq) return;
  db.prepare(
    "INSERT OR IGNORE INTO mirror_events (email, host_id, session_id, seq, data) VALUES (?, ?, ?, ?, ?)",
  ).run(email, hostId, sessionId, seq, JSON.stringify(event));
  db.prepare(
    "UPDATE mirror_sessions SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE email = ? AND host_id = ? AND id = ?",
  ).run(seq, now(), email, hostId, sessionId);
}

export async function upsertMirrorMessages(email: string, hostId: string, sessionId: string, items: Record<string, unknown>[]): Promise<void> {
  const db = await getDb();
  const stmt = db.prepare(
    "INSERT INTO mirror_messages (email, host_id, session_id, idx, data) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(email, host_id, session_id, idx) DO UPDATE SET data = excluded.data",
  );
  for (const m of items) stmt.run(email, hostId, sessionId, Number(m.idx ?? 0), JSON.stringify(m));
}

function parse(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function listMirrorSessions(email: string, hostId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT summary FROM mirror_sessions WHERE email = ? AND host_id = ? ORDER BY updated_at DESC LIMIT 200")
    .all(email, hostId);
  return rows.map((r) => parse(r.summary));
}

export async function getMirrorSession(email: string, hostId: string, id: string): Promise<{ session: Record<string, unknown>; messages: Record<string, unknown>[] } | null> {
  const db = await getDb();
  const row = db.prepare("SELECT summary FROM mirror_sessions WHERE email = ? AND host_id = ? AND id = ?").get(email, hostId, id);
  if (!row) return null;
  const msgs = db
    .prepare("SELECT data FROM mirror_messages WHERE email = ? AND host_id = ? AND session_id = ? ORDER BY idx ASC")
    .all(email, hostId, id)
    .map((r) => parse(r.data));
  return { session: parse(row.summary), messages: msgs };
}

export async function listMirrorEvents(email: string, hostId: string, sessionId: string, after: number): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare("SELECT data FROM mirror_events WHERE email = ? AND host_id = ? AND session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 5000")
    .all(email, hostId, sessionId, after)
    .map((r) => parse(r.data));
}
