// The verification layer beyond lint: review findings grounded in the
// person's other protocols, step ordering, and the confidence that rides on
// an Ask answer. In-process against the fake model, then the routes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "verify@example.com";
let ownDir: string;
type Review = typeof import("../src/services/artifactIndex/review");
type Order = typeof import("../src/services/artifactIndex/order");
type Ask = typeof import("../src/services/artifactIndex/ask");
let review: Review;
let order: Order;
let ask: Ask;

const EVIDENCE = [
  "---",
  "name: HEK293T maintenance",
  "description: Routine passaging of HEK293T.",
  "kind: protocol",
  "---",
  "## Culture",
  "",
  "1. Grow in complete DMEM in a humidified incubator at 37 C, 5% CO2.",
  "2. Passage at 80-90% confluence, 1:6 to 1:10.",
  "",
].join("\n");

const UNDER_REVIEW = [
  "## Culture",
  "",
  "1. Coat the plates with vitronectin.",
  "2. Maintain the cells in a humidified incubator at 37 C, 10% CO2.",
  "3. Exchange the medium daily.",
  "",
  "## Harvest",
  "",
  "1. Spin 5 min at 50,000 rpm.",
  "2. Ligate without the ligase for 30 min.",
  "",
].join("\n");

beforeAll(async () => {
  applyTestEnv("verify");
  process.env.LABEE_EMBED_PROVIDER = "fake";
  process.env.LABEE_SEED_PROTOCOLS = "false";
  ownDir = path.join(process.env.SKILLS_ROOTS!, "verify-at-example-com", "protocols");
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(path.join(ownDir, "hek293t-maintenance.md"), EVIDENCE);
  vi.resetModules();
  review = (await import("../src/services/artifactIndex/review")) as Review;
  order = (await import("../src/services/artifactIndex/order")) as Order;
  ask = (await import("../src/services/artifactIndex/ask")) as Ask;
});

describe("review", () => {
  it("judges each step with its context and this lab's other protocols", async () => {
    const r = await review.reviewProtocol(UNDER_REVIEW, { name: "hESC culture", description: "Keep hESCs growing.", email: EMAIL });
    expect(r.available).toBe(true);
    expect(r.steps).toBe(5);
    const byPath = new Map(r.findings.map((f) => [f.path, f]));
    const co2 = byPath.get("1.2")!;
    expect(co2.class).toBe("parameter");
    expect(co2.message).toContain("10% CO2");
    expect(co2.message).toContain("5% CO2");
    expect(co2.suggestion).toBe("5% CO2");
    expect(co2.excerpt).toContain("humidified incubator");
    expect(byPath.get("2.1")?.class).toBe("parameter");
    expect(byPath.get("2.2")?.class).toBe("reagent");
    // Fine steps get no finding; findings come back in step order.
    expect(byPath.has("1.1")).toBe(false);
    expect(r.findings.map((f) => f.path)).toEqual(["1.2", "2.1", "2.2"]);
  });

  it("does not use the protocol under review as its own evidence", async () => {
    // Saved with the odd value: if it were allowed as evidence, 10% would
    // agree with itself and the finding would vanish.
    fs.writeFileSync(
      path.join(ownDir, "hesc-culture.md"),
      `---\nname: hESC culture\ndescription: Keep hESCs growing.\nkind: protocol\n---\n${UNDER_REVIEW}`,
    );
    const r = await review.reviewProtocol(UNDER_REVIEW, {
      name: "hESC culture",
      email: EMAIL,
      excludeSlug: "user--hesc-culture",
    });
    expect(r.findings.some((f) => f.path === "1.2" && f.class === "parameter")).toBe(true);
  });

  it("says so when there is no model to review with", async () => {
    const saved = process.env.LABEE_EMBED_PROVIDER;
    process.env.LABEE_EMBED_PROVIDER = "";
    process.env.OPENAI_API_KEY = "";
    process.env.LABEE_OPENAI_API_KEY = "";
    try {
      const r = await review.reviewProtocol(UNDER_REVIEW, { name: "x", email: EMAIL });
      expect(r.available).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.steps).toBe(5);
    } finally {
      process.env.LABEE_EMBED_PROVIDER = saved;
    }
  });
});

describe("ordering", () => {
  it("restores a shuffled sequence as a permutation", async () => {
    const r = await order.orderSteps(["3. Elute the DNA.", "1. Pellet the culture.", "2. Lyse the pellet."], EMAIL);
    expect(r.available).toBe(true);
    expect(r.order).toEqual([1, 2, 0]);
    expect(r.steps[0]).toBe("1. Pellet the culture.");
  });

  it("leaves a list it cannot order as it was", async () => {
    const r = await order.orderSteps(["Elute.", "Pellet.", "Lyse."], EMAIL);
    expect(r.order).toEqual([0, 1, 2]);
  });

  it("needs nothing for fewer than two steps", async () => {
    expect((await order.orderSteps(["Only step."], EMAIL)).order).toEqual([0]);
    expect((await order.orderSteps([], EMAIL)).steps).toEqual([]);
  });
});

describe("confidence on an answer", () => {
  it("is split off the answer text", () => {
    expect(ask.splitConfidence("Spin 5 min. [1] [CONFIDENCE: 0.8]")).toEqual({ answer: "Spin 5 min. [1]", confidence: 0.8 });
    expect(ask.splitConfidence("No marker here.")).toEqual({ answer: "No marker here.", confidence: null });
    expect(ask.splitConfidence("Clamped. [CONFIDENCE: 1.0]").confidence).toBe(1);
  });

  it("comes back with the answer and never in it", async () => {
    const r = await ask.askLibrary("what CO2 for HEK293T", EMAIL, { kind: "protocol" });
    expect(r.available).toBe(true);
    expect(r.confidence).toBe(0.85);
    expect(r.answer).not.toContain("CONFIDENCE");
    expect(r.citations[0]?.path).toBeDefined();
  });
});

describe("the routes", () => {
  let server: TestServer;
  let cookie: string;

  beforeAll(async () => {
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

  const post = (p: string, body: unknown) =>
    fetch(`${server.base}${p}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lint a draft, lint a saved protocol", async () => {
    const draft = (await (await post("/api/skills/lint", { markdown: "## P\n\n1. Spin at 50,000 rpm.\n" })).json()) as { halts: number };
    expect(draft.halts).toBe(1);
    const saved = await post("/api/skills/user--hek293t-maintenance/lint", {});
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { halts: number }).halts).toBe(0);
    expect((await post("/api/skills/no-such-thing/lint", {})).status).toBe(404);
  });

  it("review a draft and a saved protocol, order a list", async () => {
    // The draft has no slug to exclude, and the same wrong value is by now
    // saved in the library, so the CO2 finding is not guaranteed here; the
    // rotor speed does not depend on evidence.
    const draft = (await (await post("/api/skills/review", { markdown: UNDER_REVIEW, name: "hESC culture" })).json()) as {
      findings: Array<{ path: string; class: string }>;
    };
    expect(draft.findings.some((f) => f.path === "2.1" && f.class === "parameter")).toBe(true);
    // The saved one is excluded from its own evidence by the route, so the
    // other protocol's 5% CO2 is what it is judged against.
    const saved = (await (await post("/api/skills/user--hesc-culture/review", {})).json()) as {
      findings: Array<{ path: string; class: string }>;
      steps: number;
    };
    expect(saved.steps).toBe(5);
    expect(saved.findings.some((f) => f.path === "1.2" && f.class === "parameter")).toBe(true);
    const ordered = (await (await post("/api/skills/order", { steps: ["2. Two.", "1. One."] })).json()) as { order: number[] };
    expect(ordered.order).toEqual([1, 0]);
    expect((await post("/api/skills/order", {})).status).toBe(400);
  });
});
