// Zero-native-dependency SQLite, using whichever embedded driver the runtime
// provides: bun:sqlite under Bun (dev), node:sqlite under Node (packaged
// desktop / server). Both expose the same prepare()/exec() surface. The
// drizzle schema in ../../../../db is the migration source of truth; this
// adapter ensures the same shape at runtime.
import fs from "node:fs";
import path from "node:path";

export interface SqlStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): unknown;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

const DATA_DIR =
  process.env.LABEE_DATA_DIR ||
  process.env.MONTEREY_DATA_DIR ||
  path.join(process.cwd(), "data");
const DB_PATH = process.env.LABEE_DB_PATH || path.join(DATA_DIR, "labee.sqlite");

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let dbPromise: Promise<SqlDb> | null = null;

async function openDb(): Promise<SqlDb> {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  let db: SqlDb;
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    db = new Database(DB_PATH, { create: true }) as unknown as SqlDb;
  } else {
    const mod = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => SqlDb };
    db = new mod.DatabaseSync(DB_PATH);
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS users (" +
      "email TEXT PRIMARY KEY, " +
      "password_hash TEXT NOT NULL, " +
      "is_admin INTEGER NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL, " +
      "google_id TEXT);",
  );
  ensureColumn(db, "users", "google_id", "TEXT");
  // Per-user LLM provider/model selection and (encrypted) own credentials.
  db.exec(
    "CREATE TABLE IF NOT EXISTS user_llm_settings (" +
      "email TEXT PRIMARY KEY, " +
      "provider TEXT NOT NULL DEFAULT 'anthropic', " +
      "model TEXT NOT NULL DEFAULT 'opus', " +
      "anthropic_mode TEXT NOT NULL DEFAULT 'provided', " +
      "openai_mode TEXT NOT NULL DEFAULT 'own_api_key', " +
      "anthropic_api_key_enc TEXT, " +
      "openai_api_key_enc TEXT, " +
      "updated_at TEXT NOT NULL);",
  );
  // Saved agent presets: skills + working directory + reference folders.
  db.exec(
    "CREATE TABLE IF NOT EXISTS agents (" +
      "id TEXT PRIMARY KEY, " +
      "email TEXT NOT NULL, " +
      "name TEXT NOT NULL, " +
      "description TEXT, " +
      "skill_slugs TEXT NOT NULL DEFAULT '[]', " +
      "working_dir TEXT NOT NULL DEFAULT '', " +
      "reference_folders TEXT NOT NULL DEFAULT '[]', " +
      "engine TEXT NOT NULL DEFAULT 'claude', " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL);",
  );
  ensureColumn(db, "agents", "engine", "TEXT NOT NULL DEFAULT 'claude'");
  // Agent marketplace: owners can list an agent publicly; installs are counted
  // on the listing. Machine paths are never exposed through the marketplace.
  ensureColumn(db, "agents", "is_public", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "agents", "published_at", "TEXT");
  ensureColumn(db, "agents", "installs", "INTEGER NOT NULL DEFAULT 0");
  // Teams: a set of agents published together because they hand off to each
  // other. `team_order` is the position in that hand-off (1-based).
  ensureColumn(db, "agents", "team", "TEXT");
  ensureColumn(db, "agents", "team_order", "INTEGER NOT NULL DEFAULT 0");
  // Per-user billing: Stripe customer/subscription + a credit balance (cents).
  db.exec(
    "CREATE TABLE IF NOT EXISTS billing (" +
      "email TEXT PRIMARY KEY, " +
      "customer_id TEXT, " +
      "plan TEXT NOT NULL DEFAULT 'free', " +
      "subscription_id TEXT, " +
      "subscription_status TEXT, " +
      "current_period_end TEXT, " +
      "cancel_at_period_end INTEGER NOT NULL DEFAULT 0, " +
      "credits INTEGER NOT NULL DEFAULT 0, " +
      "credited_period TEXT, " +
      "subscription_price_id TEXT, " +
      "updated_at TEXT NOT NULL);",
  );
  ensureColumn(db, "billing", "credited_period", "TEXT");
  ensureColumn(db, "billing", "subscription_price_id", "TEXT");
  // Processed Stripe webhook events — gives webhook handling idempotency.
  db.exec(
    "CREATE TABLE IF NOT EXISTS billing_events (" +
      "id TEXT PRIMARY KEY, " +
      "type TEXT NOT NULL, " +
      "email TEXT, " +
      "created_at TEXT NOT NULL);",
  );
  // Credit ledger: one row per balance change (signup grant, metered spend,
  // Stripe top-up/subscription). The billing.credits column is the running
  // balance; this table is the itemised audit trail shown to the user.
  db.exec(
    "CREATE TABLE IF NOT EXISTS usage_events (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "email TEXT NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "amount_cents INTEGER NOT NULL DEFAULT 0, " +
      "provider TEXT, " +
      "model TEXT, " +
      "input_tokens INTEGER NOT NULL DEFAULT 0, " +
      "output_tokens INTEGER NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_email ON usage_events (email, id);",
  );
  // Coupon redemptions — one row per (code, user), so a code can't be redeemed
  // twice by the same account.
  db.exec(
    "CREATE TABLE IF NOT EXISTS coupon_redemptions (" +
      "code TEXT NOT NULL, " +
      "email TEXT NOT NULL, " +
      "redeemed_at TEXT NOT NULL, " +
      "PRIMARY KEY (code, email));",
  );
  // ── Research runs (multi-agent pipeline) ─────────────────────────────────
  // One row per run; spec_json is the frozen RunSpec the run was launched
  // with. Content artifacts live on disk in workspace_dir — these tables are
  // the index + event log that make runs listable, replayable, and auditable.
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_runs (" +
      "id TEXT PRIMARY KEY, " +
      "email TEXT NOT NULL, " +
      "title TEXT NOT NULL, " +
      "spec_json TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "stage TEXT, " +
      "workspace_dir TEXT NOT NULL, " +
      "fail_reason TEXT, " +
      "cost_usd REAL NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL, " +
      "finished_at TEXT);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_runs_email ON research_runs (email, created_at);",
  );
  // One row per CLI child (a sub-agent invocation). branch carries PEE
  // lineage ("b2" / "b2.i3.v1"); raw transcripts live in tasks/<id>.jsonl.
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_tasks (" +
      "id TEXT PRIMARY KEY, " +
      "run_id TEXT NOT NULL, " +
      "stage TEXT NOT NULL, " +
      "role TEXT NOT NULL, " +
      "branch TEXT, " +
      "parent_task_id TEXT, " +
      "attempt INTEGER NOT NULL DEFAULT 1, " +
      "status TEXT NOT NULL, " +
      "model TEXT, " +
      "input_json TEXT, " +
      "output_path TEXT, " +
      "cost_usd REAL, " +
      "duration_ms INTEGER, " +
      "error TEXT, " +
      "started_at TEXT, " +
      "finished_at TEXT);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_tasks_run ON research_tasks (run_id, started_at);",
  );
  // Append-only event log; SSE replay is `WHERE run_id=? AND seq>?`.
  // High-frequency agent_delta/agent_tool events are live-only (not inserted).
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_events (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "run_id TEXT NOT NULL, " +
      "task_id TEXT, " +
      "stage TEXT, " +
      "role TEXT, " +
      "branch TEXT, " +
      "type TEXT NOT NULL, " +
      "data TEXT NOT NULL, " +
      "created_at TEXT NOT NULL);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_events_run ON research_events (run_id, seq);",
  );
  // Index of file-backed artifacts in the run workspace (provenance metadata
  // in meta_json: producing task, input artifact ids, evidence ids).
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_artifacts (" +
      "id TEXT PRIMARY KEY, " +
      "run_id TEXT NOT NULL, " +
      "stage TEXT NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "rel_path TEXT NOT NULL, " +
      "produced_by_task TEXT, " +
      "sha256 TEXT NOT NULL, " +
      "bytes INTEGER NOT NULL, " +
      "meta_json TEXT, " +
      "created_at TEXT NOT NULL, " +
      "UNIQUE (run_id, rel_path));",
  );
  // Retrieval cache index (chain-of-evidence): a citation is valid in a run
  // iff a row exists here for its ref_id. Payloads live in evidence/ev_*.json;
  // id is the sha256 of the canonical {tool, request}.
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_evidence (" +
      "id TEXT NOT NULL, " +
      "run_id TEXT NOT NULL, " +
      "source_tool TEXT NOT NULL, " +
      "ref_id TEXT, " +
      "request_json TEXT NOT NULL, " +
      "rel_path TEXT NOT NULL, " +
      "sha256 TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, " +
      "PRIMARY KEY (run_id, id));",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_evidence_ref ON research_evidence (run_id, ref_id);",
  );
  // Per-claim verification ledger for the final draft (typed claims, status,
  // break codes) — what the ClaimInspector UI renders.
  db.exec(
    "CREATE TABLE IF NOT EXISTS research_claims (" +
      "id TEXT PRIMARY KEY, " +
      "run_id TEXT NOT NULL, " +
      "artifact_id TEXT NOT NULL, " +
      "claim_type TEXT NOT NULL, " +
      "text TEXT NOT NULL, " +
      "source_tag TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "break_code TEXT, " +
      "detail_json TEXT, " +
      "checked_at TEXT);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_research_claims_run ON research_claims (run_id, artifact_id);",
  );
  importLegacyUsersJson(db);
  return db;
}

/** Add a column to an existing table if it isn't present yet. SQLite has no
 *  `ADD COLUMN IF NOT EXISTS`, so we check pragma table_info first. Lets us
 *  evolve the runtime schema for DBs created before a column existed. */
function ensureColumn(db: SqlDb, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
}

/** One-time migration: if the table is empty and a legacy data/users.json
 *  exists, import its records. The JSON file is left in place as a backup. */
function importLegacyUsersJson(db: SqlDb): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number } | undefined;
  if (row && Number(row.n) > 0) return;
  const legacy = path.join(DATA_DIR, "users.json");
  let raw: string;
  try {
    raw = fs.readFileSync(legacy, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as {
      users?: Array<{ email: string; passwordHash: string; isAdmin?: boolean; createdAt?: string }>;
    };
    const users = parsed.users ?? [];
    const insert = db.prepare(
      "INSERT OR IGNORE INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const u of users) {
      if (!u.email || !u.passwordHash) continue;
      insert.run(u.email, u.passwordHash, u.isAdmin ? 1 : 0, u.createdAt ?? new Date(0).toISOString());
    }
  } catch {
    // malformed legacy file — skip
  }
}

export function getDb(): Promise<SqlDb> {
  return (dbPromise ??= openDb());
}
