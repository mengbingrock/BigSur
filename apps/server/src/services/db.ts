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
