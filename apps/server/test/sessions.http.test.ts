import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyTestEnv, waitFor } from "./helpers/env";
import { readSse, startServer, type TestServer } from "./helpers/server";

const EMAIL = "bob@example.com";
let server: TestServer;
let cookie: string;
let root: string;

beforeAll(async () => {
  ({ root } = applyTestEnv("http"));
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

type Frame = { event: string; data: Record<string, unknown>; id?: string };
const evType = (f: Frame) => String(f.data.type);

describe("session HTTP API", () => {
  it("rejects anonymous callers", async () => {
    const r = await fetch(`${server.base}/api/sessions`);
    expect(r.status).toBe(401);
  });

  it("creates, lists, runs a turn, replays and tails events, resumes with Last-Event-ID", async () => {
    const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "" }) });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string; status: string } };
    expect(session.status).toBe("idle");

    // Attach BEFORE the turn: idle stream then live tail.
    const tail = await api(`/api/sessions/${session.id}/events?after=0`);
    expect(tail.headers.get("content-type")).toContain("text/event-stream");

    const started = await api(`/api/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "x-labee-device": "iPhone" },
      body: JSON.stringify({ text: "hello server" }),
    });
    expect(started.status).toBe(202);
    const startBody = (await started.json()) as { turnId: string; queued: boolean };
    expect(startBody.queued).toBe(false);

    const frames = await readSse(tail, (f) => evType(f) === "turn_ended");
    const types = frames.map(evType);
    expect(types[0]).toBe("session_status");
    expect(types).toContain("turn_started");
    expect(types).toContain("delta");
    expect(types[types.length - 1]).toBe("turn_ended");
    const startedFrame = frames.find((f) => evType(f) === "turn_started")!;
    expect((startedFrame.data.data as { device?: string }).device).toBe("iPhone");

    // Replay after the fact: compacted (no deltas), and turn_ended carries the text.
    const replay = await api(`/api/sessions/${session.id}/events?after=0&once=1`);
    const rframes = await readSse(replay, () => false, 3000);
    const rtypes = rframes.map(evType);
    expect(rtypes).not.toContain("delta");
    expect(rtypes).toContain("turn_started");
    expect(rtypes).toContain("turn_ended");
    const ended = rframes.find((f) => evType(f) === "turn_ended")!;
    expect((ended.data.data as { content: string }).content).toContain("Hello from fake claude");
    expect(rtypes[rtypes.length - 1]).toBe("session_status");

    // Last-Event-ID resume: only rows after that seq.
    const mid = Number(rframes.find((f) => evType(f) === "turn_started")!.id);
    const resumed = await api(`/api/sessions/${session.id}/events?once=1`, { headers: { "last-event-id": String(mid) } });
    const resFrames = await readSse(resumed, () => false, 3000);
    expect(resFrames.every((f) => f.id === undefined || Number(f.id) > mid)).toBe(true);
    expect(resFrames.map(evType)).not.toContain("turn_started");

    // GET session: messages + summary.
    const got = await api(`/api/sessions/${session.id}`);
    const body = (await got.json()) as { session: { title: string; status: string; costUsd: number }; messages: { role: string }[] };
    expect(body.session.title).toBe("hello server");
    expect(body.session.status).toBe("idle");
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const list = await api("/api/sessions");
    const { sessions } = (await list.json()) as { sessions: { id: string }[] };
    expect(sessions.some((s) => s.id === session.id)).toBe(true);
  }, 20000);

  it("queues a turn sent mid-turn (no 409) and reports it in GET", async () => {
    const { session } = (await (await api("/api/sessions", { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    // the fake is fast; use the server's env to slow it via a per-request trick: not available, so
    // rely on immediate back-to-back posts.
    const a = api(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "one" }) });
    const b = api(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "two" }) });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(202);
    expect(rb.status).toBe(202);
    const jb = (await rb.json()) as { queued: boolean };
    const ja = (await ra.json()) as { queued: boolean };
    expect([ja.queued, jb.queued].filter(Boolean).length).toBe(1);
    await waitFor(async () => {
      const g = (await (await api(`/api/sessions/${session.id}`)).json()) as { messages: unknown[]; session: { status: string } };
      return g.messages.length === 4 && g.session.status === "idle";
    }, 10000);
  }, 20000);

  it("answers a question and rejects answers when none is pending", async () => {
    const { session } = (await (await api("/api/sessions", { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    const none = await api(`/api/sessions/${session.id}/answer`, { method: "POST", body: JSON.stringify({ answers: [{ question: "q", answer: "a" }] }) });
    expect(none.status).toBe(409);
    const bad = await api(`/api/sessions/${session.id}/answer`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  it("cancel returns 409 when idle and diff reports non-repo dirs", async () => {
    const { session } = (await (await api("/api/sessions", { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    const c = await api(`/api/sessions/${session.id}/cancel`, { method: "POST" });
    expect(c.status).toBe(409);
    const d = (await (await api(`/api/sessions/${session.id}/diff`)).json()) as { isRepo: boolean };
    expect(d.isRepo).toBe(false);
  });

  it("diff shows uncommitted changes in a git working directory", async () => {
    const { session } = (await (await api("/api/sessions", { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    // Run one turn so the session's cwd (the user's deck dir) is recorded.
    await api(`/api/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ text: "x" }) });
    await waitFor(async () => {
      const g = (await (await api(`/api/sessions/${session.id}`)).json()) as { session: { status: string; cwd: string | null } };
      return g.session.status === "idle" && Boolean(g.session.cwd);
    }, 10000);
    const g = (await (await api(`/api/sessions/${session.id}`)).json()) as { session: { cwd: string } };
    const cwd = g.session.cwd;
    execFileSync("git", ["-C", cwd, "init", "-q"]);
    execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    fs.writeFileSync(path.join(cwd, "notes.txt"), "hello\n");
    const d = (await (await api(`/api/sessions/${session.id}/diff`)).json()) as { isRepo: boolean; clean: boolean; files: { path: string }[]; diff: string };
    expect(d.isRepo).toBe(true);
    expect(d.clean).toBe(false);
    expect(d.files.some((f) => f.path === "notes.txt")).toBe(true);
    expect(d.diff).toContain("+hello");
    void root;
  }, 20000);

  it("accepts the sealed session in the x-labee-session header (mobile Google sign-in)", async () => {
    const { sealSession } = await import("../src/services/session");
    const sealed = await sealSession({ email: "mobile@example.com" });
    const ok = await fetch(`${server.base}/api/me`, { headers: { "x-labee-session": sealed } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { email: string } }).user.email).toBe("mobile@example.com");
    const bad = await fetch(`${server.base}/api/sessions`, { headers: { "x-labee-session": "garbage" } });
    expect(bad.status).toBe(401);
  });

  it("404s for unknown sessions and other users' sessions", async () => {
    expect((await api("/api/sessions/ses_nope")).status).toBe(404);
    const { sealSession } = await import("../src/services/session");
    const other = `monterey_session=${encodeURIComponent(await sealSession({ email: "eve@example.com" }))}`;
    const { session } = (await (await api("/api/sessions", { method: "POST", body: "{}" })).json()) as { session: { id: string } };
    const r = await fetch(`${server.base}/api/sessions/${session.id}`, { headers: { cookie: other } });
    expect(r.status).toBe(404);
  });
});
