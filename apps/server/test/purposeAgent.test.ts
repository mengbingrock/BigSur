// The purpose-layer proposal: offered for protocols that lack it, applied
// through the ordinary save, and from then on part of what search sees.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";

const EMAIL = "purpose@example.com";
let ownDir: string;
type Agent = typeof import("../src/services/artifactIndex/agent");
type Skills = typeof import("../src/services/skills");
let agent: Agent;
let skills: Skills;

beforeAll(async () => {
  applyTestEnv("purpose");
  process.env.LABEE_EMBED_PROVIDER = "fake";
  process.env.LABEE_SEED_PROTOCOLS = "false";
  const root = process.env.SKILLS_ROOTS!;
  ownDir = path.join(root, "purpose-at-example-com", "protocols", "Cloning");
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(
    path.join(ownDir, "gibson.md"),
    "---\nname: Gibson assembly\ndescription: Join fragments by overlap in one isothermal reaction.\nkind: protocol\n---\n\n## Reaction\n\n1. Combine the fragments with the master mix.\n2. Incubate 1 hour at 50 C.\n",
  );
  fs.writeFileSync(
    path.join(ownDir, "digest.md"),
    "---\nname: Restriction digest\ndescription: Cut a plasmid with one enzyme.\nkind: protocol\nproblem: Already filled in by hand.\n---\n\n## Reaction\n\n1. Digest 1 hour at 37 C.\n",
  );
  vi.resetModules();
  agent = (await import("../src/services/artifactIndex/agent")) as Agent;
  skills = (await import("../src/services/skills")) as Skills;
});

describe("purpose-layer proposals", () => {
  it("proposes fields only for protocols that lack them", async () => {
    const r = await agent.suggestPurpose(EMAIL);
    expect(r.available).toBe(true);
    expect(r.proposals.map((p) => p.name)).toEqual(["Gibson assembly"]);
    const p = r.proposals[0]!;
    expect(p.problem).toMatch(/gibson assembly/i);
    expect(p.method).toBe("Join fragments by overlap in one isothermal reaction.");
    expect(p.application.length).toBeGreaterThan(0);
    expect(p.domains).toEqual(["Cloning"]);
    expect(p.keywords.length).toBeGreaterThan(0);
    expect(p.confidence).toBeGreaterThan(0);
  });

  it("can be asked about specific protocols, filled or not", async () => {
    const r = await agent.suggestPurpose(EMAIL, { slugs: ["user--restriction-digest"] });
    expect(r.proposals.map((p) => p.name)).toEqual(["Restriction digest"]);
  });

  it("lands in the file through an ordinary save, and nothing else changes", async () => {
    const [p] = (await agent.suggestPurpose(EMAIL)).proposals;
    const before = skills.getSkillBySlug(p!.slug, EMAIL)!;
    const saved = skills.saveSkill(
      p!.slug,
      {
        name: before.name,
        description: before.description,
        allowedTools: [],
        body: before.body,
        problem: p!.problem,
        method: p!.method,
        application: p!.application,
        domains: p!.domains,
        keywords: p!.keywords,
      },
      EMAIL,
    );
    expect(saved.problem).toBe(p!.problem);
    expect(saved.domains).toEqual(["Cloning"]);
    expect(saved.body).toBe(before.body);
    expect(saved.artifactKind).toBe("protocol");
    const file = fs.readFileSync(path.join(ownDir, "gibson.md"), "utf8");
    expect(file).toContain("problem: ");
    expect(file).toContain("domains:");
    // Now nothing is lacking, so there is nothing left to propose.
    expect((await agent.suggestPurpose(EMAIL)).proposals).toHaveLength(0);
  });

  it("clears a field on an empty string and keeps one that is left out", async () => {
    const before = skills.getSkillBySlug("user--gibson-assembly", EMAIL)!;
    const saved = skills.saveSkill(
      before.slug,
      { name: before.name, description: before.description, allowedTools: [], body: before.body, problem: "" },
      EMAIL,
    );
    expect(saved.problem).toBeUndefined();
    expect(saved.method).toBe(before.method);
    expect(saved.domains).toEqual(before.domains);
  });
});
