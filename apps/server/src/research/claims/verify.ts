// The Claim Verifier — dispatches on claim type. Numerical and methodological
// checks are pure functions (unit-tested against fixtures); citation
// entailment is the one LLM call, injected as a callback so this module stays
// deterministic and testable. Blocking violations block promotion of a draft.
import type { GroundedClaim } from "./ground";

export interface VerifiedClaim extends GroundedClaim {
  verdict: "pass" | "blocking" | "dropped" | "warning";
}

export interface NumberToken {
  value: number;
  /** Normalised to base units: % → fraction, ms → seconds, k/M expanded. */
  normalized: number;
  raw: string;
}

const NUM_RE = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?\s*(%|×|x|ms|s|sec|seconds|k|M)?(?![\w])/gi;

/** Extract numbers with unit normalisation (%→fraction, ms→s, k/M scaled). */
export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const cleaned = text.replace(/`[^`]*`/g, "");
  let m: RegExpExecArray | null;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(cleaned)) !== null) {
    const value = parseFloat(m[0]);
    if (!Number.isFinite(value)) continue;
    const unit = (m[1] ?? "").toLowerCase();
    let normalized = value;
    if (unit === "%") normalized = value / 100;
    else if (unit === "ms") normalized = value / 1000;
    else if (unit === "k") normalized = value * 1000;
    else if (unit === "m") normalized = value * 1_000_000;
    out.push({ value, normalized, raw: m[0].trim() });
  }
  return out;
}

/** Two numbers match when either representation agrees within tolerance —
 *  covers percent-vs-fraction and ms-vs-second mismatches. */
export function numbersMatch(a: NumberToken, b: NumberToken, tolerance: number): boolean {
  const pairs: Array<[number, number]> = [
    [a.value, b.value],
    [a.normalized, b.normalized],
    [a.value, b.normalized],
    [a.normalized, b.value],
  ];
  return pairs.some(([x, y]) => {
    if (x === y) return true;
    const scale = Math.max(Math.abs(x), Math.abs(y));
    if (scale === 0) return true;
    return Math.abs(x - y) / scale <= tolerance;
  });
}

/** Numerical claim: every number in the claim must appear in the cited log
 *  region (line ±window) within tolerance. */
export function verifyNumericalClaim(
  claimText: string,
  logContent: string,
  line: number,
  opts: { tolerance: number; window?: number },
): { ok: boolean; missing: string[] } {
  const window = opts.window ?? 3;
  const lines = logContent.split("\n");
  const lo = Math.max(0, line - 1 - window);
  const hi = Math.min(lines.length, line + window);
  const region = lines.slice(lo, hi).join("\n");
  const regionNumbers = extractNumbers(region);
  const claimNumbers = extractNumbers(claimText);
  const missing: string[] = [];
  for (const cn of claimNumbers) {
    // Small integers are usually prose counts ("3 rounds", "one of 5 seeds"),
    // not measurements — only enforce match for non-trivial values.
    if (Number.isInteger(cn.value) && Math.abs(cn.value) <= 12 && !cn.raw.includes("%")) continue;
    if (!regionNumbers.some((rn) => numbersMatch(cn, rn, opts.tolerance))) {
      missing.push(cn.raw);
    }
  }
  return { ok: missing.length === 0, missing };
}

const STOPWORDS = new Set(
  "a an the of to in on for with and or we our is are was were be been this that it its as by from at using use used".split(
    " ",
  ),
);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s._-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Methodological claim: substantive token overlap with the cited log region. */
export function methodOverlap(
  claimText: string,
  logContent: string,
  line: number,
  window = 3,
): number {
  const lines = logContent.split("\n");
  const lo = Math.max(0, line - 1 - window);
  const hi = Math.min(lines.length, line + window);
  const region = lines.slice(lo, hi).join("\n");
  const a = tokenize(claimText);
  const b = tokenize(region);
  if (a.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

export type EntailmentJudge = (
  claimText: string,
  refId: string,
) => Promise<"supports" | "contradicts" | "neutral">;

export interface VerifyOpts {
  tolerance: number;
  overlapThreshold?: number;
  readFile: (relPath: string) => string | null;
  judge: EntailmentJudge;
}

/** Verify grounded claims. Ground already handled existence; this pass
 *  checks content: numeric tolerance, citation entailment, method overlap. */
export async function verifyClaims(
  claims: GroundedClaim[],
  opts: VerifyOpts,
): Promise<VerifiedClaim[]> {
  const overlapThreshold = opts.overlapThreshold ?? 0.25;
  const out: VerifiedClaim[] = [];
  for (const claim of claims) {
    // Ground failures and malformed/unsourced claims are already decided.
    if (claim.claimType === "malformed") {
      out.push({ ...claim, verdict: "dropped" });
      continue;
    }
    if (claim.claimType === "unsourced") {
      out.push({ ...claim, verdict: "dropped", breakCode: "UNSOURCED" });
      continue;
    }
    if (claim.status === "unsupported") {
      out.push({ ...claim, verdict: "blocking" });
      continue;
    }
    const tag = claim.tag!;
    if (claim.claimType === "numerical" && tag.kind === "log") {
      const content = opts.readFile(tag.target!);
      if (content === null) {
        out.push({ ...claim, verdict: "blocking", breakCode: "SRC_MISSING" });
        continue;
      }
      const check = verifyNumericalClaim(claim.text, content, Number(tag.detail), {
        tolerance: opts.tolerance,
      });
      out.push(
        check.ok
          ? { ...claim, verdict: "pass" }
          : {
              ...claim,
              verdict: "blocking",
              breakCode: "NUM_TOLERANCE",
              note: `numbers not found in cited log region: ${check.missing.join(", ")}`,
            },
      );
      continue;
    }
    if (claim.claimType === "citation") {
      const verdict = await opts.judge(claim.text, tag.target!);
      if (verdict === "contradicts") {
        out.push({ ...claim, verdict: "blocking", breakCode: "CITE_CONTRADICTED" });
      } else if (verdict === "neutral") {
        out.push({ ...claim, verdict: "warning", status: "partial", breakCode: "CITE_NEUTRAL" });
      } else {
        out.push({ ...claim, verdict: "pass" });
      }
      continue;
    }
    if (claim.claimType === "methodological" && tag.kind === "log") {
      const content = opts.readFile(tag.target!);
      if (content === null) {
        out.push({ ...claim, verdict: "blocking", breakCode: "SRC_MISSING" });
        continue;
      }
      const overlap = methodOverlap(claim.text, content, Number(tag.detail));
      out.push(
        overlap >= overlapThreshold
          ? { ...claim, verdict: "pass" }
          : {
              ...claim,
              verdict: "warning",
              status: "partial",
              breakCode: "METHOD_OVERLAP_LOW",
              note: `token overlap ${(overlap * 100).toFixed(0)}% < ${(overlapThreshold * 100).toFixed(0)}%`,
            },
      );
      continue;
    }
    // numerical/methodological with ablation/brief tags: Ground's existence
    // checks are all we can do deterministically.
    out.push({ ...claim, verdict: "pass" });
  }
  return out;
}

export function blockingViolations(claims: VerifiedClaim[]): VerifiedClaim[] {
  return claims.filter((c) => c.verdict === "blocking");
}
