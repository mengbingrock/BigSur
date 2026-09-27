// Folders on this machine that a person has granted Labee access to.
//
// A grant means three things, which is why it is stored rather than inferred:
// protocols inside the folder are listed in the library, they are indexed for
// semantic search, and new ones can be written there. Everything outside the
// grants (and the built-in roots) stays untouched.
//
// Grants are confined to the home directory, the same boundary the folder
// picker uses, so a stored row can never be walked up into `/` or another
// account's files even if the table were edited by hand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "./db";

/** Grants, by email, kept in memory so the artifact scanner — which is
 *  synchronous and called on nearly every request — can consult them without
 *  a database round trip. Primed at boot and updated on every change. */
const cache = new Map<string, string[]>();

/** Load every grant into the cache. Called once at startup; the table is small
 *  (a handful of rows per person) so loading it whole is cheaper than lazily
 *  filling it and risking a first call that sees nothing. */
export async function primeFolderCache(): Promise<void> {
  try {
    const db = await getDb();
    const rows = db.prepare("SELECT email, path FROM user_folders").all() as Array<{
      email: string;
      path: string;
    }>;
    cache.clear();
    for (const r of rows) {
      const list = cache.get(r.email) ?? [];
      list.push(r.path);
      cache.set(r.email, list);
    }
  } catch {
    // An unreadable table just means no grants; the built-in roots still work.
  }
}

async function refresh(email: string): Promise<void> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT path FROM user_folders WHERE email = ?")
    .all(email) as Array<{ path: string }>;
  cache.set(email, rows.map((r) => r.path));
}

/** Granted folders that still exist on disk. Safe to call from sync code. */
export function grantedFolderPathsSync(email?: string): string[] {
  if (!email) return [];
  return (cache.get(email) ?? []).filter((p) => fs.existsSync(p));
}

export interface UserFolder {
  path: string;
  label: string;
  addedAt: string;
  /** False when the directory has since been moved or deleted. */
  exists: boolean;
}

function invalid(message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = "INVALID";
  return err;
}

/** Resolve and check a candidate grant. Throws with a readable reason. */
function normalise(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw invalid("Choose a folder first.");
  const expanded = trimmed.startsWith("~")
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
  if (!path.isAbsolute(expanded)) throw invalid("Give the full path to the folder.");

  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw invalid("That folder does not exist.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw invalid("That folder could not be read.");
  }
  if (!stat.isDirectory()) throw invalid("That is a file, not a folder.");

  // Confined to the home directory: same rule as the folder picker, so a grant
  // cannot reach system files or another account.
  const home = fs.realpathSync(os.homedir());
  if (real !== home && !real.startsWith(home + path.sep)) {
    throw invalid("Pick a folder inside your home directory.");
  }
  if (real === home) {
    throw invalid("Pick a folder inside your home directory, not the whole of it.");
  }
  return real;
}

export async function listUserFolders(email: string): Promise<UserFolder[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT path, label, added_at FROM user_folders WHERE email = ? ORDER BY path")
    .all(email) as Array<{ path: string; label: string; added_at: string }>;
  return rows.map((r) => ({
    path: r.path,
    label: r.label || path.basename(r.path),
    addedAt: r.added_at,
    exists: fs.existsSync(r.path),
  }));
}

export async function addUserFolder(
  email: string,
  rawPath: string,
  label?: string,
): Promise<UserFolder> {
  const real = normalise(rawPath);
  const existing = await listUserFolders(email);
  if (existing.some((f) => f.path === real)) {
    throw invalid("That folder is already on the list.");
  }
  // Nesting would index the same protocols twice and make "which folder does
  // this live in" ambiguous, so refuse in both directions.
  for (const f of existing) {
    if (real.startsWith(f.path + path.sep)) {
      throw invalid(`Already covered by ${f.label || f.path}.`);
    }
    if (f.path.startsWith(real + path.sep)) {
      throw invalid(`This contains ${f.label || f.path}, which is already on the list.`);
    }
  }
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO user_folders (email, path, label, added_at) VALUES (?, ?, ?, ?)",
  ).run(email, real, (label ?? "").trim(), now);
  await refresh(email);
  return { path: real, label: (label ?? "").trim() || path.basename(real), addedAt: now, exists: true };
}

/** Revoke a grant. Only the row goes: files on disk are never touched. */
export async function removeUserFolder(email: string, rawPath: string): Promise<void> {
  const db = await getDb();
  const target = (rawPath ?? "").trim();
  const r = db
    .prepare("DELETE FROM user_folders WHERE email = ? AND path = ?")
    .run(email, target) as { changes?: number | bigint } | undefined;
  if (Number(r?.changes ?? 0) === 0) throw invalid("That folder is not on the list.");
  await refresh(email);
}
