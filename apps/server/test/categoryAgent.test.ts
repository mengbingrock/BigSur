import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "agent@example.com";
let server: TestServer;
let cookie: string;
let ownDir: string;

function writeArtifact(rel: string, name: string, body: string) {
  const dir = path.join(ownDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\nkind: protocol\n---\n\n${body}\n`,
  );
}

beforeAll(async () => {
  applyTestEnv("agent");
  ownDir = path.join(process.env.SKILLS_ROOTS!.split(":")[0]!, "agent-at-example-com");

  // The fixtures lean on shared vocabulary rather than synonyms: the test
  // double is a bag-of-words embedder, so a word it has never seen is simply
  // orthogonal. A real embedder would relate "ligation" to "assembly" without
  // this; here the wording stands in for that relatedness, which is fine
  // because what is under test is the agent's escalation and thresholds, not
  // the quality of the vectors.
  //
  // Two already filed under Cloning — these form the centroid.
  writeArtifact(
    path.join("Cloning", "gibson"),
    "Gibson assembly",
    "Assemble plasmid vector and insert fragments with ligase and overlap.",
  );
  writeArtifact(
    path.join("Cloning", "digest"),
    "Restriction digest",
    "Cut the plasmid vector, purify the insert fragments, ligate with ligase.",
  );
  // Uncategorised and close to that pair — step 1 (centroid) should place it.
  writeArtifact(
    "ligation",
    "Blunt end ligation",
    "Ligate plasmid vector and insert fragments with ligase overnight.",
  );
  // Uncategorised and sharing nothing with cloning — falls through to step 3.
  writeArtifact(
    "scope",
    "Confocal imaging",
    "Mount the slide, focus the objective, image with the laser microscope.",
  );
  writeArtifact(
    "stain",
    "Immunofluorescence staining",
    "Stain the slide, mount it, image with the laser microscope objective.",
  );

  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_EMBED_PROVIDER: "fake",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });

interface Proposal {
  slug: string;
  name: string;
  category: string | null;
  confidence: number;
  reason: string;
  isNew: boolean;
}

const suggest = async (body: unknown = {}) =>
  (await (await api("/api/skills/categories/suggest", { method: "POST", body: JSON.stringify(body) })).json()) as {
    proposals: Proposal[];
    newCategories: string[];
    usedModel: boolean;
  };

describe("categorisation agent", () => {
  it("proposes only for uncategorised protocols and leaves filed ones alone", async () => {
    const r = await suggest();
    const names = r.proposals.map((p) => p.name);
    expect(names).not.toContain("Gibson assembly");
    expect(names).not.toContain("Restriction digest");
    expect(names).toContain("Blunt end ligation");
  });

  it("places a protocol by centroid, explaining itself, with no model call", async () => {
    const r = await suggest({ slugs: ["user--blunt-end-ligation"] });
    const p = r.proposals.find((x) => x.name === "Blunt end ligation");
    expect(p?.category).toBe("Cloning");
    expect(p?.isNew).toBe(false);
    expect(p?.confidence).toBeGreaterThanOrEqual(0.55);
    expect(p?.reason).toContain("Cloning");
    // Centroid alone answered it, so the model was never consulted.
    expect(r.usedModel).toBe(false);
  });

  it("proposes a new category for protocols nothing existing fits", async () => {
    const r = await suggest({ slugs: ["user--confocal-imaging", "user--immunofluorescence-staining"] });
    expect(r.usedModel).toBe(true);
    // Both are about slides and imaging; the agent should group them under one
    // brand-new name rather than forcing them into Cloning.
    const theirs = r.proposals.filter((p) => p.name !== "Blunt end ligation");
    expect(theirs.length).toBe(2);
    expect(theirs.every((p) => p.isNew)).toBe(true);
    expect(new Set(theirs.map((p) => p.category)).size).toBe(1);
    expect(r.newCategories.length).toBe(1);
    expect(r.newCategories[0]).not.toBe("Cloning");
  });

  it("writes nothing — the library is untouched until a proposal is applied", async () => {
    const before = fs.readdirSync(ownDir).sort();
    await suggest();
    expect(fs.readdirSync(ownDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(ownDir, "ligation", "SKILL.md"))).toBe(true);
    const listed = (await (await api("/api/skills/categories")).json()) as { categories: string[] };
    expect(listed.categories).toEqual(["Cloning"]);
  });

  it("applies a proposal through the existing move endpoint", async () => {
    const r = await suggest({ slugs: ["user--blunt-end-ligation"] });
    const p = r.proposals[0]!;
    const moved = await api(`/api/skills/${p.slug}/move`, {
      method: "POST",
      body: JSON.stringify({ category: p.category }),
    });
    expect(moved.status).toBe(200);
    expect(fs.existsSync(path.join(ownDir, "Cloning", "ligation", "SKILL.md"))).toBe(true);
    // And it stops being proposed, because it is no longer uncategorised.
    const after = await suggest();
    expect(after.proposals.map((x) => x.name)).not.toContain("Blunt end ligation");
  });

  it("rejects anonymous callers", async () => {
    const r = await fetch(`${server.base}/api/skills/categories/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });
});
