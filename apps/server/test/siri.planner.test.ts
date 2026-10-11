// The Siri agent as a planner (siri-agent design §3, §6): the model's plan
// is validated against the state, confirmed when risky, executed through
// the run and chat services, and spoken back. The fake claude returns the
// plan given in the phrase's [[reply:…]] marker.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";
import { needsConfirmation, validatePlan, type Plan, type SiriState } from "../src/services/siri/planner";

const EMAIL = "planner@example.com";
let server: TestServer;
let cookie: string;

beforeAll(async () => {
  applyTestEnv("siri-planner");
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
    // The fake model speaks one-shot only; the warm process is a real-CLI thing.
    LABEE_SIRI_WARM: "0",
  });
}, 30000);

afterAll(() => server?.stop());

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${server.base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-labee-device": "Siri", ...(init.headers ?? {}) } });
const post = (p: string, body: unknown = {}) => api(p, { method: "POST", body: JSON.stringify(body) });
/** A phrase that makes the fake model answer with this plan. */
const say = (text: string, plan: unknown) => post("/api/siri/say", { text: `${text} [[reply:${JSON.stringify(plan)}]]` });

interface Say {
  status: "answered" | "working" | "confirm";
  spoken: string;
  confirmId?: string;
  siriTurnId: string;
  actions: { action: { do: string }; ok: boolean; result?: string; error?: string; delegated?: { sessionId: string; title: string } }[];
  via: string;
}

const fixture: SiriState = {
  now: "2026-10-10T12:00:00Z",
  runs: [{ id: "run_a", protocol: "TSS", status: "running", step: 4, of: 9, stepText: "Spin", amounts: null, timer: null, notes: 0, sessionId: "ses_a" }],
  chats: [{ id: "ses_a", title: "TSS", status: "idle", lastUser: "", lastAssistant: "", waitingOn: null, updatedAt: "" }],
  protocols: [{ slug: "user--tss", name: "TSS" }],
  unread: [],
};

describe("plan validation and confirmation (pure)", () => {
  it("rejects actions and ids the state does not hold", () => {
    expect(validatePlan({ say: "ok", actions: [{ do: "runs.pause", runId: "run_zzz" }], need: null, confirm: null }, fixture)?.reason).toMatch(/unknown run/);
    expect(validatePlan({ say: "ok", actions: [{ do: "runs.delete" as never, runId: "run_a" }], need: null, confirm: null }, fixture)?.reason).toMatch(/unknown action/);
    expect(validatePlan({ say: "ok", actions: [{ do: "chats.send", sessionId: "ses_x", text: "hi" }], need: null, confirm: null }, fixture)?.reason).toMatch(/unknown chat/);
    expect(validatePlan({ say: "ok", actions: [{ do: "runs.note", runId: "run_a", text: " " }], need: null, confirm: null }, fixture)?.reason).toMatch(/without text/);
    expect(validatePlan({ say: "ok", actions: [{ do: "runs.pause", runId: "run_a" }], need: null, confirm: null }, fixture)).toBeNull();
  });
  it("finishing, starting a second run, and several writes need a yes; reads and one write do not", () => {
    const one = (actions: Plan["actions"]): Plan => ({ say: "ok", actions, need: null, confirm: null });
    expect(needsConfirmation(one([{ do: "runs.finish", runId: "run_a" }]), fixture)).toMatch(/Finish the TSS run\?/);
    expect(needsConfirmation(one([{ do: "runs.start", protocolSlug: "user--tss" }]), fixture)).toMatch(/already going/);
    expect(needsConfirmation(one([{ do: "runs.pause", runId: "run_a" }, { do: "chats.stop", sessionId: "ses_a" }]), fixture)).toMatch(/Pause TSS, and Stop "TSS"\?/);
    expect(needsConfirmation(one([{ do: "runs.pause", runId: "run_a" }]), fixture)).toBeNull();
    expect(needsConfirmation(one([{ do: "runs.amount", runId: "run_a", material: "TSS" }, { do: "ask.quick", q: "x" }]), fixture)).toBeNull();
  });
});

describe("the Siri agent over HTTP", () => {
  let runId: string;

  it("answers a run question from the executor's result, with no chat turn", async () => {
    expect((await api("/api/skills")).status).toBe(200);
    const created = (await (await post("/api/runs", { protocolSlug: "user--chemically-competent-cells-tss", scale: { base: { qty: 50, unit: "mL" }, actual: { qty: 100, unit: "mL" } } })).json()) as { run: { id: string } };
    runId = created.run.id;
    const r = (await (await say("how much LB", { say: "Here it is.", actions: [{ do: "runs.amount", runId, material: "LB" }], need: null, confirm: null })).json()) as Say;
    expect(r.status).toBe("answered");
    expect(r.via).toBe("plan");
    expect(r.actions[0]?.ok).toBe(true);
    expect(r.spoken.toLowerCase()).toMatch(/lb|millilit/);
    expect(r.spoken).not.toContain("Here it is.");
  }, 30000);

  it("asks before finishing a run, and does it on yes", async () => {
    const r = (await (await say("finish the run", { say: "Finishing.", actions: [{ do: "runs.finish", runId }], need: null, confirm: null })).json()) as Say;
    expect(r.status).toBe("confirm");
    expect(r.spoken).toMatch(/Finish the .* run\?/);
    expect(r.confirmId).toMatch(/^confirm_/);
    // The run is untouched until the yes.
    expect(((await (await api(`/api/runs/${runId}`)).json()) as { run: { status: string } }).run.status).toBe("running");
    const yes = (await (await post("/api/siri/say", { confirmId: r.confirmId, yes: true })).json()) as Say;
    expect(yes.status).toBe("answered");
    // After a yes, what was done is said, not the plan's own sentence.
    expect(yes.spoken).toMatch(/^Finished the .* run\./);
    expect(((await (await api(`/api/runs/${runId}`)).json()) as { run: { status: string } }).run.status).toBe("done");
  }, 30000);

  it("a confirm with no actions is not a confirm: the sentence is spoken, nothing waits", async () => {
    const r = (await (await say("finish the first step", { say: "Should I mark step one done?", actions: [], need: null, confirm: "Mark step one done?" })).json()) as Say;
    expect(r.status).toBe("answered");
    expect(r.confirmId).toBeUndefined();
  }, 30000);

  it("a step done says the step and the next one, and a yes afterwards is understood from the conversation", async () => {
    const created = (await (await post("/api/runs", { protocolSlug: "user--chemically-competent-cells-tss" })).json()) as { run: { id: string } };
    const r = (await (await say("finish the first step", { say: "Marking it done?", actions: [{ do: "runs.advance", runId: created.run.id }], need: null, confirm: null })).json()) as Say;
    expect(r.status).toBe("answered");
    // The plan's sentence was a question, so the executor's sentence is used.
    expect(r.spoken).toMatch(/^Step 1 done\. Next, step 2: /);
  }, 30000);

  it("a pending confirmation is answered by a plain yes or no, with no model call and no id", async () => {
    const created = (await (await post("/api/runs", { protocolSlug: "user--chemically-competent-cells-tss" })).json()) as { run: { id: string } };
    const ask = (await (await say("finish this run", { say: "Finishing.", actions: [{ do: "runs.finish", runId: created.run.id }], need: null, confirm: null })).json()) as Say;
    expect(ask.status).toBe("confirm");
    // "No" leaves it; the exchange is settled and a later yes refers to nothing.
    const no = (await (await post("/api/siri/say", { text: "No, leave it." })).json()) as Say;
    expect(no).toMatchObject({ status: "answered", spoken: "Okay, leaving it." });
    expect(((await (await api(`/api/runs/${created.run.id}`)).json()) as { run: { status: string } }).run.status).toBe("running");
    // Ask again, then a plain "yes please" does it.
    const ask2 = (await (await say("finish this run", { say: "Finishing.", actions: [{ do: "runs.finish", runId: created.run.id }], need: null, confirm: null })).json()) as Say;
    expect(ask2.status).toBe("confirm");
    const yes = (await (await post("/api/siri/say", { text: "Yes please" })).json()) as Say;
    expect(yes.status).toBe("answered");
    expect(yes.spoken).toMatch(/^Finished the .* run\./);
    expect(((await (await api(`/api/runs/${created.run.id}`)).json()) as { run: { status: string } }).run.status).toBe("done");
  }, 40000);

  it("no usable plan means saying so: never a guess, never a chat, whatever the length of the phrase", async () => {
    const rejected = (await (await say("pause the thing", { say: "Paused.", actions: [{ do: "runs.pause", runId: "run_nope" }], need: null, confirm: null })).json()) as Say;
    expect(rejected).toMatchObject({ status: "answered", spoken: "I couldn't do that. Say it again?", via: "failed" });
    const before = ((await (await api("/api/sessions")).json()) as { sessions: unknown[] }).sessions.length;
    const short = (await (await post("/api/siri/say", { text: "Yes, please. [[reply:garbage]]" })).json()) as Say;
    expect(short).toMatchObject({ status: "answered", spoken: "Something went wrong on my side. Say it again?", actions: [] });
    const long = (await (await post("/api/siri/say", { text: "compare the two transfection protocols for me please [[reply:garbage]]" })).json()) as Say;
    expect(long).toMatchObject({ status: "answered", spoken: "Something went wrong on my side. Say it again?" });
    expect(((await (await api("/api/sessions")).json()) as { sessions: unknown[] }).sessions.length).toBe(before);
  }, 40000);

  it("delegates to a new chat and reports it; the chat's turn carries the Siri origin", async () => {
    const r = (await (await say("compare the transfection protocols", { say: "Started 'compare transfections'. I'll tell you when it answers.", actions: [{ do: "chats.new", title: "compare transfections", text: "Compare the PEI and lipofection protocols." }], need: null, confirm: null })).json()) as Say;
    expect(r.status).toBe("working");
    const d = r.actions[0]?.delegated;
    expect(d?.title).toBe("compare transfections");
    const s = (await (await api(`/api/sessions/${d!.sessionId}`)).json()) as { messages: { role: string; content: string }[] };
    expect(s.messages[0]).toMatchObject({ role: "user", content: "Compare the PEI and lipofection protocols." });
  }, 30000);

  it("says it didn't catch garbled dictation and does nothing", async () => {
    const r = (await (await say("the first passcode is running out", { say: "I didn't catch that. Say it again?", actions: [], need: null, confirm: null })).json()) as Say;
    expect(r).toMatchObject({ status: "answered", spoken: "I didn't catch that. Say it again?", actions: [] });
  }, 30000);

  it("the Siri session reads as a conversation", async () => {
    const route = (await (await post("/api/siri/route", { text: "x", kind: "answer" })).json()) as { siriSessionId: string };
    const s = (await (await api(`/api/sessions/${route.siriSessionId}`)).json()) as { messages: { role: string; content: string; meta: Record<string, unknown> | null }[] };
    const roles = s.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const confirm = s.messages.find((m) => m.meta?.kind === "confirm");
    expect(confirm?.content).toMatch(/Finish the .* run\?/);
  }, 30000);
});
