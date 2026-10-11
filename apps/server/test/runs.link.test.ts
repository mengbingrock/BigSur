// A run whose session lives on a Mac (design §2.2): the box owns the run,
// asks the Mac to parse the protocol and make the session, pushes every
// event down the Device Link, and the Mac's transcript shows the lines. A
// phone talks to the box only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "bench@example.com";
let box: TestServer;
let desktop: TestServer;
let cookie: string;
let droot: string;
let desktopEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  applyTestEnv("runs-link-box");
  const { sealSession } = await import("../src/services/session");
  const sealed = await sealSession({ email: EMAIL });
  cookie = `monterey_session=${encodeURIComponent(sealed)}`;
  const shared = {
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_ANTHROPIC_API_KEY: "test-placeholder-never-sent",
  };
  box = await startServer({
    ...shared,
    LABEE_LINK_PING_MS: "700",
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
  });
  droot = fs.mkdtempSync(path.join(os.tmpdir(), "labee-runs-desktop-"));
  const sessionFile = path.join(droot, "remote-session.txt");
  fs.writeFileSync(sessionFile, encodeURIComponent(sealed));
  desktopEnv = {
    ...shared,
    LABEE_MODE: "desktop",
    LABEE_DATA_DIR: path.join(droot, "data"),
    DECK_ROOT: path.join(droot, "decks"),
    SKILLS_ROOTS: path.join(droot, "skills"),
    LABEE_SKILLS_SERVER: box.base,
    LABEE_REMOTE_SESSION_FILE: sessionFile,
    // The Mac has the starter protocols; the box has none.
    LABEE_SEED_PROTOCOLS: "true",
  };
  desktop = await startServer(desktopEnv);
}, 60000);

afterAll(() => {
  box?.stop();
  desktop?.stop();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${box.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-labee-device": "iPhone", ...(init.headers ?? {}) } });
const post = (p: string, body: unknown = {}) => api(p, { method: "POST", body: JSON.stringify(body) });

interface Msg {
  role: string;
  content: string;
}

describe("a run for a session held on a Mac", () => {
  let hostId: string;
  let runId: string;
  let sessionId: string;

  it("the Mac is online", async () => {
    await waitFor(async () => {
      const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
      return r.hosts.some((h) => h.online);
    }, 20000);
    const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
    hostId = r.hosts.find((h) => h.online)!.hostId;
    // Seed the Mac's protocols by scanning them once.
    expect((await api(`/api/hosts/${hostId}/api/skills`)).status).toBe(200);
  }, 30000);

  it("starting a run asks the Mac to parse and makes the session there", async () => {
    const res = await post("/api/runs", { protocolSlug: "user--chemically-competent-cells-tss", hostId });
    expect(res.status, await res.clone().text()).toBe(201);
    const p = (await res.json()) as { run: { id: string; sessionId: string; hostId: string; snapshot: { steps: unknown[] } } };
    runId = p.run.id;
    sessionId = p.run.sessionId;
    expect(p.run.hostId).toBe(hostId);
    expect(p.run.snapshot.steps).toHaveLength(9);
    // The session exists on the Mac, titled after the protocol, with the line.
    await waitFor(async () => {
      const s = (await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).json()) as { messages: Msg[] };
      return s.messages.some((m) => m.content.startsWith("▶ Run started"));
    }, 10000);
    const s = (await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).json()) as { session: { title: string; run: { current: number } | null }; messages: Msg[] };
    expect(s.session.title).toBe("Chemically competent cells (TSS)");
    expect(s.session.run).toMatchObject({ current: 1 });
  }, 30000);

  it("a step done on the phone shows up in the Mac's transcript, and the box lists the badge", async () => {
    expect((await post(`/api/runs/${runId}/advance`)).status).toBe(200);
    await waitFor(async () => {
      const s = (await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).json()) as { messages: Msg[] };
      return s.messages.some((m) => m.content.startsWith("✓ Step 1 done"));
    }, 10000);
    const everywhere = (await (await api("/api/link/sessions")).json()) as { sessions: { id: string; run: { current: number; total: number } | null }[] };
    expect(everywhere.sessions.find((s) => s.id === sessionId)?.run).toMatchObject({ current: 2, total: 9 });
  }, 30000);

  it("a Mac that was asleep gets the events it missed, in order", async () => {
    desktop.stop();
    await waitFor(async () => {
      const r = (await (await api("/api/link/hosts")).json()) as { hosts: { hostId: string; online: boolean }[] };
      return !r.hosts.find((h) => h.hostId === hostId)?.online;
    }, 20000);
    // The bench carries on without the Mac.
    expect((await post(`/api/runs/${runId}/advance`)).status).toBe(200);
    expect((await post(`/api/runs/${runId}/note`, { text: "OD was 0.35" })).status).toBe(200);
    const asleep = (await (await api(`/api/runs/${runId}`)).json()) as { run: { current: number } };
    expect(asleep.run.current).toBe(3);

    desktop = await startServer(desktopEnv);
    await waitFor(async () => {
      const s = (await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).json()).messages as Msg[] | undefined;
      return Boolean(s?.some((m) => m.content.startsWith("📝 Step 3: OD was 0.35")));
    }, 30000).catch(async () => {
      const s = await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).text();
      const ev = await (await api(`/api/runs/${runId}`)).text();
      throw new Error(
        `no replay.\nsession: ${s.slice(0, 300)}\nevents: ${ev.slice(-900)}\nbox: ${box.logs.filter((l) => /\[link\]|\[runs\]|run event|replay/i.test(l)).slice(-10).join("")}\ndesktop: ${desktop.logs.filter((l) => /\[link\]|\[runs\]|run event|parse/i.test(l)).slice(-10).join("")}`,
      );
    });
    const s = (await (await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`)).json()) as { messages: Msg[] };
    const lines = s.messages.filter((m) => m.role === "system").map((m) => m.content.split(" · ")[0]);
    expect(lines).toEqual(["▶ Run started: Chemically competent cells (TSS) — 9 steps, 2 timed", "✓ Step 1 done", "✓ Step 2 done", "📝 Step 3: OD was 0.35 ⟨iPhone⟩"]);
  }, 60000);

  it("the Siri router on the Mac resumes the run for its protocol", async () => {
    const r = (await (await post(`/api/hosts/${hostId}/api/siri/route`, { text: "", kind: "start", protocolSlug: "user--chemically-competent-cells-tss" })).json()) as { action: string; runId?: string; sessionId: string | null };
    expect(r.action).toBe("resume");
    expect(r.runId).toBe(runId);
    expect(r.sessionId).toBe(sessionId);
  }, 30000);

  it("deleting the run's chat from the phone ends the run, so it leaves In progress", async () => {
    expect((await api(`/api/hosts/${hostId}/api/sessions/${sessionId}`, { method: "DELETE" })).status).toBe(200);
    await waitFor(async () => {
      const r = (await (await api(`/api/runs/${runId}`)).json()) as { run: { status: string } };
      return r.run.status === "abandoned";
    }, 10000);
    const list = (await (await api("/api/runs")).json()) as { runs: { id: string; status: string }[] };
    expect(list.runs.find((r) => r.id === runId)?.status).toBe("abandoned");
    // One "abandoned" event, although the box heard of the delete twice.
    const r = (await (await api(`/api/runs/${runId}`)).json()) as { events: { type: string }[] };
    expect(r.events.filter((e) => e.type === "abandoned")).toHaveLength(1);
  }, 30000);
});
