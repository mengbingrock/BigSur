// Saved agent presets (per user): selected skills + a working artifact
// directory + folders of reference protocols. Backed by the `agents` table.
//
// An agent belongs to its owner and to nobody else. There is no public listing:
// the account's agents follow the person to every device they sign in on, and
// that is the whole of the sharing model.
import crypto from "node:crypto";
import type { Agent, AgentEngine, AgentUpdate } from "@labee/contracts";
import { getDb } from "./db";
import { getAllSkills } from "./skills";

interface AgentRow {
  id: string;
  email: string;
  name: string;
  description: string | null;
  skill_slugs: string;
  working_dir: string;
  reference_folders: string;
  engine: string | null;
  // is_public / published_at / installs remain in the table from the removed
  // marketplace. Nothing reads them; dropping a column in SQLite means
  // rebuilding the table, which is not worth doing to a live database.
  team: string | null;
  team_order: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function parseEngine(raw: string | null | undefined): AgentEngine {
  return raw === "codex" ? "codex" : "claude";
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    skillSlugs: parseJsonArray(row.skill_slugs),
    workingDir: row.working_dir,
    referenceFolders: parseJsonArray(row.reference_folders),
    engine: parseEngine(row.engine),
    team: row.team ?? null,
    teamOrder: Number(row.team_order ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitize(patch: AgentUpdate): {
  name: string;
  description: string | null;
  skillSlugs: string[];
  workingDir: string;
  referenceFolders: string[];
  engine: AgentEngine;
} {
  const name = (patch.name ?? "").trim();
  if (!name) {
    const e = new Error("Agent name is required.") as Error & { code: string };
    e.code = "INVALID";
    throw e;
  }
  const workingDir = (patch.workingDir ?? "").trim();
  if (!workingDir) {
    const e = new Error("A working directory is required.") as Error & { code: string };
    e.code = "INVALID";
    throw e;
  }
  const skillSlugs = Array.isArray(patch.skillSlugs)
    ? patch.skillSlugs.filter((s): s is string => typeof s === "string")
    : [];
  const referenceFolders = Array.isArray(patch.referenceFolders)
    ? patch.referenceFolders.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  return {
    name,
    description: patch.description?.trim() || null,
    skillSlugs,
    workingDir,
    referenceFolders,
    engine: patch.engine === "codex" ? "codex" : "claude",
  };
}

/** Anyone who needs to know the agent set changed — today the Device Link
 *  client, which mirrors it to the box so labee.online can list agents while
 *  this Mac is asleep. Kept here rather than polled from outside so a change
 *  made by any route is picked up exactly once. */
const changeListeners = new Set<(email: string) => void>();

export function subscribeAgents(fn: (email: string) => void): () => void {
  changeListeners.add(fn);
  return () => void changeListeners.delete(fn);
}

function agentsChanged(email: string): void {
  for (const fn of changeListeners) {
    try {
      fn(email);
    } catch {
      // A listener must never break the write that triggered it.
    }
  }
}

export async function listAgents(email: string): Promise<Agent[]> {
  const db = await getDb();
  const rows = db
    // Teams come first and contiguously, each in hand-off order, then
    // everything else by recency. A pipeline only reads as a pipeline in the
    // order its agents run, and that order is a property of the data, not of
    // whichever page happens to be rendering it.
    //
    // team_order is 1-based and 0 means "unordered", so 0 sorts last within a
    // team instead of jumping to the front.
    .prepare(
      "SELECT * FROM agents WHERE email = ? AND deleted_at IS NULL " +
        "ORDER BY CASE WHEN team IS NULL OR team = '' THEN 1 ELSE 0 END, " +
        "team, CASE WHEN team_order = 0 THEN 2147483647 ELSE team_order END, " +
        "updated_at DESC",
    )
    .all(email) as unknown as AgentRow[];
  return rows.map(toAgent);
}

export async function getAgent(email: string, id: string): Promise<Agent | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM agents WHERE email = ? AND id = ? AND deleted_at IS NULL").get(email, id) as
    | AgentRow
    | undefined;
  return row ? toAgent(row) : null;
}

export async function createAgent(email: string, patch: AgentUpdate): Promise<Agent> {
  const db = await getDb();
  const fields = sanitize(patch);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO agents (id, email, name, description, skill_slugs, working_dir, reference_folders, engine, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    email,
    fields.name,
    fields.description,
    JSON.stringify(fields.skillSlugs),
    fields.workingDir,
    JSON.stringify(fields.referenceFolders),
    fields.engine,
    now,
    now,
  );
  const created = await getAgent(email, id);
  if (!created) throw new Error("Failed to create agent.");
  agentsChanged(email);
  return created;
}

export async function updateAgent(
  email: string,
  id: string,
  patch: AgentUpdate,
): Promise<Agent> {
  const db = await getDb();
  const existing = await getAgent(email, id);
  if (!existing) {
    const e = new Error("Agent not found.") as Error & { code: string };
    e.code = "NOT_FOUND";
    throw e;
  }
  const fields = sanitize(patch);
  db.prepare(
    "UPDATE agents SET name = ?, description = ?, skill_slugs = ?, working_dir = ?, " +
      "reference_folders = ?, engine = ?, updated_at = ? WHERE email = ? AND id = ?",
  ).run(
    fields.name,
    fields.description,
    JSON.stringify(fields.skillSlugs),
    fields.workingDir,
    JSON.stringify(fields.referenceFolders),
    fields.engine,
    new Date().toISOString(),
    email,
    id,
  );
  const updated = await getAgent(email, id);
  if (!updated) throw new Error("Failed to update agent.");
  agentsChanged(email);
  return updated;
}

export async function deleteAgent(email: string, id: string): Promise<void> {
  const db = await getDb();
  // Tombstone, not DELETE: the row has to outlive the deletion so other
  // devices learn about it instead of syncing the agent straight back.
  const ts = new Date().toISOString();
  db.prepare(
    "UPDATE agents SET deleted_at = ?, updated_at = ? WHERE email = ? AND id = ?",
  ).run(ts, ts, email, id);
  agentsChanged(email);
}


/**
 * Insert-or-update an agent synced from a remote Labee server, keyed on the
 * remote agent `id` (so re-syncing is idempotent and preserves identity).
 * Unlike createAgent, it does NOT require a working directory or run any
 * scaffolding side effects — a web-created agent's `workingDir` may not exist on
 * this machine, so we store it verbatim and let the caller flag it for re-pick.
 */
export async function upsertAgentFromRemote(email: string, agent: Agent): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO agents (id, email, name, description, skill_slugs, working_dir, reference_folders, engine, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "email = excluded.email, name = excluded.name, description = excluded.description, " +
      "skill_slugs = excluded.skill_slugs, working_dir = excluded.working_dir, " +
      "reference_folders = excluded.reference_folders, engine = excluded.engine, " +
      "updated_at = excluded.updated_at",
  ).run(
    agent.id,
    email,
    (agent.name ?? "").trim() || "Untitled agent",
    agent.description?.trim() || null,
    JSON.stringify(Array.isArray(agent.skillSlugs) ? agent.skillSlugs : []),
    (agent.workingDir ?? "").trim(),
    JSON.stringify(Array.isArray(agent.referenceFolders) ? agent.referenceFolders : []),
    agent.engine === "codex" ? "codex" : "claude",
    agent.createdAt ?? now,
    now,
  );
}

// ── multi-device sync ────────────────────────────────────────────────────
//
// An agent belongs to the account, so every device holds the same set and
// reconciles against the box. The rule is last-write-wins per agent, compared
// on `updatedAt`: agents are edited rarely, and by one person, so a genuine
// simultaneous edit is vanishingly unlikely — and when it does happen, losing
// the older of two edits is easier to explain than a half-merged agent.
//
// `workingDir` travels verbatim even though it is machine-local. A path that
// doesn't exist here is not an error: the receiving device flags the agent so
// the person can re-pick a folder (see RemoteAgentSyncResult.needsFolder).

/** An agent as it crosses the wire, including tombstones. */
export interface SyncAgent extends Agent {
  /** Set when the agent was deleted; the row travels so the deletion does. */
  deletedAt: string | null;
}

function toSyncAgent(row: AgentRow): SyncAgent {
  return { ...toAgent(row), deletedAt: row.deleted_at ?? null };
}

/** Every agent for this account, tombstones included. The sync payload. */
export async function listAgentsForSync(email: string): Promise<SyncAgent[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM agents WHERE email = ? ORDER BY updated_at DESC")
    .all(email) as unknown as AgentRow[];
  return rows.map(toSyncAgent);
}

/** True when `incoming` should replace what we hold. Ties keep the local row,
 *  so a repeated sync of identical data is a no-op rather than a rewrite. */
function incomingWins(incoming: SyncAgent, local: AgentRow | undefined): boolean {
  if (!local) return true;
  return String(incoming.updatedAt ?? "") > String(local.updated_at ?? "");
}

/**
 * Merge a device's agents into this account and return the reconciled set.
 *
 * Symmetric by design: the box and each desktop run the same function over the
 * same payload, so whichever side initiates, both end up with the same rows.
 * The caller applies the returned set verbatim.
 */
export async function mergeAgents(email: string, incoming: SyncAgent[]): Promise<SyncAgent[]> {
  const db = await getDb();
  const existing = new Map<string, AgentRow>(
    (
      db.prepare("SELECT * FROM agents WHERE email = ?").all(email) as unknown as AgentRow[]
    ).map((r) => [r.id, r]),
  );

  const upsert = db.prepare(
    "INSERT INTO agents (id, email, name, description, skill_slugs, working_dir, reference_folders, " +
      "engine, team, team_order, created_at, updated_at, deleted_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "email = excluded.email, name = excluded.name, description = excluded.description, " +
      "skill_slugs = excluded.skill_slugs, working_dir = excluded.working_dir, " +
      "reference_folders = excluded.reference_folders, engine = excluded.engine, " +
      "team = excluded.team, team_order = excluded.team_order, " +
      "updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
  );

  // Explicit BEGIN/COMMIT rather than db.transaction(): the adapter exposes
  // only prepare() and exec(), because node:sqlite (the packaged runtime) has
  // no transaction() helper — only bun:sqlite does.
  db.exec("BEGIN");
  try {
    for (const a of incoming) {
      if (!a?.id) continue;
      if (!incomingWins(a, existing.get(a.id))) continue;
      upsert.run(
        a.id,
        email,
        (a.name ?? "").trim() || "Untitled agent",
        a.description?.trim() || null,
        JSON.stringify(Array.isArray(a.skillSlugs) ? a.skillSlugs : []),
        (a.workingDir ?? "").trim(),
        JSON.stringify(Array.isArray(a.referenceFolders) ? a.referenceFolders : []),
        a.engine === "codex" ? "codex" : "claude",
        a.team ?? null,
        Number(a.teamOrder ?? 0),
        a.createdAt ?? new Date().toISOString(),
        a.updatedAt ?? new Date().toISOString(),
        a.deletedAt ?? null,
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Deliberately does NOT call agentsChanged(): every caller of mergeAgents is
  // itself a sync, and notifying here would make the listener sync again, and
  // again. Local edits notify; reconciliation does not.
  return listAgentsForSync(email);
}
