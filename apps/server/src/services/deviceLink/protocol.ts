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
  /** Ask the box to push a notification to this account's devices. */
  notify?: { title: string; body: string; data?: Record<string, unknown> };
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

export type HostToBox = HelloFrame | ResFrame | ChunkFrame | EndFrame | MirrorFrame | PingFrame | PongFrame;
export type BoxToHost = WelcomeFrame | ReqFrame | AbortFrame | PingFrame | PongFrame;

export const LINK_VERSION = "1";
