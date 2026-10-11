// The mechanical checks. Every bundled starter must pass with no halt, so
// the rules do not cry wolf on real protocols; a protocol written to break
// each rule must trip exactly that rule.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { lintProtocol } from "../src/services/artifactIndex/lint";

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/protocols");

function starters(): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push({ file: full, body: matter(fs.readFileSync(full, "utf8")).content });
    }
  };
  walk(SEED);
  return out;
}

const ids = (body: string) => lintProtocol(body).findings.map((f) => f.ruleId);

describe("protocol lint", () => {
  it("raises no halt on any starter, and few warnings", () => {
    for (const s of starters()) {
      const r = lintProtocol(s.body);
      expect(r.halts, s.file).toBe(0);
      expect(r.warns, `${s.file}: ${JSON.stringify(r.findings)}`).toBeLessThanOrEqual(2);
    }
  });

  it("halts on a value that cannot be right", () => {
    const r = lintProtocol([
      "## Procedure",
      "",
      "1. Spin 10 min at 50,000 rpm.",
      "2. Heat the block to 200 C.",
      "3. Adjust to pH 15.",
      "4. Incubate at 37 C, 10% CO2.",
      "",
    ].join("\n"));
    const halts = r.findings.filter((f) => f.severity === "halt");
    expect(halts.map((f) => f.path)).toEqual(["1.1", "1.2", "1.3"]);
    expect(halts[0]!.message).toContain("rpm");
    expect(halts[1]!.message).toContain("temperature");
    expect(halts[2]!.message).toContain("pH");
    expect(r.halts).toBe(3);
  });

  it("warns on a number with no unit, but not on labels, ratios, ranges or exponents", () => {
    expect(ids("## P\n\n1. Add 5 of buffer and mix.\n")).toContain("number-without-unit");
    const fine = [
      "## P",
      "",
      "1. Repeat step 3 on day 2 with option 1.",
      "2. Mix insert and vector at 6:1, then 3.8 x 10^6 cells per 10 cm plate.",
      "3. Heat shock 30-60 s, then 45 min at 37 C, 250-400 rpm, OD600 0.2-0.5.",
      "4. Dilute 1:1000 — 100 ul of a 100 mg/ml stock into 100 ml, 25% final.",
      "5. Run 39 cycles, 10X buffer, 5 U/ul enzyme.",
      "",
    ].join("\n");
    expect(ids(fine)).not.toContain("number-without-unit");
  });

  it("notices a gap in the numbering as written", () => {
    const r = lintProtocol("## Steps\n\n1. One.\n2. Two.\n4. Four.\n");
    const gap = r.findings.find((f) => f.ruleId === "step-numbering-gap");
    expect(gap?.message).toBe("Step 3 is followed by step 4 in the source.");
    // Numbering restarts in a new section without complaint.
    expect(ids("## A\n\n1. One.\n2. Two.\n\n## B\n\n1. One again.\n")).not.toContain("step-numbering-gap");
  });

  it("flags an empty section and a duplicated step", () => {
    const r = lintProtocol("## Materials\n\n## Procedure\n\n1. Spin 5 min.\n2. Spin 5 min.\n");
    expect(ids(r.findings.length ? "## Materials\n\n## Procedure\n\n1. Spin 5 min.\n2. Spin 5 min.\n" : "")).toContain("empty-section");
    const dup = r.findings.find((f) => f.ruleId === "duplicate-step");
    expect(dup?.path).toBe("2.2");
    expect(dup?.message).toBe("Same as step 2.1.");
  });

  it("checks the reagents a step uses against Materials", () => {
    const r = lintProtocol([
      "## Materials",
      "",
      "- LB agar plates",
      "- Competent cells",
      "",
      "## Procedure",
      "",
      "1. Add 1 ul plasmid to the cells.",
      "2. Plate on LB with ampicillin at 100 ug/ml.",
      "",
    ].join("\n"));
    const missing = r.findings.filter((f) => f.ruleId === "reagent-not-in-materials").map((f) => f.excerpt);
    expect(missing).toContain("ampicillin");
    expect(missing).toContain("plasmid");
    expect(missing).not.toContain("lb");
  });

  it("asks for a Materials section when steps name several reagents and there is none", () => {
    const r = lintProtocol("## Procedure\n\n1. Add Tris and EDTA.\n2. Add lysozyme, then ethanol.\n");
    expect(ids("## Procedure\n\n1. Add Tris and EDTA.\n2. Add lysozyme, then ethanol.\n")).toContain("materials-missing");
    expect(r.findings.find((f) => f.ruleId === "materials-missing")?.message).toContain("4 reagents");
  });

  it("points out a protocol with no steps at all", () => {
    expect(ids("## Overview\n\nJust prose, no numbered steps.\n")).toContain("no-steps");
  });
});
