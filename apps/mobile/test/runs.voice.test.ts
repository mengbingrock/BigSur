import { describe, expect, it } from "vitest";
import type { RunPayload } from "../src/api/runs";
import { afterAdvance, durationWords, peekLine, stepAmountsLine, stepLine, timeLeftLine, whereLine } from "../src/runs/voice";

const NOW = Date.parse("2026-10-10T12:00:00Z");

function payload(over: { current?: number; status?: RunPayload["run"]["status"]; finishedAt?: string | null; timerEndsAt?: string | null } = {}): RunPayload {
  const steps = [
    { n: 1, text: "Grow a 5 ml seed culture.", say: "Grow a 5 milliliter seed culture.", note: null, amounts: [{ qty: "5", unit: "mL", of: null }], timer: null },
    { n: 2, text: "Spin 10 min at 3000 rpm, 4 C.", say: "Spin 10 minutes at 3000 rpm, 4 degrees C.", note: null, amounts: [{ qty: "10", unit: "min", of: null }, { qty: "3000", unit: "rpm", of: null }], timer: { seconds: 600, label: "10 minutes" } },
    { n: 3, text: "Freeze at -80 C.", say: "Freeze at minus 80 degrees C.", note: null, amounts: [], timer: null },
  ];
  const current = over.current ?? 2;
  const status = over.status ?? "running";
  return {
    run: {
      id: "run_1", sessionId: "s1", hostId: null, protocolSlug: "x", protocolName: "TSS",
      snapshot: { steps } as never, current, status, scale: null,
      startedAt: new Date(NOW - 12 * 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), finishedAt: over.finishedAt ?? null,
    },
    view: {
      current: status === "running" || status === "paused" ? (steps[current - 1] as never) : null,
      next: (steps[current] as never) ?? null,
      stepLog: steps.map((s) => ({ n: s.n, text: s.text, startedAt: null, doneAt: s.n < current ? new Date(NOW).toISOString() : null, skipped: false, notes: [] })),
      timers: over.timerEndsAt ? [{ id: "t1", step: 2, seconds: 600, label: "10 minutes", startedAt: new Date(NOW).toISOString(), endsAt: over.timerEndsAt, state: "running" }] : [],
      notes: [],
      elapsedSeconds: 720,
      timedSteps: 1,
    },
  };
}

describe("lab mode replies", () => {
  it("speaks durations", () => {
    expect(durationWords(600)).toBe("10 minutes");
    expect(durationWords(61)).toBe("1 minute 1 second");
    expect(durationWords(5400)).toBe("1 hour 30 minutes");
    expect(durationWords(0)).toBe("0 seconds");
  });
  it("reads the current and next step", () => {
    expect(stepLine(payload())).toBe("Step 2 of 3. Spin 10 minutes at 3000 rpm, 4 degrees C.");
    expect(peekLine(payload())).toBe("Next is step 3. Freeze at minus 80 degrees C.");
    expect(peekLine(payload({ current: 3 }))).toBe("This is the last step.");
  });
  it("says what to do once the list is finished", () => {
    expect(afterAdvance(payload({ current: 3 }))).toBe("Step 3 of 3. Freeze at minus 80 degrees C.");
    expect(afterAdvance(payload({ current: 3, status: "done" }))).toBe("That was the last step. Say finish run to close it.");
    expect(afterAdvance(payload({ current: 3, status: "done", finishedAt: new Date(NOW).toISOString() }))).toBe("The run is finished.");
  });
  it("reports position and timers", () => {
    expect(whereLine(payload(), NOW)).toBe("You're on step 2 of 3, 1 done.");
    const timed = payload({ timerEndsAt: new Date(NOW + 6 * 60_000).toISOString() });
    expect(whereLine(timed, NOW)).toBe("You're on step 2 of 3, 1 done. A timer has 6 minutes left.");
    expect(timeLeftLine(timed, NOW)).toBe("6 minutes left.");
    expect(timeLeftLine(payload(), NOW)).toBe("No timer is running.");
  });
  it("reads a step's amounts when no material is named", () => {
    expect(stepAmountsLine(payload())).toBe("This step uses 10 minutes, 3000 rpm.");
    expect(stepAmountsLine(payload({ current: 3 }))).toBe("This step doesn't list any amounts. Say how much, then the material.");
  });
});
