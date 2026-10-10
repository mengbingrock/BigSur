// Pure helpers for showing a run: progress, elapsed time, timer countdowns,
// and the one question the start sheet asks (the scale). No React, no I/O,
// so they are unit-tested.
import type { ProtocolSnapshot } from "@labee/session-core";

/** "4:12" / "1:02:30". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** "31 min", "2 h 05", "45 s". */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Seconds left on a timer, never negative. */
export function remaining(endsAt: string, now = Date.now()): number {
  return Math.max(0, Math.round((new Date(endsAt).getTime() - now) / 1000));
}

/** "step 5 of 9". */
export function fraction(current: number, total: number, status: string): string {
  if (status === "done") return `${total} of ${total} done`;
  if (status === "abandoned") return "abandoned";
  return `step ${current} of ${total}`;
}

/** The start sheet's summary line: "9 steps · 2 timers". */
export function summaryLine(snapshot: Pick<ProtocolSnapshot, "steps" | "loose">): string {
  const timers = snapshot.steps.filter((s) => s.timer).length;
  const parts = [`${snapshot.steps.length} step${snapshot.steps.length === 1 ? "" : "s"}`];
  if (timers) parts.push(`${timers} timer${timers === 1 ? "" : "s"}`);
  if (snapshot.loose) parts.push("no numbered list — one step per paragraph");
  return parts.join(" · ");
}

/** The amounts line under the current step: "10 min · 3000 rpm · 4 °C". */
export function amountsLine(step: { amounts: Array<{ qty: string; unit: string; of: string | null }> } | null): string {
  if (!step || step.amounts.length === 0) return "";
  return step.amounts.map((a) => `${a.qty} ${a.unit}${a.of ? ` ${a.of}` : ""}`).join(" · ");
}

/** Parse what the person typed for the scale ("50", "50 ml") against the base. */
export function parseScale(input: string, base: { qty: number; unit: string }): { qty: number; unit: string } | null {
  const m = input.trim().match(/^(\d+(?:[.,]\d+)?)\s*([a-zµμ%]*)$/i);
  if (!m) return null;
  const qty = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const unit = m[2] ? normaliseUnit(m[2]) ?? base.unit : base.unit;
  return { qty, unit };
}

function normaliseUnit(u: string): string | null {
  const x = u.toLowerCase();
  if (/^(µl|ul|μl)$/.test(x)) return "µL";
  if (/^(ml)$/.test(x)) return "mL";
  if (/^(l)$/.test(x)) return "L";
  if (/^(mg)$/.test(x)) return "mg";
  if (/^(g)$/.test(x)) return "g";
  if (/^(µg|ug|μg)$/.test(x)) return "µg";
  return null;
}
