// The shared library, end to end: a corpus record mapped and ingested under
// an allowed licence (and refused under a disallowed one), searched on the
// box, fused with the person's own protocols, saved into them with its
// provenance — after which the copy shadows the original — and cited by Ask
// with its licence. Then the same through a desktop, which reaches the
// library on the box with the session it keeps for its account.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "lib@example.com";

/** Three records in BioProCorpus's shape. */
const CORPUS = [
  {
    id: "Protocol-exchange-1",
    url: " https://doi.org/10.21203/rs.3.pex-2153/v1",
    title: "Oxidative release of glycans from carbohydrate-conjugated vaccine",
    keywords: " carbohydrate-conjugated vaccines, oxidative release of glycans",
    abstract: "This protocol provides an oxidative method to release glycans from glycoconjugates.",
    input: "\nNaClO (Honeywell)\n\nAcetonitrile (Sigma-Aldrich)\n\nFormic acid (Sigma-Aldrich)\n",
    hierarchical_protocol: {
      "1": { title: "Oxidation Reaction", "1.1": "Add NaClO to the glycoconjugates in\n100 ul PBS.", "1.2": "Shake the mixture at room temperature for 1 min." },
      "2": {
        title: "Centrifugation and Cartridge Activation",
        "2.1": "Centrifugate the mixture at 16,000g for 5 min at 4°C.",
        "2.2": { title: "Cartridge Activation", "2.2.1": "Activate a Sep-Pak C18 cartridge with 1 ml 50% acetonitrile." },
      },
    },
    problem: "Releasing glycans from glycoconjugates cheaply.",
    method: "Oxidative release with hypochlorite.",
    application: "Glycomic analysis of vaccines.",
    classification: { primary_domain: "Biochemical & Molecular Functional Analysis", all_domains: ["Biochemical & Molecular Functional Analysis", "Vaccine Development"], confidence: 0.9 },
  },
  {
    id: "Protocol.io-0",
    url: "https://www.protocols.io/view/cell-viability-protocol-using-celltiter-glo-3d",
    title: "Cell Viability Protocol using CellTiter-Glo 3D",
    keywords: "null",
    abstract: "This protocol provides a viability measurement for 3D culture.",
    hierarchical_protocol: {
      "1": { title: "Preparation of the CellTiter-Glo 3D Solution", "1.1": "Thaw the reagent in the\nfridge at 4°C the day before.", "1.2": "Let the kit reach room temperature for 30 minutes." },
      "2": { title: "Luminescence", "2.1": "Add the reagent to the spheroids in the opaque 96-well plate.", "2.2": "Read luminescence after 25 minutes." },
    },
    problem: "Measuring cell viability in 3D cultures.",
    method: "Luminescent ATP quantification.",
    application: "Drug screening on spheroids.",
    classification: { primary_domain: "Cell Biology & Culture", all_domains: ["Cell Biology & Culture", "Pharmacology & Drug Development"], confidence: 0.95 },
  },
  {
    id: "Protocol.io-9",
    url: "https://www.protocols.io/view/no-steps",
    title: "A record with no steps",
    abstract: "Only prose.",
    hierarchical_protocol: {},
  },
];

let ownDir: string;
let sealed: string;
let cookie: string;
let box: TestServer;

type Ingest = typeof import("../src/services/library/ingest");
type Store = typeof import("../src/services/library/store");
let ingest: Ingest;
let store: Store;

beforeAll(async () => {
  applyTestEnv("library");
  process.env.LABEE_EMBED_PROVIDER = "fake";
  process.env.LABEE_SEED_PROTOCOLS = "false";
  const root = process.env.SKILLS_ROOTS!;
  ownDir = path.join(root, "lib-at-example-com", "protocols");
  fs.mkdirSync(path.join(ownDir, "Cell culture"), { recursive: true });
  fs.writeFileSync(
    path.join(ownDir, "Cell culture", "hek293t-maintenance.md"),
    "---\nname: HEK293T maintenance\ndescription: Routine passaging of HEK293T.\nkind: protocol\n---\n## Culture\n\n1. Grow in complete DMEM at 37 C, 5% CO2.\n2. Passage at 80-90% confluence.\n",
  );
  vi.resetModules();
  ingest = (await import("../src/services/library/ingest")) as Ingest;
  store = (await import("../src/services/library/store")) as Store;
  const { sealSession } = await import("../src/services/session");
  sealed = await sealSession({ email: EMAIL });
  cookie = `monterey_session=${encodeURIComponent(sealed)}`;
}, 30000);

afterAll(() => box?.stop());

const api = (server: TestServer, p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

describe("mapping a corpus record", () => {
  it("renders the hierarchical protocol into sections, steps and sub-steps, with materials and the purpose layer", () => {
    const r = ingest.mapBioProRecord(CORPUS[0] as never, { source: "protocol-exchange", license: "CC BY 4.0" })!;
    expect(r.id).toBe("protocol-exchange:Protocol-exchange-1");
    expect(r.doi).toBe("10.21203/rs.3.pex-2153/v1");
    expect(r.sourceUrl).toBe("https://doi.org/10.21203/rs.3.pex-2153/v1");
    expect(r.category).toBe("Biochemical & Molecular Functional Analysis");
    expect(r.domains).toEqual(["Biochemical & Molecular Functional Analysis", "Vaccine Development"]);
    expect(r.keywords).toEqual(["carbohydrate-conjugated vaccines", "oxidative release of glycans"]);
    expect(r.problem).toBe("Releasing glycans from glycoconjugates cheaply.");
    expect(r.body).toContain("## Materials\n\n- NaClO (Honeywell)\n- Acetonitrile (Sigma-Aldrich)");
    expect(r.body).toContain("## Oxidation Reaction\n\n1. Add NaClO to the glycoconjugates in 100 ul PBS.\n2. Shake the mixture");
    expect(r.body).toContain("### Cartridge Activation\n\n1. Activate a Sep-Pak C18 cartridge");
    expect(r.body).toContain("Centrifugate the mixture at 16,000g for 5 min at 4°C.");
  });

  it("drops a record with no steps and a 'null' keyword string", () => {
    expect(ingest.mapBioProRecord(CORPUS[2] as never, { source: "protocol-io", license: "CC BY 4.0" })).toBeNull();
    const r = ingest.mapBioProRecord(CORPUS[1] as never, { source: "protocol-io", license: "CC BY 4.0" })!;
    expect(r.keywords).toEqual([]);
    expect(r.body).toContain("1. Thaw the reagent in the fridge at 4°C the day before.");
  });

  it("allows CC BY and CC0 and refuses NC, ND and SA", () => {
    expect(ingest.licenseAllowed("CC BY 4.0")).toBe(true);
    expect(ingest.licenseAllowed("cc-by-4.0")).toBe(true);
    expect(ingest.licenseAllowed("CC0 1.0")).toBe(true);
    expect(ingest.licenseAllowed("CC BY-NC 4.0")).toBe(false);
    expect(ingest.licenseAllowed("CC BY-SA 4.0")).toBe(false);
    expect(ingest.licenseAllowed("CC BY-ND 4.0")).toBe(false);
    expect(ingest.licenseAllowed("")).toBe(false);
    expect(ingest.licenseAllowed("CC BY-NC 4.0", ["CC BY-NC 4.0"])).toBe(true);
  });
});

describe("ingest", () => {
  it("writes allowed records with their words, skips the rest, and embeds on request", async () => {
    const ok = [CORPUS[0], CORPUS[1]].map((r, i) =>
      ingest.mapBioProRecord(r as never, { source: i === 0 ? "protocol-exchange" : "protocol-io", license: "CC BY 4.0" })!,
    );
    const nc = { ...ingest.mapBioProRecord(CORPUS[1] as never, { source: "nc-source", license: "CC BY-NC 4.0" })!, id: "nc-source:x" };
    const report = await ingest.ingestRecords([...ok, nc], { embed: true, email: EMAIL });
    expect(report).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, skipped: 1 });
    expect(report.embedded).toBe(2);
    const status = await store.libraryStatus();
    expect(status.total).toBe(2);
    expect(status.embedded).toBe(2);
    expect(status.sources.map((s) => s.source).sort()).toEqual(["protocol-exchange", "protocol-io"]);
    // A second ingest of the same content changes nothing and keeps vectors.
    expect(await ingest.ingestRecords(ok, { embed: true, email: EMAIL })).toMatchObject({ unchanged: 2, embedded: 0 });
  });
});

describe("on the box", () => {
  beforeAll(async () => {
    box = await startServer({
      LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
      DECK_ROOT: process.env.DECK_ROOT!,
      SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
      SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
      CLAUDE_BIN: process.env.CLAUDE_BIN!,
      COOKIE_SECURE: "false",
      LABEE_EMBED_PROVIDER: "fake",
    });
  }, 30000);

  it("reports the library and searches it, with licence on every hit", async () => {
    const status = (await (await api(box, "/api/library/status")).json()) as { total: number; embedded: number };
    expect(status).toMatchObject({ total: 2, embedded: 2 });
    const r = (await (await api(box, "/api/library/search?q=release%20glycans%20from%20glycoconjugates")).json()) as {
      mode: string;
      hits: Array<{ id: string; title: string; license: string; url: string; path: string; grain: string }>;
    };
    expect(r.mode).toBe("semantic");
    expect(r.hits[0]).toMatchObject({ id: "protocol-exchange:Protocol-exchange-1", license: "CC BY 4.0" });
    expect(r.hits[0]!.url).toContain("doi.org");
    const step = (await (await api(box, "/api/library/search?q=how%20long%20at%2016,000g")).json()) as { hits: Array<{ path: string; grain: string }> };
    expect(step.hits[0]).toMatchObject({ grain: "step", path: "3.1" });
    expect((await api(box, "/api/library/protocol-exchange:Protocol-exchange-1")).status).toBe(200);
    expect((await api(box, "/api/library/nope")).status).toBe(404);
  });

  it("searches the person's own protocols, the library, or both fused", async () => {
    const mine = (await (await api(box, "/api/skills/search?kind=protocol&q=CO2&scope=mine")).json()) as { hits: Array<{ pool: string; slug: string }> };
    expect(mine.hits.map((h) => h.pool)).toEqual(["mine"]);
    const lib = (await (await api(box, "/api/skills/search?kind=protocol&q=viability%20spheroids&scope=library")).json()) as {
      hits: Array<{ pool: string; slug: string; license: string; name: string }>;
      libraryReachable: boolean;
    };
    expect(lib.libraryReachable).toBe(true);
    expect(lib.hits[0]).toMatchObject({ pool: "library", slug: "library:protocol-io:Protocol.io-0", license: "CC BY 4.0" });
    const all = (await (await api(box, "/api/skills/search?kind=protocol&q=cells%20culture%20viability&scope=all")).json()) as {
      hits: Array<{ pool: string; slug: string }>;
    };
    expect(new Set(all.hits.map((h) => h.pool))).toEqual(new Set(["mine", "library"]));
  });

  it("saves a library protocol into the person's own, with provenance, and the copy then shadows the original", async () => {
    const saved = await api(box, "/api/library/import", { method: "POST", body: JSON.stringify({ id: "protocol-io:Protocol.io-0" }) });
    expect(saved.status).toBe(200);
    const { skill, already } = (await saved.json()) as { skill: { slug: string; category?: string; origin?: { kind: string; id: string; license: string }; body: string; problem?: string }; already: boolean };
    expect(already).toBe(false);
    expect(skill.category).toBe("Cell Biology & Culture");
    expect(skill.origin).toMatchObject({ kind: "library", id: "protocol-io:Protocol.io-0", license: "CC BY 4.0" });
    expect(skill.problem).toBe("Measuring cell viability in 3D cultures.");
    expect(skill.body).toContain("## References\n\n- Cell Viability Protocol using CellTiter-Glo 3D — https://www.protocols.io/view/cell-viability-protocol-using-celltiter-glo-3d (CC BY 4.0)");
    const file = path.join(ownDir, "Cell Biology & Culture", "cell-viability-protocol-using-celltiter-glo-3d.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("kind: library");
    // Saving again hands back the copy, not a twin.
    const again = (await (await api(box, "/api/library/import", { method: "POST", body: JSON.stringify({ id: "protocol-io:Protocol.io-0" }) })).json()) as { already: boolean };
    expect(again.already).toBe(true);
    // In a fused search the copy stands for the original: one row, theirs.
    await waitFor(async () => {
      const all = (await (await api(box, "/api/skills/search?kind=protocol&q=viability%20spheroids%20luminescence&scope=all")).json()) as {
        hits: Array<{ pool: string; slug: string; shadows?: string }>;
      };
      const copies = all.hits.filter((h) => h.slug === skill.slug);
      const originals = all.hits.filter((h) => h.slug === "library:protocol-io:Protocol.io-0");
      return copies.length === 1 && copies[0]!.shadows === "protocol-io:Protocol.io-0" && originals.length === 0;
    }, 10000);
  });

  it("answers across both pools and cites the library with its licence", async () => {
    const r = (await (
      await api(box, "/api/skills/ask", { method: "POST", body: JSON.stringify({ q: "how do I release glycans with hypochlorite", kind: "protocol", scope: "all" }) })
    ).json()) as { available: boolean; citations: Array<{ pool: string; license?: string; url?: string; slug: string }> };
    expect(r.available).toBe(true);
    const lib = r.citations.find((c) => c.pool === "library");
    expect(lib).toMatchObject({ slug: "library:protocol-exchange:Protocol-exchange-1", license: "CC BY 4.0" });
    expect(lib!.url).toContain("doi.org");
  });
});

describe("from a desktop", () => {
  let desktop: TestServer;
  let desktopOwn: string;

  beforeAll(async () => {
    // Its own data and library folder, a box session on disk, and the box's address.
    const { root } = applyTestEnv("library-desktop");
    desktopOwn = path.join(process.env.SKILLS_ROOTS!, "lib-at-example-com", "protocols");
    const sessionFile = path.join(root, "remote-session.txt");
    fs.writeFileSync(sessionFile, sealed);
    desktop = await startServer({
      LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
      DECK_ROOT: process.env.DECK_ROOT!,
      SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
      SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
      CLAUDE_BIN: process.env.CLAUDE_BIN!,
      COOKIE_SECURE: "false",
      LABEE_EMBED_PROVIDER: "fake",
      LABEE_MODE: "desktop",
      LABEE_SKILLS_SERVER: box.base,
      LABEE_REMOTE_SESSION_FILE: sessionFile,
    });
  }, 30000);
  afterAll(() => desktop?.stop());

  it("reaches the library on the box through the account's session", async () => {
    const status = (await (await api(desktop, "/api/library/status")).json()) as { total: number };
    expect(status.total).toBe(2);
    const lib = (await (await api(desktop, "/api/skills/search?kind=protocol&q=glycans%20hypochlorite&scope=library")).json()) as {
      hits: Array<{ pool: string; slug: string }>;
      libraryReachable: boolean;
    };
    expect(lib.libraryReachable).toBe(true);
    expect(lib.hits[0]).toMatchObject({ pool: "library", slug: "library:protocol-exchange:Protocol-exchange-1" });
  });

  it("saves a library protocol into the desktop's own folder", async () => {
    const saved = await api(desktop, "/api/library/import", { method: "POST", body: JSON.stringify({ id: "protocol-exchange:Protocol-exchange-1", category: "Glycomics" }) });
    expect(saved.status).toBe(200);
    const { skill } = (await saved.json()) as { skill: { slug: string; category?: string; origin?: { kind: string } } };
    expect(skill.category).toBe("Glycomics");
    expect(skill.origin?.kind).toBe("library");
    expect(fs.existsSync(path.join(desktopOwn, "Glycomics", "oxidative-release-of-glycans-from-carbohydrate-conjugated-vaccine.md"))).toBe(true);
    // And not on the box.
    expect(fs.existsSync(path.join(ownDir, "Glycomics"))).toBe(false);
  });
});
