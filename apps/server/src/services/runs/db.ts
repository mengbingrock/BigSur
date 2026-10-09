// Rows for protocol runs (docs/protocol-run-design.md §2). Same style as
// sessions/db.ts: async getDb(), synchronous statements, ISO timestamps,
// per-run event seq.
import crypto from "node:crypto";
import { getDb } from "../db";
import type { ProtocolSnapshot } from "./parse";

const now = () => new Date().toISOString();

export type RunStatus = "running" | "paused" | "done" | "abandoned";

export interface RunScale {
  /** What the protocol is written for. */
  base: { qty: number; unit: string };
  /** What the person is running. */
  actual: { qty: number; unit: string };
}

export interface RunRow {
  id: string;
  email: string;
  sessionId: string;
  /** Host that holds the session; null when this server holds it. */
  hostId: string | null;
  protocolSlug: string;
  protocolName: string;
  snapshot: ProtocolSnapshot;
  current: number;
  status: RunStatus;
  scale: RunScale | null;
  lastSeq: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RunEventRow {
  runId: string;
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    email: String(r.email),
    sessionId: String(r.session_id),
    hostId: (r.host_id as string | null) ?? null,
    protocolSlug: String(r.protocol_slug),
    protocolName: String(r.protocol_name),
    snapshot: parseJson<ProtocolSnapshot>(r.snapshot, { steps: [], materials: [], base: null, loose: true, hash: "", section: null }),
    current: Number(r.current ?? 1),
    status: String(r.status ?? "running") as RunStatus,
    scale: parseJson<RunScale | null>(r.scale, null),
    lastSeq: Number(r.last_seq ?? 0),
    startedAt: String(r.started_at),
    updatedAt: String(r.updated_at),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function rowToEvent(r: Record<string, unknown>): RunEventRow {
  return {
    runId: String(r.run_id),
    seq: Number(r.seq),
    ts: String(r.ts),
    type: String(r.type),
    data: parseJson<Record<string, unknown>>(r.data, {}),
  };
}

export function newRunId(): string {
  return `run_${crypto.randomBytes(9).toString("hex")}`;
}

export async function insertRun(run: Omit<RunRow, "lastSeq" | "updatedAt">): Promise<RunRow> {
  const db = await getDb();
  db.prepare(
    "INSERT INTO protocol_runs (id, email, session_id, host_id, protocol_slug, protocol_name, snapshot, current, status, scale, last_seq, started_at, updated_at, finished_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
  ).run(
    run.id,
    run.email,
    run.sessionId,
    run.hostId,
    run.protocolSlug,
    run.protocolName,
    JSON.stringify(run.snapshot),
    run.current,
    run.status,
    run.scale ? JSON.stringify(run.scale) : null,
    run.startedAt,
    run.startedAt,
    run.finishedAt,
  );
  return (await getRun(run.id))!;
}

/** Insert or replace a whole row (a host applying the box's copy). */
export async function upsertRun(run: RunRow): Promise<void> {
  const db = await getDb();
  db.prepare(
    "INSERT INTO protocol_runs (id, email, session_id, host_id, protocol_slug, protocol_name, snapshot, current, status, scale, last_seq, started_at, updated_at, finished_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET current = excluded.current, status = excluded.status, scale = excluded.scale, " +
      "last_seq = MAX(protocol_runs.last_seq, excluded.last_seq), updated_at = excluded.updated_at, finished_at = excluded.finished_at",
  ).run(
    run.id,
    run.email,
    run.sessionId,
    run.hostId,
    run.protocolSlug,
    run.protocolName,
    JSON.stringify(run.snapshot),
    run.current,
    run.status,
    run.scale ? JSON.stringify(run.scale) : null,
    run.lastSeq,
    run.startedAt,
    run.updatedAt,
    run.finishedAt,
  );
}

export async function getRun(id: string): Promise<RunRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM protocol_runs WHERE id = ?").get(id);
  return row ? rowToRun(row) : null;
}

export async function getRunForUser(email: string, id: string): Promise<RunRow | null> {
  const r = await getRun(id);
  return r && r.email === email ? r : null;
}

export async function getRunBySession(sessionId: string): Promise<RunRow | null> {
  const db = await getDb();
  const row = db
    .prepare("SELECT * FROM protocol_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(sessionId);
  return row ? rowToRun(row) : null;
}

export async function listRuns(
  email: string,
  opts: { status?: RunStatus[]; protocolSlug?: string; hostId?: string; limit?: number } = {},
): Promise<RunRow[]> {
  const db = await getDb();
  const where = ["email = ?"];
  const vals: unknown[] = [email];
  if (opts.status?.length) {
    where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
    vals.push(...opts.status);
  }
  if (opts.protocolSlug) {
    where.push("protocol_slug = ?");
    vals.push(opts.protocolSlug);
  }
  if (opts.hostId) {
    where.push("host_id = ?");
    vals.push(opts.hostId);
  }
  vals.push(opts.limit ?? 100);
  const rows = db.prepare(`SELECT * FROM protocol_runs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...vals);
  return rows.map(rowToRun);
}

export async function updateRun(
  id: string,
  patch: { current?: number; status?: RunStatus; scale?: RunScale | null; finishedAt?: string | null },
): Promise<void> {
  const db = await getDb();
  const sets = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  if (patch.current !== undefined) {
    sets.push("current = ?");
    vals.push(patch.current);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.scale !== undefined) {
    sets.push("scale = ?");
    vals.push(patch.scale ? JSON.stringify(patch.scale) : null);
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    vals.push(patch.finishedAt);
  }
  vals.push(id);
  db.prepare(`UPDATE protocol_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** Append an event with the next seq. */
export async function appendRunEvent(runId: string, type: string, data: Record<string, unknown>): Promise<RunEventRow> {
  const db = await getDb();
  const ts = now();
  const row = db
    .prepare("UPDATE protocol_runs SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq")
    .get(ts, runId);
  if (!row) throw Object.assign(new Error("Run not found."), { code: "NOT_FOUND" });
  const seq = Number(row.last_seq);
  db.prepare("INSERT INTO protocol_run_events (run_id, seq, ts, type, data, applied) VALUES (?, ?, ?, ?, ?, 0)").run(
    runId,
    seq,
    ts,
    type,
    JSON.stringify(data),
  );
  return { runId, seq, ts, type, data };
}

/** Store an event the box produced (host side). Ignores one already held. */
export async function insertRunEvent(ev: RunEventRow): Promise<boolean> {
  const db = await getDb();
  const res = db
    .prepare("INSERT OR IGNORE INTO protocol_run_events (run_id, seq, ts, type, data, applied) VALUES (?, ?, ?, ?, ?, 1)")
    .run(ev.runId, ev.seq, ev.ts, ev.type, JSON.stringify(ev.data)) as { changes?: number } | undefined;
  return Number(res?.changes ?? 0) > 0;
}

export async function listRunEvents(runId: string, after = 0): Promise<RunEventRow[]> {
  const db = await getDb();
  return db
    .prepare("SELECT * FROM protocol_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
    .all(runId, after)
    .map(rowToEvent);
}

/** Events a host has not acknowledged yet, for replay on connect. */
export async function listUnappliedEvents(email: string, hostId: string): Promise<Array<{ run: RunRow; event: RunEventRow }>> {
  const db = await getDb();
  const rows = db
    .prepare(
      "SELECT e.* FROM protocol_run_events e JOIN protocol_runs r ON r.id = e.run_id " +
        "WHERE r.email = ? AND r.host_id = ? AND e.applied = 0 ORDER BY e.ts ASC, e.seq ASC",
    )
    .all(email, hostId)
    .map(rowToEvent);
  const out: Array<{ run: RunRow; event: RunEventRow }> = [];
  const cache = new Map<string, RunRow>();
  for (const event of rows) {
    let run = cache.get(event.runId);
    if (!run) {
      run = (await getRun(event.runId))!;
      cache.set(event.runId, run);
    }
    out.push({ run, event });
  }
  return out;
}

export async function markApplied(runId: string, seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  const db = await getDb();
  const stmt = db.prepare("UPDATE protocol_run_events SET applied = 1 WHERE run_id = ? AND seq = ?");
  for (const s of seqs) stmt.run(runId, s);
}

export async function deleteRunsForSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const ids = db.prepare("SELECT id FROM protocol_runs WHERE session_id = ?").all(sessionId).map((r) => String(r.id));
  for (const id of ids) {
    db.prepare("DELETE FROM protocol_run_events WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM protocol_runs WHERE id = ?").run(id);
  }
}
