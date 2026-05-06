import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { userSlug } from "./skills";
import { formatBytes, type DeckFile } from "./deck-shared";

/**
 * Per-user persistent file storage. Mounted into chat workspaces at ./deck/
 * so the spawned claude process can read uploaded files and write outputs
 * that survive across sessions.
 *
 * Layout:
 *   <DECK_ROOT>/<email-slug>/<filename>
 *
 * DECK_ROOT defaults to ~/monterey-decks; override with the env var. The
 * deployed Lightsail box uses /home/ubuntu/monterey-decks (set in
 * .env.production by scripts/provision-server.sh).
 */

export { formatBytes, type DeckFile };

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export function getDeckRoot(): string {
  return process.env.DECK_ROOT || path.join(os.homedir(), "monterey-decks");
}

export function getMaxUploadBytes(): number {
  const v = process.env.DECK_MAX_BYTES;
  if (!v) return DEFAULT_MAX_BYTES;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export function userDeckDir(email: string): string {
  return path.join(getDeckRoot(), userSlug(email));
}

/**
 * Resolve a path like "a" or "a/b" inside deckDir. Each segment is
 * validated by the strict flat-name rules, so this allows at most one
 * level of nesting (good enough for the panel's expanded folders) without
 * letting attackers escape via deeper paths or `..` traversal.
 */
function safeResolveSubpath(deckDir: string, rawPath: string): string {
  if (typeof rawPath !== "string") {
    const err = new Error("Path must be a string.");
    (err as Error & { code: string }).code = "BAD_NAME";
    throw err;
  }
  const parts = rawPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 2) {
    const err = new Error(`Invalid path: ${JSON.stringify(rawPath)}`);
    (err as Error & { code: string }).code = "BAD_NAME";
    throw err;
  }
  let current = deckDir;
  for (const segment of parts) {
    current = safeResolve(current, segment);
  }
  // Final defense: never leave deckDir.
  const rel = path.relative(deckDir, current);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error(`Path escapes deck: ${JSON.stringify(rawPath)}`);
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  return current;
}

/**
 * Reject filenames that contain path separators, are dotfiles starting
 * the path, or end up outside the user's deck after resolution.
 */
function safeResolve(deckDir: string, filename: string): string {
  if (
    !filename ||
    typeof filename !== "string" ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".." ||
    filename.length > 255
  ) {
    const err = new Error(`Invalid filename: ${JSON.stringify(filename)}`);
    (err as Error & { code: string }).code = "BAD_NAME";
    throw err;
  }
  const target = path.join(deckDir, filename);
  // Defense in depth: ensure the resolved absolute path stays inside deckDir
  const rel = path.relative(deckDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error(`Filename escapes deck: ${JSON.stringify(filename)}`);
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  return target;
}

export async function listDeck(email: string): Promise<DeckFile[]> {
  const dir = userDeckDir(email);
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: DeckFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // hide dotfiles
    if (!entry.isFile() && !entry.isDirectory()) continue; // skip symlinks/sockets
    try {
      const stat = await fsp.stat(path.join(dir, entry.name));
      out.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
        size: entry.isDirectory() ? 0 : stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  // Directories first, then by recency.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  });
  return out;
}

/**
 * List the contents of a top-level subdirectory. Returns files only — we
 * don't surface deeper nesting in the panel yet.
 */
export async function listDeckSubdir(
  email: string,
  subdir: string,
): Promise<DeckFile[]> {
  const deckDir = userDeckDir(email);
  const target = safeResolve(deckDir, subdir);
  if (!fs.existsSync(target)) {
    const err = new Error(`Folder "${subdir}" not found.`);
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  if (!(await fsp.stat(target)).isDirectory()) {
    const err = new Error(`"${subdir}" is not a folder.`);
    (err as Error & { code: string }).code = "BAD_KIND";
    throw err;
  }
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const out: DeckFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
    try {
      const stat = await fsp.stat(path.join(target, entry.name));
      out.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
        size: entry.isDirectory() ? 0 : stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  });
  return out;
}

export async function saveDeckFile(
  email: string,
  filename: string,
  data: Uint8Array | Buffer,
  options?: { subdir?: string },
): Promise<DeckFile> {
  const max = getMaxUploadBytes();
  if (data.byteLength > max) {
    const err = new Error(
      `File is ${formatBytes(data.byteLength)} — exceeds limit of ${formatBytes(max)}.`,
    );
    (err as Error & { code: string }).code = "TOO_LARGE";
    throw err;
  }
  const deckDir = userDeckDir(email);
  await fsp.mkdir(deckDir, { recursive: true });
  let writeDir = deckDir;
  let displayName = filename;
  const subdir = options?.subdir?.trim();
  if (subdir) {
    const subPath = safeResolve(deckDir, subdir);
    if (!fs.existsSync(subPath)) {
      const err = new Error(`Folder "${subdir}" does not exist.`);
      (err as Error & { code: string }).code = "NOT_FOUND";
      throw err;
    }
    if (!(await fsp.stat(subPath)).isDirectory()) {
      const err = new Error(`"${subdir}" is not a folder.`);
      (err as Error & { code: string }).code = "BAD_KIND";
      throw err;
    }
    writeDir = subPath;
    displayName = `${subdir}/${filename}`;
  }
  const target = safeResolve(writeDir, filename);
  await fsp.writeFile(target, data);
  const stat = await fsp.stat(target);
  return {
    name: displayName,
    kind: "file",
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

/**
 * Move an entry into a destination folder. Source may be top-level or one
 * level nested (e.g. "file.txt" or "folder/file.txt"). Destination is a
 * top-level folder name, OR an empty string to move the entry to the deck
 * root.
 */
export async function moveDeckEntryToDir(
  email: string,
  sourcePath: string,
  intoDir: string,
): Promise<DeckFile> {
  const deckDir = userDeckDir(email);
  const src = safeResolveSubpath(deckDir, sourcePath);
  if (!fs.existsSync(src)) {
    const err = new Error("Source entry not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const baseName = path.basename(src);

  // Empty intoDir means "move to root".
  let dstParent: string;
  if (intoDir === "" || intoDir === "/") {
    dstParent = deckDir;
  } else {
    dstParent = safeResolve(deckDir, intoDir);
    if (!fs.existsSync(dstParent)) {
      const err = new Error(`Folder "${intoDir}" not found.`);
      (err as Error & { code: string }).code = "NOT_FOUND";
      throw err;
    }
    if (!(await fsp.stat(dstParent)).isDirectory()) {
      const err = new Error(`"${intoDir}" is not a folder.`);
      (err as Error & { code: string }).code = "BAD_KIND";
      throw err;
    }
  }
  if (src === dstParent) {
    const err = new Error("Cannot move a folder into itself.");
    (err as Error & { code: string }).code = "BAD_TARGET";
    throw err;
  }
  // No-op when moving to the same parent (drop on the same folder).
  if (path.dirname(src) === dstParent) {
    const stat = await fsp.stat(src);
    const rel = path.relative(deckDir, src).split(path.sep).join("/");
    return {
      name: rel,
      kind: stat.isDirectory() ? "dir" : "file",
      size: stat.isDirectory() ? 0 : stat.size,
      modified: stat.mtime.toISOString(),
    };
  }
  const dst = safeResolve(dstParent, baseName);
  if (fs.existsSync(dst)) {
    const err = new Error(
      intoDir
        ? `An entry named "${baseName}" already exists inside "${intoDir}".`
        : `An entry named "${baseName}" already exists at the root.`,
    );
    (err as Error & { code: string }).code = "EXISTS";
    throw err;
  }
  await fsp.rename(src, dst);
  const stat = await fsp.stat(dst);
  const rel = path.relative(deckDir, dst).split(path.sep).join("/");
  return {
    name: rel,
    kind: stat.isDirectory() ? "dir" : "file",
    size: stat.isDirectory() ? 0 : stat.size,
    modified: stat.mtime.toISOString(),
  };
}

export async function createDeckDir(
  email: string,
  name: string,
): Promise<DeckFile> {
  const deckDir = userDeckDir(email);
  await fsp.mkdir(deckDir, { recursive: true });
  const target = safeResolve(deckDir, name);
  if (fs.existsSync(target)) {
    const err = new Error(
      `An entry named "${name}" already exists in your working directory.`,
    );
    (err as Error & { code: string }).code = "EXISTS";
    throw err;
  }
  await fsp.mkdir(target);
  const stat = await fsp.stat(target);
  return {
    name,
    kind: "dir",
    size: 0,
    modified: stat.mtime.toISOString(),
  };
}

/**
 * Rename an entry in place. `oldPath` may be `name` (top-level) or
 * `subdir/name` (one-level nested). `newName` is always a flat name; the
 * entry stays in its existing parent directory.
 */
export async function renameDeckEntry(
  email: string,
  oldPath: string,
  newName: string,
): Promise<DeckFile> {
  const deckDir = userDeckDir(email);
  const src = safeResolveSubpath(deckDir, oldPath);
  if (!fs.existsSync(src)) {
    const err = new Error("Source entry not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const parent = path.dirname(src);
  const dst = safeResolve(parent, newName);
  if (fs.existsSync(dst) && src !== dst) {
    const err = new Error(
      `An entry named "${newName}" already exists in that folder.`,
    );
    (err as Error & { code: string }).code = "EXISTS";
    throw err;
  }
  await fsp.rename(src, dst);
  const stat = await fsp.stat(dst);
  // Reconstruct the qualified display name (preserves parent if any).
  const rel = path.relative(deckDir, dst).split(path.sep).join("/");
  return {
    name: rel,
    kind: stat.isDirectory() ? "dir" : "file",
    size: stat.isDirectory() ? 0 : stat.size,
    modified: stat.mtime.toISOString(),
  };
}

export async function deleteDeckDir(
  email: string,
  name: string,
): Promise<void> {
  const deckDir = userDeckDir(email);
  const target = safeResolve(deckDir, name);
  if (!fs.existsSync(target)) {
    const err = new Error("Directory not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) {
    const err = new Error("Not a directory.");
    (err as Error & { code: string }).code = "BAD_KIND";
    throw err;
  }
  await fsp.rm(target, { recursive: true, force: true });
}

export async function readDeckFile(
  email: string,
  pathFromDeck: string,
): Promise<{ data: Buffer; size: number; modified: string }> {
  const deckDir = userDeckDir(email);
  const target = safeResolveSubpath(deckDir, pathFromDeck);
  if (!fs.existsSync(target)) {
    const err = new Error("File not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    const err = new Error("Not a regular file.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const data = await fsp.readFile(target);
  return { data, size: stat.size, modified: stat.mtime.toISOString() };
}

export async function deleteDeckFile(
  email: string,
  filename: string,
): Promise<void> {
  const deckDir = userDeckDir(email);
  const target = safeResolve(deckDir, filename);
  if (!fs.existsSync(target)) {
    const err = new Error("File not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  await fsp.unlink(target);
}

/**
 * Delete a deck entry — file or directory, top-level or one level nested.
 * Directories are removed recursively.
 */
export async function deleteDeckEntry(
  email: string,
  pathFromDeck: string,
): Promise<void> {
  const deckDir = userDeckDir(email);
  const target = safeResolveSubpath(deckDir, pathFromDeck);
  if (!fs.existsSync(target)) {
    const err = new Error("Entry not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  const stat = await fsp.stat(target);
  if (stat.isDirectory()) {
    await fsp.rm(target, { recursive: true, force: true });
  } else {
    await fsp.unlink(target);
  }
}

