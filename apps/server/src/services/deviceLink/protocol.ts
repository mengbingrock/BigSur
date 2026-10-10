// Wire frames on the Device Link WebSocket between a desktop (host) and the
// box (relay). JSON text frames; binary bodies are base64. See design §5.2.

/** Desktop → box on connect. */
export interface HelloFrame {
  t: "hello";
  hostId: string;
  name: string;
  version: string;
  caps: string[];
}
/** Box → desktop: a phone's HTTP request to tunnel. */
export interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  path: string; // path + query, e.g. /api/sessions/x/events?after=3
  headers: Record<string, string>;
  body?: string; // base64
  /** Account email the box authenticated (the desktop trusts the box). */
  user: string;
}
/** Desktop → box: response head, chunks, end. */
export interface ResFrame {
  t: "res";
  id: string;
  status: number;
  headers: Record<string, string>;
}
export interface ChunkFrame {
  t: "chunk";
  id: string;
  data: string; // base64
}
export interface EndFrame {
  t: "end";
  id: string;
  error?: string;
}
/** Box → desktop: cancel a tunneled request (phone went away). */
export interface AbortFrame {
  t: "abort";
  id: string;
}
/** Desktop → box: mirror writes (persisted events, session summaries, messages). */
export interface MirrorFrame {
  t: "mirror";
  session?: Record<string, unknown>;
  event?: Record<string, unknown>;
  messages?: { sessionId: string; items: Record<string, unknown>[] };
  /** A session deleted on the host; the box drops every mirrored trace of it. */
  deleted?: string;
  /** The complete set of session ids this host holds for the account. The box
   *  drops any mirror for this host that is not in it — sessions deleted
   *  before deletions were announced, or never this account's to begin with. */
  sessionIds?: string[];
  /** Ask the box to push a notification to this account's devices. The
   *  category and interruption level ride along so a host can send a
   *  time-sensitive reply with buttons, as the box does for its own. */
  notify?: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
    categoryId?: string;
    interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  };
}
export interface PingFrame {
  t: "ping";
  ts: number;
}
export interface PongFrame {
  t: "pong";
  ts: number;
}
/** Box → desktop: acknowledged hello. */
export interface WelcomeFrame {
  t: "welcome";
  email: string;
  hostId: string;
}

// --- protocol runs (docs/protocol-run-design.md §2.2) ----------------------
// The box owns run state; the host holds the session. Events flow down, the
// host reflects them into the transcript and acknowledges; the box asks the
// host to parse a protocol it does not have.

/** Box → host: one run event, with the run's current row. */
export interface RunFrame {
  t: "run";
  run: Record<string, unknown>;
  event: { runId: string; seq: number; ts: string; type: string; data: Record<string, unknown> };
}
/** Host → box: these events are reflected in the transcript. */
export interface RunAckFrame {
  t: "runack";
  runId: string;
  seqs: number[];
}
/** Box → host: parse this protocol (and create the session for a run). */
export interface ParseFrame {
  t: "parse";
  reqId: string;
  protocolSlug: string;
  /** An existing session to bind, else the host creates one. */
  sessionId?: string;
  user: string;
}
/** Host → box: the frozen snapshot, or why not. */
export interface ParsedFrame {
  t: "parsed";
  reqId: string;
  snapshot?: Record<string, unknown>;
  sessionId?: string;
  protocolName?: string;
  error?: string;
}

export type HostToBox = HelloFrame | ResFrame | ChunkFrame | EndFrame | MirrorFrame | PingFrame | PongFrame | RunAckFrame | ParsedFrame;
export type BoxToHost = WelcomeFrame | ReqFrame | AbortFrame | PingFrame | PongFrame | RunFrame | ParseFrame;

export const LINK_VERSION = "1";
