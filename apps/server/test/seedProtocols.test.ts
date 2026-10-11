import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The seeder delivers the bundled starters into a given folder — a person's
 *  own protocols folder — and remembers, per process, which folders it has
 *  checked. Each test gets a fresh bundle and target, and clears that memory. */
let root: string;
let seedSrc: string;
let target: string;

async function seed(): Promise<number> {
  const mod = await import("../src/services/seedProtocols");
  return mod.seedStarterProtocols(target);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "labee-seed-"));
  seedSrc = path.join(root, "bundle", "protocols");
  fs.mkdirSync(path.join(seedSrc, "Cloning"), { recursive: true });
  fs.writeFileSync(
    path.join(seedSrc, "Cloning", "ligation.md"),
    "---\nname: T4 ligation\ndescription: d\nkind: protocol\n---\n\nBody.\n",
  );
  fs.mkdirSync(path.join(seedSrc, "PCR"), { recursive: true });
  fs.writeFileSync(
    path.join(seedSrc, "PCR", "taq.md"),
    "---\nname: Taq PCR\ndescription: d\nkind: protocol\n---\n\nBody.\n",
  );
  target = path.join(root, "skills", "someone-at-example-com", "protocols");
  process.env.LABEE_SEED_DIR = seedSrc;
  delete process.env.LABEE_SEED_PROTOCOLS;
  (await import("../src/services/seedProtocols")).resetSeedMemory();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.LABEE_SEED_DIR;
});

describe("starter protocols", () => {
  it("delivers into the person's own protocols folder and nowhere else", async () => {
    expect(await seed()).toBe(2);
    expect(fs.existsSync(path.join(target, "Cloning", "ligation.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "PCR", "taq.md"))).toBe(true);
    // Nothing shared: the only thing under the root is this person's folder.
    expect(fs.readdirSync(path.join(root, "skills"))).toEqual(["someone-at-example-com"]);
    expect(fs.existsSync(path.join(root, "skills", "_public"))).toBe(false);
  });

  it("does nothing on a second read", async () => {
    await seed();
    (await import("../src/services/seedProtocols")).resetSeedMemory();
    expect(await seed()).toBe(0);
  });

  it("keeps the person's edit", async () => {
    await seed();
    const f = path.join(target, "PCR", "taq.md");
    fs.writeFileSync(f, "edited by the person who owns it");
    (await import("../src/services/seedProtocols")).resetSeedMemory();
    await seed();
    expect(fs.readFileSync(f, "utf8")).toBe("edited by the person who owns it");
  });

  it("leaves a deleted starter protocol deleted", async () => {
    await seed();
    fs.rmSync(path.join(target, "PCR"), { recursive: true, force: true });
    (await import("../src/services/seedProtocols")).resetSeedMemory();
    expect(await seed()).toBe(0);
    expect(fs.existsSync(path.join(target, "PCR", "taq.md"))).toBe(false);
  });

  it("delivers a protocol added by a later release", async () => {
    await seed();
    fs.mkdirSync(path.join(seedSrc, "Imaging"), { recursive: true });
    fs.writeFileSync(
      path.join(seedSrc, "Imaging", "confocal.md"),
      "---\nname: Confocal\ndescription: d\nkind: protocol\n---\n\nBody.\n",
    );
    (await import("../src/services/seedProtocols")).resetSeedMemory();
    expect(await seed()).toBe(1);
    expect(fs.existsSync(path.join(target, "Imaging", "confocal.md"))).toBe(true);
  });

  it("delivers to each person separately", async () => {
    await seed();
    const other = path.join(root, "skills", "else-at-example-com", "protocols");
    const mod = await import("../src/services/seedProtocols");
    expect(mod.seedStarterProtocols(other)).toBe(2);
    expect(fs.existsSync(path.join(other, "Cloning", "ligation.md"))).toBe(true);
  });

  it("can be turned off", async () => {
    process.env.LABEE_SEED_PROTOCOLS = "false";
    expect(await seed()).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    delete process.env.LABEE_SEED_PROTOCOLS;
  });
});

describe("starter skills", () => {
  let skillSrc: string;
  let skillsTarget: string;

  beforeEach(async () => {
    skillSrc = path.join(root, "bundle", "skills");
    fs.mkdirSync(path.join(skillSrc, "protocol-agent", "references"), { recursive: true });
    fs.writeFileSync(
      path.join(skillSrc, "protocol-agent", "SKILL.md"),
      "---\nname: protocol-agent\ndescription: d\nkind: skill\n---\n\nBody.\n",
    );
    fs.writeFileSync(path.join(skillSrc, "protocol-agent", "references", "kit-finder.md"), "# kits\n");
    skillsTarget = path.join(root, "skills", "someone-at-example-com", "skills");
    process.env.LABEE_SEED_SKILLS_DIR = skillSrc;
    (await import("../src/services/seedProtocols")).resetSeedMemory();
  });

  afterEach(() => {
    delete process.env.LABEE_SEED_SKILLS_DIR;
  });

  it("delivers the skill folder, references included, into the person's skills folder", async () => {
    const mod = await import("../src/services/seedProtocols");
    expect(mod.seedStarterSkills(skillsTarget)).toBe(2);
    expect(fs.existsSync(path.join(skillsTarget, "protocol-agent", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsTarget, "protocol-agent", "references", "kit-finder.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsTarget, ".starter-skills"))).toBe(true);
  });

  it("keeps the protocols stamp and the skills stamp apart", async () => {
    const mod = await import("../src/services/seedProtocols");
    mod.seedStarterProtocols(target);
    mod.seedStarterSkills(skillsTarget);
    expect(fs.existsSync(path.join(target, ".starter-skills"))).toBe(false);
    expect(fs.existsSync(path.join(skillsTarget, ".starter-protocols"))).toBe(false);
  });

  it("does not bring back a skill the person deleted", async () => {
    const mod = await import("../src/services/seedProtocols");
    mod.seedStarterSkills(skillsTarget);
    fs.rmSync(path.join(skillsTarget, "protocol-agent"), { recursive: true, force: true });
    mod.resetSeedMemory();
    expect(mod.seedStarterSkills(skillsTarget)).toBe(0);
  });

  it("retires only the old protocol-plan folder under _public", async () => {
    const mod = await import("../src/services/seedProtocols");
    const rootPath = path.join(root, "skills");
    fs.mkdirSync(path.join(rootPath, "_public", "protocol-plan"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "_public", "protocol-plan", "SKILL.md"), "old");
    fs.mkdirSync(path.join(rootPath, "_public", "other"), { recursive: true });
    expect(mod.retireLegacyProtocolPlan(rootPath)).toBe(true);
    expect(fs.existsSync(path.join(rootPath, "_public", "protocol-plan"))).toBe(false);
    expect(fs.existsSync(path.join(rootPath, "_public", "other"))).toBe(true);
    expect(mod.retireLegacyProtocolPlan(rootPath)).toBe(false);
  });
});
