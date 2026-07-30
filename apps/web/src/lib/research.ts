// Client helpers for research runs: REST wrappers + a live event-stream hook.
// Server state is authoritative (persisted events replay on reconnect) — this
// deliberately does NOT follow chat-store's localStorage pattern.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ResearchEventEnvelope } from "@labee/contracts";
import { apiGet, apiSend } from "./api";

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
  created_at: string;
}

export interface ClaimRow {
  id: string;
  claim_type: string;
  text: string;
  source_tag: string;
  status: string;
  break_code: string | null;
}

export const listRuns = () => apiGet<{ runs: RunSummary[] }>("/api/research/runs");
export const getRun = (id: string) =>
  apiGet<{ run: RunSummary; spec: unknown; tasks: TaskRow[] }>(`/api/research/runs/${id}`);
export const createRun = (body: unknown) =>
  apiSend<{ run: RunSummary }>("POST", "/api/research/runs", body);
export const cancelRun = (id: string) =>
  apiSend<{ ok: boolean }>("POST", `/api/research/runs/${id}/cancel`);
export const answerGate = (id: string, gate: string, approve: boolean) =>
  apiSend<{ ok: boolean }>("POST", `/api/research/runs/${id}/gate`, { gate, approve });
export const listArtifacts = (id: string) =>
  apiGet<{ artifacts: ArtifactRow[] }>(`/api/research/runs/${id}/artifacts`);
export const listClaims = (id: string) =>
  apiGet<{ claims: ClaimRow[] }>(`/api/research/runs/${id}/claims`);
export const artifactFileUrl = (id: string, relPath: string) =>
  `/api/research/runs/${id}/artifacts/file?path=${encodeURIComponent(relPath)}`;

export interface LiveRunState {
  events: ResearchEventEnvelope[];
  /** Streaming text per live task id (agent_delta accumulation, capped). */
  liveText: Record<string, string>;
  status: string | null;
  stage: string | null;
  pendingGate: string | null;
  connected: boolean;
}

const MAX_EVENTS = 1500;
const MAX_LIVE_TEXT = 4000;

/** Subscribe to a run's SSE feed; replays persisted events then tails live. */
export function useRunEvents(runId: string | null): LiveRunState {
  const [state, setState] = useState<LiveRunState>({
    events: [],
    liveText: {},
    status: null,
    stage: null,
    pendingGate: null,
    connected: false,
  });
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!runId) return;
    lastSeq.current = 0;
    setState({ events: [], liveText: {}, status: null, stage: null, pendingGate: null, connected: false });
    const source = new EventSource(`/api/research/runs/${runId}/events?after=0`, {
      withCredentials: true,
    });
    source.addEventListener("open", () => setState((s) => ({ ...s, connected: true })));
    source.addEventListener("error", () => setState((s) => ({ ...s, connected: false })));
    source.addEventListener("run_event", (raw) => {
      let evt: ResearchEventEnvelope;
      try {
        evt = JSON.parse((raw as MessageEvent).data) as ResearchEventEnvelope;
      } catch {
        return;
      }
      setState((s) => {
        const next: LiveRunState = { ...s };
        if (evt.type === "agent_delta") {
          const key = evt.taskId ?? "unknown";
          const text = ((s.liveText[key] ?? "") + String((evt.data as { text?: string })?.text ?? "")).slice(
            -MAX_LIVE_TEXT,
          );
          next.liveText = { ...s.liveText, [key]: text };
          return next;
        }
        if (evt.seq > 0 && evt.seq <= lastSeq.current) return s;
        if (evt.seq > 0) lastSeq.current = evt.seq;
        next.events = [...s.events, evt].slice(-MAX_EVENTS);
        if (evt.type === "run_status") {
          const data = evt.data as { status?: string };
          if (data?.status) next.status = data.status;
          if (evt.stage) next.stage = evt.stage;
        }
        if (evt.type === "stage_started" && evt.stage) next.stage = evt.stage;
        if (evt.type === "gate_waiting") {
          next.pendingGate = String((evt.data as { gate?: string })?.gate ?? "");
        }
        if (evt.type === "gate_passed" || evt.type === "gate_failed") next.pendingGate = null;
        return next;
      });
    });
    return () => source.close();
  }, [runId]);

  return useMemo(() => state, [state]);
}

export const STAGES = ["investigate", "discover", "write", "verify"] as const;

export function stageLabel(stage: string): string {
  switch (stage) {
    case "investigate":
      return "1 · Investigate";
    case "discover":
      return "2 · Discover";
    case "write":
      return "3 · Write";
    case "verify":
      return "4 · Verify";
    default:
      return stage;
  }
}

export function statusTone(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600";
    case "failed":
      return "text-destructive";
    case "cancelled":
    case "interrupted":
      return "text-ink-faint";
    case "awaiting_gate":
      return "text-amber-600";
    default:
      return "text-sky-600";
  }
}
