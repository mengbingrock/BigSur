import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The seeder reads the skills root at call time, so each test gets a fresh
 *  one and re-imports the module to clear any module-level state. */
let root: string;
let seedSrc: string;

async function seed(): Promise<number> {
  const mod = await import("../src/services/seedProtocols");
  return mod.seedPublicProtocols();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "labee-seed-"));
  seedSrc = path.join(root, "bundle", "protocols");
  fs.mkdirSync(path.join(seedSrc, "Cloning", "ligation"), { recursive: true });
  fs.writeFileSync(
    path.join(seedSrc, "Cloning", "ligation", "SKILL.md"),
    "---\nname: T4 ligation\ndescription: d\nkind: protocol\n---\n\nBody.\n",
  );
  fs.mkdirSync(path.join(seedSrc, "PCR", "taq"), { recursive: true });
  fs.writeFileSync(
    path.join(seedSrc, "PCR", "taq", "SKILL.md"),
    "---\nname: Taq PCR\ndescription: d\nkind: protocol\n---\n\nBody.\n",
  );

  process.env.SKILLS_ROOTS = path.join(root, "skills");
  process.env.LABEE_SEED_DIR = seedSrc;
  delete process.env.LABEE_SEED_PROTOCOLS;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.LABEE_SEED_DIR;
  delete process.env.SKILLS_ROOTS;
});

const pub = () => path.join(root, "skills", "_public");

describe("starter protocols", () => {
  it("seeds an empty library and writes nothing outside _public", async () => {
    expect(await seed()).toBe(2);
    expect(fs.existsSync(path.join(pub(), "Cloning", "ligation", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(pub(), "PCR", "taq", "SKILL.md"))).toBe(true);
    // Only _public exists under the skills root — no user folder was touched.
    expect(fs.readdirSync(path.join(root, "skills"))).toEqual(["_public"]);
  });

  it("does nothing on a second boot", async () => {
    await seed();
    expect(await seed()).toBe(0);
  });

  it("keeps an operator's edit", async () => {
    await seed();
    const f = path.join(pub(), "PCR", "taq", "SKILL.md");
    fs.writeFileSync(f, "edited by the operator");
    await seed();
    expect(fs.readFileSync(f, "utf8")).toBe("edited by the operator");
  });

  it("leaves a deleted starter protocol deleted", async () => {
    await seed();
    fs.rmSync(path.join(pub(), "PCR"), { recursive: true, force: true });
    expect(await seed()).toBe(0);
    expect(fs.existsSync(path.join(pub(), "PCR", "taq", "SKILL.md"))).toBe(false);
  });

  it("delivers a protocol added by a later release", async () => {
    await seed();
    fs.mkdirSync(path.join(seedSrc, "Imaging", "confocal"), { recursive: true });
    fs.writeFileSync(
      path.join(seedSrc, "Imaging", "confocal", "SKILL.md"),
      "---\nname: Confocal\ndescription: d\nkind: protocol\n---\n\nBody.\n",
    );
    expect(await seed()).toBe(1);
    expect(fs.existsSync(path.join(pub(), "Imaging", "confocal", "SKILL.md"))).toBe(true);
  });

  it("can be turned off", async () => {
    process.env.LABEE_SEED_PROTOCOLS = "false";
    expect(await seed()).toBe(0);
    expect(fs.existsSync(pub())).toBe(false);
    delete process.env.LABEE_SEED_PROTOCOLS;
  });
});
