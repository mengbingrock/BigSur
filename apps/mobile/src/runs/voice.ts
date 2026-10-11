// What Lab mode says back after a spoken run command. Pure functions over a
// run payload, so they are unit-tested; the session screen does the I/O and
// hands the sentence to the phone's own text-to-speech.
import { spokenForm } from "@labee/session-core";
import type { RunPayload } from "~/api/runs";
import { amountsLine, remaining } from "./format";

/** "10 minutes", "1 hour 30 minutes", "45 seconds". */
export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (h) parts.push(part(h, "hour"));
  if (m) parts.push(part(m, "minute"));
  if (r && !h) parts.push(part(r, "second"));
  return parts.length ? parts.join(" ") : "0 seconds";
}

const total = (p: RunPayload) => p.run.snapshot.steps.length;

/** "Step 5 of 9. Spin for 10 minutes at 3000 rpm, 4 degrees C." */
export function stepLine(p: RunPayload): string {
  const step = p.view.current;
  if (!step) return p.run.status === "done" ? "All steps are done." : "This run has ended.";
  return `Step ${step.n} of ${total(p)}. ${step.say}`;
}

/** After "done": the new step, or what to say when the list is finished. */
export function afterAdvance(p: RunPayload): string {
  if (p.run.status === "done") {
    return p.run.finishedAt ? "The run is finished." : "That was the last step. Say finish run to close it.";
  }
  return stepLine(p);
}

/** "You're on step 4 of 9, 3 done, 12 minutes in. A timer has 6 minutes left." */
export function whereLine(p: RunPayload, now = Date.now()): string {
  const done = p.view.stepLog.filter((s) => s.doneAt).length;
  const parts = [
    p.run.status === "done"
      ? `All ${total(p)} steps are done`
      : `You're on step ${p.run.current} of ${total(p)}, ${done} done`,
  ];
  if (p.run.status === "paused") parts.push("the run is paused");
  const left = timeLeftSeconds(p, now);
  let line = parts.join(", ") + ".";
  if (left !== null) line += left > 0 ? ` A timer has ${durationWords(left)} left.` : " A timer has finished.";
  return line;
}

/** The step after this one, without moving. */
export function peekLine(p: RunPayload): string {
  const next = p.view.next;
  return next ? `Next is step ${next.n}. ${next.say}` : "This is the last step.";
}

export function timeLeftSeconds(p: RunPayload, now = Date.now()): number | null {
  const t = p.view.timers.find((x) => x.state === "running");
  return t ? remaining(t.endsAt, now) : null;
}

export function timeLeftLine(p: RunPayload, now = Date.now()): string {
  const left = timeLeftSeconds(p, now);
  if (left === null) return "No timer is running.";
  return left > 0 ? `${durationWords(left)} left.` : "The timer has finished.";
}

/** "How much?" with no material: read this step's amounts, if it has any. */
export function stepAmountsLine(p: RunPayload): string {
  const line = amountsLine(p.view.current);
  return line ? `This step uses ${spokenForm(line.replace(/ · /g, ", "))}.` : "This step doesn't list any amounts. Say how much, then the material.";
}
