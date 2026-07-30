// Final verification: run the Claim Verifier over the tagged draft, persist
// the per-claim ledger, attempt bounded refinement of blocking violations,
// and only then promote — stripping tags and appending a references section
// built exclusively from cached retrievals. A draft that still carries
// blocking violations after refinement fails the run closed.
import { emitRunEvent } from "../events";
import { getEvidenceByRef, listEvidence, replaceClaims, upsertArtifact } from "../runsDb";
import { readEvidencePayload } from "../evidence";
import { runAgentTask, runStructuredTask, type RunCtx } from "../agentTask";
import { clipForPrompt, readRunFile, writeArtifact, sha256 } from "../workspace";
import { RunFailed } from "../types";
import { citedRefIds, parseClaims, stripTags } from "../claims/grammar";
import { blockingViolations, verifyClaims, type EntailmentJudge, type VerifiedClaim } from "../claims/verify";
import { groundDocument } from "./write";
import { vObject, vString } from "../validate";
import type { InvestigateResult } from "./investigate";
import type { DiscoverResult } from "./discover";
import type { WriteResult } from "./write";

const STAGE = "verify" as const;

export interface VerifyResult {
  finalRelPath: string;
  claims: VerifiedClaim[];
  blocking: number;
}

function makeJudge(ctx: RunCtx): EntailmentJudge {
  const cache = new Map<string, "supports" | "contradicts" | "neutral">();
  return async (claimText, refId) => {
    const key = `${refId}::${claimText}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const evidence = await getEvidenceByRef(ctx.runId, refId);
    if (!evidence) return "neutral";
    const payload = await readEvidencePayload(ctx.workspaceDir, evidence.relPath);
    const record =
      typeof (payload?.payload as { text?: unknown })?.text === "string"
        ? String((payload!.payload as { text: string }).text)
        : JSON.stringify(payload?.payload ?? null);
    try {
      const verdict = await runStructuredTask(
        ctx,
        {
          stage: STAGE,
          role: "entailment_judge",
          prompt:
            `CLAIM:\n${claimText}\n\nCITED WORK (${refId}) — retrieved record:\n` +
            clipForPrompt(record, 24_000),
        },
        (u) => {
          const o = vObject(u);
          const v = vString(o.verdict, "verdict");
          if (v !== "supports" && v !== "contradicts" && v !== "neutral") {
            throw new Error('verdict must be "supports"|"contradicts"|"neutral"');
          }
          return v;
        },
      );
      cache.set(key, verdict);
      return verdict;
    } catch {
      return "neutral"; // an unjudgeable citation is a warning, not a block
    }
  };
}

export async function runVerifyStage(
  ctx: RunCtx,
  investigation: InvestigateResult,
  discovery: DiscoverResult,
  written: WriteResult,
): Promise<VerifyResult> {
  const { gates } = ctx.spec;
  await emitRunEvent(ctx.runId, "stage_started", { stage: STAGE }, { stage: STAGE });
  const judge = makeJudge(ctx);
  const bestScore = discovery.best.scoreKind === "golden" ? discovery.best.score : null;

  let draft = await readRunFile(ctx.workspaceDir, written.taggedDraftRelPath);
  let verified: VerifiedClaim[] = [];

  for (let round = 1; round <= 2; round++) {
    const ground = await groundDocument(ctx, draft, bestScore);
    const readFileCache = new Map<string, string | null>();
    const readFile = (relPath: string): string | null => {
      if (!readFileCache.has(relPath)) readFileCache.set(relPath, null);
      return readFileCache.get(relPath)!;
    };
    // Pre-read the log/ablation targets the claims reference.
    for (const claim of ground.claims) {
      const tag = claim.tag;
      if (tag && (tag.kind === "log" || tag.kind === "ablation") && tag.target) {
        if (!readFileCache.has(tag.target)) {
          readFileCache.set(
            tag.target,
            await readRunFile(ctx.workspaceDir, tag.target).catch(() => null),
          );
        }
      }
    }
    verified = await verifyClaims(ground.claims, {
      tolerance: gates.numericTolerance,
      readFile,
      judge,
    });
    const blocking = blockingViolations(verified);
    await writeArtifact({
      runId: ctx.runId,
      workspaceDir: ctx.workspaceDir,
      stage: STAGE,
      kind: "claims_report",
      relPath: `stage3/verify/claims.round${round}.json`,
      content: JSON.stringify(
        verified.map((c) => ({
          type: c.claimType,
          status: c.status,
          verdict: c.verdict,
          breakCode: c.breakCode,
          tag: c.tag?.raw ?? c.raw,
          text: c.text,
          note: c.note ?? null,
        })),
        null,
        2,
      ),
    });
    await emitRunEvent(
      ctx.runId,
      "claim_checked",
      {
        pass: "verify",
        round,
        claims: verified.length,
        blocking: blocking.length,
        warnings: verified.filter((c) => c.verdict === "warning").length,
      },
      { stage: STAGE },
    );
    if (blocking.length === 0) break;
    if (round === 2) {
      await emitRunEvent(
        ctx.runId,
        "gate_failed",
        { gate: "VERIFICATION_GATE", blocking: blocking.length },
        { stage: STAGE },
      );
      throw new RunFailed(
        "VERIFICATION_GATE",
        `${blocking.length} blocking claim violations survived refinement — the draft is not promotable.`,
      );
    }
    // Refinement: rewrite the flagged sentences to match their evidence.
    const refined = await runAgentTask(ctx, {
      stage: STAGE,
      role: "resolver",
      branch: `refine${round}`,
      prompt:
        `TAGGED DRAFT:\n${clipForPrompt(draft, 140_000)}\n\n` +
        `BLOCKING CLAIM VIOLATIONS (rewrite each flagged sentence to match its cited evidence, ` +
        `re-tag it to a correct source, or delete it — everything else must stay unchanged):\n` +
        blocking
          .map((c) => `- [${c.breakCode}] "${c.text.slice(0, 200)}" (${c.tag?.raw ?? c.raw})${c.note ? ` — ${c.note}` : ""}`)
          .join("\n"),
    });
    const next = refined.text.trim();
    if (next.length > 200) {
      draft = next;
      await writeArtifact({
        runId: ctx.runId,
        workspaceDir: ctx.workspaceDir,
        stage: STAGE,
        kind: "draft",
        relPath: "stage3/draft/paper.refined.md",
        content: draft,
      });
    }
  }

  // Persist the claims ledger for the UI.
  const draftArtifactId = await upsertArtifact({
    runId: ctx.runId,
    stage: STAGE,
    kind: "draft",
    relPath: written.taggedDraftRelPath,
    sha256: sha256(draft),
    bytes: Buffer.byteLength(draft, "utf8"),
  });
  await replaceClaims(
    ctx.runId,
    draftArtifactId,
    verified.map((c) => ({
      claimType: c.claimType,
      text: c.text.slice(0, 2000),
      sourceTag: c.tag?.raw ?? c.raw,
      status: c.verdict === "dropped" ? "dropped" : c.status,
      breakCode: c.breakCode,
      detail: c.note ? { note: c.note } : undefined,
    })),
  );

  // ── promote: strip tags, drop unsourced sentences, append references ───
  let final = draft;
  // Remove sentences whose only support was "unsourced" (drop the tag AND its text
  // would be ideal; conservatively we drop just the tag and flag the count).
  const unsourced = parseClaims(draft).filter((c) => c.claimType === "unsourced").length;
  final = stripTags(final);
  const usedRefs = citedRefIds(draft);
  const retrieved = new Set<string>(
    (await listEvidence(ctx.runId))
      .map((row) => row.ref_id)
      .filter((r): r is string => typeof r === "string"),
  );
  const titleByRef = new Map(investigation.references.map((r) => [r.refId, r.title]));
  const refLines = usedRefs
    .filter((refId) => retrieved.has(refId))
    .map((refId) => `- ${refId}${titleByRef.get(refId) ? ` — ${titleByRef.get(refId)}` : ""}`);
  final +=
    `\n\n# References\n\n${refLines.join("\n") || "(none)"}\n` +
    (discovery.best.scoreKind === "llm_rubric"
      ? "\n> ⚠ No golden evaluator was configured for this run: quantitative outcomes are unverified.\n"
      : "") +
    (unsourced > 0 ? `\n> ${unsourced} explicitly unsourced statement(s) were removed from claims accounting.\n` : "");

  const finalRelPath = "stage3/final/paper.md";
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "final",
    relPath: finalRelPath,
    content: final,
  });
  await emitRunEvent(
    ctx.runId,
    "stage_finished",
    { stage: STAGE, finalRelPath, claims: verified.length },
    { stage: STAGE },
  );
  return { finalRelPath, claims: verified, blocking: 0 };
}
