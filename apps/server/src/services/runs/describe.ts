// One line per run event for the session transcript (design §2.2), and the
// spoken sentence Siri says back. Both read the frozen snapshot, so they are
// the protocol's words.
import type { RunEventRow, RunRow } from "./db";
import { formatClock } from "./parse";

function stepText(run: RunRow, n: number): string {
  return run.snapshot.steps.find((s) => s.n === n)?.text.split("\n")[0] ?? `step ${n}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The quiet transcript line, or null for events that are not worth a line. */
export function transcriptLine(run: RunRow, e: RunEventRow): string | null {
  const n = Number(e.data.step ?? 0);
  const via = typeof e.data.device === "string" ? ` ⟨${e.data.device}⟩` : "";
  switch (e.type) {
    case "run_started":
      return `▶ Run started: ${run.protocolName} — ${e.data.steps} steps${Number(e.data.timers) ? `, ${e.data.timers} timed` : ""}${e.data.loose ? " (no numbered list; one step per paragraph)" : ""}`;
    case "step_done":
      return `✓ Step ${n} done · ${hhmm(e.ts)} — ${stepText(run, n)}${via}`;
    case "step_skipped":
      return `⤼ Step ${n} skipped${e.data.reason ? ` (${e.data.reason})` : ""} · ${hhmm(e.ts)}${via}`;
    case "step_reopened":
      return `↩ Back on step ${n} — ${stepText(run, n)}${via}`;
    case "note":
      return `📝 Step ${n}: ${e.data.text}${via}`;
    case "timer_started":
      return `⏱ ${e.data.label} timer started on step ${n} · ends ${hhmm(String(e.data.endsAt))}${via}`;
    case "timer_done":
      return `⏱ ${e.data.label} timer done · step ${n}`;
    case "timer_cancelled":
      return `⏱ Timer cancelled · step ${n}`;
    case "paused":
      return `⏸ Paused at step ${n} · ${hhmm(e.ts)}`;
    case "resumed":
      return `▶ Resumed at step ${n} · ${hhmm(e.ts)}`;
    case "completed":
      return `✓ All ${e.data.steps} steps done · ${hhmm(e.ts)}`;
    case "finished":
      return `■ Run finished · ${e.data.done} of ${e.data.steps} steps done${Number(e.data.skipped) ? `, ${e.data.skipped} skipped` : ""}, ${e.data.notes} note${Number(e.data.notes) === 1 ? "" : "s"}, ${formatClock(Number(e.data.elapsedSeconds ?? 0))}${via}`;
    case "abandoned":
      return `✕ Run abandoned at step ${n}${e.data.reason ? ` (${e.data.reason})` : ""}`;
    case "scaled":
      return e.data.scale
        ? `⚖ Scale set: running ${(e.data.scale as { actual: { qty: number; unit: string } }).actual.qty} ${(e.data.scale as { actual: { unit: string } }).actual.unit}`
        : "⚖ Scale cleared";
    default:
      return null;
  }
}
