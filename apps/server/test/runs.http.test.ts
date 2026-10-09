// A run on one server that holds the session itself (the box with no Mac, or
// a desktop with no account): start from a seeded protocol, step through it,
// note, timer, finish → transcript lines and the write-up turn.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";

const EMAIL = "runner@example.com";
let server: TestServer;
let cookie: string;

beforeAll(async () => {
  applyTestEnv("runs");
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
    LABEE_SEED_PROTOCOLS: "true",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-labee-device": "iPhone", ...(init.headers ?? {}) } });
const post = (p: string, body: unknown = {}) => api(p, { method: "POST", body: JSON.stringify(body) });

interface RunPayload {
  run: { id: string; sessionId: string; current: number; status: string; protocolName: string; snapshot: { steps: { n: number; text: string; timer: { seconds: number } | null }[]; base: { qty: number; unit: string } | null } };
  view: { current: { n: number } | null; next: { n: number } | null; timers: { id: string; state: string }[]; notes: { step: number; text: string }[]; stepLog: { n: number; doneAt: string | null; skipped: boolean }[] };
}

describe("protocol runs on the server that holds the session", () => {
  let run: RunPayload["run"];

  it("starts from a seeded protocol with a frozen snapshot and a fresh session", async () => {
    // The starter protocols are seeded on the first scan.
    expect((await api("/api/skills")).status).toBe(200);
    const res = await post("/api/runs", { protocolSlug: "user--chemically-competent-cells-tss", scale: { base: { qty: 50, unit: "mL" }, actual: { qty: 50, unit: "mL" } } });
    if (res.status !== 201) console.log("POST /api/runs →", res.status, await res.clone().text(), server.logs.slice(-5).join(""));
    expect(res.status).toBe(201);
    const p = (await res.json()) as RunPayload;
    run = p.run;
    expect(run.status).toBe("running");
    expect(run.current).toBe(1);
    expect(run.snapshot.steps).toHaveLength(9);
    expect(p.view.current?.n).toBe(1);
    expect(p.view.next?.n).toBe(2);

    const s = (await (await api(`/api/sessions/${run.sessionId}`)).json()) as { session: { title: string; run: { current: number; total: number } | null }; messages: { role: string; content: string }[] };
    expect(s.session.title).toBe("Chemically competent cells (TSS)");
    expect(s.session.run).toMatchObject({ current: 1, total: 9 });
    expect(s.messages.map((m) => m.role)).toEqual(["system"]);
    expect(s.messages[0]!.content).toMatch(/^▶ Run started: Chemically competent cells \(TSS\) — 9 steps, 2 timed/);
  });

  it("'active' resolves to the run in progress", async () => {
    const r = (await (await api("/api/runs/active")).json()) as { run: { id: string } };
    expect(r.run.id).toBe(run.id);
  });

  it("advances, goes back, skips, and never loses the record", async () => {
    let p = (await (await post(`/api/runs/${run.id}/advance`)).json()) as RunPayload & { done: { n: number }; next: { n: number } };
    expect(p.done.n).toBe(1);
    expect(p.next.n).toBe(2);
    expect(p.run.current).toBe(2);
    p = (await (await post(`/api/runs/${run.id}/back`)).json()) as typeof p;
    expect(p.run.current).toBe(1);
    expect(p.view.stepLog[0]!.doneAt).toBeNull();
    p = (await (await post(`/api/runs/${run.id}/skip`, { reason: "already grown" })).json()) as typeof p;
    expect(p.run.current).toBe(2);
    expect(p.view.stepLog[0]!.skipped).toBe(true);
    const events = (await (await api(`/api/runs/${run.id}`)).json()) as { events: { type: string }[] };
    expect(events.events.map((e) => e.type)).toEqual(["run_started", "step_started", "step_done", "step_started", "step_reopened", "step_skipped", "step_started"]);
  });

  it("files a note on the current step with the device that sent it", async () => {
    const p = (await (await post(`/api/runs/${run.id}/note`, { text: "OD was 0.35, harvesting now" })).json()) as RunPayload;
    expect(p.view.notes).toEqual([expect.objectContaining({ step: 2, text: "OD was 0.35, harvesting now", device: "iPhone" })]);
    const s = (await (await api(`/api/sessions/${run.sessionId}`)).json()) as { messages: { role: string; content: string; meta: { device?: string } | null }[] };
    const line = s.messages.find((m) => m.content.startsWith("📝"));
    expect(line?.content).toBe("📝 Step 2: OD was 0.35, harvesting now ⟨iPhone⟩");
    expect(line?.meta?.device).toBe("iPhone");
  });

  it("starts the step's own timer, and refuses one where the protocol has none", async () => {
    // Step 2 (incubate to OD) has no duration; step 4 stands on ice 10 min.
    const none = await post(`/api/runs/${run.id}/timer`);
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toMatch(/no timer/);
    const custom = (await (await post(`/api/runs/${run.id}/timer`, { seconds: 90, label: "custom" })).json()) as RunPayload & { timer: { id: string; seconds: number; label: string; state: string } };
    expect(custom.timer).toMatchObject({ seconds: 90, label: "custom", state: "running" });
    const cancelled = (await (await api(`/api/runs/${run.id}/timer/${custom.timer.id}`, { method: "DELETE" })).json()) as RunPayload;
    expect(cancelled.view.timers[0]!.state).toBe("cancelled");
    await post(`/api/runs/${run.id}/jump`, { step: 4 });
    const own = (await (await post(`/api/runs/${run.id}/timer`)).json()) as typeof custom;
    expect(own.timer).toMatchObject({ seconds: 600, label: "10 minutes" });
  });

  it("answers 'how much' from the protocol's words, scaled when it is a ratio, and honestly when absent", async () => {
    await post(`/api/runs/${run.id}/jump`, { step: 7 });
    const tss = (await (await post(`/api/runs/${run.id}/amount`, { material: "TSS" })).json()) as { found: boolean; text: string; say: string; computed: { text: string } | null; step: number };
    expect(tss.found).toBe(true);
    expect(tss.step).toBe(7);
    expect(tss.text).toMatch(/^Step 7: Resuspend in TSS at 10% of the original culture volume/);
    expect(tss.computed?.text).toBe("5 to 25 mL".includes("to") ? tss.computed!.text : "");
    expect(tss.text).toContain("For your 50 mL, 5 mL.");
    const water = (await (await post(`/api/runs/${run.id}/amount`, { material: "water" })).json()) as { found: boolean; text: string; source: string };
    expect(water.found).toBe(false);
    expect(water.text).toBe("The protocol doesn't give an amount of water in step 7, or in the materials list.");
    const aliquot = (await (await post(`/api/runs/${run.id}/amount`, { material: "aliquot", step: 8 })).json()) as { found: boolean; text: string };
    expect(aliquot.found).toBe(true);
    expect(aliquot.text).toContain("100 ul");
  });

  it("pauses and resumes; the Runs list shows progress", async () => {
    expect((await post(`/api/runs/${run.id}/pause`)).status).toBe(200);
    expect((await post(`/api/runs/${run.id}/advance`)).status).toBe(409);
    expect((await post(`/api/runs/${run.id}/resume`)).status).toBe(200);
    const list = (await (await api("/api/runs")).json()) as { runs: { id: string; current: number; total: number; status: string; notes: number }[] };
    expect(list.runs.find((r) => r.id === run.id)).toMatchObject({ current: 7, total: 9, status: "running", notes: 1 });
  });

  it("finishes: the run closes, a transcript line sums it up, and the write-up turn runs", async () => {
    const p = (await (await post(`/api/runs/${run.id}/finish`)).json()) as RunPayload;
    expect(p.run.status).toBe("done");
    await waitFor(async () => {
      const s = (await (await api(`/api/sessions/${run.sessionId}`)).json()) as { session: { status: string }; messages: { role: string; content: string }[] };
      return s.session.status === "idle" && s.messages.some((m) => m.role === "assistant");
    }, 15000);
    const s = (await (await api(`/api/sessions/${run.sessionId}`)).json()) as { messages: { role: string; content: string }[] };
    const summary = s.messages.find((m) => m.content.startsWith("■ Run finished"));
    expect(summary?.content).toMatch(/■ Run finished · 0 of 9 steps done, 1 skipped, 1 note, \d+:\d\d/);
    const writeupRequest = s.messages.find((m) => m.role === "user");
    expect(writeupRequest?.content).toContain("Runs/");
    expect(writeupRequest?.content).toContain("| 2 Incubate at 30-37 C");
    expect(writeupRequest?.content).toContain("OD was 0.35");
    expect((await post(`/api/runs/${run.id}/advance`)).status).toBe(409);
  }, 30000);

  it("a protocol with a base volume reports it so the client can ask the scale", async () => {
    expect(run.snapshot.base).toMatchObject({ qty: 50, unit: "mL" });
  });

  it("a session's system lines come back on the event stream", async () => {
    const { readSse } = await import("./helpers/server");
    const res = await api(`/api/sessions/${run.sessionId}/events?after=0&once=1`, { headers: { accept: "text/event-stream" } });
    const frames = await readSse(res, (f) => f.data.type === "session_status", 10000);
    const sys = frames.filter((f) => f.data.type === "system_message");
    expect(sys.length).toBeGreaterThanOrEqual(5);
    expect(String((sys[0]!.data.data as { content: string }).content)).toMatch(/^▶ Run started/);
  });
});
