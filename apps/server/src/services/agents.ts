// Saved agent presets (per user): selected skills + a working artifact
// directory + folders of reference protocols. Backed by the `agents` table.
import crypto from "node:crypto";
import type { Agent, AgentEngine, AgentUpdate } from "@labee/contracts";
import { getDb } from "./db";

interface AgentRow {
  id: string;
  email: string;
  name: string;
  description: string | null;
  skill_slugs: string;
  working_dir: string;
  reference_folders: string;
  engine: string | null;
  created_at: string;
  updated_at: string;
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

export async function listAgents(email: string): Promise<Agent[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM agents WHERE email = ? ORDER BY updated_at DESC")
    .all(email) as unknown as AgentRow[];
  return rows.map(toAgent);
}

export async function getAgent(email: string, id: string): Promise<Agent | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM agents WHERE email = ? AND id = ?").get(email, id) as
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
  return updated;
}

export async function deleteAgent(email: string, id: string): Promise<void> {
  const db = await getDb();
  db.prepare("DELETE FROM agents WHERE email = ? AND id = ?").run(email, id);
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
