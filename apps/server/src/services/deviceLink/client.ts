// Desktop side of the Device Link (design §5.2): dial the box, answer
// tunneled requests against the local loopback server, and mirror session
// events/summaries/messages up so phones can read them while the Mac sleeps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as sdb from "../sessions/db";
import { subscribeAll } from "../sessions/runner";
import { toSummary } from "../../routes/sessions";
import { boxSessionCookie, isDesktop, proxyServerBase } from "../llmSettings";
import type { BoxToHost, HostToBox } from "./protocol";
import { LINK_VERSION } from "./protocol";
import { ensureLinkSecret } from "./secret";

const CHUNK = 64 * 1024;
const HEARTBEAT_MS = 20_000;

export interface LinkClientOptions {
  /** Box origin (default: LABEE_SKILLS_SERVER / https://labee.online). */
  base?: string;
  /** Local server port to replay requests against. */
  port?: number;
  /** Host display name (default: os.hostname()). */
  name?: string;
  /** Called on every state change (tests). */
  onState?: (state: LinkState) => void;
}

export type LinkState = "disabled" | "no_session" | "connecting" | "connected" | "reconnecting";

let started = false;
let currentState: LinkState = "disabled";
let ws: WebSocket | null = null;

export function linkState(): LinkState {
  return currentState;
}

function hostIdFile(): string {
  const dir = process.env.LABEE_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "link-host-id.txt");
}

export function stableHostId(): string {
  const file = hostIdFile();
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch {
    // create below
  }
  const id = `host_${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch {
    // best effort
  }
  return id;
}

/** Start the client once. No-op outside desktop mode. Never throws. */
export function startLinkClient(opts: LinkClientOptions = {}): void {
  if (started) return;
  started = true;
  if (!isDesktop() && !opts.base) {
    setState("disabled", opts);
    return;
  }
  console.log(`[link] starting Device Link client → ${(opts.base ?? proxyServerBase()).replace(/\/+$/, "")} (session file: ${process.env.LABEE_REMOTE_SESSION_FILE ?? "unset"})`);
  void loop(opts);
}

function setState(s: LinkState, opts: LinkClientOptions) {
  if (s !== currentState) console.log(`[link] ${currentState} → ${s}`);
  currentState = s;
  opts.onState?.(s);
}

async function loop(opts: LinkClientOptions): Promise<void> {
  const base = (opts.base ?? proxyServerBase()).replace(/\/+$/, "");
  const port = opts.port ?? Number(process.env.LABEE_PORT ?? process.env.PORT ?? 3000);
  const secret = ensureLinkSecret();
  const hostId = stableHostId();
  const name = opts.name ?? os.hostname();
  let backoff = 1000;
  while (true) {
    const cookie = boxSessionCookie();
    if (!cookie) {
      setState("no_session", opts);
      await sleep(30_000);
      continue;
    }
    setState(currentState === "connected" ? "reconnecting" : "connecting", opts);
    let token: string | null = null;
    try {
      const res = await fetch(`${base}/api/link/host-token`, { method: "POST", headers: { cookie, accept: "application/json" } });
      if (res.ok) token = ((await res.json()) as { token?: string }).token ?? null;
    } catch {
      token = null;
    }
    if (!token) {
      console.warn(`[link] could not get a link token from ${base} (is the desktop connected to Labee? retry in ${backoff}ms)`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    const wsUrl = `${base.replace(/^http/, "ws")}/api/link/host?token=${encodeURIComponent(token)}`;
    const ok = await runSocket(wsUrl, { hostId, name, port, secret }, opts);
    backoff = ok ? 1000 : Math.min(backoff * 2, 60_000);
    await sleep(backoff);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One socket lifetime. Resolves true if the socket ever reached `welcome`. */
function runSocket(
  url: string,
  cfg: { hostId: string; name: string; port: number; secret: string },
  opts: LinkClientOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let welcomed = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    ws = socket;
    const inflight = new Map<string, AbortController>();
    const send = (frame: HostToBox) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > HEARTBEAT_MS * 2.5) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      }
      send({ t: "ping", ts: Date.now() });
    }, HEARTBEAT_MS);

    // Mirror: every persisted event + a summary; messages at turn boundaries.
    const summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const pushSummary = (sessionId: string) => {
      if (summaryTimers.has(sessionId)) return;
      summaryTimers.set(
        sessionId,
        setTimeout(async () => {
          summaryTimers.delete(sessionId);
          const s = await sdb.getSessionById(sessionId).catch(() => null);
          if (s) send({ t: "mirror", session: toSummary(s, (await sdb.listQueue(sessionId).catch(() => [])).length) });
        }, 250),
      );
    };
    const pushMessages = async (sessionId: string) => {
      const msgs = await sdb.listMessages(sessionId).catch(() => []);
      send({ t: "mirror", messages: { sessionId, items: msgs.slice(-4) as unknown as Record<string, unknown>[] } });
    };
    const unsubscribe = subscribeAll((evt) => {
      if (!welcomed) return;
      if (evt.seq > 0) {
        void (async () => {
          const s = await sdb.getSessionById(evt.sessionId).catch(() => null);
          send({ t: "mirror", event: evt as unknown as Record<string, unknown>, ...(s ? { session: toSummary(s) } : {}) });
        })();
      }
      pushSummary(evt.sessionId);
      if (evt.type === "turn_ended" || evt.type === "turn_cancelled" || evt.type === "question_answered" || evt.type === "turn_started") {
        void pushMessages(evt.sessionId);
      }
    });

    const fullSync = async () => {
      // Sessions of every local account: the desktop is single-user in practice.
      const rows = await sdb.listRunningSessions().catch(() => []);
      void rows;
      const all = await allSessions();
      for (const s of all.slice(0, 50)) {
        send({ t: "mirror", session: toSummary(s) });
        await pushMessages(s.id);
      }
    };

    socket.addEventListener("open", () => {
      send({ t: "hello", hostId: cfg.hostId, name: cfg.name, version: LINK_VERSION, caps: ["sessions", "research", "transcribe"] });
    });
    socket.addEventListener("message", (ev) => {
      let frame: BoxToHost;
      try {
        frame = JSON.parse(String(ev.data)) as BoxToHost;
      } catch {
        return;
      }
      if (frame.t === "welcome") {
        welcomed = true;
        console.log(`[link] connected as ${frame.email}, host ${frame.hostId}`);
        setState("connected", opts);
        void fullSync();
        return;
      }
      if (frame.t === "pong") {
        lastPong = Date.now();
        return;
      }
      if (frame.t === "ping") {
        lastPong = Date.now();
        send({ t: "pong", ts: frame.ts });
        return;
      }
      if (frame.t === "abort") {
        inflight.get(frame.id)?.abort();
        inflight.delete(frame.id);
        return;
      }
      if (frame.t === "req") {
        const ctrl = new AbortController();
        inflight.set(frame.id, ctrl);
        void replay(frame, cfg, send, ctrl.signal).finally(() => inflight.delete(frame.id));
      }
    });
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe();
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      if (ws === socket) ws = null;
      setState(welcomed ? "reconnecting" : "connecting", opts);
      resolve(welcomed);
    };
    socket.addEventListener("close", done);
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  });
}

async function allSessions(): Promise<sdb.SessionRow[]> {
  // The desktop has one local account, but list per known email to stay correct.
  const { getDb } = await import("../db");
  const db = await getDb();
  const rows = db.prepare("SELECT DISTINCT email FROM chat_sessions").all();
  const out: sdb.SessionRow[] = [];
  for (const r of rows) out.push(...(await sdb.listSessions(String(r.email), { limit: 50 })));
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Replay a tunneled request against the local server and stream it back. */
async function replay(
  frame: Extract<BoxToHost, { t: "req" }>,
  cfg: { port: number; secret: string },
  send: (f: HostToBox) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${frame.path}`, {
      method: frame.method,
      headers: { ...frame.headers, "x-labee-link-user": frame.user, "x-labee-link-secret": cfg.secret },
      ...(frame.body ? { body: Buffer.from(frame.body, "base64") } : {}),
      signal,
      // @ts-expect-error node/bun fetch: needed to send a body with GET-less methods
      duplex: "half",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    send({ t: "res", id: frame.id, status: res.status, headers });
    if (!res.body) {
      send({ t: "end", id: frame.id });
      return;
    }
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.byteLength; i += CHUNK) {
        send({ t: "chunk", id: frame.id, data: Buffer.from(value.subarray(i, i + CHUNK)).toString("base64") });
      }
    }
    send({ t: "end", id: frame.id });
  } catch (e) {
    if (signal.aborted) return;
    send({ t: "end", id: frame.id, error: e instanceof Error ? e.message : String(e) });
  }
}

export function stopLinkClient(): void {
  try {
    ws?.close();
  } catch {
    // ignore
  }
}
