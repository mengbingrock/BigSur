// The Siri agent as a planner (docs/siri-agent-design.md §3). One fast
// model call over the account's state returns a sentence to speak and a
// closed list of actions; this module validates the plan and carries it
// out through the service functions the routes already use. No agent
// loop, no tools handed to a model: the limits live in the executor.
//
// Runs are box-owned. On a Mac the run actions go to the box over HTTP (as
// the run routes do); on the box they are local. Chats are always local:
// the Siri session and the chats it reaches live on the same server.
import { normalizeQuestions } from "@labee/session-core";
import { completeText } from "../complete";
import { auxModel } from "../llm";
import { boxSessionCookie, isDesktop, proxyServerBase } from "../llmSettings";
import * as rdb from "../runs/db";
import type { RunRow } from "../runs/db";
import { answerAmount } from "../runs/amount";
import * as runs from "../runs/service";
import { RunError, viewOf } from "../runs/service";
import * as sdb from "../sessions/db";
import type { SessionRow } from "../sessions/db";
import * as runner from "../sessions/runner";
import { mapSpokenAnswer } from "../sessions/answerMap";
import { getAllSkills } from "../skills";
import { quickAnswer } from "./quick";
import { ensureSiriSession } from "./router";
import { unreadReturns } from "./delivery";

// --- state ----------------------------------------------------------------------

export interface StateRun {
  id: string;
  protocol: string;
  status: string;
  step: number;
  of: number;
  stepText: string | null;
  amounts: string | null;
  timer: string | null;
  notes: number;
  sessionId: string;
}

export interface StateChat {
  id: string;
  title: string;
  status: string;
  lastUser: string;
  lastAssistant: string;
  waitingOn: { question: string; options: string[] } | null;
  updatedAt: string;
}

export interface SiriState {
  now: string;
  runs: StateRun[];
  chats: StateChat[];
  protocols: Array<{ slug: string; name: string }>;
  unread: Array<{ title: string; spoken: string }>;
  /** The last few exchanges in the Siri chat, so "yes", "the first one" and
   *  "do that" mean something. Oldest first. */
  recent: Array<{ who: "person" | "labee"; said: string; did?: string[] }>;
}

const CHATS = 10;
const PROTOCOLS = 40;

function boxed(): boolean {
  return isDesktop() && Boolean(boxSessionCookie());
}

/** Call the box's run API from a Mac, as the phone would. */
async function boxCall<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const cookie = boxSessionCookie();
  if (!cookie) throw new RunError(409, "Connect to Labee first.");
  const res = await fetch(`${proxyServerBase()}${path}`, {
    method,
    headers: { cookie, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) throw new RunError(res.status, String((parsed as { error?: string }).error ?? `labee.online answered ${res.status}.`));
  return parsed as T;
}

interface RunPayload {
  run: RunRow;
  view: { current: { n: number; text: string; amounts: Array<{ qty: string; unit: string; of: string | null }>; timer: { seconds: number; label: string } | null } | null; timers: Array<{ state: string; endsAt: string; label: string }>; notes: unknown[] };
}

function stateRun(p: RunPayload): StateRun {
  const t = p.view.timers.find((x) => x.state === "running");
  const left = t ? Math.max(0, Math.round((new Date(t.endsAt).getTime() - Date.now()) / 1000)) : null;
  const cur = p.view.current;
  return {
    id: p.run.id,
    protocol: p.run.protocolName,
    status: p.run.status,
    step: p.run.current,
    of: p.run.snapshot.steps.length,
    stepText: cur ? cur.text.split("\n")[0]!.slice(0, 160) : null,
    amounts: cur && cur.amounts.length ? cur.amounts.map((a) => `${a.qty} ${a.unit}${a.of ? ` ${a.of}` : ""}`).join(", ") : null,
    timer: t ? `${t.label}, ${left && left > 0 ? `${Math.ceil(left / 60)} min left` : "finished"}` : cur?.timer ? `step has a ${cur.timer.label} timer, not started` : null,
    notes: p.view.notes.length,
    sessionId: p.run.sessionId,
  };
}

async function openRuns(email: string): Promise<RunPayload[]> {
  if (boxed()) {
    const list = await boxCall<{ runs: Array<{ id: string; status: string }> }>("GET", "/api/runs");
    const open = list.runs.filter((r) => r.status === "running" || r.status === "paused").slice(0, 4);
    return Promise.all(open.map((r) => boxCall<RunPayload>("GET", `/api/runs/${encodeURIComponent(r.id)}`)));
  }
  const open = await rdb.listRuns(email, { status: ["running", "paused"], limit: 4 });
  return Promise.all(open.map(async (run) => ({ run, view: (await viewOf(run)) as unknown as RunPayload["view"] })));
}

function waitingOn(s: SessionRow): StateChat["waitingOn"] {
  const q = normalizeQuestions(s.pendingQuestion?.input)[0];
  return q ? { question: q.question, options: q.options.map((o) => o.label).slice(0, 4) } : null;
}

export async function gatherState(email: string): Promise<SiriState> {
  const siri = await ensureSiriSession(email);
  const [runPayloads, sessions, unread] = await Promise.all([
    openRuns(email).catch(() => [] as RunPayload[]),
    sdb.listSessions(email, { limit: CHATS + 1, kind: null }),
    unreadReturns(email, 5).catch(() => []),
  ]);
  const chats = await Promise.all(
    sessions
      .filter((s) => s.id !== siri.id)
      .slice(0, CHATS)
      .map(async (s) => {
        const msgs = await sdb.listMessages(s.id);
        const last = (role: "user" | "assistant") => [...msgs].reverse().find((m) => m.role === role)?.content.replace(/\s+/g, " ").slice(0, 140) ?? "";
        return { id: s.id, title: s.title, status: s.status, lastUser: last("user"), lastAssistant: last("assistant"), waitingOn: waitingOn(s), updatedAt: s.updatedAt };
      }),
  );
  const protocols = getAllSkills(email)
    .filter((k) => k.artifactKind === "protocol")
    .slice(0, PROTOCOLS)
    .map((k) => ({ slug: k.slug, name: k.name }));
  const recent = (await sdb.listMessages(siri.id))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-8)
    .map((m) => {
      const did = Array.isArray(m.meta?.actions) ? (m.meta!.actions as Array<{ do?: string; ok?: boolean }>).map((a) => `${a.do}${a.ok === false ? " (failed)" : ""}`) : [];
      return { who: m.role === "user" ? ("person" as const) : ("labee" as const), said: m.content.replace(/\s+/g, " ").slice(0, 200), ...(did.length ? { did } : {}) };
    });
  return { now: new Date().toISOString(), runs: runPayloads.map(stateRun), chats, protocols, unread: unread.map((u) => ({ title: u.title, spoken: u.spoken })), recent };
}

// --- the plan -------------------------------------------------------------------

export type Action =
  | { do: "runs.advance" | "runs.back" | "runs.pause" | "runs.resume" | "runs.finish"; runId: string }
  | { do: "runs.skip"; runId: string; reason?: string }
  | { do: "runs.note"; runId: string; text: string }
  | { do: "runs.timer"; runId: string; seconds?: number }
  | { do: "runs.amount"; runId: string; material: string }
  | { do: "runs.start"; protocolSlug: string }
  | { do: "chats.send"; sessionId: string; text: string }
  | { do: "chats.new"; title: string; text: string }
  | { do: "chats.answer"; sessionId: string; spoken: string }
  | { do: "chats.stop"; sessionId: string }
  | { do: "ask.quick"; q: string };

export interface Plan {
  say: string;
  actions: Action[];
  need: { do: "chats.read"; sessionId: string; last?: number } | null;
  confirm: string | null;
}

const ACTIONS = new Set<Action["do"]>([
  "runs.advance", "runs.back", "runs.pause", "runs.resume", "runs.finish", "runs.skip", "runs.note", "runs.timer", "runs.amount", "runs.start",
  "chats.send", "chats.new", "chats.answer", "chats.stop", "ask.quick",
]);
const WRITES = new Set<Action["do"]>(["runs.advance", "runs.back", "runs.pause", "runs.resume", "runs.finish", "runs.skip", "runs.note", "runs.timer", "runs.start", "chats.send", "chats.new", "chats.answer", "chats.stop"]);
/** Actions that need a yes first, whatever the model wrote (design §6). */
const CONFIRMED = new Set<Action["do"]>(["runs.finish"]);

export const SYSTEM_PROMPT = `You are Labee's Siri agent: the voice of a lab assistant app, answering a scientist who spoke to Siri, often with gloves on and the phone locked. You get the current state (runs in progress, recent chats, the person's protocols, unread returns) and what they said. Reply with JSON only.

{"say": "<one or two short spoken sentences>", "actions": [<actions>], "need": null | {"do":"chats.read","sessionId":"<id>","last":6}, "confirm": null | "<question to ask before acting>"}

Actions (ids must come from the state):
- {"do":"runs.advance"|"runs.back"|"runs.pause"|"runs.resume"|"runs.finish", "runId":"…"}
- {"do":"runs.skip","runId":"…","reason":"…"}  {"do":"runs.note","runId":"…","text":"…"}
- {"do":"runs.timer","runId":"…","seconds":600}  (omit seconds to use the step's own timer)
- {"do":"runs.amount","runId":"…","material":"TSS"}  (the server answers; your say may say "here it is")
- {"do":"runs.start","protocolSlug":"…"}
- {"do":"chats.send","sessionId":"…","text":"…"}  {"do":"chats.new","title":"…","text":"…"}
- {"do":"chats.answer","sessionId":"…","spoken":"…"}  {"do":"chats.stop","sessionId":"…"}
- {"do":"ask.quick","q":"…"}  (a pure protocol question: the server answers from the protocols)

Rules:
- Act, don't retrieve: a command about a run is a run action; a question beyond the protocols is a chat (chats.new or chats.send), and your say names it: "Started 'compare transfections'. I'll tell you when it answers."
- Continue an existing chat when the message clearly belongs to it; start a new one when it is a new topic. Never put a message in a chat about something else.
- A pure fact from the person's protocols ("how long is the spin", "what temperature") is ask.quick. An amount for the run in progress is runs.amount.
- Decline what Labee cannot do (messaging people, calendars, the web): say so in one sentence and take no action.
- If you did not understand (garbled dictation), say "I didn't catch that. Say it again?" with no actions. Silence beats a guess.
- Questions about the runs in progress ("what's running", "which step", "how long left") are answered from the state, in "say", with no action and never a chat.
- "confirm" is a short question to ask BEFORE acting, and it always goes together with the "actions" you would then take; a confirm with no actions does nothing. Use it when you would finish a run, start a run of a protocol already in progress, or make more than one write at once. Otherwise null. Marking one step done needs no confirm.
- "recent" is the conversation so far. A short reply ("yes", "the first one", "do that") answers the last thing Labee said: if Labee asked whether to do something and the person agrees, now do it, with no confirm. If nothing was pending, say so in a few words.
- "say" is what to say after the actions have run, never a question about whether to run them (that is what "confirm" is for). No markdown, no lists, units in full, names of chats in quotes. Lead with the answer.
- Use "need" only when the answer depends on a chat's recent content you were not given. At most once.`;

// On a Mac the completion goes through the Claude CLI, which takes 2–5 s to
// start before the model answers; 6 s timed out on every phrase on the first
// device day. The route's own ceiling is 15 s.
const PLAN_MS = Number(process.env.LABEE_SIRI_PLAN_MS ?? 12000);

export async function planWith(email: string, text: string, state: SiriState, extra?: Record<string, unknown>): Promise<Plan | null> {
  // The phrase first: it is what the model must answer, and anything quoted
  // in the state (a chat's last line) is context, not instruction.
  const user = JSON.stringify({ said: text, state, ...(extra ? { more: extra } : {}) });
  let raw: string;
  try {
    raw = await Promise.race([
      completeText({ email, system: SYSTEM_PROMPT, user, effort: "low", timeoutMs: PLAN_MS, anthropicModel: process.env.LABEE_SIRI_MODEL || "haiku", openaiModel: auxModel("openai") }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("planner timeout")), PLAN_MS)),
    ]);
  } catch {
    return null;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return normalise(JSON.parse(m[0]) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function normalise(j: Record<string, unknown>): Plan | null {
  const say = typeof j.say === "string" ? j.say.replace(/\s+/g, " ").trim() : "";
  if (!say) return null;
  const actions = Array.isArray(j.actions) ? (j.actions as Action[]) : [];
  const need = j.need && typeof j.need === "object" && (j.need as { do?: string }).do === "chats.read" ? (j.need as Plan["need"]) : null;
  // A confirm with nothing to confirm would ask and then do nothing on yes
  // (the first device day): the question becomes the answer instead.
  const confirm = typeof j.confirm === "string" && j.confirm.trim() && actions.length > 0 ? j.confirm.trim() : null;
  return { say, actions, need, confirm };
}

export interface Rejection {
  reason: string;
}

/** The plan must name only what the state holds and only actions that exist. */
export function validatePlan(plan: Plan, state: SiriState): Rejection | null {
  const runIds = new Set(state.runs.map((r) => r.id));
  const chatIds = new Set(state.chats.map((c) => c.id));
  const slugs = new Set(state.protocols.map((p) => p.slug));
  if (plan.actions.length > 4) return { reason: "too many actions" };
  for (const a of plan.actions) {
    if (!a || typeof a !== "object" || !ACTIONS.has(a.do)) return { reason: `unknown action ${String((a as { do?: unknown })?.do)}` };
    if ("runId" in a && !runIds.has(a.runId)) return { reason: `unknown run ${a.runId}` };
    if ("sessionId" in a && !chatIds.has(a.sessionId)) return { reason: `unknown chat ${a.sessionId}` };
    if (a.do === "runs.start" && !slugs.has(a.protocolSlug)) return { reason: `unknown protocol ${a.protocolSlug}` };
    if ((a.do === "runs.note" || a.do === "chats.send" || a.do === "chats.new") && !String((a as { text?: unknown }).text ?? "").trim()) return { reason: `${a.do} without text` };
    if (a.do === "chats.answer" && !String(a.spoken ?? "").trim()) return { reason: "answer without text" };
    if (a.do === "runs.amount" && !String(a.material ?? "").trim()) return { reason: "amount without material" };
    if (a.do === "ask.quick" && !String(a.q ?? "").trim()) return { reason: "quick without question" };
    if (a.do === "runs.timer" && a.seconds !== undefined && !(Number.isFinite(a.seconds) && a.seconds > 0 && a.seconds <= 24 * 3600)) return { reason: "bad timer length" };
  }
  if (plan.need && !chatIds.has(plan.need.sessionId)) return { reason: `need names unknown chat ${plan.need.sessionId}` };
  return null;
}

/** Whether a yes is needed before this plan runs, and why (design §6). */
export function needsConfirmation(plan: Plan, state: SiriState): string | null {
  if (plan.confirm) return plan.confirm;
  const writes = plan.actions.filter((a) => WRITES.has(a.do));
  const open = new Set(state.runs.map((r) => r.protocol.toLowerCase()));
  for (const a of writes) {
    if (CONFIRMED.has(a.do)) return `${describe(a, state)}?`;
    if (a.do === "runs.start") {
      const name = state.protocols.find((p) => p.slug === a.protocolSlug)?.name ?? a.protocolSlug;
      if (open.has(name.toLowerCase())) return `A ${name} run is already going. Start another?`;
    }
  }
  if (writes.length > 1) return `${writes.map((a) => describe(a, state)).join(", and ")}?`;
  return null;
}

function describe(a: Action, state: SiriState): string {
  const run = (id: string) => state.runs.find((r) => r.id === id)?.protocol ?? "the run";
  const chat = (id: string) => `"${state.chats.find((c) => c.id === id)?.title ?? "the chat"}"`;
  switch (a.do) {
    case "runs.advance": return `Mark the ${run(a.runId)} step done`;
    case "runs.back": return `Go back a step in ${run(a.runId)}`;
    case "runs.skip": return `Skip the ${run(a.runId)} step`;
    case "runs.pause": return `Pause ${run(a.runId)}`;
    case "runs.resume": return `Resume ${run(a.runId)}`;
    case "runs.finish": return `Finish the ${run(a.runId)} run`;
    case "runs.note": return `Note on ${run(a.runId)}`;
    case "runs.timer": return `Start a timer on ${run(a.runId)}`;
    case "runs.amount": return `Look up ${a.material} for ${run(a.runId)}`;
    case "runs.start": return `Start ${state.protocols.find((p) => p.slug === a.protocolSlug)?.name ?? a.protocolSlug}`;
    case "chats.send": return `Send to ${chat(a.sessionId)}`;
    case "chats.new": return `Start "${a.title}"`;
    case "chats.answer": return `Answer ${chat(a.sessionId)}`;
    case "chats.stop": return `Stop ${chat(a.sessionId)}`;
    case "ask.quick": return "Look it up";
  }
}

// --- execution ------------------------------------------------------------------

export interface Executed {
  action: Action;
  ok: boolean;
  /** Something the server found out that the sentence should carry. */
  result?: string;
  /** What was done, in a sentence, for when the plan's own sentence will not
   *  do (it was a question, or the plan was confirmed first). */
  said?: string;
  error?: string;
  /** A chat turn was started: the return comes later. */
  delegated?: { sessionId: string; title: string };
}

interface StepLike {
  n: number;
  say: string;
}
interface ActPayload {
  run: { protocolName: string; current: number; status: string; snapshot: { steps: StepLike[] } };
  view: { current: StepLike | null; next: StepLike | null };
  done?: StepLike;
  next?: StepLike | null;
  timer?: { label: string };
}

/** What a run action did, for the ear. */
function saidFor(a: Extract<Action, { runId: string }>, p: ActPayload): string {
  const name = p.run.protocolName;
  const next = p.view.current;
  switch (a.do) {
    case "runs.advance": {
      const done = p.done ? `Step ${p.done.n} done.` : "Done.";
      if (p.run.status === "done") return `${done} That was the last step. Say finish the run to close it.`;
      return next ? `${done} Next, step ${next.n}: ${next.say}` : done;
    }
    case "runs.back":
      return next ? `Back to step ${next.n}: ${next.say}` : "Back a step.";
    case "runs.skip":
      return next ? `Skipped. Now step ${next.n}: ${next.say}` : "Skipped.";
    case "runs.note":
      return `Noted on step ${p.run.current} of ${name}.`;
    case "runs.timer":
      return `Timer started${p.timer ? `: ${p.timer.label}` : ""}.`;
    case "runs.pause":
      return `Paused ${name} at step ${p.run.current}.`;
    case "runs.resume":
      return next ? `Resumed ${name}. Step ${next.n}: ${next.say}` : `Resumed ${name}.`;
    case "runs.finish":
      return `Finished the ${name} run. The write-up will be in its chat.`;
    case "runs.amount":
      return "";
  }
}

async function runAction(email: string, a: Extract<Action, { runId: string }>, device: string): Promise<{ result?: string; said?: string }> {
  if (boxed()) {
    const id = encodeURIComponent(a.runId);
    const post = (path: string, body: unknown) => boxCall<ActPayload>("POST", `/api/runs/${id}/${path}`, body);
    switch (a.do) {
      case "runs.advance": return { said: saidFor(a, await post("advance", { device })) };
      case "runs.back": return { said: saidFor(a, await post("back", { device })) };
      case "runs.skip": return { said: saidFor(a, await post("skip", { device, ...(a.reason ? { reason: a.reason } : {}) })) };
      case "runs.note": return { said: saidFor(a, await post("note", { device, text: a.text })) };
      case "runs.timer": return { said: saidFor(a, await post("timer", { device, ...(a.seconds ? { seconds: a.seconds } : {}) })) };
      case "runs.pause": return { said: saidFor(a, await post("pause", {})) };
      case "runs.resume": return { said: saidFor(a, await post("resume", {})) };
      case "runs.finish": return { said: saidFor(a, await post("finish", { device })) };
      case "runs.amount": {
        const r = await boxCall<{ say?: string; text?: string }>("POST", `/api/runs/${id}/amount`, { material: a.material });
        return { result: r.say || r.text || "" };
      }
    }
  }
  const run = await rdb.getRunForUser(email, a.runId);
  if (!run) throw new RunError(404, "Run not found.");
  const payload = async (r: RunRow, extra: Partial<ActPayload> = {}): Promise<ActPayload> => {
    const v = await viewOf(r);
    return { run: r as unknown as ActPayload["run"], view: { current: v.current, next: v.next }, ...extra };
  };
  switch (a.do) {
    case "runs.advance": {
      const r = await runs.advance(run, device);
      return { said: saidFor(a, await payload(r.run, { done: r.done, next: r.next })) };
    }
    case "runs.back": return { said: saidFor(a, await payload((await runs.back(run, device)).run)) };
    case "runs.skip": return { said: saidFor(a, await payload((await runs.skip(run, a.reason, device)).run)) };
    case "runs.note": return { said: saidFor(a, await payload(await runs.note(run, a.text, undefined, device))) };
    case "runs.timer": {
      const r = await runs.startTimer(run, { ...(a.seconds ? { seconds: a.seconds } : {}), device });
      return { said: saidFor(a, await payload(r.run, { timer: { label: r.timer.label } })) };
    }
    case "runs.pause": return { said: saidFor(a, await payload(await runs.pause(run))) };
    case "runs.resume": return { said: saidFor(a, await payload(await runs.resume(run))) };
    case "runs.finish": return { said: saidFor(a, await payload(await runs.finish(run, device))) };
    case "runs.amount": {
      const r = answerAmount(run, a.material);
      return { result: r.say || r.text || "" };
    }
  }
}

export async function executePlan(
  email: string,
  plan: Plan,
  opts: { siriTurnId: string; device: string; said: string },
): Promise<Executed[]> {
  const out: Executed[] = [];
  for (const a of plan.actions) {
    try {
      if (a.do.startsWith("runs.")) {
        if (a.do === "runs.start") {
          if (boxed()) {
            const { stableHostId } = await import("../deviceLink/client");
            await boxCall("POST", "/api/runs", { protocolSlug: a.protocolSlug, hostId: stableHostId() });
          } else {
            const { getSkillBySlug } = await import("../skills");
            const { parseProtocol } = await import("../runs/parse");
            const skill = getSkillBySlug(a.protocolSlug, email);
            if (!skill || skill.artifactKind !== "protocol") throw new RunError(404, "Protocol not found.");
            const s = await sdb.createSession({ email, title: skill.name, lastBody: { skillSlugs: [skill.slug] } });
            await runs.createRun({ email, sessionId: s.id, hostId: null, protocolSlug: skill.slug, protocolName: skill.name, snapshot: parseProtocol(skill.body) });
          }
          const name = (await import("../skills")).getSkillBySlug(a.protocolSlug, email)?.name ?? a.protocolSlug;
          out.push({ action: a, ok: true, said: `Started ${name}.` });
        } else {
          const r = await runAction(email, a as Extract<Action, { runId: string }>, opts.device);
          out.push({ action: a, ok: true, ...(r.result ? { result: r.result } : {}), ...(r.said ? { said: r.said } : {}) });
        }
        continue;
      }
      switch (a.do) {
        case "chats.send": {
          const s = await sdb.getSession(email, a.sessionId);
          if (!s) throw new Error("Chat not found.");
          const r = await runner.startTurn(email, s.id, { text: a.text, device: opts.device, voice: true, origin: { kind: "siri", siriTurnId: opts.siriTurnId, said: opts.said } });
          if (!r.ok) throw new Error(r.message);
          out.push({ action: a, ok: true, delegated: { sessionId: s.id, title: s.title }, said: `Sent to "${s.title}". I'll tell you when it answers.` });
          break;
        }
        case "chats.new": {
          const s = await sdb.createSession({ email, title: a.title.slice(0, 64) });
          const r = await runner.startTurn(email, s.id, { text: a.text, device: opts.device, voice: true, origin: { kind: "siri", siriTurnId: opts.siriTurnId, said: opts.said } });
          if (!r.ok) throw new Error(r.message);
          out.push({ action: a, ok: true, delegated: { sessionId: s.id, title: s.title }, said: `Started "${s.title}". I'll tell you when it answers.` });
          break;
        }
        case "chats.answer": {
          const s = await sdb.getSession(email, a.sessionId);
          const questions = normalizeQuestions(s?.pendingQuestion?.input);
          if (!s || questions.length === 0) throw new Error("Nothing is waiting on an answer there.");
          const { answers } = mapSpokenAnswer(questions, a.spoken);
          const r = await runner.answerQuestion(email, s.id, answers, { device: opts.device, voice: true });
          if (!r.ok) throw new Error(r.message);
          out.push({ action: a, ok: true, delegated: { sessionId: s.id, title: s.title }, said: `Answered "${s.title}".` });
          break;
        }
        case "chats.stop": {
          const r = await runner.cancelTurn(email, a.sessionId);
          if (!r.ok) throw new Error(r.message ?? "Nothing to stop.");
          out.push({ action: a, ok: true, said: "Stopped." });
          break;
        }
        case "ask.quick": {
          const r = await quickAnswer(email, a.q, { device: opts.device, log: false });
          out.push({ action: a, ok: !r.needsAgent, ...(r.needsAgent ? { error: r.reason ?? "no quick answer" } : { result: r.answer }) });
          break;
        }
      }
    } catch (e) {
      out.push({ action: a, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// --- the exchange ---------------------------------------------------------------

export interface SayResult {
  status: "answered" | "working" | "confirm";
  spoken: string;
  siriTurnId: string;
  confirmId?: string;
  actions: Executed[];
  via: "plan" | "fallback" | "confirm";
}

interface Pending {
  email: string;
  plan: Plan;
  state: SiriState;
  text: string;
  device: string;
  expires: number;
}
const pending = new Map<string, Pending>();
const CONFIRM_MS = 60_000;

/** Fold the executor's findings into the sentence: an amount it looked up,
 *  a quick answer, an action that failed. After a confirmation, or when the
 *  plan's sentence is itself a question, what was done is said instead. */
function finalSentence(plan: Plan, executed: Executed[], confirmed = false): string {
  const found = executed.filter((e) => e.ok && e.result).map((e) => e.result!);
  const failed = executed.filter((e) => !e.ok);
  const done = executed.filter((e) => e.ok && e.said).map((e) => e.said!);
  let say = plan.say;
  if ((confirmed || /\?\s*$/.test(say) || !say.trim()) && done.length) say = done.join(" ");
  if (found.length) say = /\b(here it is|here's|here is|the answer)\b/i.test(say) ? found.join(" ") : `${found.join(" ")} ${say}`.trim();
  if (failed.length) {
    const fails = failed.map((e) => (e.action.do === "ask.quick" ? "I couldn't find that in your protocols." : `${e.error ?? "That failed."}`));
    say = `${say} ${fails.join(" ")}`.replace(/\s+/g, " ").trim();
  }
  return say;
}

/** The whole exchange: log the phrase, plan, validate, confirm or execute, log the reply. */
export async function sayToLabee(email: string, text: string, opts: { device?: string; confirmId?: string; yes?: boolean } = {}): Promise<SayResult> {
  const device = opts.device ?? "Siri";
  const siri = await ensureSiriSession(email);

  // A yes (or no) to a question asked a moment ago.
  if (opts.confirmId) {
    const p = pending.get(opts.confirmId);
    pending.delete(opts.confirmId);
    if (!p || p.email !== email || p.expires < Date.now()) {
      return { status: "answered", spoken: "That's expired. Say it again?", siriTurnId: sdb.newId("siri"), actions: [], via: "confirm" };
    }
    const siriTurnId = sdb.newId("siri");
    // The yes or no is part of the conversation too.
    await sdb.appendMessage(siri.id, null, "user", text || (opts.yes ? "Yes." : "No."), { siriTurnId, device, confirmId: opts.confirmId });
    if (!opts.yes) {
      await sdb.appendMessage(siri.id, null, "assistant", "Okay, leaving it.", { siriTurnId, device, kind: "say" });
      return { status: "answered", spoken: "Okay, leaving it.", siriTurnId, actions: [], via: "confirm" };
    }
    const executed = await executePlan(email, p.plan, { siriTurnId, device, said: p.text });
    const spoken = finalSentence(p.plan, executed, true);
    await sdb.appendMessage(siri.id, null, "assistant", spoken, { siriTurnId, device, kind: "say", actions: executed.map((e) => ({ do: e.action.do, ok: e.ok })) });
    return { status: executed.some((e) => e.delegated) ? "working" : "answered", spoken, siriTurnId, actions: executed, via: "confirm" };
  }

  const siriTurnId = sdb.newId("siri");
  await sdb.appendMessage(siri.id, null, "user", text, { siriTurnId, device });
  const t0 = Date.now();
  const state = await gatherState(email);
  let plan = await planWith(email, text, state);
  // A second look only when there is time for it inside the route's ceiling.
  if (plan?.need && Date.now() - t0 > 7000) plan.need = null;
  if (plan?.need) {
    const s = state.chats.find((c) => c.id === plan!.need!.sessionId);
    const msgs = s ? (await sdb.listMessages(s.id)).filter((m) => m.role !== "system").slice(-(plan.need.last ?? 6)) : [];
    plan = await planWith(email, text, state, { chat: s?.title, messages: msgs.map((m) => ({ role: m.role, text: m.content.slice(0, 700) })) });
    if (plan) plan.need = null;
  }
  const rejected = plan ? validatePlan(plan, state) : { reason: "no plan" };
  if (!plan || rejected) {
    const words = text.split(/\s+/).filter(Boolean).length;
    // A plan that named things the state does not hold, or a phrase too short
    // to be a request: say so rather than open a chat about it. A chat is
    // only for a real request the planner could not handle in time.
    if (plan || words <= 4) {
      const spoken = plan ? "I couldn't act on that. Say it again?" : "I didn't catch that. Say it again?";
      console.warn(`[siri] ${plan ? `plan rejected (${rejected?.reason})` : "no plan"}; asking again`);
      await sdb.appendMessage(siri.id, null, "assistant", spoken, { siriTurnId, device, kind: "say", via: "unclear" });
      return { status: "answered", spoken, siriTurnId, actions: [], via: "fallback" };
    }
    console.warn(`[siri] plan rejected (${rejected?.reason}); falling back to a new chat`);
    const s = await sdb.createSession({ email, title: text.length > 48 ? `${text.slice(0, 48)}…` : text });
    const r = await runner.startTurn(email, s.id, { text, device, voice: true, origin: { kind: "siri", siriTurnId, said: text } });
    const spoken = r.ok ? `I've started a chat called "${s.title}". I'll tell you when it answers.` : `I couldn't start a chat: ${r.message}`;
    await sdb.appendMessage(siri.id, null, "assistant", spoken, { siriTurnId, device, kind: "say", via: "fallback" });
    return { status: r.ok ? "working" : "answered", spoken, siriTurnId, actions: [], via: "fallback" };
  }

  const question = needsConfirmation(plan, state);
  if (question) {
    const confirmId = sdb.newId("confirm");
    pending.set(confirmId, { email, plan, state, text, device, expires: Date.now() + CONFIRM_MS });
    await sdb.appendMessage(siri.id, null, "assistant", question, { siriTurnId, device, kind: "confirm", confirmId });
    return { status: "confirm", spoken: question, siriTurnId, confirmId, actions: [], via: "plan" };
  }

  const executed = await executePlan(email, plan, { siriTurnId, device, said: text });
  const spoken = finalSentence(plan, executed);
  await sdb.appendMessage(siri.id, null, "assistant", spoken, { siriTurnId, device, kind: "say", actions: executed.map((e) => ({ do: e.action.do, ok: e.ok, ...(e.error ? { error: e.error } : {}) })) });
  return { status: executed.some((e) => e.delegated) ? "working" : "answered", spoken, siriTurnId, actions: executed, via: "plan" };
}
