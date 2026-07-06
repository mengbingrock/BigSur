// Read-only file access scoped to an agent's working directory and reference
// folders. Lets the chat surface what the agent produced/reads without
// repointing the whole mutable deck stack. Every path is validated to live
// within one of the agent's configured roots.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DeckFile } from "@labee/contracts";
import { getAgent } from "./agents";

export interface AgentRoot {
  /** "working" or "ref:<abs>" — identifies which configured root this is. */
  kind: "working" | "reference";
  label: string;
  path: string;
}

async function rootsFor(email: string, agentId: string): Promise<AgentRoot[]> {
  const agent = await getAgent(email, agentId);
  if (!agent) {
    const e = new Error("Agent not found.") as Error & { code: string };
    e.code = "NOT_FOUND";
    throw e;
  }
  const roots: AgentRoot[] = [];
  if (agent.workingDir) {
    roots.push({ kind: "working", label: "Working directory", path: path.resolve(agent.workingDir) });
  }
  for (const f of agent.referenceFolders) {
    roots.push({ kind: "reference", label: path.basename(f) || f, path: path.resolve(f) });
  }
  return roots;
}

/** Resolve `target` and confirm it lives within one of the agent's roots. */
function assertWithin(roots: AgentRoot[], target: string): string {
  const resolved = path.resolve(target);
  for (const root of roots) {
    const rel = path.relative(root.path, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  }
  const e = new Error("Path is outside the agent's folders.") as Error & { code: string };
  e.code = "FORBIDDEN";
  throw e;
}

// Only hide genuine noise. Agent-internal entries (.skill/, .claude/,
// agent-memory.md, AGENTS.md) are shown so users can see the full working dir.
const HIDDEN_ENTRIES = new Set([".git", ".DS_Store", "node_modules"]);

async function readEntries(dir: string): Promise<DeckFile[]> {
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: DeckFile[] = [];
  for (const entry of entries) {
    if (HIDDEN_ENTRIES.has(entry.name)) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
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
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  });
  return out;
}

/** The agent's roots (working dir + reference folders) for display. */
export async function agentRoots(email: string, agentId: string): Promise<AgentRoot[]> {
  return rootsFor(email, agentId);
}

/** List a directory inside one of the agent's roots (defaults to working dir). */
export async function listAgentDir(
  email: string,
  agentId: string,
  absPath?: string,
): Promise<{ path: string; files: DeckFile[] }> {
  const roots = await rootsFor(email, agentId);
  const target = absPath ? assertWithin(roots, absPath) : roots[0]?.path;
  if (!target) return { path: "", files: [] };
  return { path: target, files: await readEntries(target) };
}

/** Read a file inside one of the agent's roots. */
export async function readAgentFile(
  email: string,
  agentId: string,
  absPath: string,
): Promise<{ data: Buffer; name: string }> {
  const roots = await rootsFor(email, agentId);
  const target = assertWithin(roots, absPath);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    const e = new Error("Not a file.") as Error & { code: string };
    e.code = "NOT_FOUND";
    throw e;
  }
  return { data: await fsp.readFile(target), name: path.basename(target) };
}
