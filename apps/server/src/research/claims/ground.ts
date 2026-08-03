// The deterministic Ground checker — pure TS, no LLM. Verifies what code can
// verify: tagged artifacts exist, log lines exist, the headline score matches
// the best run, required sections are present. Emits per-claim labels and the
// grounding ratio the fail-closed gate reads. LLM judgment (contradictions,
// overclaims) belongs to the Critic, never here.
import type { ParsedClaim } from "./grammar";

export interface GroundContext {
  /** Read a workspace-relative file; null when it doesn't exist. */
  readFile: (relPath: string) => string | null;
  /** The best run's verified score; null when no golden evaluator ran. */
  bestScore: number | null;
  /** Ref ids with a cached retrieval in this run (retrieval-only citations). */
  retrievedRefIds: Set<string>;
  requiredSections: readonly string[];
}

export interface GroundedClaim extends ParsedClaim {
  status: "supported" | "partial" | "unsupported";
  breakCode: string | null;
  note?: string;
}

export interface GroundReport {
  claims: GroundedClaim[];
  groundingRatio: number;
  missingSections: string[];
  flags: string[];
  totals: { supported: number; partial: number; unsupported: number; unsourced: number };
}

/** Split a log file into 1-based lines (cached per relPath by the caller). */
function logLine(content: string, line: number): string | null {
  const lines = content.split("\n");
  if (line < 1 || line > lines.length) return null;
  const text = lines[line - 1]!.trim();
  return text.length > 0 ? text : null;
}

export function groundClaims(
  doc: string,
  claims: ParsedClaim[],
  ctx: GroundContext,
): GroundReport {
  const fileCache = new Map<string, string | null>();
  const read = (relPath: string): string | null => {
    if (!fileCache.has(relPath)) fileCache.set(relPath, ctx.readFile(relPath));
    return fileCache.get(relPath)!;
  };

  const grounded: GroundedClaim[] = claims.map((claim) => {
    const tag = claim.tag;
    if (claim.claimType === "malformed" || !tag) {
      return { ...claim, status: "unsupported", breakCode: "TAG_MALFORMED" };
    }
    if (claim.claimType === "unsourced") {
      // Explicitly unsourced: excluded from the ratio, dropped at render time.
      return { ...claim, status: "unsupported", breakCode: null };
    }
    if (tag.kind === "cite") {
      if (!ctx.retrievedRefIds.has(tag.target!)) {
        return { ...claim, status: "unsupported", breakCode: "CITE_NOT_RETRIEVED" };
      }
      // Existence verified deterministically; entailment is the verifier's job.
      return { ...claim, status: "supported", breakCode: null };
    }
    if (tag.kind === "log") {
      const content = read(tag.target!);
      if (content === null) {
        return { ...claim, status: "unsupported", breakCode: "SRC_MISSING" };
      }
      const line = logLine(content, Number(tag.detail));
      if (line === null) {
        return { ...claim, status: "unsupported", breakCode: "LOG_LINE_MISSING" };
      }
      return { ...claim, status: "supported", breakCode: null };
    }
    if (tag.kind === "ablation") {
      const content = read(tag.target!);
      if (content === null) {
        return { ...claim, status: "unsupported", breakCode: "SRC_MISSING" };
      }
      if (!content.includes(tag.detail!)) {
        return { ...claim, status: "partial", breakCode: "ABLATION_KEY_MISSING" };
      }
      return { ...claim, status: "supported", breakCode: null };
    }
    // brief:<sectionId> — accepted section ids only.
    const ok = ["landscape", "plan", "references"].includes(tag.target ?? "");
    return ok
      ? { ...claim, status: "supported", breakCode: null }
      : { ...claim, status: "unsupported", breakCode: "BRIEF_SECTION_UNKNOWN" };
  });

  const missingSections = ctx.requiredSections.filter(
    (section) => !new RegExp(`^#{1,3}\\s+${section}\\b`, "mi").test(doc),
  );

  const flags: string[] = [];
  for (const claim of grounded) {
    if (claim.breakCode) {
      flags.push(
        `${claim.breakCode}: "${claim.text.slice(0, 120)}" (${claim.tag?.raw ?? claim.raw})`,
      );
    }
  }
  for (const section of missingSections) flags.push(`SECTION_MISSING: ${section}`);

  // Headline-score check: if we have a verified best score, some numerical
  // claim in Results must state it (within a loose textual match).
  if (ctx.bestScore != null) {
    const scoreText = formatScoreVariants(ctx.bestScore);
    const mentioned = grounded.some(
      (claim) =>
        claim.claimType === "numerical" && scoreText.some((v) => claim.text.includes(v)),
    );
    if (!mentioned) flags.push(`HEADLINE_SCORE_ABSENT: best verified score ${ctx.bestScore}`);
  }

  const totals = { supported: 0, partial: 0, unsupported: 0, unsourced: 0 };
  for (const claim of grounded) {
    if (claim.claimType === "unsourced") totals.unsourced++;
    else if (claim.status === "supported") totals.supported++;
    else if (claim.status === "partial") totals.partial++;
    else totals.unsupported++;
  }
  const denominator = totals.supported + totals.partial + totals.unsupported;
  const groundingRatio = denominator === 0 ? 0 : totals.supported / denominator;

  return { claims: grounded, groundingRatio, missingSections, flags, totals };
}

/** Textual variants a score may be reported as (rounding tolerance). */
function formatScoreVariants(score: number): string[] {
  const variants = new Set<string>();
  variants.add(String(score));
  for (const digits of [0, 1, 2, 3]) variants.add(score.toFixed(digits));
  if (score > 0 && score <= 1) {
    for (const digits of [0, 1, 2]) variants.add((score * 100).toFixed(digits));
  }
  return [...variants];
}
