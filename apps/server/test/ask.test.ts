import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "ask@example.com";
const OTHER = "other@example.com";
let server: TestServer;
let cookie: string;

function writeArtifact(dir: string, rel: string, name: string, body: string) {
  const full = path.join(dir, rel);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(
    path.join(full, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\nkind: protocol\n---\n\n${body}\n`,
  );
}

beforeAll(async () => {
  applyTestEnv("ask");
  const root = process.env.SKILLS_ROOTS!.split(":")[0]!;
  writeArtifact(
    path.join(root, "ask-at-example-com"),
    "miniprep",
    "Plasmid miniprep",
    [
      "## Elution",
      "",
      "Elute the column in 30 microlitres of warmed elution buffer.",
      "Leave it to stand for one minute before the final spin.",
    ].join("\n"),
  );
  // Another account's protocol must never be quoted back to this caller.
  writeArtifact(
    path.join(root, "other-at-example-com"),
    "secret",
    "Secret elution protocol",
    "## Elution\n\nElute in 12 microlitres of proprietary buffer.",
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

interface AskResult {
  answer: string;
  citations: Array<{ n: number; slug: string; name: string; heading: string; quote: string }>;
  available: boolean;
}

const ask = async (q: string): Promise<AskResult> =>
  (await (
    await fetch(`${server.base}/api/skills/ask`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ q }),
    })
  ).json()) as AskResult;

describe("ask the library", () => {
  it("answers from a protocol and cites the passage it used", async () => {
    const r = await ask("how much elution buffer");
    expect(r.available).toBe(true);
    expect(r.answer).toMatch(/\[\d+\]/);
    expect(r.answer.toLowerCase()).toContain("elute");
    expect(r.citations.length).toBeGreaterThan(0);
    const c = r.citations[0]!;
    expect(c.name).toBe("Plasmid miniprep");
    expect(c.heading).toBe("Elution");
    // The cited quote is the passage the model was actually shown.
    expect(c.quote).toContain("30 microlitres");
  });

  it("declines when the protocols do not cover the question", async () => {
    const r = await ask("what voltage for the electroporator");
    expect(r.available).toBe(true);
    expect(r.answer.toLowerCase()).toContain("do not cover");
    expect(r.citations).toEqual([]);
  });

  it("never cites another account's protocol", async () => {
    const r = await ask("how much elution buffer");
    expect(r.citations.every((c) => !c.slug.includes("secret"))).toBe(true);
    expect(r.answer).not.toContain("12 microlitres");
  });

  it("returns nothing for an empty question and rejects anonymous callers", async () => {
    const empty = await ask("   ");
    expect(empty.answer).toBe("");
    expect(empty.citations).toEqual([]);

    const anon = await fetch(`${server.base}/api/skills/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "anything" }),
    });
    expect(anon.status).toBe(401);
  });

  it("only lists citations the answer actually referenced", async () => {
    const r = await ask("how much elution buffer");
    const cited = new Set([...r.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    expect(new Set(r.citations.map((c) => c.n))).toEqual(cited);
  });
});
