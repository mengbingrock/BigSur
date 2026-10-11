// Protocol runs (docs/protocol-run-design.md §2.3). Box-owned, so every call
// goes to the account server (the root target), never through a Mac's
// tunnel; `hostId` travels in the body so the box knows which Mac holds the
// session. A desktop in dev forwards these to the box itself.
import type { ProtocolSnapshot, Step } from "@labee/session-core";
import { apiGet, apiSend, type Target } from "./client";

export type RunStatus = "running" | "paused" | "done" | "abandoned";

export interface RunScale {
  base: { qty: number; unit: string };
  actual: { qty: number; unit: string };
}

export interface Run {
  id: string;
  sessionId: string;
  hostId: string | null;
  protocolSlug: string;
  protocolName: string;
  snapshot: ProtocolSnapshot;
  current: number;
  status: RunStatus;
  scale: RunScale | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
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

export interface StepLogEntry {
  n: number;
  text: string;
  startedAt: string | null;
  doneAt: string | null;
  skipped: boolean;
  notes: string[];
}

export interface RunView {
  current: Step | null;
  next: Step | null;
  stepLog: StepLogEntry[];
  timers: RunTimer[];
  notes: Array<{ step: number; text: string; ts: string; device?: string }>;
  elapsedSeconds: number;
  timedSteps: number;
}

export interface RunPayload {
  run: Run;
  view: RunView;
}

export interface RunListItem {
  id: string;
  sessionId: string;
  hostId: string | null;
  protocolSlug: string;
  protocolName: string;
  status: RunStatus;
  current: number;
  total: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  elapsedSeconds: number;
  timerEndsAt: string | null;
  notes: number;
  /** Steps completed (a finished run may have fewer than `total`). */
  done: number;
}

export interface AmountAnswer {
  found: boolean;
  text: string;
  say: string;
  step: number | null;
  computed: { qty: number; unit: string; text: string } | null;
  source: string;
}

/** Runs always go to the account server. */
const root = (t: Target): Target => ({ base: t.base });

export const startRun = (t: Target, body: { protocolSlug: string; sessionId?: string; scale?: RunScale | null }) =>
  apiSend<RunPayload>(root(t), "POST", "/api/runs", { ...body, ...(t.hostId ? { hostId: t.hostId } : {}) });
export const listRuns = (t: Target) => apiGet<{ runs: RunListItem[] }>(root(t), "/api/runs");
export const getRun = (t: Target, id: string) => apiGet<RunPayload & { events: unknown[] }>(root(t), `/api/runs/${encodeURIComponent(id)}`);
export const activeRun = (t: Target) => apiGet<RunPayload>(root(t), "/api/runs/active");

type Action = "advance" | "back" | "skip" | "note" | "timer" | "pause" | "resume" | "finish" | "abandon" | "jump" | "scale" | "timer-done";
export const runAction = <T = RunPayload>(t: Target, id: string, action: Action, body: Record<string, unknown> = {}) =>
  apiSend<T>(root(t), "POST", `/api/runs/${encodeURIComponent(id)}/${action}`, body);
export const cancelRunTimer = (t: Target, id: string, timerId: string) =>
  apiSend<RunPayload>(root(t), "DELETE", `/api/runs/${encodeURIComponent(id)}/timer/${encodeURIComponent(timerId)}`);
export const amountFor = (t: Target, id: string, material: string, step?: number) =>
  apiSend<AmountAnswer>(root(t), "POST", `/api/runs/${encodeURIComponent(id)}/amount`, { material, ...(step ? { step } : {}) });
