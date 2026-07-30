import { describe, expect, it } from "vitest";
import {
  citedRefIds,
  classifyClaim,
  hasNumberToken,
  parseClaims,
  parseTag,
  stripTags,
} from "../src/research/claims/grammar";
import { groundClaims } from "../src/research/claims/ground";
import {
  extractNumbers,
  methodOverlap,
  numbersMatch,
  verifyClaims,
  verifyNumericalClaim,
} from "../src/research/claims/verify";

const LOG = [
  "[001] 2026-07-29T10:00:00Z set up baseline pipeline with 3-layer MLP",
  "[002] 2026-07-29T10:05:00Z baseline accuracy 71.2% on validation split",
  "[003] 2026-07-29T10:30:00Z switched optimizer to AdamW, lr 0.0003",
  "[004] 2026-07-29T11:00:00Z best run: accuracy 87.3% (0.873), latency 142 ms",
  "[005] 2026-07-29T11:10:00Z final model saved to solution/model.bin",
].join("\n");

describe("tag grammar", () => {
  it("parses each tag kind", () => {
    expect(parseTag("{{src: log:stage2/nodes/b1/experimental_log.md:4}}")).toEqual({
      kind: "log",
      target: "stage2/nodes/b1/experimental_log.md",
      detail: "4",
      raw: "{{src: log:stage2/nodes/b1/experimental_log.md:4}}",
    });
    expect(parseTag("{{src: cite:doi:10.1038/s41586-020-1}}")).toMatchObject({
      kind: "cite",
      target: "doi:10.1038/s41586-020-1",
    });
    expect(parseTag("{{src: ablation:stage2/ablations/ablations.json#no-adamw}}")).toMatchObject({
      kind: "ablation",
      target: "stage2/ablations/ablations.json",
      detail: "no-adamw",
    });
    expect(parseTag("{{src: brief:plan}}")).toMatchObject({ kind: "brief", target: "plan" });
    expect(parseTag("{{src: unsourced}}")).toMatchObject({ kind: "unsourced" });
  });

  it("rejects malformed tags", () => {
    expect(parseTag("{{src: log:no-line-number}}")).toBeNull();
    expect(parseTag("{{src: ablation:file.json}}")).toBeNull(); // missing #key
    expect(parseTag("{{source: cite:doi:10.1/x}}")).toBeNull();
  });

  it("types claims by tag kind and number presence", () => {
    const log = parseTag("{{src: log:a.md:2}}");
    expect(classifyClaim("accuracy reached 87.3%", log)).toBe("numerical");
    expect(classifyClaim("we used an AdamW optimizer", log)).toBe("methodological");
    expect(classifyClaim("Smith showed X", parseTag("{{src: cite:doi:10.1/x}}"))).toBe("citation");
    expect(classifyClaim("whatever", null)).toBe("malformed");
  });

  it("segments a tagged document into claims", () => {
    const doc = [
      "# Results",
      "",
      "The best configuration reaches 87.3% accuracy. {{src: log:log.md:4}} " +
        "This outperforms the published baseline. {{src: cite:doi:10.1/x}}",
      "",
      "Broken tag here. {{src: bogus}}",
    ].join("\n");
    const claims = parseClaims(doc);
    expect(claims).toHaveLength(3);
    expect(claims[0]!.claimType).toBe("numerical");
    expect(claims[1]!.claimType).toBe("citation");
    expect(claims[2]!.claimType).toBe("malformed");
  });

  it("strips tags and collects cited refs", () => {
    const doc = "A result. {{src: log:l.md:1}} A cite. {{src: cite:pmid:123}}";
    expect(stripTags(doc)).toBe("A result. A cite.");
    expect(citedRefIds(doc)).toEqual(["pmid:123"]);
  });

  it("detects number tokens but not inline code", () => {
    expect(hasNumberToken("we got 42% better")).toBe(true);
    expect(hasNumberToken("see `v2` config")).toBe(false);
  });
});

describe("ground checker", () => {
  const doc = [
    "# Problem",
    "We optimize accuracy. {{src: brief:plan}}",
    "# Results",
    "Accuracy reached 87.3%. {{src: log:log.md:4}}",
    "Latency was 999 s. {{src: log:log.md:99}}",
    "Prior work agrees. {{src: cite:doi:10.1/known}}",
    "Unknown paper agrees too. {{src: cite:doi:10.1/never-fetched}}",
    "We believe this generalises. {{src: unsourced}}",
  ].join("\n\n");

  const ctx = {
    readFile: (rel: string) => (rel === "log.md" ? LOG : null),
    bestScore: 87.3,
    retrievedRefIds: new Set(["doi:10.1/known"]),
    requiredSections: ["Problem", "Results", "Limitations"],
  };

  it("labels claims and computes the grounding ratio", () => {
    const report = groundClaims(doc, parseClaims(doc), ctx);
    const byText = new Map(report.claims.map((c) => [c.text, c]));
    expect(byText.get("Accuracy reached 87.3%.")!.status).toBe("supported");
    expect(byText.get("Latency was 999 s.")!.breakCode).toBe("LOG_LINE_MISSING");
    expect(byText.get("Prior work agrees.")!.status).toBe("supported");
    expect(byText.get("Unknown paper agrees too.")!.breakCode).toBe("CITE_NOT_RETRIEVED");
    // unsourced excluded from denominator: 5 counted, 3 supported
    expect(report.totals.unsourced).toBe(1);
    expect(report.groundingRatio).toBeCloseTo(3 / 5);
    expect(report.missingSections).toEqual(["Limitations"]);
    expect(report.flags.some((f) => f.startsWith("SECTION_MISSING"))).toBe(true);
  });

  it("flags an absent headline score", () => {
    const noScoreDoc = "# Results\n\nAll good qualitatively. {{src: log:log.md:1}}";
    const report = groundClaims(noScoreDoc, parseClaims(noScoreDoc), { ...ctx, bestScore: 87.3 });
    expect(report.flags.some((f) => f.startsWith("HEADLINE_SCORE_ABSENT"))).toBe(true);
  });
});

describe("numerical verification", () => {
  it("normalizes percent vs fraction and ms vs seconds", () => {
    const [a] = extractNumbers("87.3%");
    const [b] = extractNumbers("0.873");
    expect(numbersMatch(a!, b!, 0.01)).toBe(true);
    const [ms] = extractNumbers("142 ms");
    const [s] = extractNumbers("0.142 s");
    expect(numbersMatch(ms!, s!, 0.01)).toBe(true);
    const [k] = extractNumbers("5k");
    const [plain] = extractNumbers("5000");
    expect(numbersMatch(k!, plain!, 0.01)).toBe(true);
  });

  it("verifies numbers against the cited log region (±3 lines)", () => {
    const ok = verifyNumericalClaim("accuracy of 87.3% with 142 ms latency", LOG, 4, {
      tolerance: 0.01,
    });
    expect(ok.ok).toBe(true);
    const bad = verifyNumericalClaim("accuracy of 95.0%", LOG, 4, { tolerance: 0.01 });
    expect(bad.ok).toBe(false);
    expect(bad.missing).toContain("95.0%");
  });

  it("ignores small prose integers", () => {
    const ok = verifyNumericalClaim("across 3 rounds we reached 87.3%", LOG, 4, {
      tolerance: 0.01,
    });
    expect(ok.ok).toBe(true);
  });

  it("respects the window: a number 4+ lines away fails", () => {
    const res = verifyNumericalClaim("baseline was 71.2%", LOG, 5, { tolerance: 0.01 });
    expect(res.ok).toBe(true); // line 2 is within 5±3
    const far = verifyNumericalClaim("accuracy 87.3%", LOG, 1, { tolerance: 0.01 });
    expect(far.ok).toBe(true); // line 4 within 1+3
  });
});

describe("method overlap", () => {
  it("scores overlap of substantive tokens", () => {
    const high = methodOverlap("switched the optimizer to AdamW", LOG, 3);
    expect(high).toBeGreaterThan(0.5);
    const low = methodOverlap("quantum annealing on a photonic chip", LOG, 3);
    expect(low).toBeLessThan(0.2);
  });
});

describe("claim verifier dispatch", () => {
  it("passes, blocks, and drops by claim type", async () => {
    const doc = [
      "Accuracy reached 87.3%. {{src: log:log.md:4}}",
      "Accuracy reached 95%. {{src: log:log.md:4}}",
      "Known work agrees. {{src: cite:doi:10.1/known}}",
      "Contradicted work agrees. {{src: cite:doi:10.1/contra}}",
      "We think so. {{src: unsourced}}",
    ].join(" ");
    const grounded = groundClaims(doc, parseClaims(doc), {
      readFile: () => LOG,
      bestScore: null,
      retrievedRefIds: new Set(["doi:10.1/known", "doi:10.1/contra"]),
      requiredSections: [],
    });
    const verified = await verifyClaims(grounded.claims, {
      tolerance: 0.01,
      readFile: () => LOG,
      judge: async (_claim, refId) => (refId.includes("contra") ? "contradicts" : "supports"),
    });
    const byText = new Map(verified.map((c) => [c.text, c]));
    expect(byText.get("Accuracy reached 87.3%.")!.verdict).toBe("pass");
    expect(byText.get("Accuracy reached 95%.")!.verdict).toBe("blocking");
    expect(byText.get("Accuracy reached 95%.")!.breakCode).toBe("NUM_TOLERANCE");
    expect(byText.get("Known work agrees.")!.verdict).toBe("pass");
    expect(byText.get("Contradicted work agrees.")!.breakCode).toBe("CITE_CONTRADICTED");
    expect(byText.get("We think so.")!.verdict).toBe("dropped");
  });
});
