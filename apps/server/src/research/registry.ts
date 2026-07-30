// In-memory state for live runs: abort signal, child-process reapers, gate
// resolvers, and the per-run event pubsub. Nothing here survives a restart —
// the boot sweep marks any DB rows that claim otherwise as interrupted.
import type { ResearchEventEnvelope } from "@labee/contracts";

export type EventListener = (evt: ResearchEventEnvelope) => void;

export interface RunHandle {
  runId: string;
  abort: AbortController;
  /** kill() functions for every live CLI child of this run. */
  kills: Set<() => void>;
  /** Pending human gates keyed by gate name. */
  gateResolvers: Map<string, (approve: boolean) => void>;
  listeners: Set<EventListener>;
}

const live = new Map<string, RunHandle>();

export function registerRun(runId: string): RunHandle {
  const handle: RunHandle = {
    runId,
    abort: new AbortController(),
    kills: new Set(),
    gateResolvers: new Map(),
    listeners: new Set(),
  };
  live.set(runId, handle);
  return handle;
}

export function getRunHandle(runId: string): RunHandle | undefined {
  return live.get(runId);
}

export function unregisterRun(runId: string): void {
  live.delete(runId);
}

/** Subscribe to a run's live events; returns the unsubscribe function.
 *  Safe to call for finished runs (events just never arrive). */
export function subscribeRun(runId: string, listener: EventListener): () => void {
  const handle = live.get(runId);
  if (!handle) return () => {};
  handle.listeners.add(listener);
  return () => handle.listeners.delete(listener);
}

export function publish(runId: string, evt: ResearchEventEnvelope): void {
  const handle = live.get(runId);
  if (!handle) return;
  for (const listener of handle.listeners) {
    try {
      listener(evt);
    } catch {
      // a broken subscriber must not take down the run
    }
  }
}

/** Interrupt a run: abort its signal and SIGTERM every live child. */
export function interruptRun(runId: string): boolean {
  const handle = live.get(runId);
  if (!handle) return false;
  handle.abort.abort();
  for (const kill of handle.kills) {
    try {
      kill();
    } catch {
      // already gone
    }
  }
  // Unblock any pending gate so the run fiber can observe the abort.
  for (const [, resolve] of handle.gateResolvers) resolve(false);
  handle.gateResolvers.clear();
  return true;
}
