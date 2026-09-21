import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "erase-me@example.com";
const OTHER = "keep-me@example.com";
let server: TestServer;
let cookie: string;
let otherCookie: string;
let dataDir: string;
let deckRoot: string;

beforeAll(async () => {
  applyTestEnv("account");
  dataDir = process.env.LABEE_DATA_DIR!;
  deckRoot = process.env.DECK_ROOT!;
  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  otherCookie = `monterey_session=${encodeURIComponent(await sealSession({ email: OTHER }))}`;
  server = await startServer({
    LABEE_DATA_DIR: dataDir,
    DECK_ROOT: deckRoot,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (c: string, p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, {
    ...init,
    headers: { cookie: c, "content-type": "application/json", ...(init.headers ?? {}) },
  });

/** Every table that carries an email column, plus the child tables, counted
 *  for one address straight out of the SQLite file the server writes. */
function rowsFor(email: string): Record<string, number> {
  const db = new DatabaseSync(path.join(dataDir, "labee.sqlite"), { readOnly: true });
  const count = (sql: string) => Number((db.prepare(sql).get(email) as { n: number }).n);
  const out: Record<string, number> = {
    users: count("SELECT COUNT(*) n FROM users WHERE email = ?"),
    chat_sessions: count("SELECT COUNT(*) n FROM chat_sessions WHERE email = ?"),
    chat_session_messages: count(
      "SELECT COUNT(*) n FROM chat_session_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE email = ?)",
    ),
    chat_session_events: count(
      "SELECT COUNT(*) n FROM chat_session_events WHERE session_id IN (SELECT id FROM chat_sessions WHERE email = ?)",
    ),
    link_devices: count("SELECT COUNT(*) n FROM link_devices WHERE email = ?"),
    billing: count("SELECT COUNT(*) n FROM billing WHERE email = ?"),
    mirror_sessions: count("SELECT COUNT(*) n FROM mirror_sessions WHERE email = ?"),
  };
  db.close();
  return out;
}

describe("DELETE /api/account", () => {
  it("rejects anonymous callers", async () => {
    const r = await fetch(`${server.base}/api/account`, { method: "DELETE" });
    expect(r.status).toBe(401);
  });

  it("erases every row and file for the account, and only that account", async () => {
    // Seed both people with the same footprint through the public API.
    for (const c of [cookie, otherCookie]) {
      const created = await api(c, "/api/sessions", { method: "POST", body: JSON.stringify({ title: "t" }) });
      expect(created.status).toBe(201);
      const { session: { id } } = (await created.json()) as { session: { id: string } };
      // A turn writes messages + events.
      const turn = await api(c, `/api/sessions/${id}/turns`, {
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
      });
      expect([200, 202]).toContain(turn.status);
      // A pending device row.
      await api(c, "/api/link/devices", { method: "POST", body: JSON.stringify({ name: "iPhone", platform: "ios" }) });
      // Billing row via first touch.
      await api(c, "/api/billing");
    }
    // Deck files on disk.
    const { userDeckDir } = await import("../src/services/deck");
    const deck = userDeckDir(EMAIL);
    fs.mkdirSync(deck, { recursive: true });
    fs.writeFileSync(path.join(deck, "notes.md"), "private");

    // Wait until the turn has actually persisted something.
    await new Promise((r) => setTimeout(r, 1500));
    const before = rowsFor(EMAIL);
    expect(before.chat_sessions).toBe(1);
    expect(before.billing).toBe(1);
    expect(before.chat_session_messages).toBeGreaterThan(0);

    const del = await api(cookie, "/api/account", { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean; deleted: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.deleted.chat_sessions).toBe(1);
    // The response ends the browser session.
    expect(del.headers.get("set-cookie") ?? "").toMatch(/monterey_session=;|max-age=0|expires=/i);

    // Nothing left for the deleted person…
    const after = rowsFor(EMAIL);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
    expect(fs.existsSync(deck)).toBe(false);

    // …and the other person is untouched.
    const other = rowsFor(OTHER);
    expect(other.chat_sessions).toBe(1);
    expect(other.billing).toBe(1);
    expect(other.chat_session_messages).toBeGreaterThan(0);
  });

  it("stops honouring the deleted account's still-valid cookie", async () => {
    const me = await api(cookie, "/api/me");
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
    const sessions = await api(cookie, "/api/sessions");
    expect(sessions.status).toBe(401);
    // Other account keeps working.
    const otherSessions = await api(otherCookie, "/api/sessions");
    expect(otherSessions.status).toBe(200);
  });
});
