import { getDb, type SqlDb } from "../db";
import { newId } from "../sessions/db";
import type { SayResult } from "./planner";

export function installSiriSchema(db: SqlDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS siri_tasks (
      id TEXT PRIMARY KEY,email TEXT NOT NULL,session_id TEXT NOT NULL,request TEXT NOT NULL,
      device TEXT NOT NULL,status TEXT NOT NULL,checkpoint TEXT NOT NULL DEFAULT '{}',
      confirm_id TEXT,expires_at INTEGER,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
      result TEXT,late INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS siri_task_owner ON siri_tasks(email,status,updated_at);
    CREATE TABLE IF NOT EXISTS siri_requests (
      email TEXT NOT NULL,request_id TEXT NOT NULL,body TEXT NOT NULL,task_id TEXT NOT NULL,
      PRIMARY KEY(email,request_id));
    CREATE TABLE IF NOT EXISTS siri_task_events (
      id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,email TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS siri_task_event_owner ON siri_task_events(email,task_id,id);
    CREATE TABLE IF NOT EXISTS siri_actions (
      email TEXT NOT NULL,operation_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,result TEXT,
      created_at TEXT NOT NULL,PRIMARY KEY(email,operation_id));
    CREATE TABLE IF NOT EXISTS siri_delegations (
      email TEXT NOT NULL,task_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'working',result TEXT,
      id TEXT NOT NULL,origin_id TEXT NOT NULL,host_id TEXT,target_turn TEXT,
      PRIMARY KEY(email,id));
    CREATE TABLE IF NOT EXISTS siri_migrations (email TEXT PRIMARY KEY,at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS siri_account_cleanup AFTER DELETE ON users BEGIN
      DELETE FROM siri_tasks WHERE email=old.email;
      DELETE FROM siri_requests WHERE email=old.email;
      DELETE FROM siri_task_events WHERE email=old.email;
      DELETE FROM siri_actions WHERE email=old.email;
      DELETE FROM siri_delegations WHERE email=old.email;
      DELETE FROM siri_migrations WHERE email=old.email;
    END;
  `);
}
export interface Task {
  id: string;
  email: string;
  session_id: string;
  request: string;
  device: string;
  status: string;
  checkpoint: string;
  confirm_id: string | null;
  expires_at: number | null;
  lease_owner: string | null;
  lease_until: number;
  result: string | null;
  late: number;
  delivered: number;
  created_at: string;
  updated_at: string;
}
export async function taskById(
  email: string,
  id: string,
): Promise<Task | null> {
  const db = await getDb();
  return (
    (db
      .prepare("SELECT * FROM siri_tasks WHERE email=? AND id=?")
      .get(email, id) as unknown as Task) ?? null
  );
}
export async function addEvent(
  task: Pick<Task, "id" | "email">,
  kind: string,
  data: unknown,
): Promise<number> {
  const db = await getDb();
  db.prepare(
    "INSERT INTO siri_task_events(task_id,email,kind,data,created_at) VALUES(?,?,?,?,?)",
  ).run(
    task.id,
    task.email,
    kind,
    JSON.stringify(data),
    new Date().toISOString(),
  );
  return Number(db.prepare("SELECT last_insert_rowid() id").get()!.id);
}
export async function updateTask(
  id: string,
  values: Partial<
    Pick<
      Task,
      | "status"
      | "checkpoint"
      | "confirm_id"
      | "expires_at"
      | "lease_owner"
      | "lease_until"
      | "result"
      | "late"
      | "delivered"
    >
  >,
): Promise<void> {
  const db = await getDb();
  const entries = Object.entries(values);
  db.prepare(
    `UPDATE siri_tasks SET ${entries.map(([k]) => `${k}=?`).join(",")},updated_at=? WHERE id=?`,
  ).run(...entries.map(([, v]) => v), new Date().toISOString(), id);
}
export async function enqueue(
  email: string,
  sessionId: string,
  request: string,
  device: string,
  requestId: string,
  body: string,
  initial: unknown = {},
): Promise<Task> {
  const db = await getDb();
  db.exec("BEGIN IMMEDIATE");
  let id: string;
  try {
    const prev = db
      .prepare("SELECT * FROM siri_requests WHERE email=? AND request_id=?")
      .get(email, requestId);
    if (prev) {
      if (prev.body !== body)
        throw Object.assign(
          new Error("requestId was already used for a different request."),
          { status: 409 },
        );
      id = String(prev.task_id);
    } else {
      id = newId("siri");
      const at = new Date().toISOString();
      db.prepare(
        "INSERT INTO siri_tasks(id,email,session_id,request,device,status,checkpoint,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)",
      ).run(
        id,
        email,
        sessionId,
        request,
        device,
        JSON.stringify(initial),
        at,
        at,
      );
      db.prepare("INSERT INTO siri_requests VALUES(?,?,?,?)").run(
        email,
        requestId,
        body,
        id,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return (await taskById(email, id))!;
}
/** Import legacy exchanges once without discarding their transcript. Old
 * confirmations must be proposed again because they had no state version. */
export async function migrateLegacy(
  email: string,
  sessionId: string,
  memory: unknown,
): Promise<void> {
  const db = await getDb();
  if (db.prepare("SELECT 1 FROM siri_migrations WHERE email=?").get(email))
    return;
  const m = memory as {
    open?: {
      id?: string;
      request?: string;
      delegated?: Array<{
        sessionId: string;
        siriTurnId: string;
        returned?: boolean;
      }>;
    };
    previous?: unknown;
  } | null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const at = new Date().toISOString();
    if (m?.open) {
      const id = m.open.id ?? newId("legacy");
      const active = m.open.delegated?.some((d) => !d.returned);
      db.prepare(
        "INSERT OR IGNORE INTO siri_tasks(id,email,session_id,request,device,status,checkpoint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        email,
        sessionId,
        m.open.request ?? "Previous Siri exchange",
        "Siri",
        active ? "delegated" : "clarify",
        JSON.stringify({ legacy: m.open }),
        at,
        at,
      );
      for (const d of m.open.delegated ?? [])
        db.prepare(
          "INSERT OR IGNORE INTO siri_delegations(email,task_id,session_id,status,id,origin_id) VALUES(?,?,?,?,?,?)",
        ).run(
          email,
          id,
          d.sessionId,
          d.returned ? "completed" : "working",
          `${d.siriTurnId}:${d.sessionId}`,
          d.siriTurnId,
        );
    }
    db.prepare("INSERT INTO siri_migrations VALUES(?,?)").run(email, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export async function settleTaskDelegation(
  email: string,
  originId: string,
  sessionId: string,
  outcome: string,
  asks = false,
  delegationId?: string,
): Promise<void> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT task_id FROM siri_delegations WHERE email=? AND origin_id=? AND session_id=?${delegationId ? " AND id=?" : ""}`,
    )
    .all(email, originId, sessionId, ...(delegationId ? [delegationId] : []));
  db.prepare(
    `UPDATE siri_delegations SET status=?,result=? WHERE email=? AND origin_id=? AND session_id=?${delegationId ? " AND id=?" : ""}`,
  ).run(
    asks ? "clarify" : "completed",
    outcome,
    email,
    originId,
    sessionId,
    ...(delegationId ? [delegationId] : []),
  );
  for (const row of rows) {
    const pending = db
      .prepare(
        "SELECT 1 FROM siri_delegations WHERE email=? AND task_id=? AND status!='completed' LIMIT 1",
      )
      .get(email, row.task_id);
    if (!pending)
      db.prepare(
        "UPDATE siri_tasks SET status='completed',updated_at=? WHERE email=? AND id=? AND status='delegated'",
      ).run(new Date().toISOString(), email, row.task_id);
  }
}
export const workingResult = (task: Pick<Task, "id">): SayResult => ({
  status: "working",
  spoken: "Give me a moment. I'll tell you.",
  siriTurnId: task.id,
  actions: [],
  via: "late",
});
