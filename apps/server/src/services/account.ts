// Self-service account deletion (App Store guideline 5.1.1(v): an app that
// lets people create an account must let them delete it in the app).
//
// This is the only code path that erases a person completely. The admin
// `deleteUser` only drops the users row; everything keyed by email stayed
// behind. Here every table that carries the email, plus the child tables that
// hang off sessions and research runs, plus the on-disk deck and research
// workspaces, are removed in one SQLite transaction. The Stripe customer is
// deleted too (which cancels any live subscription) — best effort, since a
// Stripe outage must not block the person's right to erase their data.
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { stripe } from "./billing";
import { userDeckDir } from "./deck";
import { normalizeEmail } from "./users";

/** Emails deleted during this process's lifetime. A sealed session cookie is
 *  stateless, so without this a deleted person's cookie would keep working
 *  until it expires (30 days). Checked on every cookie-authenticated request. */
const deleted = new Set<string>();

export function isDeletedAccount(email: string): boolean {
  return deleted.has(normalizeEmail(email));
}

export interface DeleteAccountResult {
  /** Rows removed per table, for the audit log and tests. */
  rows: Record<string, number>;
  /** Directories removed from disk. */
  dirs: string[];
  /** Stripe customer id that was deleted, if any. */
  stripeCustomer: string | null;
}

/** Tables with an `email` column, deleted directly. Order does not matter for
 *  SQLite (no foreign keys), but users goes last so a crash mid-way leaves an
 *  account that can still sign in and retry rather than a ghost. */
const EMAIL_TABLES = [
  "mirror_sessions",
  "mirror_events",
  "mirror_messages",
  "link_devices",
  "billing_events",
  "billing",
  "usage_events",
  "coupon_redemptions",
  "oauth_codes",
  "oauth_refresh_tokens",
  "user_llm_settings",
  "agents",
  "users",
] as const;

/** Child tables keyed by a parent id, deleted via a subquery on the parent. */
const CHILD_TABLES: ReadonlyArray<{ table: string; key: string; parent: string }> = [
  { table: "chat_session_events", key: "session_id", parent: "chat_sessions" },
  { table: "chat_session_messages", key: "session_id", parent: "chat_sessions" },
  { table: "chat_session_queue", key: "session_id", parent: "chat_sessions" },
  { table: "research_tasks", key: "run_id", parent: "research_runs" },
  { table: "research_events", key: "run_id", parent: "research_runs" },
  { table: "research_artifacts", key: "run_id", parent: "research_runs" },
  { table: "research_evidence", key: "run_id", parent: "research_runs" },
  { table: "research_claims", key: "run_id", parent: "research_runs" },
];

function rmDir(dir: string, out: string[]): void {
  // Never follow an empty or root path, whatever the DB says.
  const abs = path.resolve(dir);
  if (!abs || abs === path.parse(abs).root) return;
  if (!fs.existsSync(abs)) return;
  fs.rmSync(abs, { recursive: true, force: true });
  out.push(abs);
}

export async function deleteAccount(rawEmail: string): Promise<DeleteAccountResult> {
  const email = normalizeEmail(rawEmail);
  const db = await getDb();
  const rows: Record<string, number> = {};
  const dirs: string[] = [];

  // 1. Stripe first, while we still know the customer id. Deleting the
  //    customer cancels active subscriptions immediately.
  let stripeCustomer: string | null = null;
  const billingRow = db.prepare("SELECT customer_id FROM billing WHERE email = ?").get(email) as
    | { customer_id: string | null }
    | undefined;
  const customerId = billingRow?.customer_id ?? null;
  const s = stripe();
  if (customerId && s) {
    try {
      await s.customers.del(customerId);
      stripeCustomer = customerId;
    } catch (e) {
      console.warn(`[account] could not delete Stripe customer ${customerId} for ${email}:`, e);
    }
  }

  // 2. Collect on-disk research workspaces before their rows disappear.
  const workspaces = (
    db.prepare("SELECT workspace_dir FROM research_runs WHERE email = ?").all(email) as Array<{
      workspace_dir: string;
    }>
  ).map((r) => r.workspace_dir);

  // 3. Everything in the database, atomically.
  db.exec("BEGIN");
  try {
    for (const c of CHILD_TABLES) {
      const r = db
        .prepare(`DELETE FROM ${c.table} WHERE ${c.key} IN (SELECT id FROM ${c.parent} WHERE email = ?)`)
        .run(email) as { changes?: number | bigint } | undefined;
      rows[c.table] = (rows[c.table] ?? 0) + Number(r?.changes ?? 0);
    }
    for (const t of ["chat_sessions", "research_runs", ...EMAIL_TABLES]) {
      const r = db.prepare(`DELETE FROM ${t} WHERE email = ?`).run(email) as
        | { changes?: number | bigint }
        | undefined;
      rows[t] = (rows[t] ?? 0) + Number(r?.changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // 4. Files. Only after the rows are gone, so a disk failure cannot leave a
  //    live account pointing at missing data.
  rmDir(userDeckDir(email), dirs);
  for (const w of workspaces) rmDir(w, dirs);

  deleted.add(email);
  console.info(`[account] deleted ${email}:`, { rows, dirs: dirs.length, stripeCustomer });
  return { rows, dirs, stripeCustomer };
}
