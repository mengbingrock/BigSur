// The run engine: creates runs, executes them as detached background work
// (outliving the HTTP request and the browser), sequences the three stages
// with their human gates, and owns the terminal-status transitions. Not
// resumable across restarts in v1 — bootSweep marks stale rows interrupted;
// every stage is re-runnable from its artifacts, so retry-from-stage is a
// straightforward follow-up.
import type { CreateRunRequest, ModelTier } from "@labee/contracts";
import { DEFAULT_RUN_BUDGET, DEFAULT_RUN_GATES } from "@labee/contracts";
import { claudeEnvForCredential } from "../services/llm";
import { resolveCredential } from "../services/llmSettings";
import { emitRunEvent } from "./events";
import { Semaphore, type RunCtx } from "./agentTask";
import { getRunById, insertRun, markStaleRunsInterrupted, setRunWorkspace, updateRun } from "./runsDb";
import { getRunHandle, interruptRun, registerRun, unregisterRun } from "./registry";
import { initWorkspace, runWorkspaceDir, writeArtifact } from "./workspace";
import { GateRejected, RunCancelled, RunFailed, type RunRow, type RunSpec } from "./types";
import { runInvestigateStage } from "./stages/investigate";
import { runDiscoverStage } from "./stages/discover";
import { runWriteStage } from "./stages/write";
import { runVerifyStage } from "./stages/verify";

function resolveSpec(req: CreateRunRequest): RunSpec {
  const question = req.question.trim();
  const budget = { ...DEFAULT_RUN_BUDGET };
  for (const key of Object.keys(budget) as Array<keyof typeof budget>) {
    const v = req.budget?.[key as keyof typeof req.budget];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      (budget as Record<string, number | null>)[key] = key === "maxCostUsd" ? v : Math.floor(v);
    }
  }
  const gates = { ...DEFAULT_RUN_GATES };
  if (typeof req.gates?.minCoreAdjacent === "number") gates.minCoreAdjacent = req.gates.minCoreAdjacent;
  if (typeof req.gates?.groundingRatioMin === "number") gates.groundingRatioMin = req.gates.groundingRatioMin;
  if (typeof req.gates?.numericTolerance === "number") gates.numericTolerance = req.gates.numericTolerance;
  if (typeof req.gates?.approveAfterBrief === "boolean") gates.approveAfterBrief = req.gates.approveAfterBrief;
  if (typeof req.gates?.approveBeforeWrite === "boolean") gates.approveBeforeWrite = req.gates.approveBeforeWrite;
  return {
    title: req.title?.trim() || question.slice(0, 120),
    question,
    seeds: [...(req.seeds ?? [])].map((s) => ({
      refId: s.refId.trim(),
      ...(s.title ? { title: s.title } : {}),
    })),
    evaluator: req.evaluator ?? { kind: "none" },
    budget,
    gates,
    modelTiers: { ...(req.modelTiers ?? {}) } as Record<string, ModelTier>,
  };
}

export interface StartRunError {
  status: number;
  message: string;
}

/** Validate + create + launch a run. Returns the row or a client error. */
export async function startRun(
  email: string,
  req: CreateRunRequest,
): Promise<{ ok: true; run: RunRow } | { ok: false; error: StartRunError }> {
  if (!req.question || req.question.trim().length < 12) {
    return { ok: false, error: { status: 400, message: "`question` must describe the research task." } };
  }
  const seeds = (req.seeds ?? []).filter((s) => typeof s.refId === "string" && s.refId.trim());
  if (seeds.length < 1 || seeds.length > 4) {
    return { ok: false, error: { status: 400, message: "Provide 1–4 seed references (doi:/pmid:/pmcid:/openalex: ids)." } };
  }
  if (req.evaluator?.kind === "command" && !req.evaluator.command.trim()) {
    return { ok: false, error: { status: 400, message: "Evaluator command must not be empty." } };
  }
  // Research v1 runs on the claude CLI only — resolve the anthropic credential
  // up front so a misconfigured account fails the request, not the run.
  const cred = await resolveCredential(email, "anthropic");
  if (cred.unavailable) {
    return { ok: false, error: { status: 400, message: cred.reason ?? "No usable Anthropic credential." } };
  }
  if (process.env.LABEE_MODE === "desktop" && cred.mode === "own_api_key") {
    return {
      ok: false,
      error: {
        status: 400,
        message:
          "Research runs with your own API key aren't available in the desktop app yet — " +
          'switch Anthropic to "Your subscription" or "Labee Provided" in Settings.',
      },
    };
  }

  const spec = resolveSpec({ ...req, seeds });
  const run = await insertRun({
    email,
    spec,
    workspaceDir: runWorkspaceDir(email, "pending"),
  });
  // The workspace path embeds the run id, which we only have post-insert.
  const workspaceDir = runWorkspaceDir(email, run.id);
  await setRunWorkspace(run.id, workspaceDir);
  run.workspaceDir = workspaceDir;
  await initWorkspace(workspaceDir);
  await writeArtifact({
    runId: run.id,
    workspaceDir,
    stage: "investigate",
    kind: "run_spec",
    relPath: "run.json",
    content: JSON.stringify(spec, null, 2),
  });

  // Detach: the run outlives this request (but not the server process).
  void executeRun(run.id, email, spec, workspaceDir, claudeEnvForCredential(cred)).catch(() => {});
  return { ok: true, run };
}

async function waitForGate(ctx: RunCtx, gate: string): Promise<void> {
  await updateRun(ctx.runId, { status: "awaiting_gate" });
  await emitRunEvent(ctx.runId, "gate_waiting", { gate });
  const approved = await new Promise<boolean>((resolve) => {
    if (ctx.handle.abort.signal.aborted) return resolve(false);
    ctx.handle.gateResolvers.set(gate, resolve);
  });
  ctx.handle.gateResolvers.delete(gate);
  if (ctx.handle.abort.signal.aborted) throw new RunCancelled();
  if (!approved) throw new GateRejected(gate);
  await updateRun(ctx.runId, { status: "running" });
  await emitRunEvent(ctx.runId, "gate_passed", { gate });
}

async function executeRun(
  runId: string,
  email: string,
  spec: RunSpec,
  workspaceDir: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const handle = registerRun(runId);
  const ctx: RunCtx = {
    runId,
    email,
    workspaceDir,
    spec,
    extraEnv,
    handle,
    runSemaphore: new Semaphore(spec.budget.maxConcurrentAgents),
  };
  try {
    await updateRun(runId, { status: "running", stage: "investigate" });
    await emitRunEvent(runId, "run_status", { status: "running", stage: "investigate" });

    const investigation = await runInvestigateStage(ctx);
    if (spec.gates.approveAfterBrief) await waitForGate(ctx, "afterBrief");

    await updateRun(runId, { stage: "discover" });
    await emitRunEvent(runId, "run_status", { status: "running", stage: "discover" });
    const discovery = await runDiscoverStage(ctx, investigation);
    if (spec.gates.approveBeforeWrite) await waitForGate(ctx, "beforeWrite");

    await updateRun(runId, { stage: "write" });
    await emitRunEvent(runId, "run_status", { status: "running", stage: "write" });
    const written = await runWriteStage(ctx, investigation, discovery);

    await updateRun(runId, { stage: "verify" });
    await emitRunEvent(runId, "run_status", { status: "running", stage: "verify" });
    const result = await runVerifyStage(ctx, investigation, discovery, written);

    await updateRun(runId, { status: "completed", finished: true });
    await emitRunEvent(runId, "run_status", {
      status: "completed",
      finalRelPath: result.finalRelPath,
    });
  } catch (err) {
    if (err instanceof RunCancelled || handle.abort.signal.aborted) {
      await updateRun(runId, { status: "cancelled", finished: true });
      await emitRunEvent(runId, "run_status", { status: "cancelled" });
    } else if (err instanceof GateRejected) {
      await updateRun(runId, { status: "failed", failReason: `GATE_REJECTED:${err.gate}`, finished: true });
      await emitRunEvent(runId, "run_status", { status: "failed", failReason: `GATE_REJECTED:${err.gate}` });
    } else if (err instanceof RunFailed) {
      await updateRun(runId, { status: "failed", failReason: err.code, finished: true });
      await emitRunEvent(runId, "run_status", { status: "failed", failReason: err.code, message: err.message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await updateRun(runId, { status: "failed", failReason: "INTERNAL", finished: true });
      await emitRunEvent(runId, "run_status", { status: "failed", failReason: "INTERNAL", message });
    }
  } finally {
    unregisterRun(runId);
  }
}

/** Cancel a run the caller owns. */
export async function cancelRun(email: string, runId: string): Promise<boolean> {
  const run = await getRunById(runId);
  if (!run || run.email !== email) return false;
  const wasLive = interruptRun(runId);
  if (!wasLive && ["queued", "running", "awaiting_gate"].includes(run.status)) {
    // Not live in this process (e.g. it was interrupted earlier) — settle the row.
    await updateRun(runId, { status: "cancelled", finished: true });
  }
  return true;
}

/** Answer a pending human gate. */
export async function answerGate(
  email: string,
  runId: string,
  gate: string,
  approve: boolean,
): Promise<{ ok: boolean; message?: string }> {
  const run = await getRunById(runId);
  if (!run || run.email !== email) return { ok: false, message: "Run not found." };
  const handle = getRunHandle(runId);
  const resolve = handle?.gateResolvers.get(gate);
  if (!resolve) return { ok: false, message: `No pending "${gate}" gate on this run.` };
  resolve(approve);
  return { ok: true };
}

/** Called once at server start: settle rows from a previous process. */
export async function bootSweep(): Promise<void> {
  try {
    const n = await markStaleRunsInterrupted();
    if (n > 0) console.warn(`[research] marked ${n} stale run(s) interrupted`);
  } catch (err) {
    console.warn("[research] boot sweep failed:", err);
  }
}
