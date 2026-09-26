import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "cat@example.com";
let server: TestServer;
let cookie: string;
let ownDir: string;

/** Write an artifact at `<own>/<rel>/SKILL.md`. */
function writeArtifact(rel: string, name: string, kind: "skill" | "protocol") {
  const dir = path.join(ownDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\nkind: ${kind}\n---\n\nBody for ${name}. Mentions phenol:chloroform at step four.\n`,
  );
}

beforeAll(async () => {
  applyTestEnv("categories");
  const root = path.join(process.env.SKILLS_ROOTS!.split(":")[0]!);
  // userSlug("cat@example.com") → "cat-at-example-com"
  ownDir = path.join(root, "cat-at-example-com");
  writeArtifact("miniprep", "Miniprep", "protocol");
  writeArtifact(path.join("Cloning", "gibson"), "Gibson assembly", "protocol");
  writeArtifact(path.join("Cloning", "digest"), "Restriction digest", "protocol");
  writeArtifact("helper", "Helper", "skill");

  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("artifact categories", () => {
  it("reports the folder as the category and leaves flat artifacts uncategorised", async () => {
    const r = await api("/api/skills");
    expect(r.status).toBe(200);
    const { skills } = (await r.json()) as {
      skills: Array<{ name: string; category?: string; updatedAt?: string; fileCount?: number }>;
    };
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("Gibson assembly")?.category).toBe("Cloning");
    expect(byName.get("Restriction digest")?.category).toBe("Cloning");
    expect(byName.get("Miniprep")?.category).toBeUndefined();
    // mtime and sibling count travel with every artifact
    expect(byName.get("Miniprep")?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byName.get("Miniprep")?.fileCount).toBe(0);
  });

  it("lists only real category folders, not artifact directories", async () => {
    const r = await api("/api/skills/categories");
    const { categories } = (await r.json()) as { categories: string[] };
    expect(categories).toEqual(["Cloning"]);
  });

  it("creates, renames and refuses to delete a category that still holds artifacts", async () => {
    expect((await api("/api/skills/categories", { method: "POST", body: JSON.stringify({ name: "PCR" }) })).status).toBe(200);
    const listed = (await (await api("/api/skills/categories")).json()) as { categories: string[] };
    expect(listed.categories).toEqual(["Cloning", "PCR"]);

    const renamed = await api("/api/skills/categories/PCR", { method: "PATCH", body: JSON.stringify({ name: "Amplification" }) });
    expect(renamed.status).toBe(200);
    expect(fs.existsSync(path.join(ownDir, "Amplification"))).toBe(true);

    // empty → deletable
    expect((await api("/api/skills/categories/Amplification", { method: "DELETE" })).status).toBe(200);
    // non-empty → refused, and nothing is removed
    const refused = await api("/api/skills/categories/Cloning", { method: "DELETE" });
    expect(refused.status).toBe(400);
    expect(fs.existsSync(path.join(ownDir, "Cloning", "gibson", "SKILL.md"))).toBe(true);
  });

  it("rejects a name that would escape the folder", async () => {
    for (const name of ["../evil", "a/b", "_public", ".hidden"]) {
      const r = await api("/api/skills/categories", { method: "POST", body: JSON.stringify({ name }) });
      expect(r.status, name).toBe(400);
    }
    expect(fs.existsSync(path.join(ownDir, "..", "evil"))).toBe(false);
  });

  it("moves an artifact between categories and back to the top level", async () => {
    const before = (await (await api("/api/skills")).json()) as { skills: Array<{ slug: string; name: string }> };
    const slug = before.skills.find((s) => s.name === "Miniprep")!.slug;

    const into = await api(`/api/skills/${slug}/move`, { method: "POST", body: JSON.stringify({ category: "Cloning" }) });
    expect(into.status).toBe(200);
    expect((await into.json() as { skill: { category?: string } }).skill.category).toBe("Cloning");
    expect(fs.existsSync(path.join(ownDir, "Cloning", "miniprep", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(ownDir, "miniprep"))).toBe(false);

    const out = await api(`/api/skills/${slug}/move`, { method: "POST", body: JSON.stringify({ category: null }) });
    expect(out.status).toBe(200);
    expect((await out.json() as { skill: { category?: string } }).skill.category).toBeUndefined();
    expect(fs.existsSync(path.join(ownDir, "miniprep", "SKILL.md"))).toBe(true);
  });
});

describe("artifact search", () => {
  it("matches names, descriptions and body text, and returns a body snippet", async () => {
    const byName = await (await api("/api/skills/search?q=gibson")).json() as {
      hits: Array<{ slug: string; field: string; snippet?: string }>;
    };
    expect(byName.hits[0]?.field).toBe("name");

    const byBody = await (await api("/api/skills/search?q=phenol")).json() as {
      hits: Array<{ field: string; snippet?: string }>;
    };
    expect(byBody.hits.length).toBeGreaterThan(0);
    expect(byBody.hits[0]?.field).toBe("body");
    expect(byBody.hits[0]?.snippet).toContain("phenol");
  });

  it("filters by kind and returns nothing for an empty query", async () => {
    const protocols = await (await api("/api/skills/search?q=phenol&kind=protocol")).json() as { hits: unknown[] };
    const skills = await (await api("/api/skills/search?q=phenol&kind=skill")).json() as { hits: unknown[] };
    expect(protocols.hits.length).toBe(3);
    expect(skills.hits.length).toBe(1);
    const empty = await (await api("/api/skills/search?q=")).json() as { hits: unknown[] };
    expect(empty.hits).toEqual([]);
  });
});
