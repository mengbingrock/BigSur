import { apiGet, apiSend, apiText, urlFor, type Target } from "./client";
import { openEventStream, type EventStreamHandle } from "./sse";

export interface RunSummary {
  id: string;
  title: string;
  question: string;
  status: string;
  stage: string | null;
  failReason: string | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  pendingGates: string[];
}
export interface TaskRow {
  id: string;
  stage: string;
  role: string;
  branch: string | null;
  status: string;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  started_at: string | null;
}
export interface ArtifactRow {
  id: string;
  kind: string;
  stage: string;
  rel_path: string;
  bytes: number;
}
export interface RunEvent {
  seq: number;
  runId: string;
  ts: string;
  type: string;
  stage: string | null;
  role: string | null;
  taskId: string | null;
  branch: string | null;
  data: Record<string, unknown>;
}

export const listRuns = (t: Target) => apiGet<{ runs: RunSummary[] }>(t, "/api/research/runs");
export const getRun = (t: Target, id: string) =>
  apiGet<{ run: RunSummary; spec: unknown; tasks: TaskRow[] }>(t, `/api/research/runs/${id}`);
export const cancelRun = (t: Target, id: string) => apiSend<{ ok: true }>(t, "POST", `/api/research/runs/${id}/cancel`);
export const answerGate = (t: Target, id: string, gate: string, approve: boolean) =>
  apiSend<{ ok: true }>(t, "POST", `/api/research/runs/${id}/gate`, { gate, approve });
export const listArtifacts = (t: Target, id: string) =>
  apiGet<{ artifacts: ArtifactRow[] }>(t, `/api/research/runs/${id}/artifacts`);
export const artifactText = (t: Target, id: string, relPath: string) =>
  apiText(t, `/api/research/runs/${id}/artifacts/file?path=${encodeURIComponent(relPath)}`);

export function openRunEvents(t: Target, id: string, after: number, onEvent: (e: RunEvent) => void, onError?: (e: unknown) => void): EventStreamHandle {
  return openEventStream(urlFor(t, `/api/research/runs/${id}/events?after=${after}`), {
    eventName: "run_event",
    onEvent: (d) => onEvent(d as unknown as RunEvent),
    ...(onError ? { onError } : {}),
  });
}
