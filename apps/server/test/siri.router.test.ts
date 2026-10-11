// The Siri session and router (docs/siri-design.md §3.3), on one server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "siri@example.com";
let server: TestServer;
let cookie: string;

beforeAll(async () => {
  applyTestEnv("siri");
  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email: EMAIL }))}`;
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_MODE: "server",
    LABEE_ANTHROPIC_API_KEY: "test-placeholder-never-sent",
    LABEE_EMBED_PROVIDER: "fake",
    LABEE_SEED_PROTOCOLS: "true",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-labee-device": "Siri", ...(init.headers ?? {}) } });
const post = (p: string, body: unknown = {}) => api(p, { method: "POST", body: JSON.stringify(body) });

interface Route {
  action: string;
  sessionId: string | null;
  title: string | null;
  via: string;
  confidence: number;
  candidates: { sessionId: string; title: string }[];
  siriSessionId: string;
}

async function session(title: string): Promise<string> {
  const r = (await (await post("/api/sessions", { title })).json()) as { session: { id: string } };
  return r.session.id;
}

async function sessions(): Promise<{ id: string; title: string; kind: string | null; status: string }[]> {
  return ((await (await api("/api/sessions")).json()) as { sessions: { id: string; title: string; kind: string | null; status: string }[] }).sessions;
}

describe("the Siri router", () => {
  let gel: string;
  let ligation: string;

  it("creates the Siri session on first use and routes a named session without a model", async () => {
    gel = await session("gel troubleshooting");
    ligation = await session("ligation prep");
    const r = (await (await post("/api/siri/route", { text: "the gel is done", kind: "tell", sessionId: gel })).json()) as Route;
    expect(r).toMatchObject({ action: "continue", sessionId: gel, title: "gel troubleshooting", via: "named", confidence: 1 });
    const all = await sessions();
    const siri = all.find((s) => s.kind === "siri");
    expect(siri?.title).toBe("Siri");
    expect(r.siriSessionId).toBe(siri!.id);
  });

  it("logs every exchange in the Siri session as a quiet line", async () => {
    const s = (await (await api(`/api/sessions/${(await sessions()).find((x) => x.kind === "siri")!.id}`)).json()) as { messages: { role: string; content: string; meta: { via?: string } | null }[] };
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.role).toBe("system");
    expect(s.messages[0]!.content).toBe('→ gel troubleshooting · said: "the gel is done"');
    expect(s.messages[0]!.meta?.via).toBe("named");
  });

  it("an answer goes to the session waiting on a question", async () => {
    // [[question]] makes the fake claude ask; the session ends up awaiting_input.
    const started = await post(`/api/sessions/${ligation}/turns`, { text: "pick one [[question]]" });
    if (started.status !== 202) console.log("turn →", started.status, await started.clone().text(), server.logs.slice(-5).join(""));
    await waitFor(async () => (await sessions()).find((s) => s.id === ligation)?.status === "awaiting_input", 10000).catch(async () => {
      const s = (await (await api(`/api/sessions/${ligation}`)).json()) as { session: { status: string }; messages: { role: string; content: string; meta: unknown }[] };
      throw new Error(`session after turn: ${JSON.stringify(s).slice(0, 1500)}\nlogs: ${server.logs.slice(-8).join("")}`);
    });
    const r = (await (await post("/api/siri/route", { text: "the second one", kind: "answer" })).json()) as Route;
    expect(r).toMatchObject({ action: "continue", sessionId: ligation, via: "pending" });
    // And the spoken answer maps onto the option server-side.
    const a = await post(`/api/sessions/${ligation}/answer`, { spoken: "the second one" });
    expect(a.status).toBe(202);
    const body = (await a.json()) as { answers: { answer: string }[]; matched: boolean };
    expect(body.matched).toBe(true);
    expect(body.answers[0]!.answer).toBe("Rubric");
    // The fake asks again on every turn whose transcript carries [[question]];
    // the point here is only that the answer was mapped and accepted.
  }, 30000);

  it("the model picks a chat when it is sure, and the message lands there", async () => {
    const text = 'lanes one to six look fine [[reply:{"sessionId":"' + gel + '","confidence":0.9}]]';
    const r = (await (await post("/api/siri/send", { text, kind: "tell" })).json()) as { needsChoice: boolean; sessionId: string; title: string; created: boolean };
    expect(r.needsChoice).toBe(false);
    expect(r.sessionId).toBe(gel);
    expect(r.created).toBe(false);
    await waitFor(async () => {
      const s = (await (await api(`/api/sessions/${gel}`)).json()) as { messages: { role: string; content: string; meta: { device?: string } | null }[] };
      return s.messages.some((m) => m.role === "user" && m.content.startsWith("lanes one to six") && m.meta?.device === "Siri");
    }, 10000);
  }, 30000);

  it("an unsure model answer becomes a choice, and nothing is sent", async () => {
    const text = 'something about lanes [[reply:{"sessionId":"' + gel + '","confidence":0.45,"alternatives":["' + ligation + '"]}]]';
    const r = (await (await post("/api/siri/send", { text, kind: "tell" })).json()) as { needsChoice: boolean; candidates: { sessionId: string; title: string }[] };
    expect(r.needsChoice).toBe(true);
    expect(r.candidates.map((c) => c.title)).toEqual(["gel troubleshooting", "ligation prep"]);
  });

  it("'new' from the model, or an unparseable reply, starts a new chat titled from the text", async () => {
    const r = (await (await post("/api/siri/send", { text: "order more agarose for next week [[reply:nonsense]]", kind: "tell", voice: false })).json()) as { needsChoice: boolean; created: boolean; title: string; sessionId: string };
    expect(r.needsChoice).toBe(false);
    expect(r.created).toBe(true);
    expect(r.title).toBe("order more agarose for next week [[reply:nonsens…");
    expect((await sessions()).some((s) => s.id === r.sessionId)).toBe(true);
  });

  it("a quick question is answered from the protocols in one spoken sentence and logged", async () => {
    expect((await api("/api/skills")).status).toBe(200);
    // The fake completion quotes the first sentence of a matching passage,
    // so the exact words depend on retrieval; the contract is: an answer,
    // spoken (no citation markers), logged.
    const r = (await (await post("/api/ask/quick", { q: "how long does the gibson assembly incubate" })).json()) as { needsAgent: boolean; answer: string; reason?: string };
    expect(r.needsAgent, r.reason).toBe(false);
    expect(r.answer.length).toBeGreaterThan(0);
    expect(r.answer).not.toMatch(/\[\d+\]/);
    const siri = (await sessions()).find((s) => s.kind === "siri")!;
    const s = (await (await api(`/api/sessions/${siri.id}`)).json()) as { messages: { content: string }[] };
    expect(s.messages.some((m) => m.content.startsWith('asked: "how long does the gibson assembly incubate"'))).toBe(true);
  });

  it("the Siri session is never a destination", async () => {
    const siri = (await sessions()).find((s) => s.kind === "siri")!;
    const r = (await (await post("/api/siri/route", { text: "hello", kind: "tell", sessionId: siri.id })).json()) as Route;
    expect(r.via).not.toBe("named");
    expect(r.sessionId).not.toBe(siri.id);
  });
});
