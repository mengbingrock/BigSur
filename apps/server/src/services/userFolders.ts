// Places on this machine that a person has granted Labee access to: a whole
// folder, or a single protocol file.
//
// A grant means three things, which is why it is stored rather than inferred:
// the protocols it covers are listed in the library, they are indexed for
// semantic search, and they can be written to. Everything outside the grants
// (and the built-in roots) stays untouched.
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
interface Grant {
  path: string;
  kind: "folder" | "file";
}

const cache = new Map<string, Grant[]>();

/** Load every grant into the cache. Called once at startup; the table is small
 *  (a handful of rows per person) so loading it whole is cheaper than lazily
 *  filling it and risking a first call that sees nothing. */
export async function primeFolderCache(): Promise<void> {
  try {
    const db = await getDb();
    const rows = db.prepare("SELECT email, path, kind FROM user_folders").all() as Array<{
      email: string;
      path: string;
      kind: string;
    }>;
    cache.clear();
    for (const r of rows) {
      const list = cache.get(r.email) ?? [];
      list.push({ path: r.path, kind: r.kind === "file" ? "file" : "folder" });
      cache.set(r.email, list);
    }
  } catch {
    // An unreadable table just means no grants; the built-in roots still work.
  }
}

async function refresh(email: string): Promise<void> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT path, kind FROM user_folders WHERE email = ?")
    .all(email) as Array<{ path: string; kind: string }>;
  cache.set(
    email,
    rows.map((r) => ({ path: r.path, kind: r.kind === "file" ? "file" : "folder" })),
  );
}

/** Granted directories that still exist. Safe to call from sync code. */
export function grantedFolderPathsSync(email?: string): string[] {
  if (!email) return [];
  return (cache.get(email) ?? [])
    .filter((g) => g.kind === "folder" && fs.existsSync(g.path))
    .map((g) => g.path);
}

/** Granted single files that still exist. Each is read as one protocol. */
export function grantedFilePathsSync(email?: string): string[] {
  if (!email) return [];
  return (cache.get(email) ?? [])
    .filter((g) => g.kind === "file" && fs.existsSync(g.path))
    .map((g) => g.path);
}

export interface UserFolder {
  path: string;
  label: string;
  /** A whole folder, or a single protocol file. */
  kind: "folder" | "file";
  addedAt: string;
  /** False when it has since been moved or deleted. */
  exists: boolean;
}

/** Extensions a single-file grant may point at. A protocol has to be readable
 *  text; anything else would fail to parse and sit in the list looking broken. */
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst"]);

function invalid(message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = "INVALID";
  return err;
}

/** Resolve and check a candidate grant, returning the real path and what kind
 *  of thing it is. Throws with a reason a person can act on. */
function normalise(raw: string): { real: string; kind: "folder" | "file" } {
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
  const kind: "folder" | "file" = stat.isDirectory() ? "folder" : "file";
  if (kind === "file" && !DOC_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw invalid("Pick a text document: .md, .markdown, .txt or .rst.");
  }

  // Confined to the home directory: same rule as the picker, so a grant cannot
  // reach system files or another account.
  const home = fs.realpathSync(os.homedir());
  if (real !== home && !real.startsWith(home + path.sep)) {
    throw invalid("Pick something inside your home directory.");
  }
  if (real === home) {
    throw invalid("Pick a folder inside your home directory, not the whole of it.");
  }
  return { real, kind };
}

export async function listUserFolders(email: string): Promise<UserFolder[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT path, label, kind, added_at FROM user_folders WHERE email = ? ORDER BY path")
    .all(email) as Array<{ path: string; label: string; kind: string; added_at: string }>;
  return rows.map((r) => ({
    path: r.path,
    label: r.label || path.basename(r.path),
    kind: r.kind === "file" ? ("file" as const) : ("folder" as const),
    addedAt: r.added_at,
    exists: fs.existsSync(r.path),
  }));
}

export async function addUserFolder(
  email: string,
  rawPath: string,
  label?: string,
): Promise<UserFolder> {
  const { real, kind } = normalise(rawPath);
  const existing = await listUserFolders(email);
  if (existing.some((f) => f.path === real)) {
    throw invalid(`That ${kind} is already on the list.`);
  }
  // Nesting would cover the same protocols twice and make "where does this
  // live" ambiguous, so refuse in both directions. A file inside an already
  // granted folder is the common case of this.
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
    "INSERT INTO user_folders (email, path, label, kind, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(email, real, (label ?? "").trim(), kind, now);
  await refresh(email);
  return {
    path: real,
    label: (label ?? "").trim() || path.basename(real),
    kind,
    addedAt: now,
    exists: true,
  };
}

/** Revoke a grant. Only the row goes: nothing on disk is touched. */
export async function removeUserFolder(email: string, rawPath: string): Promise<void> {
  const db = await getDb();
  const target = (rawPath ?? "").trim();
  const r = db
    .prepare("DELETE FROM user_folders WHERE email = ? AND path = ?")
    .run(email, target) as { changes?: number | bigint } | undefined;
  if (Number(r?.changes ?? 0) === 0) throw invalid("That is not on the list.");
  await refresh(email);
}
