// Box-side registry of connected desktops, keyed by account email → hostId.
// Each host has a writer for frames and a table of in-flight tunneled
// requests waiting on response frames.
import crypto from "node:crypto";
import type { BoxToHost, ChunkFrame, EndFrame, HostToBox, ParsedFrame, ResFrame } from "./protocol";

export interface PendingResponse {
  onHead: (frame: ResFrame) => void;
  onChunk: (frame: ChunkFrame) => void;
  onEnd: (frame: EndFrame) => void;
}

export interface HostConn {
  email: string;
  hostId: string;
  name: string;
  connectedAt: string;
  lastSeenAt: string;
  send: (frame: BoxToHost) => void;
  close: () => void;
  pending: Map<string, PendingResponse>;
  /** In-flight `parse` requests waiting on a `parsed` frame. */
  parses: Map<string, (frame: ParsedFrame) => void>;
}

const hosts = new Map<string, Map<string, HostConn>>();
/** Last-seen timestamps for hosts that have gone offline (for the hosts list). */
const lastSeen = new Map<string, Map<string, { name: string; at: string }>>();

export function registerHost(conn: HostConn): void {
  let byId = hosts.get(conn.email);
  if (!byId) {
    byId = new Map();
    hosts.set(conn.email, byId);
  }
  const prev = byId.get(conn.hostId);
  if (prev && prev !== conn) {
    try {
      prev.close();
    } catch {
      // ignore
    }
  }
  byId.set(conn.hostId, conn);
}

export function unregisterHost(conn: HostConn): void {
  const byId = hosts.get(conn.email);
  if (!byId || byId.get(conn.hostId) !== conn) return;
  byId.delete(conn.hostId);
  if (byId.size === 0) hosts.delete(conn.email);
  let seen = lastSeen.get(conn.email);
  if (!seen) {
    seen = new Map();
    lastSeen.set(conn.email, seen);
  }
  seen.set(conn.hostId, { name: conn.name, at: new Date().toISOString() });
  for (const p of conn.pending.values()) p.onEnd({ t: "end", id: "", error: "Host disconnected." });
  conn.pending.clear();
  for (const [reqId, resolve] of conn.parses) resolve({ t: "parsed", reqId, error: "This Mac went offline." });
  conn.parses.clear();
}

/** Ask a host to parse a protocol (and create the run's session). */
export function requestParse(
  conn: HostConn,
  req: { protocolSlug: string; sessionId?: string; user: string },
  timeoutMs = 15_000,
): Promise<ParsedFrame> {
  const reqId = newRequestId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.parses.delete(reqId);
      resolve({ t: "parsed", reqId, error: "The Mac did not answer in time." });
    }, timeoutMs);
    conn.parses.set(reqId, (frame) => {
      clearTimeout(timer);
      conn.parses.delete(reqId);
      resolve(frame);
    });
    conn.send({ t: "parse", reqId, protocolSlug: req.protocolSlug, ...(req.sessionId ? { sessionId: req.sessionId } : {}), user: req.user });
  });
}

/** The first connected host for an account, for callers that did not name one. */
export function anyHost(email: string): HostConn | undefined {
  return hosts.get(email)?.values().next().value;
}

export function getHost(email: string, hostId: string): HostConn | undefined {
  return hosts.get(email)?.get(hostId);
}

export function listHosts(email: string): { hostId: string; name: string; online: boolean; lastSeenAt: string | null }[] {
  const out = new Map<string, { hostId: string; name: string; online: boolean; lastSeenAt: string | null }>();
  for (const [hostId, c] of hosts.get(email) ?? []) {
    out.set(hostId, { hostId, name: c.name, online: true, lastSeenAt: c.lastSeenAt });
  }
  for (const [hostId, s] of lastSeen.get(email) ?? []) {
    if (!out.has(hostId)) out.set(hostId, { hostId, name: s.name, online: false, lastSeenAt: s.at });
  }
  return [...out.values()];
}

export function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Route a host→box frame to the pending request it belongs to. */
export function dispatchHostFrame(conn: HostConn, frame: HostToBox): void {
  if (frame.t === "parsed") {
    conn.parses.get(frame.reqId)?.(frame);
    return;
  }
  if (frame.t === "res" || frame.t === "chunk" || frame.t === "end") {
    const p = conn.pending.get(frame.id);
    if (!p) return;
    if (frame.t === "res") p.onHead(frame);
    else if (frame.t === "chunk") p.onChunk(frame);
    else {
      conn.pending.delete(frame.id);
      p.onEnd(frame);
    }
  }
}
