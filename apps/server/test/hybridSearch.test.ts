// Hybrid retrieval end to end: words alone when there is no credential, words
// plus embeddings when there is, step-grain hits for parameter questions,
// summary-grain hits for goal questions, step paths in Ask's citations, and
// the purpose layer surviving a save.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "hybrid@example.com";

const GIBSON = [
  "---",
  "name: Gibson assembly reaction",
  "description: Join fragments by 30 bp overlaps in a one-hour isothermal reaction at 50 C.",
  "kind: protocol",
  "category: Cloning",
  "---",
  "## Primer design",
  "",
  "Order primers about 60 bp long: 30 bp matching the end of the adjacent fragment.",
  "",
  "## Reaction",
  "",
  "1. Work on ice.",
  "2. Combine the fragments with the assembly master mix at equimolar concentration.",
  "3. Incubate 1 hour at 50 C, or follow the master mix manufacturer's timing.",
  "4. Transform 2 ul of the reaction.",
  "",
  "## Notes",
  "",
  "- Success falls off sharply beyond about five fragments in one reaction.",
  "",
].join("\n");

const MINIPREP = [
  "---",
  "name: Plasmid miniprep",
  "description: Alkaline lysis and a silica spin column.",
  "kind: protocol",
  "category: Nucleic acids",
  "---",
  "## Procedure",
  "",
  "1. Pellet the overnight culture.",
  "2. Resuspend, lyse, neutralise.",
  "3. Centrifuge 5 min at 16,000 g and load the cleared lysate onto the column.",
  "4. Elute in 30 ul of elution buffer.",
  "",
].join("\n");

const VIABILITY = [
  "---",
  "name: CellTiter-Glo 3D assay",
  "description: Luminescent ATP readout on spheroids in an opaque plate.",
  "kind: protocol",
  "category: Cell culture",
  "problem: Measuring cell viability in 3D cultures, which 2D assays handle badly.",
  "method: Quantify ATP with a luminescent reagent as a marker of metabolically active cells.",
  "application: Drug screening and toxicity testing on spheroids.",
  "domains: [Cell Biology & Culture, Pharmacology & Drug Development]",
  "---",
  "## Reagent",
  "",
  "1. Thaw the reagent in the fridge the day before.",
  "2. Let the kit reach room temperature for 30 minutes before use.",
  "",
  "## Plate",
  "",
  "1. Transfer the spheroids into the opaque 96-well plate.",
  "2. Add reagent, shake 5 minutes, read luminescence after 25 minutes.",
  "",
].join("\n");

function writeProtocols(root: string, email: string): string {
  // The person's folder, as the server names it: "hybrid-at-example-com".
  const slug = email.toLowerCase().replace("@", "-at-").replace(/[^a-z0-9]+/g, "-");
  const dir = path.join(root, slug, "protocols");
  fs.mkdirSync(path.join(dir, "Cloning"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Nucleic acids"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Cell culture"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cloning", "gibson-assembly-reaction.md"), GIBSON);
  fs.writeFileSync(path.join(dir, "Nucleic acids", "plasmid-miniprep.md"), MINIPREP);
  fs.writeFileSync(path.join(dir, "Cell culture", "celltiter-glo-3d-assay.md"), VIABILITY);
  return dir;
}

interface Hit {
  slug: string;
  score: number;
  heading: string;
  snippet: string;
  path: string;
  grain: string;
}

async function boot(name: string, env: NodeJS.ProcessEnv): Promise<{ server: TestServer; cookie: string; dir: string }> {
  applyTestEnv(name);
  const root = process.env.SKILLS_ROOTS!;
  const dir = writeProtocols(root, EMAIL);
  const { sealSession } = await import("../src/services/session");
  const cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  const server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: root,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    ...env,
  });
  return { server, cookie, dir };
}

const api = (server: TestServer, cookie: string, p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });

const search = async (server: TestServer, cookie: string, q: string) =>
  (await (await api(server, cookie, `/api/skills/search?kind=protocol&q=${encodeURIComponent(q)}`)).json()) as {
    mode: string;
    hits: Hit[];
  };

describe("without any embedding credential", () => {
  let server: TestServer;
  let cookie: string;

  beforeAll(async () => {
    ({ server, cookie } = await boot("lexical", { LABEE_EMBED_PROVIDER: "" }));
  }, 30000);
  afterAll(() => server?.stop());

  it("still ranks by words, over chunks, with a step path", async () => {
    const status = (await (await api(server, cookie, "/api/skills/index/status")).json()) as { available: boolean; indexed: number; total: number };
    expect(status.available).toBe(false);
    // Nothing is embedded…
    expect(status.indexed).toBe(0);
    // …yet the words are searchable, and the hit is a chunk, not a file scan.
    const r = await search(server, cookie, "16,000 g");
    expect(r.mode).toBe("lexical");
    expect(r.hits[0]?.slug).toContain("plasmid-miniprep");
    expect(r.hits[0]?.grain).toBe("step");
    expect(r.hits[0]?.path).toBe("1.3");
    expect(r.hits[0]?.heading).toBe("Procedure");
  });

  it("finds a protocol by a word only its summary has", async () => {
    const r = await search(server, cookie, "viability");
    expect(r.hits[0]?.slug).toContain("celltiter-glo-3d-assay");
    expect(r.hits[0]?.grain).toBe("summary");
  });
});

describe("with embeddings", () => {
  let server: TestServer;
  let cookie: string;
  let dir: string;

  beforeAll(async () => {
    ({ server, cookie, dir } = await boot("hybrid", { LABEE_EMBED_PROVIDER: "fake" }));
    await search(server, cookie, "warm up");
  }, 30000);
  afterAll(() => server?.stop());

  it("answers a parameter question with a step", async () => {
    const r = await search(server, cookie, "how long at 50 C");
    expect(r.mode).toBe("semantic");
    expect(r.hits[0]?.slug).toContain("gibson-assembly-reaction");
    expect(r.hits[0]?.grain).toBe("step");
    expect(r.hits[0]?.path).toBe("2.3");
    expect(r.hits[0]?.snippet).toContain("1 hour at 50 C");
  });

  it("answers a goal question through the purpose layer", async () => {
    const r = await search(server, cookie, "measure viability in a 3D culture");
    expect(r.hits[0]?.slug).toContain("celltiter-glo-3d-assay");
    expect(r.hits[0]?.grain).toBe("summary");
  });

  it("answers a how-to with a section", async () => {
    const r = await search(server, cookie, "how do I set up the Gibson reaction");
    expect(r.hits[0]?.slug).toContain("gibson-assembly-reaction");
    expect(r.hits[0]?.grain).toBe("section");
  });

  it("cites a step path from Ask", async () => {
    const r = (await (
      await api(server, cookie, "/api/skills/ask", {
        method: "POST",
        body: JSON.stringify({ q: "how long do I incubate the Gibson assembly", kind: "protocol" }),
      })
    ).json()) as { answer: string; available: boolean; citations: Array<{ slug: string; path: string; grain: string }> };
    expect(r.available).toBe(true);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations[0]!.slug).toContain("gibson-assembly-reaction");
    expect(["step", "section"]).toContain(r.citations[0]!.grain);
    expect(r.citations[0]!.path).toMatch(/^2(\.\d+)?$/);
  });

  it("round-trips the purpose layer through a save and re-indexes it", async () => {
    const detail = (await (await api(server, cookie, "/api/skills/user--plasmid-miniprep")).json()) as {
      skill: { name: string; description: string; body: string; problem?: string };
    };
    expect(detail.skill.problem).toBeUndefined();
    const put = await api(server, cookie, "/api/skills/user--plasmid-miniprep", {
      method: "PUT",
      body: JSON.stringify({
        name: detail.skill.name,
        description: detail.skill.description,
        allowedTools: [],
        kind: "protocol",
        body: detail.skill.body,
        problem: "Recovering a plasmid from an overnight culture quickly.",
        domains: ["Nucleic acids", "Cloning"],
      }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { skill: { problem?: string; domains?: string[] } };
    expect(saved.skill.problem).toBe("Recovering a plasmid from an overnight culture quickly.");
    expect(saved.skill.domains).toEqual(["Nucleic acids", "Cloning"]);
    const file = fs.readFileSync(path.join(dir, "Nucleic acids", "plasmid-miniprep.md"), "utf8");
    expect(file).toContain("problem: Recovering a plasmid");
    // The summary chunk now carries the new words.
    const r = await search(server, cookie, "recovering a plasmid quickly");
    expect(r.hits[0]?.slug).toContain("plasmid-miniprep");
    expect(r.hits[0]?.grain).toBe("summary");
  });
});
