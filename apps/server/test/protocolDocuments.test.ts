import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

/**
 * Protocols are documents. A protocol is one .md file; a skill keeps the folder
 * with a SKILL.md, because it can carry scripts and references beside it.
 */
const EMAIL = "docs@example.com";
let server: TestServer;
let cookie: string;
let workspace: string;
let pdir: string;
let sdir: string;
let ownDir: string;

beforeAll(async () => {
  applyTestEnv("protocoldocs");
  workspace = path.join(process.env.DECK_ROOT!, "docs-at-example-com", ".skill");
  ownDir = path.join(process.env.SKILLS_ROOTS!.split(":")[0]!, "docs-at-example-com");

  // A protocol someone already had on disk, with no frontmatter at all.
  // The layout: protocols/ holds documents (categories are subfolders),
  // skills/ holds SKILL.md folders. The folder says what a thing is.
  pdir = path.join(ownDir, "protocols");
  sdir = path.join(ownDir, "skills");
  fs.mkdirSync(path.join(pdir, "Cloning"), { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "Cloning", "ligation.md"),
    "# Ligation\n\nT4 ligase, 30 min at 22.5 C.\n",
  );
  // A skill in the old folder shape, which must keep working.
  fs.mkdirSync(path.join(sdir, "formatter"), { recursive: true });
  fs.writeFileSync(
    path.join(sdir, "formatter", "SKILL.md"),
    "---\nname: Formatter\ndescription: A skill\n---\n\nBody.\n",
  );
  // Reference material beside a skill manifest is not a protocol of its own.
  fs.writeFileSync(path.join(sdir, "formatter", "NOTES.md"), "# Notes\n\nNot an artifact.\n");

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

interface Art {
  slug: string;
  name: string;
  artifactKind: string;
  category?: string;
  artifactFile?: string;
  fileCount?: number;
}
const all = async (): Promise<Art[]> =>
  ((await (await api("/api/skills")).json()) as { skills: Art[] }).skills;

describe("protocols are documents", () => {
  it("reads a plain .md as a protocol, and a SKILL.md folder as a skill", async () => {
    const arts = await all();
    const lig = arts.find((a) => a.name === "ligation");
    expect(lig?.artifactKind).toBe("protocol");
    expect(lig?.category).toBe("Cloning");
    expect(lig?.artifactFile).toContain("ligation.md");
    expect(lig?.fileCount).toBe(0);

    const skill = arts.find((a) => a.name === "Formatter");
    expect(skill?.artifactKind).toBe("skill");
    expect(skill?.artifactFile).toBeUndefined();
  });

  it("does not treat reference material beside a manifest as its own artifact", async () => {
    expect((await all()).some((a) => a.name === "NOTES")).toBe(false);
  });

  it("skips project furniture like README and AGENTS", async () => {
    for (const n of ["README.md", "AGENTS.md", "CHANGELOG.md"]) {
      fs.writeFileSync(path.join(pdir, n), `# ${n}\n\nNot a protocol.\n`);
    }
    const names = (await all()).map((a) => a.name.toLowerCase());
    for (const n of ["readme", "agents", "changelog"]) expect(names).not.toContain(n);
  });

  it("creates a new protocol as one file, not a folder", async () => {
    const r = await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "Gel pouring",
        description: "Pour an agarose gel",
        allowedTools: [],
        body: "## Steps\n\nMelt, cool, pour.",
        kind: "protocol",
      }),
    });
    expect(r.status).toBe(200);
    const { skill } = (await r.json()) as { skill: Art };
    expect(skill.artifactKind).toBe("protocol");
    expect(skill.artifactFile).toBeTruthy();
    // Written to the person's own protocols folder — one home for everything
    // they own, not the deck workspace.
    expect(fs.existsSync(path.join(pdir, "gel-pouring.md"))).toBe(true);
    expect(fs.existsSync(path.join(pdir, "gel-pouring"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "gel-pouring.md"))).toBe(false);
  });

  it("still creates a skill as a folder with a manifest", async () => {
    const r = await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "Tidy output",
        description: "A skill",
        allowedTools: [],
        body: "Body.",
        kind: "skill",
      }),
    });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(sdir, "tidy-output", "SKILL.md"))).toBe(true);
    // And never beside the protocols: skills and protocols keep to their own folders.
    expect(fs.existsSync(path.join(pdir, "tidy-output"))).toBe(false);
  });

  it("edits a document in place and moves it as a file", async () => {
    const slug = (await all()).find((a) => a.name === "ligation")!.slug;

    const put = await api(`/api/skills/${slug}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "ligation",
        description: "Edited",
        allowedTools: [],
        body: "T4 ligase, 60 min.",
        kind: "protocol",
      }),
    });
    expect(put.status).toBe(200);
    expect(fs.readFileSync(path.join(pdir, "Cloning", "ligation.md"), "utf8")).toContain("60 min");
    // No manifest was invented beside it.
    expect(fs.existsSync(path.join(pdir, "Cloning", "SKILL.md"))).toBe(false);

    const moved = await api(`/api/skills/${slug}/move`, {
      method: "POST",
      body: JSON.stringify({ category: null }),
    });
    expect(moved.status).toBe(200);
    expect(fs.existsSync(path.join(pdir, "ligation.md"))).toBe(true);
    expect(fs.existsSync(path.join(pdir, "Cloning", "ligation.md"))).toBe(false);
  });

  it("deletes a document without removing its neighbours", async () => {
    fs.writeFileSync(path.join(pdir, "keep-me.md"), "# Keep\n\nStays.\n");
    const arts = await all();
    const slug = arts.find((a) => a.name === "ligation")!.slug;

    const r = await api(`/api/skills/${slug}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(pdir, "ligation.md"))).toBe(false);
    // The folder and everything else in it survive.
    expect(fs.existsSync(path.join(pdir, "keep-me.md"))).toBe(true);
    expect(fs.existsSync(ownDir)).toBe(true);
  });

  it("moves an old flat layout into protocols/ and skills/ on first read", async () => {
    // Before the two folders existed, everything sat at the top of the person's
    // folder and was told apart by "is it a SKILL.md". That shape is still on
    // every existing install, so the first read files it away — and a folder
    // whose manifest says `kind: protocol` (how protocols were written before
    // they became documents) goes with the protocols, not the skills.
    fs.writeFileSync(path.join(ownDir, "old-doc.md"), "# Old doc\n\nA protocol from the flat days.\n");
    fs.mkdirSync(path.join(ownDir, "old-skill"), { recursive: true });
    fs.writeFileSync(path.join(ownDir, "old-skill", "SKILL.md"), "---\nname: Old skill\ndescription: d\n---\n\nBody.\n");
    fs.mkdirSync(path.join(ownDir, "old-proto"), { recursive: true });
    fs.writeFileSync(path.join(ownDir, "old-proto", "SKILL.md"), "---\nname: Old proto\ndescription: d\nkind: protocol\n---\n\nBody.\n");

    const arts = await all();
    expect(arts.find((a) => a.name === "old-doc")?.artifactKind).toBe("protocol");
    expect(arts.find((a) => a.name === "Old skill")?.artifactKind).toBe("skill");
    expect(arts.find((a) => a.name === "Old proto")?.artifactKind).toBe("protocol");

    expect(fs.existsSync(path.join(pdir, "old-doc.md"))).toBe(true);
    expect(fs.existsSync(path.join(sdir, "old-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(pdir, "old-proto", "SKILL.md"))).toBe(true);
    for (const n of ["old-doc.md", "old-skill", "old-proto"]) {
      expect(fs.existsSync(path.join(ownDir, n)), `${n} still at top level`).toBe(false);
    }
  });

  it("merges an old category folder into one that already exists under protocols/", async () => {
    // The starter library creates category folders. If a person's own folder of
    // the same name is migrated afterwards, its destination is taken — and the
    // never-overwrite rule used to leave the whole folder behind, unread, with
    // every protocol in it invisible. A folder is merged child by child instead.
    fs.mkdirSync(path.join(pdir, "Cloning"), { recursive: true });
    fs.mkdirSync(path.join(ownDir, "Cloning"), { recursive: true });
    fs.writeFileSync(path.join(ownDir, "Cloning", "my-own-gibson.md"), "# My own Gibson\n\nMine.\n");

    const arts = await all();
    expect(arts.some((a) => a.name === "my-own-gibson")).toBe(true);
    expect(fs.existsSync(path.join(pdir, "Cloning", "my-own-gibson.md"))).toBe(true);
    expect(fs.existsSync(path.join(ownDir, "Cloning"))).toBe(false);
  });
});
