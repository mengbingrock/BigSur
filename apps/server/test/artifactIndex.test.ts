import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "rag@example.com";
const OTHER = "nosy@example.com";
let server: TestServer;
let cookie: string;
let otherCookie: string;
let ownDir: string;

function writeArtifact(dir: string, rel: string, name: string, body: string, kind = "protocol") {
  const full = path.join(dir, rel);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(
    path.join(full, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\nkind: ${kind}\n---\n\n${body}\n`,
  );
}

beforeAll(async () => {
  applyTestEnv("rag");
  const root = process.env.SKILLS_ROOTS!.split(":")[0]!;
  ownDir = path.join(root, "rag-at-example-com");

  writeArtifact(
    ownDir,
    "miniprep",
    "Plasmid miniprep",
    [
      "## Materials",
      "",
      "- Resuspension buffer, lysis buffer, neutralisation buffer",
      "- Silica spin column",
      "",
      "## Procedure",
      "",
      "Pellet the overnight culture. Resuspend, lyse, neutralise.",
      "Centrifuge 5 min at 16,000 g and load the cleared lysate onto the column.",
      "Elute in 30 ul of pUC19-compatible elution buffer.",
    ].join("\n"),
  );
  writeArtifact(
    ownDir,
    "organic",
    "Organic phase separation",
    [
      "## Procedure",
      "",
      "Add an equal volume of phenol chloroform isoamyl alcohol.",
      "Vortex and spin. The aqueous phase carries the nucleic acid.",
    ].join("\n"),
  );
  writeArtifact(ownDir, "helper", "Formatting helper", "A skill, not a protocol.", "skill");

  // Another person's artifact must never surface in this caller's results.
  writeArtifact(
    path.join(root, "nosy-at-example-com"),
    "secret",
    "Secret centrifuge protocol",
    "Centrifuge 5 min at 16,000 g. Private to the other account.",
  );

  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  otherCookie = `monterey_session=${encodeURIComponent(await sealSession({ email: OTHER }))}`;
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

const api = (c: string, p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie: c, "content-type": "application/json", ...(init.headers ?? {}) },
  });

const search = async (c: string, q: string, extra = "") =>
  (await (await api(c, `/api/skills/search?kind=protocol&q=${encodeURIComponent(q)}${extra}`)).json()) as {
    mode: string;
    hits: Array<{ slug: string; score: number; heading: string; snippet: string }>;
  };

describe("artifact index", () => {
  it("indexes every visible artifact and reports progress", async () => {
    // The first search drives the reconcile + drain.
    await search(cookie, "warm up the index");
    const status = (await (await api(cookie, "/api/skills/index/status")).json()) as {
      total: number;
      indexed: number;
      model: string;
      available: boolean;
    };
    expect(status.available).toBe(true);
    expect(status.model).toBe("fake-hash-256");
    expect(status.total).toBe(3); // 2 protocols + 1 skill, all indexed
    expect(status.indexed).toBe(3);
  });

  it("searches semantically and returns a chunk heading and snippet", async () => {
    const r = await search(cookie, "phenol chloroform");
    expect(r.mode).toBe("semantic");
    expect(r.hits[0]?.slug).toContain("organic-phase-separation");
    expect(r.hits[0]?.heading).toBe("Procedure");
    expect(r.hits[0]?.snippet.toLowerCase()).toContain("phenol");
  });

  it("boosts an exact identifier the embedding would miss", async () => {
    const r = await search(cookie, "pUC19");
    expect(r.hits[0]?.slug).toContain("plasmid-miniprep");
    // The boost is worth 0.15, so the top hit clears a bare cosine match.
    expect(r.hits[0]?.score).toBeGreaterThan(0.15);
  });

  it("honours the kind filter and never crosses accounts", async () => {
    const protocols = await search(cookie, "centrifuge");
    expect(protocols.hits.every((h) => !h.slug.includes("formatting-helper"))).toBe(true);
    // The other account's protocol mentions the same words but is invisible.
    expect(protocols.hits.every((h) => !h.slug.includes("secret"))).toBe(true);

    const theirs = await search(otherCookie, "centrifuge");
    expect(theirs.hits.some((h) => h.slug.includes("secret"))).toBe(true);
    expect(theirs.hits.every((h) => !h.slug.includes("plasmid-miniprep"))).toBe(true);
  });

  it("re-embeds only what changed when a protocol is edited on disk", async () => {
    const before = (await (await api(cookie, "/api/skills/index/status")).json()) as { indexed: number };
    fs.writeFileSync(
      path.join(ownDir, "protocols", "organic", "SKILL.md"),
      `---\nname: Organic phase separation\ndescription: Organic phase separation\nkind: protocol\n---\n\n## Procedure\n\nNow uses a column instead, with guanidine thiocyanate.\n`,
    );
    const r = await search(cookie, "guanidine thiocyanate");
    expect(r.mode).toBe("semantic");
    expect(r.hits[0]?.slug).toContain("organic-phase-separation");
    expect(r.hits[0]?.snippet).toContain("guanidine");
    const after = (await (await api(cookie, "/api/skills/index/status")).json()) as { indexed: number };
    expect(after.indexed).toBe(before.indexed);
  });

  it("drops rows for a deleted artifact", async () => {
    fs.rmSync(path.join(ownDir, "protocols", "organic"), { recursive: true, force: true });
    const r = await search(cookie, "phenol chloroform");
    expect(r.hits.every((h) => !h.slug.includes("organic-phase-separation"))).toBe(true);
    const status = (await (await api(cookie, "/api/skills/index/status")).json()) as { total: number };
    expect(status.total).toBe(2);
  });

  it("keeps a plain-document protocol indexed across reconciles", async () => {
    // Every other fixture here is a folder with a SKILL.md, which is why this
    // was never caught: the dead-row check looked for <path>/SKILL.md, which
    // a document file can never have, so a protocol's row was deleted on each
    // reconcile and re-embedded on the next — the library looked permanently
    // half-indexed and paid for the other half on every pass.
    fs.writeFileSync(
      path.join(ownDir, "lysis-buffer.md"),
      "---\nname: Lysis buffer\ndescription: RIPA-style lysis buffer\nkind: protocol\n---\n\n## Recipe\n\n50 mM Tris, 150 mM NaCl, 1% NP-40.\n",
    );
    const status = async () =>
      (await (await api(cookie, "/api/skills/index/status")).json()) as { total: number; indexed: number };

    // First search: reconcile queues it, drain embeds it.
    await search(cookie, "lysis buffer recipe");
    const first = await status();
    expect(first.indexed).toBe(first.total);

    // Each further search runs another reconcile. The document must survive
    // every one of them, not just the first.
    for (let i = 0; i < 3; i++) {
      await search(cookie, "lysis buffer recipe");
      const again = await status();
      expect(again.indexed, `after reconcile ${i + 2}`).toBe(again.total);
    }
    const hit = (await search(cookie, "NP-40 lysis")).hits.find((h) => h.slug.includes("lysis-buffer"));
    expect(hit).toBeTruthy();
  });

  it("indexes two documents in the same folder as two artifacts, not one", async () => {
    // A document's sourcePath is its *folder*, so two documents side by side
    // used to share one index key and overwrite each other — search then
    // returned one protocol's text for its neighbour. Keyed by file now.
    fs.writeFileSync(
      path.join(ownDir, "gel-stain.md"),
      "---\nname: Gel stain\ndescription: post-stain\nkind: protocol\n---\n\n## Steps\n\nSoak the gel in SYBR Safe for 30 minutes.\n",
    );
    await search(cookie, "warm");
    const status = (await (await api(cookie, "/api/skills/index/status")).json()) as { total: number; indexed: number };
    expect(status.indexed).toBe(status.total);

    // Each one is found on its own text, with its own slug.
    const stain = (await search(cookie, "SYBR Safe soak")).hits[0];
    const lysis = (await search(cookie, "NP-40 lysis buffer")).hits[0];
    expect(stain?.slug).toContain("gel-stain");
    expect(lysis?.slug).toContain("lysis-buffer");
  });

  it("re-embeds an edit as soon as it is saved, without waiting for a search", async () => {
    // Saving used to only *queue* the re-embed; nothing drained the queue
    // until the next search ran a reconcile. So an edit was invisible to
    // search until someone searched — "the index doesn't follow my changes".
    // This reads the index tables directly: a search here would itself
    // trigger the reconcile and hide the bug.
    const { getDb } = await import("../src/services/db");
    const db = await getDb();
    const slug = (await search(cookie, "NP-40 lysis buffer")).hits.find((h) => h.slug.includes("lysis-buffer"))!.slug;
    const detail = (await (await api(cookie, `/api/skills/${slug}`)).json()) as {
      skill: { slug: string; name: string; description?: string; allowedTools?: string[]; artifactFile?: string; sourcePath: string };
    };
    const key = detail.skill.artifactFile ?? detail.skill.sourcePath;

    const put = await api(cookie, `/api/skills/${detail.skill.slug}`, {
      method: "PUT",
      body: JSON.stringify({
        name: detail.skill.name,
        description: detail.skill.description ?? "",
        allowedTools: [],
        kind: "protocol",
        body: "## Recipe\n\nNow with 0.5% sodium deoxycholate as well.\n",
      }),
    });
    expect(put.status).toBe(200);

    await waitFor(async () => {
      const rows = db.prepare("SELECT text FROM artifact_chunks WHERE source_path = ?").all(key) as { text: string }[];
      return rows.some((r) => r.text.includes("sodium deoxycholate"));
    }, 10000);
  });

  it("forgets a deleted protocol from the index at once", async () => {
    const { getDb } = await import("../src/services/db");
    const db = await getDb();
    const slug = (await search(cookie, "sodium deoxycholate")).hits.find((h) => h.slug.includes("lysis-buffer"))!.slug;
    const detail = (await (await api(cookie, `/api/skills/${slug}`)).json()) as {
      skill: { slug: string; artifactFile?: string; sourcePath: string };
    };
    const key = detail.skill.artifactFile ?? detail.skill.sourcePath;
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifact_index WHERE source_path = ?").get(key) as { n: number }).n).toBe(1);

    const del = await api(cookie, `/api/skills/${detail.skill.slug}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    await waitFor(async () => {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM artifact_index WHERE source_path = ?").get(key) as { n: number }).n;
      const c = (db.prepare("SELECT COUNT(*) AS n FROM artifact_chunks WHERE source_path = ?").get(key) as { n: number }).n;
      return n === 0 && c === 0;
    }, 5000);
    expect(fs.existsSync(key)).toBe(false);
  });

  it("rebuilds from scratch on request", async () => {
    const r = (await (await api(cookie, "/api/skills/index/rebuild", { method: "POST" })).json()) as {
      queued: number;
    };
    expect(r.queued).toBeGreaterThan(0);
    const after = await search(cookie, "silica spin column");
    expect(after.hits[0]?.slug).toContain("plasmid-miniprep");
  });

  it("returns an empty result set for an empty query", async () => {
    const r = await search(cookie, "");
    expect(r.hits).toEqual([]);
  });
});
