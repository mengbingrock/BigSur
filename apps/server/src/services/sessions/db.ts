// Prepared-statement CRUD over the chat_session_* tables (design §4.1). Same
// style as research/runsDb.ts: async getDb(), synchronous statements, ISO
// timestamps. Event seq numbers are per session and strictly increasing.
import crypto from "node:crypto";
import { getDb } from "../db";

const now = () => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

export type SessionStatus = "idle" | "running" | "awaiting_input" | "error";

export interface SessionRow {
  id: string;
  email: string;
  agentId: string | null;
  title: string;
  cwd: string | null;
  engine: string;
  provider: string;
  model: string | null;
  status: SessionStatus;
  activeTurn: string | null;
  pendingQuestion: PendingQuestion | null;
  lastBody: Record<string, unknown> | null;
  lastSeq: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PendingQuestion {
  turnId: string;
  toolUseId: string;
  input: unknown;
}

export interface SessionEventRow {
  seq: number;
  sessionId: string;
  turnId: string | null;
  type: string;
  data: unknown;
  ts: string;
}

export interface SessionMessageRow {
  idx: number;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    email: String(r.email),
    agentId: (r.agent_id as string | null) ?? null,
    title: String(r.title),
    cwd: (r.cwd as string | null) ?? null,
    engine: String(r.engine ?? "claude"),
    provider: String(r.provider ?? "anthropic"),
    model: (r.model as string | null) ?? null,
    status: String(r.status ?? "idle") as SessionStatus,
    activeTurn: (r.active_turn as string | null) ?? null,
    pendingQuestion: parseJson<PendingQuestion | null>(r.pending_question, null),
    lastBody: parseJson<Record<string, unknown> | null>(r.last_body, null),
    lastSeq: Number(r.last_seq ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

export async function createSession(opts: {
  email: string;
  agentId?: string | null;
  title?: string;
  cwd?: string | null;
  engine?: string;
  provider?: string;
  model?: string | null;
}): Promise<SessionRow> {
  const db = await getDb();
  const id = newId("ses");
  const ts = now();
  db.prepare(
    "INSERT INTO chat_sessions (id, email, agent_id, title, cwd, engine, provider, model, status, last_seq, cost_usd, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?)",
  ).run(
    id,
    opts.email,
    opts.agentId ?? null,
    opts.title?.trim() || "New chat",
    opts.cwd ?? null,
    opts.engine ?? "claude",
    opts.provider ?? "anthropic",
    opts.model ?? null,
    ts,
    ts,
  );
  return (await getSessionById(id))!;
}

export async function getSessionById(id: string): Promise<SessionRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
  return row ? rowToSession(row) : null;
}

export async function getSession(email: string, id: string): Promise<SessionRow | null> {
  const s = await getSessionById(id);
  return s && s.email === email ? s : null;
}

export async function listSessions(
  email: string,
  opts: { status?: SessionStatus; includeArchived?: boolean; limit?: number } = {},
): Promise<SessionRow[]> {
  const db = await getDb();
  const where: string[] = ["email = ?"];
  const vals: unknown[] = [email];
  if (opts.status) {
    where.push("status = ?");
    vals.push(opts.status);
  }
  if (!opts.includeArchived) where.push("archived_at IS NULL");
  vals.push(opts.limit ?? 200);
  const rows = db
    .prepare(
      `SELECT * FROM chat_sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...vals);
  return rows.map(rowToSession);
}

export async function listRunningSessions(): Promise<SessionRow[]> {
  const db = await getDb();
  const rows = db.prepare("SELECT * FROM chat_sessions WHERE status = 'running'").all();
  return rows.map(rowToSession);
}

export async function updateSession(
  id: string,
  patch: {
    title?: string;
    status?: SessionStatus;
    activeTurn?: string | null;
    pendingQuestion?: PendingQuestion | null;
    lastBody?: Record<string, unknown> | null;
    addCostUsd?: number;
    model?: string | null;
    engine?: string;
    provider?: string;
    cwd?: string | null;
    archived?: boolean;
  },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.activeTurn !== undefined) set("active_turn", patch.activeTurn);
  if (patch.pendingQuestion !== undefined)
    set("pending_question", patch.pendingQuestion ? JSON.stringify(patch.pendingQuestion) : null);
  if (patch.lastBody !== undefined)
    set("last_body", patch.lastBody ? JSON.stringify(patch.lastBody) : null);
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.engine !== undefined) set("engine", patch.engine);
  if (patch.provider !== undefined) set("provider", patch.provider);
  if (patch.cwd !== undefined) set("cwd", patch.cwd);
  if (patch.archived !== undefined) set("archived_at", patch.archived ? now() : null);
  if (patch.addCostUsd) {
    sets.push("cost_usd = cost_usd + ?");
    vals.push(patch.addCostUsd);
  }
  vals.push(id);
  db.prepare(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  db.prepare("DELETE FROM chat_session_events WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM chat_session_messages WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM chat_session_queue WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}

/** Append one event; returns its seq (per-session, monotonic) and timestamp. */
export async function appendEvent(
  sessionId: string,
  turnId: string | null,
  type: string,
  data: unknown,
): Promise<{ seq: number; ts: string }> {
  const db = await getDb();
  const ts = now();
  const row = db
    .prepare("UPDATE chat_sessions SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq")
    .get(ts, sessionId);
  if (!row) throw Object.assign(new Error("Session not found."), { code: "NOT_FOUND" });
  const seq = Number(row.last_seq);
  db.prepare(
    "INSERT INTO chat_session_events (session_id, seq, turn_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, seq, turnId, type, JSON.stringify(data ?? {}), ts);
  return { seq, ts };
}

function rowToEvent(r: Record<string, unknown>): SessionEventRow {
  return {
    seq: Number(r.seq),
    sessionId: String(r.session_id),
    turnId: (r.turn_id as string | null) ?? null,
    type: String(r.type),
    data: parseJson<unknown>(r.data, {}),
    ts: String(r.created_at),
  };
}

export async function listEventsAfter(
  sessionId: string,
  after: number,
  limit = 5000,
): Promise<SessionEventRow[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      "SELECT * FROM chat_session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(sessionId, after, limit);
  return rows.map(rowToEvent);
}

/** Event types kept after a turn ends. Everything else (deltas, block
 *  start/stop, status pings) is transient and dropped by compactTurn. */
export const DURABLE_EVENT_TYPES = new Set([
  "turn_started",
  "turn_ended",
  "turn_cancelled",
  "turn_queued",
  "turn_dequeued",
  "question_asked",
  "question_answered",
  "session_renamed",
  "init",
  "tool_start",
  "tool_input",
  "tool_stop",
  "tool_result",
  "result",
  "error",
  "skills_loaded",
]);

export async function compactTurn(sessionId: string, turnId: string): Promise<number> {
  const db = await getDb();
  const placeholders = [...DURABLE_EVENT_TYPES].map(() => "?").join(",");
  const res = db
    .prepare(
      `DELETE FROM chat_session_events WHERE session_id = ? AND turn_id = ? AND type NOT IN (${placeholders})`,
    )
    .run(sessionId, turnId, ...DURABLE_EVENT_TYPES) as { changes?: number } | undefined;
  return Number(res?.changes ?? 0);
}

export async function appendMessage(
  sessionId: string,
  turnId: string | null,
  role: "user" | "assistant",
  content: string,
  meta: Record<string, unknown> | null = null,
): Promise<SessionMessageRow> {
  const db = await getDb();
  const ts = now();
  const last = db
    .prepare("SELECT COALESCE(MAX(idx), -1) AS idx FROM chat_session_messages WHERE session_id = ?")
    .get(sessionId);
  const idx = Number(last?.idx ?? -1) + 1;
  db.prepare(
    "INSERT INTO chat_session_messages (session_id, idx, turn_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, idx, turnId, role, content, meta ? JSON.stringify(meta) : null, ts);
  return { idx, turnId, role, content, meta, createdAt: ts };
}

export async function listMessages(sessionId: string): Promise<SessionMessageRow[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM chat_session_messages WHERE session_id = ? ORDER BY idx ASC")
    .all(sessionId);
  return rows.map((r) => ({
    idx: Number(r.idx),
    turnId: (r.turn_id as string | null) ?? null,
    role: String(r.role) as "user" | "assistant",
    content: String(r.content),
    meta: parseJson<Record<string, unknown> | null>(r.meta, null),
    createdAt: String(r.created_at),
  }));
}

export interface QueuedTurn {
  id: string;
  sessionId: string;
  body: Record<string, unknown>;
  createdAt: string;
}

export async function enqueueTurn(sessionId: string, body: Record<string, unknown>): Promise<QueuedTurn> {
  const db = await getDb();
  const id = newId("q");
  const ts = now();
  db.prepare("INSERT INTO chat_session_queue (id, session_id, body, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    sessionId,
    JSON.stringify(body),
    ts,
  );
  return { id, sessionId, body, createdAt: ts };
}

export async function listQueue(sessionId: string): Promise<QueuedTurn[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM chat_session_queue WHERE session_id = ? ORDER BY created_at ASC, id ASC")
    .all(sessionId);
  return rows.map((r) => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    body: parseJson<Record<string, unknown>>(r.body, {}),
    createdAt: String(r.created_at),
  }));
}

export async function dequeueTurn(sessionId: string): Promise<QueuedTurn | null> {
  const db = await getDb();
  const [next] = await listQueue(sessionId);
  if (!next) return null;
  db.prepare("DELETE FROM chat_session_queue WHERE id = ?").run(next.id);
  return next;
}

export async function removeQueued(sessionId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const res = db
    .prepare("DELETE FROM chat_session_queue WHERE session_id = ? AND id = ?")
    .run(sessionId, id) as { changes?: number } | undefined;
  return Number(res?.changes ?? 0) > 0;
}
