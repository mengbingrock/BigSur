// Single emission path for run events: persist (except high-frequency agent
// deltas, which are live-only) then publish to in-memory subscribers. The SSE
// route replays persisted rows, then tails the pubsub.
import type { ResearchEventEnvelope, ResearchEventType, ResearchStage } from "@labee/contracts";
import { insertEvent } from "./runsDb";
import { publish } from "./registry";

/** Event types that are never persisted — full transcripts live on disk. */
const LIVE_ONLY = new Set<ResearchEventType>(["agent_delta", "agent_tool"]);

export interface EmitOpts {
  taskId?: string | null;
  stage?: ResearchStage | null;
  role?: string | null;
  branch?: string | null;
}

export async function emitRunEvent(
  runId: string,
  type: ResearchEventType,
  data: unknown,
  opts: EmitOpts = {},
): Promise<void> {
  let seq = 0;
  let ts = new Date().toISOString();
  if (!LIVE_ONLY.has(type)) {
    const inserted = await insertEvent({
      runId,
      taskId: opts.taskId ?? null,
      stage: opts.stage ?? null,
      role: opts.role ?? null,
      branch: opts.branch ?? null,
      type,
      data,
    });
    seq = inserted.seq;
    ts = inserted.ts;
  }
  const envelope: ResearchEventEnvelope = {
    seq,
    runId,
    ts,
    type,
    stage: opts.stage ?? null,
    role: opts.role ?? null,
    taskId: opts.taskId ?? null,
    branch: opts.branch ?? null,
    data: data ?? {},
  };
  publish(runId, envelope);
}

/** Convert a persisted research_events row back into an SSE envelope. */
export function rowToEnvelope(row: Record<string, unknown>): ResearchEventEnvelope {
  let data: unknown = {};
  try {
    data = JSON.parse(String(row.data ?? "{}"));
  } catch {
    // leave {}
  }
  return {
    seq: Number(row.seq),
    runId: String(row.run_id),
    ts: String(row.created_at),
    type: String(row.type) as ResearchEventType,
    stage: (row.stage as ResearchStage | null) ?? null,
    role: (row.role as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    data,
  };
}
