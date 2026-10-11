// Where a run meets its session (design §2.2). A run event becomes a quiet
// transcript line in the session that tracks it, and `finished` starts the
// write-up turn. Two entry points, same effect:
//
//   - locally owned runs (this server created them and holds the session):
//     the service's listener below;
//   - runs the box owns while this server holds the session (a Mac behind
//     the Device Link): `applyRemoteRunEvent`, fed by `run` frames.
import * as sdb from "../sessions/db";
import * as runner from "../sessions/runner";
import * as rdb from "./db";
import type { RunEventRow, RunRow } from "./db";
import { transcriptLine } from "./describe";
import { subscribeRunEvents, viewOf, writeupPrompt } from "./service";

/** Append the transcript line for an event and, on `finished`, ask the agent
 *  for the write-up. Idempotent per (run, seq) through the message meta. */
export async function reflectInSession(run: RunRow, event: RunEventRow): Promise<void> {
  const session = await sdb.getSessionById(run.sessionId);
  if (!session) return;
  const line = transcriptLine(run, event);
  if (line) {
    const existing = await sdb.listMessages(session.id);
    const dup = existing.some((m) => m.role === "system" && m.meta?.runId === run.id && m.meta?.seq === event.seq);
    if (!dup) {
      await runner.emitSystemMessage(session.id, line, {
        runId: run.id,
        seq: event.seq,
        type: event.type,
        ...(typeof event.data.step === "number" ? { step: event.data.step } : {}),
        ...(typeof event.data.device === "string" ? { device: event.data.device } : {}),
      });
    }
  }
  if (event.type === "finished") {
    const view = await viewOf(run);
    const d = new Date(run.startedAt);
    const dateLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await runner.startTurn(session.email, session.id, {
      text: writeupPrompt(view, dateLabel),
      device: "Labee",
      runMode: "build",
      skillSlugs: [run.protocolSlug],
    });
  }
}

/** Host side: take the box's copy of a run event, keep a local copy of the
 *  run, and reflect it. Returns false when the event was already held. */
export async function applyRemoteRunEvent(run: RunRow, event: RunEventRow): Promise<boolean> {
  await rdb.upsertRun(run);
  const fresh = await rdb.insertRunEvent(event);
  if (!fresh) return false;
  await reflectInSession(run, event);
  return true;
}

let started = false;

/** Reflect locally owned runs. Safe to call more than once. */
export function startSessionBridge(): void {
  if (started) return;
  started = true;
  subscribeRunEvents((run, event) => {
    if (run.hostId) return; // the box pushes these to the host that holds the session
    void reflectInSession(run, event).catch((e) => console.warn("[runs] reflect failed:", e instanceof Error ? e.message : e));
  });
}
