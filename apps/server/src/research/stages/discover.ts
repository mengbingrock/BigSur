// Stage 2 — Discovery. Ideator seeds B branches; the Parallel Explore-Exploit
// orchestrator runs I iterations, developing every live branch concurrently
// (solver in its own node workspace, appending to its experimental log),
// scoring each version with the golden evaluator (or the LLM rubric when none
// is configured — pruning only), keeping the top K per iteration and refilling
// from survivors via fresh ideation. Afterwards: best-run selection (spec
// violators excluded) and controlled ablations on a copy of the best node.
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalResult } from "../evaluator";
import { runCommandEvaluator } from "../evaluator";
import { emitRunEvent } from "../events";
import { mapConcurrent, runStructuredTask, type RunCtx } from "../agentTask";
import { clipForPrompt, indexExistingFile, readRunFile, runFileExists, safeRunPath, writeArtifact } from "../workspace";
import { RunFailed } from "../types";
import { fsSlug, vArray, vNumber, vObject, vString } from "../validate";
import type { InvestigateResult } from "./investigate";

const STAGE = "discover" as const;

export interface Idea {
  title: string;
  approach: string;
  novelty: number;
  feasibility: number;
  buildsOn: string | null;
}

export interface BranchState {
  id: string;
  idea: Idea;
  /** Workspace-relative node dir: stage2/nodes/<id> */
  relDir: string;
  alive: boolean;
  versions: Array<{ iteration: number; score: number | null; scoreKind: string; error?: string }>;
  lastSummary: string;
}

export interface DiscoverResult {
  best: {
    branch: string;
    iteration: number;
    score: number;
    scoreKind: "golden" | "llm_rubric";
    nodeRelDir: string;
    logRelPath: string;
  };
  report: string;
  ablations: Array<{ key: string; component: string; change: string; score: number | null; conclusion: string }>;
  tree: BranchState[];
}

const validateIdeas = (u: unknown): Idea[] => {
  const o = vObject(u);
  return vArray(o.ideas, "ideas").map((i) => {
    const io = vObject(i, "ideas[]");
    return {
      title: vString(io.title, "title"),
      approach: vString(io.approach, "approach"),
      novelty: vNumber(io.novelty, "novelty"),
      feasibility: vNumber(io.feasibility, "feasibility"),
      buildsOn: typeof io.buildsOn === "string" ? io.buildsOn : null,
    };
  });
};

function latestScore(branch: BranchState): number {
  for (let i = branch.versions.length - 1; i >= 0; i--) {
    const v = branch.versions[i]!;
    if (v.score != null) return v.score;
  }
  return Number.NEGATIVE_INFINITY;
}

async function emitTree(ctx: RunCtx, iteration: number, branches: BranchState[]): Promise<void> {
  const tree = branches.map((b) => ({
    id: b.id,
    title: b.idea.title,
    alive: b.alive,
    buildsOn: b.idea.buildsOn,
    versions: b.versions,
  }));
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "tree",
    relPath: "stage2/tree.json",
    content: JSON.stringify({ iteration, branches: tree }, null, 2),
  });
  await emitRunEvent(ctx.runId, "tree_updated", { iteration, branches: tree }, { stage: STAGE });
}

export async function runDiscoverStage(
  ctx: RunCtx,
  investigation: InvestigateResult,
): Promise<DiscoverResult> {
  const { budget } = ctx.spec;
  await emitRunEvent(ctx.runId, "stage_started", { stage: STAGE }, { stage: STAGE });
  const evaluatorSpec = ctx.spec.evaluator;
  const briefClip = clipForPrompt(investigation.brief, 100_000);

  // ── ideation ───────────────────────────────────────────────────────────
  const ideate = async (survivors: BranchState[], count: number): Promise<Idea[]> => {
    const survivorBlock = survivors.length
      ? `SURVIVING BRANCHES (build variations on these):\n` +
        survivors
          .map(
            (b) =>
              `- ${b.id} "${b.idea.title}" (latest score ${latestScore(b)}): ${b.idea.approach}\n  last iteration: ${b.lastSummary}`,
          )
          .join("\n")
      : "(first ideation round — no survivors yet)";
    const ideas = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "ideator",
        prompt:
          `EXPERIMENT BRIEF:\n${briefClip}\n\n${survivorBlock}\n\n` +
          `EVALUATOR: ${evaluatorSpec.kind === "command" ? `command \`${evaluatorSpec.command}\`` : "none (LLM rubric, pruning only)"}\n` +
          `Generate ${count} distinct candidate approaches.`,
      },
      validateIdeas,
    );
    return [...ideas].sort((a, b) => b.novelty + b.feasibility - (a.novelty + a.feasibility)).slice(0, count);
  };

  const branches: BranchState[] = [];
  let branchCounter = 0;
  const spawnBranch = async (idea: Idea): Promise<BranchState> => {
    const id = `b${++branchCounter}`;
    const relDir = `stage2/nodes/${id}`;
    const abs = safeRunPath(ctx.workspaceDir, relDir);
    await fs.mkdir(path.join(abs, "solution"), { recursive: true });
    await fs.writeFile(path.join(abs, "experimental_log.md"), "", "utf8");
    const branch: BranchState = { id, idea, relDir, alive: true, versions: [], lastSummary: "(new branch)" };
    branches.push(branch);
    return branch;
  };

  const initialIdeas = await ideate([], budget.branches);
  if (initialIdeas.length === 0) throw new RunFailed("NO_IDEAS", "Ideator produced no approaches.");
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "idea_set",
    relPath: "stage2/ideas.json",
    content: JSON.stringify(initialIdeas, null, 2),
  });
  for (const idea of initialIdeas) await spawnBranch(idea);

  // ── evaluate one branch version ────────────────────────────────────────
  const evaluate = async (branch: BranchState, iteration: number): Promise<EvalResult> => {
    const abs = safeRunPath(ctx.workspaceDir, branch.relDir);
    if (evaluatorSpec.kind === "command") {
      return runCommandEvaluator(evaluatorSpec, abs, {
        RUN_ID: ctx.runId,
        NODE_ID: branch.id,
        ITERATION: String(iteration),
      });
    }
    const logText = await readRunFile(ctx.workspaceDir, `${branch.relDir}/experimental_log.md`).catch(() => "");
    const rubric = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "evaluator_rubric",
        branch: branch.id,
        prompt:
          `EXPERIMENT BRIEF (success criteria live here):\n${clipForPrompt(investigation.brief, 40_000)}\n\n` +
          `BRANCH ${branch.id} "${branch.idea.title}" — SOLUTION SUMMARY:\n${branch.lastSummary}\n\n` +
          `EXPERIMENTAL LOG (tail):\n${clipForPrompt(logText, 30_000)}`,
      },
      (u) => {
        const o = vObject(u);
        return { score: vNumber(o.score, "score"), rationale: String(o.rationale ?? "") };
      },
    );
    return { score: rubric.score, scoreKind: "llm_rubric", details: rubric };
  };

  // ── PEE iterations ─────────────────────────────────────────────────────
  for (let iteration = 1; iteration <= budget.iterations; iteration++) {
    const live = branches.filter((b) => b.alive && b.versions.length < budget.evalsPerNode);
    if (live.length === 0) break;

    await mapConcurrent(live, budget.maxConcurrentAgents, async (branch) => {
      const abs = safeRunPath(ctx.workspaceDir, branch.relDir);
      try {
        const solved = await runStructuredTask(
          ctx,
          {
            stage: STAGE,
            role: "solver",
            branch: `${branch.id}.i${iteration}`,
            cwd: abs,
            prompt:
              `EXPERIMENT BRIEF:\n${briefClip}\n\n` +
              `YOUR ASSIGNED APPROACH (branch ${branch.id}, iteration ${iteration}/${budget.iterations}):\n` +
              `${branch.idea.title}\n${branch.idea.approach}\n\n` +
              (branch.versions.length > 0
                ? `PREVIOUS ITERATION SUMMARY:\n${branch.lastSummary}\nContinue refining the existing ./solution.`
                : "This is the branch's first iteration — set up ./solution from scratch.") +
              (evaluatorSpec.kind === "command"
                ? `\n\nOFFICIAL EVALUATION COMMAND (run from this directory): ${evaluatorSpec.command}`
                : "\n\nNo golden evaluator is configured; optimise the brief's success criteria and log measurable proxies."),
          },
          (u) => {
            const o = vObject(u);
            return { summary: vString(o.summary, "summary") };
          },
        );
        branch.lastSummary = solved.summary;
        await indexExistingFile({
          runId: ctx.runId,
          workspaceDir: ctx.workspaceDir,
          stage: STAGE,
          kind: "experimental_log",
          relPath: `${branch.relDir}/experimental_log.md`,
        });
        const evaluated = await evaluate(branch, iteration);
        branch.versions.push({ iteration, score: evaluated.score, scoreKind: evaluated.scoreKind });
        await writeArtifact({
          runId: ctx.runId,
          workspaceDir: ctx.workspaceDir,
          stage: STAGE,
          kind: "eval_result",
          relPath: `${branch.relDir}/versions/v${iteration}/eval.json`,
          content: JSON.stringify(
            { branch: branch.id, iteration, score: evaluated.score, scoreKind: evaluated.scoreKind, details: evaluated.details },
            null,
            2,
          ),
        });
        await emitRunEvent(
          ctx.runId,
          "eval_scored",
          { branch: branch.id, iteration, score: evaluated.score, scoreKind: evaluated.scoreKind },
          { stage: STAGE, branch: branch.id },
        );
      } catch (err) {
        if (err instanceof RunFailed || (err as Error)?.name === "RunCancelled") throw err;
        const message = err instanceof Error ? err.message : String(err);
        branch.versions.push({ iteration, score: null, scoreKind: "error", error: message });
        await emitRunEvent(
          ctx.runId,
          "eval_scored",
          { branch: branch.id, iteration, score: null, error: message },
          { stage: STAGE, branch: branch.id },
        );
      }
    });

    // Selection: keep top-K live branches, refill from survivors.
    const rankable = branches.filter((b) => b.alive);
    rankable.sort((a, b) => latestScore(b) - latestScore(a));
    const survivors = rankable.slice(0, budget.keepK);
    for (const b of rankable.slice(budget.keepK)) b.alive = false;

    if (iteration < budget.iterations) {
      const refillCount = Math.max(0, budget.branches - survivors.filter((s) => s.versions.length < budget.evalsPerNode).length);
      if (refillCount > 0) {
        try {
          const fresh = await ideate(survivors, refillCount);
          for (const idea of fresh) await spawnBranch(idea);
        } catch {
          // refill is best-effort; survivors keep developing
        }
      }
    }
    await emitTree(ctx, iteration, branches);
  }

  // ── best-run selection (spec violators / errored versions excluded) ────
  let best: DiscoverResult["best"] | null = null;
  for (const branch of branches) {
    for (const v of branch.versions) {
      if (v.score == null) continue;
      if (!best || v.score > best.score) {
        best = {
          branch: branch.id,
          iteration: v.iteration,
          score: v.score,
          scoreKind: v.scoreKind === "golden" ? "golden" : "llm_rubric",
          nodeRelDir: branch.relDir,
          logRelPath: `${branch.relDir}/experimental_log.md`,
        };
      }
    }
  }
  if (!best) throw new RunFailed("NO_SCORED_SOLUTION", "No branch produced an evaluable solution.");
  const bestBranch = branches.find((b) => b.id === best!.branch)!;

  // ── node report for the best branch ────────────────────────────────────
  const bestLog = await readRunFile(ctx.workspaceDir, best.logRelPath).catch(() => "");
  const reported = await runStructuredTask(
    ctx,
    {
      stage: STAGE,
      role: "report_writer",
      branch: best.branch,
      prompt:
        `BRANCH ${best.branch} "${bestBranch.idea.title}" — best score ${best.score} (${best.scoreKind}).\n\n` +
        `SOLUTION SUMMARY:\n${bestBranch.lastSummary}\n\nEXPERIMENTAL LOG:\n${clipForPrompt(bestLog, 120_000)}`,
    },
    (u) => ({ report: vString(vObject(u).report, "report") }),
  );
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "node_report",
    relPath: `${best.nodeRelDir}/report.md`,
    content: reported.report,
  });
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "best",
    relPath: "stage2/best.json",
    content: JSON.stringify(best, null, 2),
  });

  // ── ablations on a copy of the best node ───────────────────────────────
  let ablations: DiscoverResult["ablations"] = [];
  try {
    const ablRelDir = "stage2/ablations/work";
    const ablAbs = safeRunPath(ctx.workspaceDir, ablRelDir);
    await fs.rm(ablAbs, { recursive: true, force: true });
    await fs.cp(safeRunPath(ctx.workspaceDir, best.nodeRelDir), ablAbs, { recursive: true });
    const result = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "ablation",
        branch: best.branch,
        cwd: ablAbs,
        prompt:
          `BEST SOLUTION (branch ${best.branch}, score ${best.score}, ${best.scoreKind}).\n` +
          `Design and run up to 3 controlled ablations.\n` +
          (evaluatorSpec.kind === "command"
            ? `EVALUATION COMMAND (run from each ablation dir or as instructed): ${evaluatorSpec.command}`
            : "No golden evaluator: implement each ablation and report qualitative deltas; scores stay null."),
      },
      (u) => {
        const o = vObject(u);
        return vArray(o.ablations ?? [], "ablations").map((a) => {
          const ao = vObject(a, "ablations[]");
          return {
            key: fsSlug(vString(ao.key, "key")),
            component: vString(ao.component, "component"),
            change: vString(ao.change, "change"),
            score: typeof ao.score === "number" ? ao.score : null,
            conclusion: vString(ao.conclusion, "conclusion"),
          };
        });
      },
    );
    ablations = result;
    await indexExistingFile({
      runId: ctx.runId,
      workspaceDir: ctx.workspaceDir,
      stage: STAGE,
      kind: "experimental_log",
      relPath: `${ablRelDir}/experimental_log.md`,
    });
  } catch (err) {
    if (err instanceof RunFailed || (err as Error)?.name === "RunCancelled") throw err;
    await emitRunEvent(
      ctx.runId,
      "error",
      { note: "ablation pass failed; continuing without ablations", error: String(err) },
      { stage: STAGE },
    );
  }
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "ablation",
    relPath: "stage2/ablations/ablations.json",
    content: JSON.stringify(ablations, null, 2),
  });

  // Make sure the best node's log exists for stage 3 tags.
  if (!(await runFileExists(ctx.workspaceDir, best.logRelPath))) {
    throw new RunFailed("LOG_MISSING", `Best node has no experimental log at ${best.logRelPath}.`);
  }
  await emitRunEvent(ctx.runId, "stage_finished", { stage: STAGE, best }, { stage: STAGE });
  return { best, report: reported.report, ablations, tree: branches };
}
