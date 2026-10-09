// The run state machine (docs/protocol-run-design.md §2). Every change is an
// event; `current` and `status` are derived and cached on the row. Nothing is
// deleted: "go back" reopens a step, it does not erase that it was done.
//
// This runs wherever the run is owned (the box, or a desktop with no box).
// Listeners get every event; the Device Link bridge pushes them to the host
// that holds the session, and the session bridge turns them into transcript
// lines where the session is local.
import * as rdb from "./db";
import type { RunEventRow, RunRow, RunScale, RunStatus } from "./db";
import type { ProtocolSnapshot, Step } from "./parse";
import { formatClock } from "./parse";

export type RunListener = (run: RunRow, event: RunEventRow) => void;
const listeners = new Set<RunListener>();

export function subscribeRunEvents(fn: RunListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function publish(run: RunRow, event: RunEventRow): void {
  for (const l of listeners) {
    try {
      l(run, event);
    } catch {
      // a broken listener must not break the run
    }
  }
}

async function emit(runId: string, type: string, data: Record<string, unknown> = {}): Promise<{ run: RunRow; event: RunEventRow }> {
  const event = await rdb.appendRunEvent(runId, type, data);
  const run = (await rdb.getRun(runId))!;
  publish(run, event);
  return { run, event };
}

export class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- creation -------------------------------------------------------------------

export async function createRun(opts: {
  email: string;
  sessionId: string;
  hostId: string | null;
  protocolSlug: string;
  protocolName: string;
  snapshot: ProtocolSnapshot;
  scale?: RunScale | null;
}): Promise<RunRow> {
  if (opts.snapshot.steps.length === 0) throw new RunError(400, "This protocol has no steps to run.");
  const ts = new Date().toISOString();
  await rdb.insertRun({
    id: rdb.newRunId(),
    email: opts.email,
    sessionId: opts.sessionId,
    hostId: opts.hostId,
    protocolSlug: opts.protocolSlug,
    protocolName: opts.protocolName,
    snapshot: opts.snapshot,
    current: 1,
    status: "running",
    scale: opts.scale ?? null,
    startedAt: ts,
    finishedAt: null,
  });
  const run = (await rdb.getRunBySession(opts.sessionId))!;
  await emit(run.id, "run_started", {
    protocolSlug: opts.protocolSlug,
    protocolName: opts.protocolName,
    steps: opts.snapshot.steps.length,
    timers: opts.snapshot.steps.filter((s) => s.timer).length,
    loose: opts.snapshot.loose,
    ...(opts.scale ? { scale: opts.scale } : {}),
  });
  const { run: after } = await emit(run.id, "step_started", { step: 1 });
  return after;
}

// --- transitions ------------------------------------------------------------------

function stepOf(run: RunRow, n: number): Step {
  const s = run.snapshot.steps.find((x) => x.n === n);
  if (!s) throw new RunError(400, `There is no step ${n}.`);
  return s;
}

function mustBeOpen(run: RunRow): void {
  if (run.status === "done" || run.status === "abandoned") throw new RunError(409, `This run is ${run.status}.`);
  if (run.status === "paused") throw new RunError(409, "This run is paused. Resume it first.");
}

export async function advance(run: RunRow, device?: string): Promise<{ run: RunRow; done: Step; next: Step | null }> {
  mustBeOpen(run);
  const done = stepOf(run, run.current);
  await emit(run.id, "step_done", { step: done.n, ...(device ? { device } : {}) });
  const last = run.current >= run.snapshot.steps.length;
  if (last) {
    await rdb.updateRun(run.id, { status: "done", finishedAt: new Date().toISOString() });
    const { run: after } = await emit(run.id, "completed", { steps: run.snapshot.steps.length });
    return { run: after, done, next: null };
  }
  await rdb.updateRun(run.id, { current: run.current + 1 });
  const { run: after } = await emit(run.id, "step_started", { step: run.current + 1 });
  return { run: after, done, next: stepOf(after, after.current) };
}

export async function back(run: RunRow, device?: string): Promise<{ run: RunRow; step: Step }> {
  if (run.status === "abandoned") throw new RunError(409, "This run was abandoned.");
  const wasDone = run.status === "done";
  const target = wasDone ? run.current : run.current - 1;
  if (target < 1) throw new RunError(409, "Already on the first step.");
  await rdb.updateRun(run.id, { current: target, status: "running", finishedAt: null });
  const { run: after } = await emit(run.id, "step_reopened", { step: target, ...(device ? { device } : {}) });
  return { run: after, step: stepOf(after, target) };
}

export async function skip(run: RunRow, reason?: string, device?: string): Promise<{ run: RunRow; skipped: Step; next: Step | null }> {
  mustBeOpen(run);
  const skipped = stepOf(run, run.current);
  await emit(run.id, "step_skipped", { step: skipped.n, ...(reason ? { reason } : {}), ...(device ? { device } : {}) });
  if (run.current >= run.snapshot.steps.length) {
    await rdb.updateRun(run.id, { status: "done", finishedAt: new Date().toISOString() });
    const { run: after } = await emit(run.id, "completed", { steps: run.snapshot.steps.length });
    return { run: after, skipped, next: null };
  }
  await rdb.updateRun(run.id, { current: run.current + 1 });
  const { run: after } = await emit(run.id, "step_started", { step: run.current + 1 });
  return { run: after, skipped, next: stepOf(after, after.current) };
}

export async function jumpTo(run: RunRow, n: number, device?: string): Promise<RunRow> {
  if (run.status === "abandoned") throw new RunError(409, "This run was abandoned.");
  stepOf(run, n);
  if (n === run.current && run.status === "running") return run;
  await rdb.updateRun(run.id, { current: n, status: "running", finishedAt: null });
  const type = n < run.current || run.status === "done" ? "step_reopened" : "step_started";
  const { run: after } = await emit(run.id, type, { step: n, jumped: true, ...(device ? { device } : {}) });
  return after;
}

export async function note(run: RunRow, text: string, stepN?: number, device?: string): Promise<RunRow> {
  const t = text.trim();
  if (!t) throw new RunError(400, "The note is empty.");
  const step = stepN ?? run.current;
  stepOf(run, step);
  const { run: after } = await emit(run.id, "note", { step, text: t, ...(device ? { device } : {}) });
  return after;
}

export interface RunTimer {
  id: string;
  step: number;
  seconds: number;
  label: string;
  startedAt: string;
  endsAt: string;
  state: "running" | "done" | "cancelled";
}

export async function startTimer(
  run: RunRow,
  opts: { seconds?: number; label?: string; step?: number; device?: string } = {},
): Promise<{ run: RunRow; timer: RunTimer }> {
  mustBeOpen(run);
  const stepN = opts.step ?? run.current;
  const step = stepOf(run, stepN);
  const seconds = opts.seconds ?? step.timer?.seconds;
  if (!seconds || seconds <= 0) throw new RunError(400, `Step ${stepN} has no timer in the protocol. Say how long.`);
  const label = opts.label ?? step.timer?.label ?? `${formatClock(seconds)}`;
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + seconds * 1000);
  const id = `tmr_${Math.random().toString(36).slice(2, 10)}`;
  const { run: after } = await emit(run.id, "timer_started", {
    timerId: id,
    step: stepN,
    seconds,
    label,
    endsAt: endsAt.toISOString(),
    ...(opts.device ? { device: opts.device } : {}),
  });
  return { run: after, timer: { id, step: stepN, seconds, label, startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString(), state: "running" } };
}

export async function cancelTimer(run: RunRow, timerId: string): Promise<RunRow> {
  const timers = await timersOf(run);
  const t = timers.find((x) => x.id === timerId);
  if (!t) throw new RunError(404, "No such timer.");
  if (t.state !== "running") return run;
  const { run: after } = await emit(run.id, "timer_cancelled", { timerId, step: t.step });
  return after;
}

export async function timerDone(run: RunRow, timerId: string): Promise<RunRow> {
  const timers = await timersOf(run);
  const t = timers.find((x) => x.id === timerId);
  if (!t || t.state === "cancelled") return run;
  const events = await rdb.listRunEvents(run.id);
  if (events.some((e) => e.type === "timer_done" && e.data.timerId === timerId)) return run;
  const { run: after } = await emit(run.id, "timer_done", { timerId, step: t.step, label: t.label });
  return after;
}

export async function pause(run: RunRow): Promise<RunRow> {
  if (run.status !== "running") throw new RunError(409, `This run is ${run.status}.`);
  await rdb.updateRun(run.id, { status: "paused" });
  const { run: after } = await emit(run.id, "paused", { step: run.current });
  return after;
}

export async function resume(run: RunRow): Promise<RunRow> {
  if (run.status !== "paused") throw new RunError(409, `This run is ${run.status}.`);
  await rdb.updateRun(run.id, { status: "running" });
  const { run: after } = await emit(run.id, "resumed", { step: run.current });
  return after;
}

/** Close the run and ask for the write-up. Open steps are left as they are. */
export async function finish(run: RunRow, device?: string): Promise<RunRow> {
  if (run.status === "abandoned") throw new RunError(409, "This run was abandoned.");
  const events = await rdb.listRunEvents(run.id);
  if (events.some((e) => e.type === "finished")) return run;
  const view = await viewOf(run, events);
  if (run.status !== "done") await rdb.updateRun(run.id, { status: "done", finishedAt: new Date().toISOString() });
  const { run: after } = await emit(run.id, "finished", {
    steps: run.snapshot.steps.length,
    done: view.stepLog.filter((s) => s.doneAt).length,
    skipped: view.stepLog.filter((s) => s.skipped).length,
    notes: view.notes.length,
    elapsedSeconds: view.elapsedSeconds,
    ...(device ? { device } : {}),
  });
  return after;
}

export async function abandon(run: RunRow, reason?: string): Promise<RunRow> {
  if (run.status === "abandoned") return run;
  await rdb.updateRun(run.id, { status: "abandoned", finishedAt: new Date().toISOString() });
  const { run: after } = await emit(run.id, "abandoned", { step: run.current, ...(reason ? { reason } : {}) });
  return after;
}

export async function setScale(run: RunRow, scale: RunScale | null): Promise<RunRow> {
  await rdb.updateRun(run.id, { scale });
  const { run: after } = await emit(run.id, "scaled", scale ? { scale } : { cleared: true });
  return after;
}

// --- derived views --------------------------------------------------------------

export interface StepLogEntry {
  n: number;
  text: string;
  startedAt: string | null;
  doneAt: string | null;
  skipped: boolean;
  notes: string[];
}

export interface RunView {
  run: RunRow;
  current: Step | null;
  next: Step | null;
  stepLog: StepLogEntry[];
  timers: RunTimer[];
  notes: Array<{ step: number; text: string; ts: string; device?: string }>;
  elapsedSeconds: number;
  /** Steps that have a timer and how long it is, for the UI badge. */
  timedSteps: number;
}

export async function timersOf(run: RunRow, events?: RunEventRow[]): Promise<RunTimer[]> {
  const evs = events ?? (await rdb.listRunEvents(run.id));
  const timers = new Map<string, RunTimer>();
  const nowMs = Date.now();
  for (const e of evs) {
    const id = String(e.data.timerId ?? "");
    if (e.type === "timer_started") {
      timers.set(id, {
        id,
        step: Number(e.data.step),
        seconds: Number(e.data.seconds),
        label: String(e.data.label ?? ""),
        startedAt: e.ts,
        endsAt: String(e.data.endsAt),
        state: new Date(String(e.data.endsAt)).getTime() <= nowMs ? "done" : "running",
      });
    } else if (e.type === "timer_cancelled") {
      const t = timers.get(id);
      if (t) t.state = "cancelled";
    } else if (e.type === "timer_done") {
      const t = timers.get(id);
      if (t) t.state = "done";
    }
  }
  return [...timers.values()];
}

export async function viewOf(run: RunRow, events?: RunEventRow[]): Promise<RunView> {
  const evs = events ?? (await rdb.listRunEvents(run.id));
  const log = new Map<number, StepLogEntry>();
  for (const s of run.snapshot.steps) log.set(s.n, { n: s.n, text: s.text, startedAt: null, doneAt: null, skipped: false, notes: [] });
  const notes: RunView["notes"] = [];
  for (const e of evs) {
    const n = Number(e.data.step ?? 0);
    const entry = log.get(n);
    switch (e.type) {
      case "step_started":
        if (entry && !entry.startedAt) entry.startedAt = e.ts;
        break;
      case "step_reopened":
        if (entry) {
          entry.doneAt = null;
          entry.skipped = false;
          if (!entry.startedAt) entry.startedAt = e.ts;
        }
        break;
      case "step_done":
        if (entry) entry.doneAt = e.ts;
        break;
      case "step_skipped":
        if (entry) entry.skipped = true;
        break;
      case "note":
        if (entry) entry.notes.push(String(e.data.text ?? ""));
        notes.push({ step: n, text: String(e.data.text ?? ""), ts: e.ts, ...(typeof e.data.device === "string" ? { device: e.data.device } : {}) });
        break;
      default:
        break;
    }
  }
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const current = run.status === "done" || run.status === "abandoned" ? null : (run.snapshot.steps.find((s) => s.n === run.current) ?? null);
  const next = current ? (run.snapshot.steps.find((s) => s.n === current.n + 1) ?? null) : null;
  return {
    run,
    current,
    next,
    stepLog: [...log.values()],
    timers: await timersOf(run, evs),
    notes,
    elapsedSeconds: Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000)),
    timedSteps: run.snapshot.steps.filter((s) => s.timer).length,
  };
}

/** The compact text the agent sees on every turn in a run session. */
export function runContextText(view: RunView): string {
  const { run } = view;
  const lines: string[] = [];
  lines.push(`## PROTOCOL RUN: ${run.protocolName}`);
  lines.push(
    `Status: ${run.status}. ${view.stepLog.filter((s) => s.doneAt).length} of ${run.snapshot.steps.length} steps done, ${formatClock(view.elapsedSeconds)} elapsed.` +
      (run.scale ? ` Scale: running ${run.scale.actual.qty} ${run.scale.actual.unit} (protocol: ${run.scale.base.qty} ${run.scale.base.unit}).` : ""),
  );
  if (view.current) lines.push(`Current step ${view.current.n}: ${view.current.text}`);
  if (view.next) lines.push(`Next step ${view.next.n}: ${view.next.text}`);
  lines.push("Step log:");
  for (const s of view.stepLog) {
    const state = s.skipped ? "skipped" : s.doneAt ? `done ${hhmm(s.doneAt)}` : s.startedAt ? `in progress since ${hhmm(s.startedAt)}` : "not started";
    lines.push(`- ${s.n}. ${state}${s.notes.length ? ` — notes: ${s.notes.join(" | ")}` : ""}`);
  }
  const running = view.timers.filter((t) => t.state === "running");
  if (running.length) lines.push("Timers running: " + running.map((t) => `${t.label} on step ${t.step}, ends ${hhmm(t.endsAt)}`).join("; "));
  lines.push(
    "The person tracks this run by voice; step changes and notes above are facts, not questions. When they ask about a step, answer about that step. " +
      "Say 'the protocol doesn't specify' rather than guess a quantity, and label any number you compute as computed.",
  );
  return lines.join("\n");
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The instruction for the write-up turn (design §4.3). The table is built
 *  here from events, so the numbers are exact; the model adds the judgement. */
export function writeupPrompt(view: RunView, dateLabel: string): string {
  const { run } = view;
  const rows = view.stepLog
    .map((s) => `| ${s.n} ${s.text.split("\n")[0]!.slice(0, 60)} | ${s.startedAt ? hhmm(s.startedAt) : ""} | ${s.skipped ? "skipped" : s.doneAt ? hhmm(s.doneAt) : ""} | ${s.notes.join("; ")} |`)
    .join("\n");
  const timers = view.timers.map((t) => `step ${t.step} ${t.label} (${t.state})`).join(" · ") || "none";
  const file = `Runs/${dateLabel} ${run.protocolName.replace(/[\\/:*?"<>|]+/g, "-")}.md`;
  return [
    `The run of "${run.protocolName}" is finished. Write it up as a file named exactly \`${file}\` in the working directory, then reply with the same write-up as your message.`,
    "",
    "Use this table verbatim as the first section (it is generated from the run's event log and is exact):",
    "",
    `# ${run.protocolName} — ${dateLabel}`,
    `Protocol: ${run.protocolSlug} · ${run.snapshot.steps.length} steps · ${formatClock(view.elapsedSeconds)} elapsed${run.scale ? ` · scale ${run.scale.actual.qty} ${run.scale.actual.unit}` : ""}`,
    "",
    "| Step | Started | Done | Notes |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    `Timers: ${timers}`,
    "",
    "Then add a short 'Deviations' section: compare the notes and timings against the protocol's own steps and say what differed and whether it matters. Quote the protocol when you judge; say 'the protocol doesn't specify' where it is silent. Keep it under 200 words. Do not invent measurements.",
  ].join("\n");
}

export type { RunRow, RunEventRow, RunScale, RunStatus };
