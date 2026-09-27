import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "folders@example.com";
let server: TestServer;
let cookie: string;
/** A folder under $HOME, because grants are confined to the home directory. */
let granted: string;
let outside: string;

beforeAll(async () => {
  applyTestEnv("folders");
  granted = fs.mkdtempSync(path.join(os.homedir(), ".labee-test-grant-"));
  fs.mkdirSync(path.join(granted, "lysis"), { recursive: true });
  fs.writeFileSync(
    path.join(granted, "lysis", "SKILL.md"),
    "---\nname: Bench lysis\ndescription: A protocol kept in a lab folder\nkind: protocol\n---\n\n## Procedure\n\nResuspend, lyse, neutralise.\n",
  );
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "labee-outside-"));

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

afterAll(() => {
  server?.stop();
  fs.rmSync(granted, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });

const add = (p: string) => api("/api/folders", { method: "POST", body: JSON.stringify({ path: p }) });
const protocols = async () =>
  ((await (await api("/api/skills")).json()) as { skills: Array<{ name: string; slug: string }> }).skills;

describe("granted folders", () => {
  it("starts empty and rejects anonymous callers", async () => {
    const r = (await (await api("/api/folders")).json()) as { folders: unknown[] };
    expect(r.folders).toEqual([]);
    const anon = await fetch(`${server.base}/api/folders`);
    expect(anon.status).toBe(401);
  });

  it("refuses anything outside the home directory, a file, or a missing path", async () => {
    for (const [p, why] of [
      [outside, "outside home"],
      [path.join(granted, "lysis", "SKILL.md"), "a file"],
      [path.join(granted, "nope"), "missing"],
      [os.homedir(), "the whole home directory"],
      ["relative/path", "not absolute"],
    ] as const) {
      const r = await add(p);
      expect(r.status, why).toBe(400);
    }
    const listed = (await (await api("/api/folders")).json()) as { folders: unknown[] };
    expect(listed.folders).toEqual([]);
  });

  it("adds a folder and puts its protocols in the library", async () => {
    expect((await protocols()).some((s) => s.name === "Bench lysis")).toBe(false);

    const r = await add(granted);
    expect(r.status).toBe(200);
    const { folder } = (await r.json()) as { folder: { path: string; label: string; exists: boolean } };
    expect(folder.exists).toBe(true);
    expect(folder.label).toBe(path.basename(granted));

    expect((await protocols()).some((s) => s.name === "Bench lysis")).toBe(true);
  });

  it("refuses a duplicate and refuses nesting in either direction", async () => {
    expect((await add(granted)).status).toBe(400);

    const child = path.join(granted, "lysis");
    expect((await add(child)).status).toBe(400);

    // And a parent that would swallow the existing grant.
    const parent = path.dirname(granted);
    if (parent !== os.homedir()) expect((await add(parent)).status).toBe(400);
  });

  it("lets a protocol in a granted folder be edited, which proves it is writable", async () => {
    const slug = (await protocols()).find((s) => s.name === "Bench lysis")!.slug;
    const r = await api(`/api/skills/${slug}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Bench lysis",
        description: "Edited through the app",
        allowedTools: [],
        body: "## Procedure\n\nEdited.",
        kind: "protocol",
      }),
    });
    expect(r.status).toBe(200);
    const onDisk = fs.readFileSync(path.join(granted, "lysis", "SKILL.md"), "utf8");
    expect(onDisk).toContain("Edited through the app");
  });

  it("revoking hides the protocols but leaves the files alone", async () => {
    const r = await api(`/api/folders?path=${encodeURIComponent(granted)}`, { method: "DELETE" });
    expect(r.status).toBe(200);

    expect((await protocols()).some((s) => s.name === "Bench lysis")).toBe(false);
    expect(fs.existsSync(path.join(granted, "lysis", "SKILL.md"))).toBe(true);

    // Removing something that is not on the list is an error, not a silent no-op.
    const again = await api(`/api/folders?path=${encodeURIComponent(granted)}`, { method: "DELETE" });
    expect(again.status).toBe(400);
  });
});
