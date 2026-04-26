import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { userSlug } from "./skills";

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

export interface DeckFile {
  name: string;
  size: number;
  modified: string; // ISO 8601
}

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
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue; // hide dotfiles
    try {
      const stat = await fsp.stat(path.join(dir, entry.name));
      out.push({
        name: entry.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}

export async function saveDeckFile(
  email: string,
  filename: string,
  data: Uint8Array | Buffer,
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
  const target = safeResolve(deckDir, filename);
  await fsp.writeFile(target, data);
  const stat = await fsp.stat(target);
  return {
    name: filename,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

export async function readDeckFile(
  email: string,
  filename: string,
): Promise<{ data: Buffer; size: number; modified: string }> {
  const deckDir = userDeckDir(email);
  const target = safeResolve(deckDir, filename);
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
