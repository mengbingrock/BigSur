// Box side of run state on the Device Link (design §2.2): push each event of
// a host-held run down to that host as a `run` frame, and replay what a host
// missed when it reconnects. The host acknowledges with `runack`, which marks
// events applied, so a Mac that slept through a run catches up in order.
import { getHost, type HostConn } from "../deviceLink/hosts";
import * as rdb from "./db";
import type { RunEventRow, RunRow } from "./db";
import { subscribeRunEvents } from "./service";

function frameFor(run: RunRow, event: RunEventRow) {
  return { t: "run" as const, run: run as unknown as Record<string, unknown>, event };
}

/** Send a host every event it has not acknowledged, oldest first. */
export async function replayRunsTo(conn: HostConn): Promise<number> {
  const pending = await rdb.listUnappliedEvents(conn.email, conn.hostId);
  if (pending.length) console.log(`[runs] replaying ${pending.length} run event(s) to ${conn.hostId}`);
  for (const { run, event } of pending) conn.send(frameFor(run, event));
  return pending.length;
}

export async function ackRunEvents(conn: HostConn, runId: string, seqs: number[]): Promise<void> {
  const run = await rdb.getRun(runId);
  if (!run || run.email !== conn.email || run.hostId !== conn.hostId) return;
  await rdb.markApplied(runId, seqs);
}

let started = false;

export function startLinkBridge(): void {
  if (started) return;
  started = true;
  subscribeRunEvents((run, event) => {
    if (!run.hostId) return;
    const host = getHost(run.email, run.hostId);
    if (host) host.send(frameFor(run, event));
    // Offline: the event stays unapplied and is replayed on connect.
  });
}
