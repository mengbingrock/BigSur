// The tree is derived from markdown and rendered back to it. The contract that
// matters: parsing is stable under its own rendering, every starter protocol
// parses into the sections and steps a person would count, and nothing inside
// a code fence is mistaken for structure.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  allSections,
  allSteps,
  materialsOf,
  parseTree,
  renderTree,
  sectionText,
  stepAt,
} from "../src/services/protocolTree";

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/protocols");

function starters(): Array<{ file: string; name: string; body: string }> {
  const out: Array<{ file: string; name: string; body: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        const parsed = matter(fs.readFileSync(full, "utf8"));
        out.push({ file: full, name: String(parsed.data.name), body: parsed.content });
      }
    }
  };
  walk(SEED);
  return out;
}

const byName = (name: string) => starters().find((s) => s.name === name)!;

describe("protocol tree", () => {
  it("reads the twelve starters", () => {
    expect(starters()).toHaveLength(12);
  });

  it("is stable under its own rendering, for every starter", () => {
    for (const s of starters()) {
      const once = parseTree(s.body);
      const rendered = renderTree(once);
      const twice = parseTree(rendered);
      expect(twice, s.file).toEqual(once);
      expect(renderTree(twice), s.file).toBe(rendered);
    }
  });

  it("numbers sections and steps by position", () => {
    const t = parseTree(byName("Gibson assembly reaction").body);
    expect(t.sections.map((s) => [s.path, s.title])).toEqual([
      ["1", "Primer design"],
      ["2", "Reaction"],
      ["3", "Notes"],
    ]);
    const reaction = t.sections[1]!;
    expect(reaction.steps.map((s) => s.path)).toEqual(["2.1", "2.2", "2.3", "2.4"]);
    expect(reaction.steps[2]!.text).toBe("Incubate 1 hour at 50 C, or follow the master mix manufacturer's timing.");
    // Prose-only sections have no steps; bullet lists are prose, not steps.
    expect(t.sections[0]!.steps).toHaveLength(0);
    expect(t.sections[0]!.prose).toContain("Order primers about 60 bp long");
    expect(t.sections[2]!.steps).toHaveLength(0);
    expect(t.sections[2]!.prose).toContain("- Success falls off sharply");
  });

  it("folds an indented continuation into its step", () => {
    const t = parseTree(byName("Colony PCR screening").body);
    const cycling = allSections(t).find((s) => s.title === "Cycling")!;
    expect(cycling.steps).toHaveLength(4);
    // The bullet lines under "39 cycles of:" are part of step 2.
    expect(cycling.steps[1]!.text).toContain("39 cycles of:");
    expect(cycling.steps[1]!.text).toContain("56 C for 30 s");
    expect(cycling.steps[2]!.text).toBe("68 C for 20 min");
  });

  it("nests numbered sub-steps one level", () => {
    const t = parseTree("## Procedure\n\n1. Prepare the mix.\n   1. Thaw the buffer.\n   2. Vortex it.\n2. Incubate.\n");
    const steps = t.sections[0]!.steps;
    expect(steps.map((s) => s.path)).toEqual(["1.1", "1.2"]);
    expect(steps[0]!.substeps.map((s) => [s.path, s.text])).toEqual([
      ["1.1.1", "Thaw the buffer."],
      ["1.1.2", "Vortex it."],
    ]);
    expect(stepAt(t, "1.1.2")?.text).toBe("Vortex it.");
    expect(renderTree(t)).toBe("## Procedure\n\n1. Prepare the mix.\n   1. Thaw the buffer.\n   2. Vortex it.\n2. Incubate.\n");
  });

  it("makes a child section of a deeper heading, with the heading path", () => {
    const t = parseTree("## Materials\n\nStuff.\n\n### Buffers\n\n- TE\n\n## Procedure\n\n1. Go.\n");
    expect(t.sections.map((s) => s.path)).toEqual(["1", "2"]);
    const child = t.sections[0]!.children[0]!;
    expect(child.path).toBe("1.1");
    expect(child.heading).toBe("Materials › Buffers");
    expect(allSections(t).map((s) => s.path)).toEqual(["1", "1.1", "2"]);
  });

  it("keeps text before the first heading as the preamble", () => {
    const t = parseTree("A line of introduction.\n\n## Steps\n\n1. One.\n");
    expect(t.preamble).toBe("A line of introduction.");
    expect(renderTree(t)).toBe("A line of introduction.\n\n## Steps\n\n1. One.\n");
  });

  it("treats a heading level as relative to the shallowest one", () => {
    const t = parseTree("# Title\n\n1. Step.\n\n## Sub\n\n2. Another.\n");
    expect(t.sections.map((s) => s.path)).toEqual(["1"]);
    expect(t.sections[0]!.children[0]!.path).toBe("1.1");
  });

  it("ignores structure inside a code fence", () => {
    const t = parseTree("## Script\n\n```sh\n# not a heading\n1. not a step\n```\n\n1. A real step.\n");
    expect(t.sections).toHaveLength(1);
    expect(t.sections[0]!.steps.map((s) => s.text)).toEqual(["A real step."]);
    expect(t.sections[0]!.prose).toContain("# not a heading");
  });

  it("lists materials from the Materials section", () => {
    const t = parseTree(byName("Heat-shock transformation").body);
    const items = materialsOf(t);
    expect(items).toHaveLength(5);
    expect(items[0]).toBe("Chemically competent cells, kept at -80 C until use");
    expect(stepAt(t, "2.5")?.text).toContain("42 C");
  });

  it("finds every step across the starters", () => {
    const total = starters().reduce((n, s) => n + allSteps(parseTree(s.body)).length, 0);
    // Twelve protocols, roughly six to thirteen steps each.
    expect(total).toBeGreaterThan(70);
    expect(total).toBeLessThan(130);
  });

  it("renders a section's text as prose then steps", () => {
    const t = parseTree(byName("T4 DNA ligation").body);
    const procedure = allSections(t).find((s) => s.title === "Procedure")!;
    expect(sectionText(procedure).startsWith("1. Vortex the buffer")).toBe(true);
    const reaction = allSections(t)[0]!;
    expect(sectionText(reaction)).toContain("| 10X T4 ligase buffer | 1.0 ul |");
  });
});
