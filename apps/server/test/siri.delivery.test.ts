// The return path (siri-agent design §5): a turn the Siri agent delegated
// comes back as a line in the Siri session (unread), a spoken summary, and
// a time-sensitive push; "Any news" lists it and marks it read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { applyTestEnv, waitFor } from "./helpers/env";
import { freePort, startServer, type TestServer } from "./helpers/server";

const EMAIL = "siri-return@example.com";
let server: TestServer;
let cookie: string;
let pushServer: http.Server;
const pushes: { to: string; title: string; body: string; data: Record<string, unknown>; categoryId?: string; interruptionLevel?: string }[] = [];

beforeAll(async () => {
  applyTestEnv("siri-delivery");
  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  const pushPort = await freePort();
  pushServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        pushes.push(...(JSON.parse(body) as typeof pushes));
      } catch {
        // ignore
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ status: "ok" }] }));
    });
  });
  await new Promise<void>((r) => pushServer.listen(pushPort, "127.0.0.1", r));
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_MODE: "server",
    LABEE_ANTHROPIC_API_KEY: "test-placeholder-never-sent",
    EXPO_PUSH_URL: `http://127.0.0.1:${pushPort}/push`,
  });
}, 30000);

afterAll(() => {
  server?.stop();
  pushServer?.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-labee-device": "Siri", ...(init.headers ?? {}) } });
const post = (p: string, body: unknown = {}) => api(p, { method: "POST", body: JSON.stringify(body) });

interface News {
  items: { idx: number; sessionId: string; title: string; spoken: string; question: { text: string; options: string[] } | null; siriTurnId: string | null }[];
}

describe("the Siri return path", () => {
  it("a delegated turn comes back: Siri line, spoken summary, announced push, unread", async () => {
    // The phone registers for pushes with its account session only.
    expect((await post("/api/link/push-token", { pushToken: "ExponentPushToken[siri-phone]" })).status).toBe(200);

    const sent = await post("/api/siri/send", { text: "what are PCR stats", kind: "ask", forceNew: true });
    expect(sent.status).toBe(202);
    const r = (await sent.json()) as { sessionId: string; title: string; siriTurnId: string };
    expect(r.siriTurnId).toMatch(/^siri_/);

    // The turn ends → the return is delivered.
    await waitFor(async () => ((await (await api("/api/siri/news")).json()) as News).items.length > 0, 20000);
    const news = (await (await api("/api/siri/news")).json()) as News;
    expect(news.items).toHaveLength(1);
    const item = news.items[0]!;
    expect(item.sessionId).toBe(r.sessionId);
    expect(item.title).toBe(r.title);
    expect(item.spoken.length).toBeGreaterThan(0);
    expect(item.siriTurnId).toBe(r.siriTurnId);
    expect(item.question).toBeNull();

    // The push: time-sensitive, the reply category, carrying the chat and origin.
    await waitFor(() => pushes.some((p) => p.data.sessionId === r.sessionId), 10000);
    const p = pushes.find((x) => x.data.sessionId === r.sessionId)!;
    expect(p.to).toBe("ExponentPushToken[siri-phone]");
    expect(p.categoryId).toBe("labee.reply");
    expect(p.interruptionLevel).toBe("time-sensitive");
    expect(p.data).toMatchObject({ kind: "done", origin: "siri", siriTurnId: r.siriTurnId });
    expect(p.body).toBe(item.spoken);
    // Exactly one push for the turn: the generic "turn finished" push stays quiet.
    expect(pushes.filter((x) => x.data.sessionId === r.sessionId)).toHaveLength(1);

    // The Siri session holds the exchange and its return.
    const siri = (await (await api(`/api/sessions/${(await (await api("/api/siri/route", { method: "POST", body: JSON.stringify({ text: "x", kind: "answer" }) })).json() as { siriSessionId: string }).siriSessionId}`)).json()) as { messages: { role: string; content: string; meta: Record<string, unknown> | null }[] };
    const ret = siri.messages.find((m) => m.meta?.kind === "return");
    expect(ret?.content.startsWith(`← "${r.title}"`)).toBe(true);
    expect(ret?.meta).toMatchObject({ unread: true, sessionId: r.sessionId });

    // Heard → read.
    expect(((await (await post("/api/siri/news/read", { idx: [item.idx] })).json()) as { read: number }).read).toBe(1);
    expect(((await (await api("/api/siri/news")).json()) as News).items).toHaveLength(0);
  }, 60000);

  it("a turn typed in the chat (no Siri origin) is not returned to Siri", async () => {
    const before = pushes.length;
    const { session } = (await (await post("/api/sessions", { title: "typed" })).json()) as { session: { id: string } };
    expect((await post(`/api/sessions/${session.id}/turns`, { text: "hello there" })).status).toBe(202);
    await waitFor(async () => {
      const s = (await (await api(`/api/sessions/${session.id}`)).json()) as { session: { status: string } };
      return s.session.status === "idle";
    }, 20000);
    expect(((await (await api("/api/siri/news")).json()) as News).items).toHaveLength(0);
    // No Siri return was pushed for it (a chat held here sends no generic
    // "turn finished" push either; that one is the box's for Mac-held chats).
    expect(pushes.slice(before).filter((p) => p.data.origin === "siri")).toHaveLength(0);
  }, 60000);
});
