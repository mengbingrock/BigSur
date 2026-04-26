import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Workspaces live in tmpdir; each spawned `claude` session gets one.
// The cwd becomes the session's jail for file I/O (the assistant can Write
// there, Bash scripts run there). We keep the dir around after the stream
// closes so the browser can download produced files.

const WORKSPACE_PREFIX = "monterey-chat-";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

interface Entry {
  dir: string;
  timer: NodeJS.Timeout;
}

// Process-global map; survives across hot-reloads in dev via globalThis.
declare global {
  // eslint-disable-next-line no-var
  var __monterey_workspaces: Map<string, Entry> | undefined;
}
const workspaces: Map<string, Entry> =
  globalThis.__monterey_workspaces ?? new Map();
globalThis.__monterey_workspaces = workspaces;

export function isWorkspaceId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length < 128;
}

export function workspaceIdFromDir(dir: string): string {
  const base = path.basename(dir);
  if (!base.startsWith(WORKSPACE_PREFIX)) {
    throw new Error(`refusing to track non-prefix dir: ${base}`);
  }
  return base;
}

export async function createWorkspace(): Promise<{
  id: string;
  dir: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  const id = path.basename(dir);
  return { id, dir };
}

export function touchWorkspace(id: string, dir: string, ttlMs: number = DEFAULT_TTL_MS) {
  const existing = workspaces.get(id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    workspaces.delete(id);
    void fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }, ttlMs);
  // Unref so the timer doesn't keep the process alive.
  timer.unref?.();
  workspaces.set(id, { dir, timer });
}

export function getWorkspaceDir(id: string): string | null {
  if (!isWorkspaceId(id)) return null;
  const entry = workspaces.get(id);
  return entry?.dir ?? null;
}

export async function deleteWorkspace(id: string) {
  const entry = workspaces.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  workspaces.delete(id);
  await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
}

export interface ProducedFile {
  relPath: string;
  size: number;
  mtimeMs: number;
}

// Walk a workspace for files the assistant produced. Skip our .claude
// scaffolding (which contains skill symlinks, not output files), the
// per-user deck mount (persistent — those files surface on /deck), and
// hidden dotfiles.
export async function scanProducedFiles(
  dir: string,
  since: number,
): Promise<ProducedFile[]> {
  const out: ProducedFile[] = [];

  async function walk(subdir: string, relBase: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(subdir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".claude") continue;
      if (relBase === "" && e.name === "deck") continue;
      if (e.name.startsWith(".")) continue;
      const full = path.join(subdir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          await walk(full, rel);
        } else if (stat.isFile() && stat.mtimeMs >= since) {
          out.push({
            relPath: rel,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        }
      } catch {
        // skip
      }
    }
  }

  await walk(dir, "");
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
