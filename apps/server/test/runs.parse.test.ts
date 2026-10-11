import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { extractAmounts, extractTimer, parseProtocol, spokenForm } from "../src/services/runs/parse";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(here, "../seed/protocols");

function seed(rel: string): string {
  return matter(fs.readFileSync(path.join(SEED, rel), "utf8")).content;
}

describe("parseProtocol on the seeded protocols", () => {
  it("TSS competent cells: nine steps, timers, amounts, note attachment", () => {
    const snap = parseProtocol(seed("Bacterial culture/chemically-competent-cells-tss.md"));
    expect(snap.loose).toBe(false);
    expect(snap.section).toBe("Procedure");
    expect(snap.steps).toHaveLength(9);
    expect(snap.steps[0]!.text).toMatch(/^Grow a 5 ml seed culture/);
    // Step 4 stands on ice for 10 min; step 5 spins 10 min.
    expect(snap.steps[3]!.timer).toEqual({ seconds: 600, label: "10 minutes" });
    expect(snap.steps[4]!.timer?.seconds).toBe(600);
    expect(snap.steps[0]!.timer).toBeNull();
    // Amounts are the protocol's own numbers.
    expect(snap.steps[6]!.amounts.find((a) => a.unit === "%")).toMatchObject({ qty: "10", ratio: true, of: "TSS" });
    expect(snap.steps[7]!.amounts[0]).toMatchObject({ qty: "100", unit: "µL" });
    expect(snap.steps[4]!.amounts.map((a) => a.unit)).toEqual(["min", "rpm", "°C"]);
    // The note that names step 4 travels with it.
    expect(snap.steps[3]!.note).toMatch(/after step 4/);
    expect(snap.steps[0]!.note).toBeNull();
    // Materials and the base volume the procedure is written for.
    expect(snap.materials.map((m) => m.name)).toEqual(expect.arrayContaining(["TSS buffer", "LB", "ice"]));
    expect(snap.base).toMatchObject({ qty: 50, unit: "mL" });
    expect(snap.hash).toHaveLength(16);
  });

  it("Taq PCR: the numbered cycling section wins, sub-bullets stay with their step, the table is materials", () => {
    const snap = parseProtocol(seed("PCR/standard-taq-pcr.md"));
    expect(snap.section).toBe("Cycling");
    expect(snap.steps).toHaveLength(4);
    expect(snap.steps[1]!.text).toContain("- 94 C for 30 s");
    expect(snap.steps[0]!.timer).toEqual({ seconds: 120, label: "2 minutes" });
    const water = snap.materials.find((m) => /water/i.test(m.name));
    expect(water?.amount).toMatchObject({ qty: "36.8", unit: "µL" });
  });

  it("Gibson: a 'Reaction' section with four steps and an hour-long timer", () => {
    const snap = parseProtocol(seed("Cloning/gibson-assembly-reaction.md"));
    expect(snap.steps).toHaveLength(4);
    expect(snap.steps[2]!.timer).toEqual({ seconds: 3600, label: "1 hour" });
    expect(snap.steps[3]!.amounts[0]).toMatchObject({ qty: "2", unit: "µL" });
  });

  it("every seeded protocol parses to at least two steps without the loose fallback", () => {
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []));
    const files = walk(SEED);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const snap = parseProtocol(matter(fs.readFileSync(f, "utf8")).content);
      expect(snap.loose, f).toBe(false);
      expect(snap.steps.length, f).toBeGreaterThanOrEqual(2);
      for (const s of snap.steps) expect(s.say.length, f).toBeGreaterThan(0);
    }
  });

  it("a protocol with no numbered list falls back to paragraphs and says so", () => {
    const snap = parseProtocol("## Procedure\n\nMix everything.\n\nWait a while.\n\n## Notes\n\nBe careful.\n");
    expect(snap.loose).toBe(true);
    expect(snap.steps.map((s) => s.text)).toEqual(["Mix everything.", "Wait a while."]);
  });

  it("editing a later step does not renumber earlier ones", () => {
    const a = parseProtocol("## Steps\n1. First.\n2. Second.\n3. Third.\n");
    const b = parseProtocol("## Steps\n1. First.\n2. Second.\n3. Third, now longer.\n4. Fourth.\n");
    expect(b.steps.slice(0, 2)).toEqual(a.steps.slice(0, 2));
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("amounts and speech", () => {
  it("extracts quantities with what they apply to", () => {
    expect(extractAmounts("Add 5 ul of T4 ligase and 2.5 ul of buffer.")).toEqual([
      { qty: "5", unit: "µL", of: "T4 ligase", ratio: false },
      { qty: "2.5", unit: "µL", of: "buffer", ratio: false },
    ]);
    expect(extractAmounts("Resuspend in TSS at 10% of the original culture volume")[0]).toMatchObject({ qty: "10", unit: "%", ratio: true, of: "TSS" });
    expect(extractAmounts("Incubate at 30-37 C")[0]).toMatchObject({ qty: "30-37", unit: "°C" });
    // A dimension is not a multiple.
    expect(extractAmounts("suits a 7 x 10 cm tray").some((a) => a.unit === "×")).toBe(false);
  });

  it("timers take the lower bound of a range", () => {
    expect(extractTimer("Cool about 5 min, then add the stain")).toEqual({ seconds: 300, label: "5 minutes" });
    expect(extractTimer("Run for 1-2 min")).toEqual({ seconds: 60, label: "1 to 2 minutes" });
    expect(extractTimer("Leave to set for 30 min")).toEqual({ seconds: 1800, label: "30 minutes" });
    expect(extractTimer("Weigh the agarose")).toBeNull();
  });

  it("speaks units in full and ranges with 'to'", () => {
    expect(spokenForm("Spin 10 min at 3000 rpm, 4 C.")).toBe("Spin 10 minutes at 3000 rpm, 4 degrees.");
    expect(spokenForm("Aliquot 100 ul into the chilled tubes.")).toBe("Aliquot 100 microlitres into the chilled tubes.");
    expect(spokenForm("Incubate at 30-37 C until OD600 reaches 0.2-0.5.")).toBe("Incubate at 30 to 37 degrees until OD six hundred reaches 0.2-0.5.");
    expect(spokenForm("Freeze at -80 C.")).toBe("Freeze at minus 80 degrees.");
  });
});
