// Stage 3 — Paper Writer, "provenance before prose". Conceive drafts the
// research representation with inline {{src: …}} tags; then a bounded
// [Ground (deterministic) → Critic (LLM) → Resolve (LLM)] loop repairs it,
// stopping on convergence (zero flags) or plateau (flag count stops
// decreasing). The grounding-ratio gate fails the run closed. Compose renders
// per-section prose that PRESERVES the tags — the Claim Verifier (verify.ts)
// consumes them before they're stripped from the final document.
import path from "node:path";
import fs from "node:fs/promises";
import { emitRunEvent } from "../events";
import { listEvidence } from "../runsDb";
import { runStructuredTask, runAgentTask, type RunCtx } from "../agentTask";
import { clipForPrompt, readRunFile, safeRunPath, writeArtifact } from "../workspace";
import { RunFailed } from "../types";
import { parseClaims } from "../claims/grammar";
import { groundClaims, type GroundReport } from "../claims/ground";
import { vArray, vBoolean, vObject } from "../validate";
import type { InvestigateResult } from "./investigate";
import type { DiscoverResult } from "./discover";

const STAGE = "write" as const;

export const REQUIRED_SECTIONS = [
  "Problem",
  "Related Work",
  "Approach",
  "Experiments",
  "Results",
  "Ablations",
  "Limitations",
  "Conclusion",
] as const;

export interface WriteResult {
  /** The tagged draft (tags intact — verify.ts consumes them). */
  taggedDraftRelPath: string;
  representationRelPath: string;
  lastGround: GroundReport;
}

/** Build the sync file reader Ground needs by pre-reading every tag target. */
async function buildReadFile(
  workspaceDir: string,
  doc: string,
): Promise<(relPath: string) => string | null> {
  const targets = new Set<string>();
  for (const claim of parseClaims(doc)) {
    const tag = claim.tag;
    if (tag && (tag.kind === "log" || tag.kind === "ablation") && tag.target) {
      targets.add(tag.target);
    }
  }
  const cache = new Map<string, string | null>();
  for (const target of targets) {
    try {
      cache.set(target, await readRunFile(workspaceDir, target));
    } catch {
      cache.set(target, null);
    }
  }
  return (relPath) => cache.get(relPath) ?? null;
}

export async function groundDocument(
  ctx: RunCtx,
  doc: string,
  bestScore: number | null,
): Promise<GroundReport> {
  const readFile = await buildReadFile(ctx.workspaceDir, doc);
  const retrieved = new Set<string>(
    (await listEvidence(ctx.runId))
      .map((row) => row.ref_id)
      .filter((r): r is string => typeof r === "string" && r.length > 0),
  );
  return groundClaims(doc, parseClaims(doc), {
    readFile,
    bestScore,
    retrievedRefIds: retrieved,
    requiredSections: REQUIRED_SECTIONS,
  });
}

export async function runWriteStage(
  ctx: RunCtx,
  investigation: InvestigateResult,
  discovery: DiscoverResult,
): Promise<WriteResult> {
  const { budget, gates } = ctx.spec;
  await emitRunEvent(ctx.runId, "stage_started", { stage: STAGE }, { stage: STAGE });

  const bestLog = await readRunFile(ctx.workspaceDir, discovery.best.logRelPath).catch(() => "");
  const bestScore = discovery.best.scoreKind === "golden" ? discovery.best.score : null;
  const materials =
    `RESEARCH QUESTION:\n${ctx.spec.question}\n\n` +
    `EXPERIMENT BRIEF:\n${clipForPrompt(investigation.brief, 60_000)}\n\n` +
    `BEST RUN: branch ${discovery.best.branch}, score ${discovery.best.score} ` +
    `(${discovery.best.scoreKind}${discovery.best.scoreKind === "llm_rubric" ? " — UNVERIFIED, no golden evaluator; label all quantitative outcomes as unverified" : ""}).\n` +
    `EXPERIMENTAL LOG (cite as {{src: log:${discovery.best.logRelPath}:<line>}} — each line below is prefixed with its FILE line number):\n` +
    clipForPrompt(numberLines(bestLog), 100_000) +
    `\n\nNODE REPORT:\n${clipForPrompt(discovery.report, 30_000)}\n\n` +
    `ABLATIONS (cite as {{src: ablation:stage2/ablations/ablations.json#<key>}}):\n` +
    JSON.stringify(discovery.ablations, null, 2) +
    `\n\nCITABLE REFERENCES (cite as {{src: cite:<refId>}} — ONLY these):\n` +
    investigation.references.map((r) => `- ${r.refId} ${r.title}`).join("\n") +
    `\n\nBRIEF BASELINES (cite as {{src: brief:plan}} etc.):\n` +
    investigation.baselines.map((b) => `- ${b.name}: ${b.value} (${b.source})`).join("\n");

  // ── Conceive ───────────────────────────────────────────────────────────
  const conceived = await runAgentTask(ctx, {
    stage: STAGE,
    role: "conceive",
    prompt: materials + `\n\nSections required: ${REQUIRED_SECTIONS.map((s) => `# ${s}`).join(", ")}.`,
  });
  let representation = conceived.text.trim();
  if (representation.length < 200) {
    throw new RunFailed("CONCEIVE_EMPTY", "Conceive produced no usable representation.");
  }

  // ── Ground → Critic → Resolve loop ─────────────────────────────────────
  let ground = await groundDocument(ctx, representation, bestScore);
  let prevFlagCount = Number.POSITIVE_INFINITY;
  for (let round = 1; round <= budget.writerRounds; round++) {
    await writeArtifact({
      runId: ctx.runId,
      workspaceDir: ctx.workspaceDir,
      stage: STAGE,
      kind: "representation",
      relPath: "stage3/representation.md",
      content: representation,
    });
    await writeArtifact({
      runId: ctx.runId,
      workspaceDir: ctx.workspaceDir,
      stage: STAGE,
      kind: "ground_report",
      relPath: `stage3/ground/round${round}.json`,
      content: JSON.stringify(
        {
          groundingRatio: ground.groundingRatio,
          totals: ground.totals,
          flags: ground.flags,
          missingSections: ground.missingSections,
        },
        null,
        2,
      ),
    });
    await emitRunEvent(
      ctx.runId,
      "claim_checked",
      { pass: "ground", round, ratio: ground.groundingRatio, flags: ground.flags.length },
      { stage: STAGE },
    );

    const critique = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "critic",
        branch: `round${round}`,
        prompt:
          `RESEARCH REPRESENTATION:\n${clipForPrompt(representation, 120_000)}\n\n` +
          `GROUND REPORT (deterministic flags):\n${ground.flags.join("\n") || "(clean)"}\n` +
          `Grounding ratio: ${(ground.groundingRatio * 100).toFixed(1)}%.`,
      },
      (u) => {
        const o = vObject(u);
        return {
          pass: vBoolean(o.pass, "pass"),
          issues: vArray(o.issues ?? [], "issues").map((i) => JSON.stringify(i)),
        };
      },
    );
    await writeArtifact({
      runId: ctx.runId,
      workspaceDir: ctx.workspaceDir,
      stage: STAGE,
      kind: "critic_report",
      relPath: `stage3/critic/round${round}.json`,
      content: JSON.stringify(critique, null, 2),
    });

    const flagCount = ground.flags.length + critique.issues.length;
    if (flagCount === 0 && critique.pass) break; // convergence
    if (flagCount >= prevFlagCount) break; // plateau — more rounds won't help
    prevFlagCount = flagCount;
    if (round === budget.writerRounds) break;

    const resolved = await runAgentTask(ctx, {
      stage: STAGE,
      role: "resolver",
      branch: `round${round}`,
      prompt:
        materials +
        `\n\nCURRENT REPRESENTATION:\n${clipForPrompt(representation, 120_000)}\n\n` +
        `GROUND FLAGS TO FIX:\n${ground.flags.join("\n") || "(none)"}\n\n` +
        `CRITIC ISSUES TO FIX:\n${critique.issues.join("\n") || "(none)"}`,
    });
    const next = resolved.text.trim();
    if (next.length > 200) representation = next;
    ground = await groundDocument(ctx, representation, bestScore);
  }

  // ── grounding-ratio gate (fail closed) ─────────────────────────────────
  if (ground.groundingRatio < gates.groundingRatioMin) {
    await emitRunEvent(
      ctx.runId,
      "gate_failed",
      { gate: "GROUNDING_GATE", ratio: ground.groundingRatio, min: gates.groundingRatioMin },
      { stage: STAGE },
    );
    throw new RunFailed(
      "GROUNDING_GATE",
      `Grounding ratio ${(ground.groundingRatio * 100).toFixed(1)}% is below the ` +
        `${(gates.groundingRatioMin * 100).toFixed(0)}% floor — refusing to compose a poorly grounded draft.`,
    );
  }
  await emitRunEvent(
    ctx.runId,
    "gate_passed",
    { gate: "GROUNDING_GATE", ratio: ground.groundingRatio },
    { stage: STAGE },
  );

  // ── Compose (per-section, tags preserved) ──────────────────────────────
  const factSheet =
    `VERIFIED FACT SHEET:\n- headline score: ${discovery.best.score} (${discovery.best.scoreKind})` +
    (bestScore == null ? " — UNVERIFIED (no golden evaluator); say so wherever quantitative" : "") +
    `\n- baselines: ${investigation.baselines.map((b) => `${b.name}=${b.value} (${b.source})`).join("; ") || "(none)"}` +
    `\n- citable refs: ${investigation.references.map((r) => r.refId).join(", ") || "(none)"}`;
  const sections: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const composed = await runAgentTask(ctx, {
      stage: STAGE,
      role: "composer_section",
      branch: section.toLowerCase().replace(/\s+/g, "-"),
      prompt:
        `SECTION TO WRITE: # ${section}\n\n${factSheet}\n\n` +
        `RESEARCH REPRESENTATION:\n${clipForPrompt(representation, 110_000)}`,
    });
    const text = composed.text.trim();
    sections.push(text.startsWith("#") ? text : `# ${section}\n\n${text}`);
  }
  const title = ctx.spec.title || "Research Report";
  const taggedDraft = `# ${title}\n\n${sections.join("\n\n")}\n`;
  const taggedDraftRelPath = "stage3/draft/paper.tagged.md";
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "draft",
    relPath: taggedDraftRelPath,
    content: taggedDraft,
  });

  // Keep a copy of the final representation next to the draft for the audit trail.
  const representationRelPath = "stage3/representation.md";
  const abs = safeRunPath(ctx.workspaceDir, representationRelPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, representation, "utf8");

  await emitRunEvent(ctx.runId, "stage_finished", { stage: STAGE }, { stage: STAGE });
  return { taggedDraftRelPath, representationRelPath, lastGround: ground };
}

/** Prefix every line with its 1-based number so log tags can be exact. */
function numberLines(text: string): string {
  return text
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}
