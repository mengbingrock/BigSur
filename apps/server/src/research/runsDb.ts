// Prepared-statement CRUD over the six research_* tables. Same style as the
// other services: async getDb(), synchronous statements, ISO-8601 timestamps.
import crypto from "node:crypto";
import { getDb } from "../services/db";
import type { ResearchStage } from "@labee/contracts";
import type { RunRow, RunSpec } from "./types";

const now = () => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    email: String(r.email),
    title: String(r.title),
    spec: JSON.parse(String(r.spec_json)) as RunSpec,
    status: String(r.status),
    stage: (r.stage as ResearchStage | null) ?? null,
    workspaceDir: String(r.workspace_dir),
    failReason: (r.fail_reason as string | null) ?? null,
    costUsd: Number(r.cost_usd ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

export async function insertRun(opts: {
  email: string;
  spec: RunSpec;
  workspaceDir: string;
}): Promise<RunRow> {
  const db = await getDb();
  const id = newId("run");
  const ts = now();
  db.prepare(
    "INSERT INTO research_runs (id, email, title, spec_json, status, stage, workspace_dir, cost_usd, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'queued', NULL, ?, 0, ?, ?)",
  ).run(id, opts.email, opts.spec.title, JSON.stringify(opts.spec), opts.workspaceDir, ts, ts);
  return (await getRunById(id))!;
}

export async function getRunById(id: string): Promise<RunRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id);
  return row ? rowToRun(row) : null;
}

export async function getRun(email: string, id: string): Promise<RunRow | null> {
  const run = await getRunById(id);
  return run && run.email === email ? run : null;
}

export async function listRuns(email: string): Promise<RunRow[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM research_runs WHERE email = ? ORDER BY created_at DESC")
    .all(email);
  return rows.map(rowToRun);
}

export async function updateRun(
  id: string,
  patch: {
    status?: string;
    stage?: ResearchStage | null;
    failReason?: string | null;
    finished?: boolean;
  },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.stage !== undefined) {
    sets.push("stage = ?");
    vals.push(patch.stage);
  }
  if (patch.failReason !== undefined) {
    sets.push("fail_reason = ?");
    vals.push(patch.failReason);
  }
  if (patch.finished) {
    sets.push("finished_at = ?");
    vals.push(now());
  }
  vals.push(id);
  db.prepare(`UPDATE research_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export async function setRunWorkspace(id: string, workspaceDir: string): Promise<void> {
  const db = await getDb();
  db.prepare("UPDATE research_runs SET workspace_dir = ?, updated_at = ? WHERE id = ?").run(
    workspaceDir,
    now(),
    id,
  );
}

/** Accumulate CLI cost onto the run; returns the new total. */
export async function addRunCost(id: string, deltaUsd: number): Promise<number> {
  const db = await getDb();
  db.prepare("UPDATE research_runs SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(
    deltaUsd,
    now(),
    id,
  );
  const row = db.prepare("SELECT cost_usd FROM research_runs WHERE id = ?").get(id);
  return Number(row?.cost_usd ?? 0);
}

/** Boot sweep: any run still marked live from a previous process is dead. */
export async function markStaleRunsInterrupted(): Promise<number> {
  const db = await getDb();
  const rows = db
    .prepare(
      "SELECT id FROM research_runs WHERE status IN ('queued','running','awaiting_gate')",
    )
    .all();
  for (const r of rows) {
    db.prepare(
      "UPDATE research_runs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE id = ?",
    ).run(now(), now(), String(r.id));
  }
  return rows.length;
}

// ── tasks ────────────────────────────────────────────────────────────────

export async function insertTask(opts: {
  runId: string;
  stage: ResearchStage;
  role: string;
  branch?: string | null;
  parentTaskId?: string | null;
  attempt?: number;
  model: string;
  input?: unknown;
}): Promise<string> {
  const db = await getDb();
  const id = newId("task");
  db.prepare(
    "INSERT INTO research_tasks (id, run_id, stage, role, branch, parent_task_id, attempt, status, model, input_json, started_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)",
  ).run(
    id,
    opts.runId,
    opts.stage,
    opts.role,
    opts.branch ?? null,
    opts.parentTaskId ?? null,
    opts.attempt ?? 1,
    opts.model,
    opts.input === undefined ? null : JSON.stringify(opts.input),
    now(),
  );
  return id;
}

export async function finishTask(
  id: string,
  patch: {
    status: "succeeded" | "failed" | "cancelled";
    outputPath?: string | null;
    costUsd?: number;
    durationMs?: number;
    error?: string | null;
  },
): Promise<void> {
  const db = await getDb();
  db.prepare(
    "UPDATE research_tasks SET status = ?, output_path = ?, cost_usd = ?, duration_ms = ?, error = ?, finished_at = ? WHERE id = ?",
  ).run(
    patch.status,
    patch.outputPath ?? null,
    patch.costUsd ?? null,
    patch.durationMs ?? null,
    patch.error ?? null,
    now(),
    id,
  );
}

export async function listTasks(runId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare("SELECT * FROM research_tasks WHERE run_id = ? ORDER BY started_at, id")
    .all(runId);
}

// ── events ───────────────────────────────────────────────────────────────

export async function insertEvent(opts: {
  runId: string;
  taskId?: string | null;
  stage?: string | null;
  role?: string | null;
  branch?: string | null;
  type: string;
  data: unknown;
}): Promise<{ seq: number; ts: string }> {
  const db = await getDb();
  const ts = now();
  db.prepare(
    "INSERT INTO research_events (run_id, task_id, stage, role, branch, type, data, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.runId,
    opts.taskId ?? null,
    opts.stage ?? null,
    opts.role ?? null,
    opts.branch ?? null,
    opts.type,
    JSON.stringify(opts.data ?? {}),
    ts,
  );
  const row = db.prepare("SELECT last_insert_rowid() AS seq").get();
  return { seq: Number(row?.seq ?? 0), ts };
}

export async function listEventsAfter(
  runId: string,
  afterSeq: number,
  limit = 5000,
): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare(
      "SELECT * FROM research_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(runId, afterSeq, limit);
}

// ── artifacts ────────────────────────────────────────────────────────────

export async function upsertArtifact(opts: {
  runId: string;
  stage: ResearchStage;
  kind: string;
  relPath: string;
  producedByTask?: string | null;
  sha256: string;
  bytes: number;
  meta?: unknown;
}): Promise<string> {
  const db = await getDb();
  // Stable id per (run, relPath) so re-writing an artifact updates in place.
  const id = "art_" + crypto.createHash("sha256").update(`${opts.runId}:${opts.relPath}`).digest("hex").slice(0, 12);
  db.prepare(
    "INSERT INTO research_artifacts (id, run_id, stage, kind, rel_path, produced_by_task, sha256, bytes, meta_json, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (run_id, rel_path) DO UPDATE SET " +
      "stage = excluded.stage, kind = excluded.kind, produced_by_task = excluded.produced_by_task, " +
      "sha256 = excluded.sha256, bytes = excluded.bytes, meta_json = excluded.meta_json",
  ).run(
    id,
    opts.runId,
    opts.stage,
    opts.kind,
    opts.relPath,
    opts.producedByTask ?? null,
    opts.sha256,
    opts.bytes,
    opts.meta === undefined ? null : JSON.stringify(opts.meta),
    now(),
  );
  return id;
}

export async function listArtifacts(runId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare("SELECT * FROM research_artifacts WHERE run_id = ? ORDER BY created_at, rel_path")
    .all(runId);
}

// ── evidence ─────────────────────────────────────────────────────────────

export function evidenceId(tool: string, request: unknown): string {
  const canonical = JSON.stringify({ tool, request });
  return "ev_" + crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export async function insertEvidence(opts: {
  id: string;
  runId: string;
  sourceTool: string;
  refId?: string | null;
  request: unknown;
  relPath: string;
  sha256: string;
}): Promise<boolean> {
  const db = await getDb();
  const before = db
    .prepare("SELECT 1 FROM research_evidence WHERE run_id = ? AND id = ?")
    .get(opts.runId, opts.id);
  if (before) return false;
  db.prepare(
    "INSERT OR IGNORE INTO research_evidence (id, run_id, source_tool, ref_id, request_json, rel_path, sha256, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.id,
    opts.runId,
    opts.sourceTool,
    opts.refId ?? null,
    JSON.stringify(opts.request ?? {}),
    opts.relPath,
    opts.sha256,
    now(),
  );
  return true;
}

/** Retrieval-only citations: a ref is citable iff evidence exists for it. */
export async function hasEvidenceForRef(runId: string, refId: string): Promise<boolean> {
  const db = await getDb();
  const row = db
    .prepare("SELECT 1 FROM research_evidence WHERE run_id = ? AND ref_id = ? LIMIT 1")
    .get(runId, refId);
  return Boolean(row);
}

/** Most recent cached retrieval for a ref id (for entailment judging). */
export async function getEvidenceByRef(
  runId: string,
  refId: string,
): Promise<{ relPath: string } | null> {
  const db = await getDb();
  const row = db
    .prepare(
      "SELECT rel_path FROM research_evidence WHERE run_id = ? AND ref_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(runId, refId);
  return row ? { relPath: String(row.rel_path) } : null;
}

export async function listEvidence(runId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare("SELECT * FROM research_evidence WHERE run_id = ? ORDER BY created_at")
    .all(runId);
}

// ── claims ───────────────────────────────────────────────────────────────

export async function replaceClaims(
  runId: string,
  artifactId: string,
  claims: Array<{
    claimType: string;
    text: string;
    sourceTag: string;
    status: string;
    breakCode?: string | null;
    detail?: unknown;
  }>,
): Promise<void> {
  const db = await getDb();
  db.prepare("DELETE FROM research_claims WHERE run_id = ? AND artifact_id = ?").run(
    runId,
    artifactId,
  );
  const stmt = db.prepare(
    "INSERT INTO research_claims (id, run_id, artifact_id, claim_type, text, source_tag, status, break_code, detail_json, checked_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of claims) {
    stmt.run(
      newId("clm"),
      runId,
      artifactId,
      c.claimType,
      c.text,
      c.sourceTag,
      c.status,
      c.breakCode ?? null,
      c.detail === undefined ? null : JSON.stringify(c.detail),
      now(),
    );
  }
}

export async function listClaims(runId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .prepare("SELECT * FROM research_claims WHERE run_id = ? ORDER BY id")
    .all(runId);
}
