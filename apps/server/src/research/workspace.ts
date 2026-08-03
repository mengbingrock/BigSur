// Run workspace on disk: <userDeckDir(email)>/runs/<runId>/. All artifact
// writes go through writeArtifact so every file lands in the index with a
// hash — that's what makes the chain-of-evidence auditable after the fact.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResearchStage } from "@labee/contracts";
import { userDeckDir } from "../services/deck";
import { upsertArtifact } from "./runsDb";
import { emitRunEvent } from "./events";

export function runWorkspaceDir(email: string, runId: string): string {
  return path.join(userDeckDir(email), "runs", runId);
}

const STAGE_DIRS = [
  "tasks",
  "evidence",
  "stage1/filter",
  "stage1/notes",
  "stage1/directions",
  "stage1/audit",
  "stage2/nodes",
  "stage2/ablations",
  "stage3/ground",
  "stage3/critic",
  "stage3/draft",
  "stage3/final",
  "stage3/verify",
] as const;

export async function initWorkspace(workspaceDir: string): Promise<void> {
  for (const dir of STAGE_DIRS) {
    await fs.mkdir(path.join(workspaceDir, dir), { recursive: true });
  }
}

/** Resolve a workspace-relative path, refusing anything that escapes it.
 *  (deck.ts's safeResolveSubpath caps nesting at 2 segments — run workspaces
 *  are deeper, so they get their own confinement.) */
export function safeRunPath(workspaceDir: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0 || path.isAbsolute(relPath)) {
    throw Object.assign(new Error(`Invalid path: ${JSON.stringify(relPath)}`), {
      code: "INVALID",
    });
  }
  const resolved = path.resolve(workspaceDir, relPath);
  const rel = path.relative(path.resolve(workspaceDir), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(new Error(`Path escapes workspace: ${JSON.stringify(relPath)}`), {
      code: "FORBIDDEN",
    });
  }
  return resolved;
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface WriteArtifactOpts {
  runId: string;
  workspaceDir: string;
  stage: ResearchStage;
  kind: string;
  relPath: string;
  content: string;
  producedByTask?: string | null;
  meta?: unknown;
}

/** Write a file into the workspace and index it (idempotent per rel_path). */
export async function writeArtifact(opts: WriteArtifactOpts): Promise<string> {
  const abs = safeRunPath(opts.workspaceDir, opts.relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, opts.content, "utf8");
  const hash = sha256(opts.content);
  const id = await upsertArtifact({
    runId: opts.runId,
    stage: opts.stage,
    kind: opts.kind,
    relPath: opts.relPath,
    producedByTask: opts.producedByTask ?? null,
    sha256: hash,
    bytes: Buffer.byteLength(opts.content, "utf8"),
    meta: opts.meta,
  });
  await emitRunEvent(
    opts.runId,
    "artifact_created",
    { artifactId: id, kind: opts.kind, relPath: opts.relPath, bytes: Buffer.byteLength(opts.content, "utf8") },
    { stage: opts.stage, taskId: opts.producedByTask ?? null },
  );
  return id;
}

/** Index a file that an agent (e.g. the solver) wrote itself. */
export async function indexExistingFile(opts: {
  runId: string;
  workspaceDir: string;
  stage: ResearchStage;
  kind: string;
  relPath: string;
  producedByTask?: string | null;
  meta?: unknown;
}): Promise<string | null> {
  const abs = safeRunPath(opts.workspaceDir, opts.relPath);
  let content: Buffer;
  try {
    content = await fs.readFile(abs);
  } catch {
    return null;
  }
  const id = await upsertArtifact({
    runId: opts.runId,
    stage: opts.stage,
    kind: opts.kind,
    relPath: opts.relPath,
    producedByTask: opts.producedByTask ?? null,
    sha256: sha256(content),
    bytes: content.byteLength,
    meta: opts.meta,
  });
  await emitRunEvent(
    opts.runId,
    "artifact_created",
    { artifactId: id, kind: opts.kind, relPath: opts.relPath, bytes: content.byteLength },
    { stage: opts.stage, taskId: opts.producedByTask ?? null },
  );
  return id;
}

export async function readRunFile(workspaceDir: string, relPath: string): Promise<string> {
  const abs = safeRunPath(workspaceDir, relPath);
  return fs.readFile(abs, "utf8");
}

export async function runFileExists(workspaceDir: string, relPath: string): Promise<boolean> {
  try {
    const abs = safeRunPath(workspaceDir, relPath);
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Append a raw CLI transcript line for a task (audit trail). */
export async function appendTranscript(
  workspaceDir: string,
  taskId: string,
  line: unknown,
): Promise<void> {
  const abs = safeRunPath(workspaceDir, path.join("tasks", `${taskId}.jsonl`));
  await fs.appendFile(abs, JSON.stringify(line) + "\n", "utf8");
}

/** Clip a string to a byte budget for prompt inlining (keeps head + tail). */
export function clipForPrompt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n\n[… clipped ${Buffer.byteLength(text, "utf8") - maxBytes} bytes …]\n\n${tail}`;
}
