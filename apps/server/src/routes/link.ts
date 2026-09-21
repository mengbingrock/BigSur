// Device Link (design §5): the box side of the relay — desktops dial in over a
// WebSocket, phones reach a desktop through /api/hosts/:hostId/*, the box keeps
// a read-only mirror for when the Mac is asleep, and manages paired devices +
// push tokens. The pending-approval routes also work on a desktop, where they
// proxy to the box with the desktop's linked session.
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CloseEvent as SocketCloseEvent } from "effect/unstable/socket/Socket";
import { bodyJson, error, json, requestUrl, sessionUser } from "../httpKit";
import * as devices from "../services/deviceLink/devices";
import { dispatchHostFrame, getHost, listHosts, newRequestId, registerHost, unregisterHost, type HostConn } from "../services/deviceLink/hosts";
import * as mirror from "../services/deviceLink/mirror";
import type { BoxToHost, HostToBox } from "../services/deviceLink/protocol";
import { boxSessionCookie, isDesktop, proxyServerBase } from "../services/llmSettings";
import { linkState, stableHostId } from "../services/deviceLink/client";
import { sendPush } from "../services/push";
import { readLinkToken, sealLinkToken } from "../services/session";

const params = HttpRouter.params;

/** Box → host heartbeat. A host that misses 2.5 intervals is dropped, which
 *  is how a Mac that lost power or network shows as offline even when the TCP
 *  socket lingers. Tests shorten it via LABEE_LINK_PING_MS. */
const PING_MS = Math.max(200, Number(process.env.LABEE_LINK_PING_MS ?? 15_000) || 15_000);

/** Synchronous JSON response (for use inside plain promises). */
const jsonNow = (body: unknown, status: number) =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: "application/json" });
const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** Phones currently tailing a session's events through the tunnel, so the box
 *  can skip "turn finished" pushes when someone is already watching. */
const watching = new Map<string, number>();
const watchKey = (email: string, hostId: string, sessionId: string) => `${email}\u0000${hostId}\u0000${sessionId}`;

// ---------------------------------------------------------------- host socket

export const hostTokenRoute = HttpRouter.add(
  "POST",
  "/api/link/host-token",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const token = yield* Effect.promise(() => sealLinkToken(user.email));
    return yield* json({ token });
  }),
);

export const hostSocketRoute = HttpRouter.add(
  "GET",
  "/api/link/host",
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const email = yield* Effect.promise(() => readLinkToken(url.searchParams.get("token") ?? undefined));
    if (!email) return yield* error("Invalid or expired link token.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        let conn: HostConn | null = null;
        let lastSeenMs = Date.now();
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const send = (frame: BoxToHost) => {
          Effect.runPromise(write(JSON.stringify(frame))).catch(() => {});
        };
        const onFrame = (raw: string | Uint8Array) => {
          let frame: HostToBox;
          try {
            frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as HostToBox;
          } catch {
            return;
          }
          if (frame.t === "hello") {
            conn = {
              email,
              hostId: String(frame.hostId).slice(0, 64),
              name: String(frame.name).slice(0, 64),
              connectedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              send,
              close: () => {
                Effect.runPromise(write(new SocketCloseEvent(4000, "replaced"))).catch(() => {});
              },
              pending: new Map(),
            };
            registerHost(conn);
            send({ t: "welcome", email, hostId: conn.hostId });
            lastSeenMs = Date.now();
            heartbeat = setInterval(() => {
              if (Date.now() - lastSeenMs > PING_MS * 2.5) {
                const c = conn!;
                conn = null;
                unregisterHost(c);
                Effect.runPromise(write(new SocketCloseEvent(4001, "heartbeat timeout"))).catch(() => {});
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = null;
                return;
              }
              send({ t: "ping", ts: Date.now() });
            }, PING_MS);
            return;
          }
          if (!conn) return;
          lastSeenMs = Date.now();
          conn.lastSeenAt = new Date().toISOString();
          if (frame.t === "ping") {
            send({ t: "pong", ts: frame.ts });
            return;
          }
          if (frame.t === "pong") return;
          if (frame.t === "mirror") {
            void handleMirror(conn, frame);
            return;
          }
          dispatchHostFrame(conn, frame);
        };
        yield* socket.runRaw(onFrame).pipe(Effect.catch(() => Effect.void));
        if (heartbeat) clearInterval(heartbeat);
        if (conn) unregisterHost(conn);
      }),
    );
    return HttpServerResponse.empty();
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 })))),
);

async function handleMirror(conn: HostConn, frame: Extract<HostToBox, { t: "mirror" }>): Promise<void> {
  const { email, hostId } = conn;
  try {
    if (frame.session) await mirror.upsertMirrorSession(email, hostId, { ...frame.session, hostId });
    if (frame.messages) await mirror.upsertMirrorMessages(email, hostId, frame.messages.sessionId, frame.messages.items);
    if (frame.event) {
      await mirror.insertMirrorEvent(email, hostId, frame.event);
      const evt = frame.event as { type?: string; sessionId?: string; data?: Record<string, unknown> };
      const sessionId = String(evt.sessionId ?? "");
      const title = String((frame.session as { title?: string } | undefined)?.title ?? "Labee");
      if (evt.type === "question_asked") {
        await sendPush(email, { title, body: "Labee is asking you a question.", data: { sessionId, hostId, kind: "question" } });
      } else if (evt.type === "turn_ended") {
        const err = typeof evt.data?.error === "string" ? evt.data.error : null;
        const beingWatched = (watching.get(watchKey(email, hostId, sessionId)) ?? 0) > 0;
        if (err) await sendPush(email, { title, body: `Turn failed: ${err.slice(0, 120)}`, data: { sessionId, hostId, kind: "error" } });
        else if (!beingWatched && !evt.data?.question) {
          const content = typeof evt.data?.content === "string" ? evt.data.content : "";
          await sendPush(email, { title, body: content ? content.slice(0, 140) : "Turn finished.", data: { sessionId, hostId, kind: "done" } });
        }
      }
    }
    if (frame.notify) await sendPush(email, frame.notify);
  } catch (e) {
    console.warn("[link] mirror write failed:", e instanceof Error ? e.message : e);
  }
}

// ------------------------------------------------------------------- tunnel

const FORWARD_HEADERS = ["content-type", "accept", "x-labee-device", "last-event-id", "cache-control"];
const MIRROR_READ = /^\/api\/sessions(?:\/([^/?]+)(?:\/events)?)?(?:\?.*)?$/;

export const tunnelRoute = HttpRouter.add(
  "*",
  "/api/hosts/:hostId/*",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const p = yield* params;
    const hostId = p.hostId ?? "";
    const request = yield* HttpServerRequest.HttpServerRequest;
    const prefix = `/api/hosts/${hostId}`;
    const raw = request.url;
    const idx = raw.indexOf(prefix);
    const rest = idx === -1 ? `/${p["*"] ?? ""}` : raw.slice(idx + prefix.length) || "/";
    const host = getHost(user.email, hostId);

    if (!host) {
      const served = yield* serveFromMirror(user.email, hostId, request.method, rest);
      if (served) return served;
      return yield* error("This Mac is offline.", 503);
    }

    const bodyBuf = request.method === "GET" || request.method === "HEAD" ? null : yield* request.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))));
    const headers: Record<string, string> = {};
    for (const h of FORWARD_HEADERS) {
      const v = request.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const id = newRequestId();
    const isEvents = /\/events(\?|$)/.test(rest);
    const sessionMatch = rest.match(/^\/api\/sessions\/([^/?]+)/);
    const wkey = isEvents && sessionMatch ? watchKey(user.email, hostId, sessionMatch[1]!) : null;

    const response = yield* Effect.promise(
      () =>
        new Promise<HttpServerResponse.HttpServerResponse>((resolve) => {
          let settled = false;
          let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
          let closed = false;
          const buffered: Uint8Array[] = [];
          const finish = () => {
            if (closed) return;
            closed = true;
            if (wkey) watching.set(wkey, Math.max(0, (watching.get(wkey) ?? 1) - 1));
            try {
              controller?.close();
            } catch {
              // already closed
            }
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            host.pending.delete(id);
            resolve(jsonNow({ error: "The Mac did not answer in time." }, 504));
          }, 30_000);
          host.pending.set(id, {
            onHead: (head) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (wkey) watching.set(wkey, (watching.get(wkey) ?? 0) + 1);
              const stream = new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                  for (const b of buffered) c.enqueue(b);
                  buffered.length = 0;
                  if (closed) {
                    try {
                      c.close();
                    } catch {
                      // ignore
                    }
                  }
                },
                cancel() {
                  closed = true;
                  host.pending.delete(id);
                  host.send({ t: "abort", id });
                  if (wkey) watching.set(wkey, Math.max(0, (watching.get(wkey) ?? 1) - 1));
                },
              });
              const hdrs: Record<string, string> = {};
              for (const [k, v] of Object.entries(head.headers)) {
                if (["content-length", "transfer-encoding", "connection", "set-cookie"].includes(k.toLowerCase())) continue;
                hdrs[k] = v;
              }
              resolve(
                HttpServerResponse.stream(Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }), {
                  status: head.status,
                  headers: hdrs,
                }),
              );
            },
            onChunk: (chunk) => {
              const bytes = Buffer.from(chunk.data, "base64");
              if (controller && !closed) {
                try {
                  controller.enqueue(bytes);
                } catch {
                  closed = true;
                }
              } else if (!closed) buffered.push(bytes);
            },
            onEnd: (end) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(jsonNow({ error: end.error ?? "The Mac closed the connection." }, 502));
                return;
              }
              finish();
            },
          });
          host.send({
            t: "req",
            id,
            method: request.method,
            path: rest,
            headers,
            ...(bodyBuf && bodyBuf.byteLength > 0 ? { body: Buffer.from(bodyBuf).toString("base64") } : {}),
            user: user.email,
          });
        }),
    );
    return response;
  }),
);

/** Offline host: serve session list / session / events from the mirror. */
function serveFromMirror(email: string, hostId: string, method: string, rest: string) {
  return Effect.gen(function* () {
    if (method !== "GET") return null;
    const m = rest.match(MIRROR_READ);
    if (!m) return null;
    const sessionId = m[1];
    if (!sessionId) {
      const sessions = yield* Effect.promise(() => mirror.listMirrorSessions(email, hostId));
      return yield* json({ sessions: sessions.map((s) => ({ ...s, hostId, hostOnline: false })) });
    }
    const isEvents = /\/events/.test(rest);
    if (!isEvents) {
      const found = yield* Effect.promise(() => mirror.getMirrorSession(email, hostId, sessionId));
      if (!found) return yield* error("Session not found.", 404);
      return yield* json({ session: { ...found.session, hostId, hostOnline: false }, messages: found.messages, queue: [] });
    }
    const after = Number(new URL(`http://x${rest}`).searchParams.get("after") ?? 0) || 0;
    const events = yield* Effect.promise(() => mirror.listMirrorEvents(email, hostId, sessionId, after));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(encoder.encode(`id: ${e.seq}\nevent: session_event\ndata: ${JSON.stringify(e)}\n\n`));
        c.enqueue(
          encoder.encode(
            `event: session_event\ndata: ${JSON.stringify({ seq: 0, sessionId, turnId: null, type: "session_status", ts: new Date().toISOString(), data: { status: "offline", live: false, hostOnline: false } })}\n\n`,
          ),
        );
        c.close();
      },
    });
    return HttpServerResponse.stream(Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => cause }), {
      contentType: "text/event-stream; charset=utf-8",
      headers: { "cache-control": "no-cache" },
    });
  });
}

// ------------------------------------------------------------------ devices

export const listHostsRoute = HttpRouter.add(
  "GET",
  "/api/link/hosts",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    return yield* json({ hosts: listHosts(user.email) });
  }),
);

export const createDeviceRoute = HttpRouter.add(
  "POST",
  "/api/link/devices",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ name?: string; platform?: string }>();
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "Phone";
    const created = yield* Effect.promise(() =>
      devices.createDevice({ email: user.email, name, ...(typeof body?.platform === "string" ? { platform: body.platform } : {}) }),
    );
    return yield* json(created, 201);
  }),
);

export const listDevicesRoute = HttpRouter.add(
  "GET",
  "/api/link/devices",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const rows = yield* Effect.promise(() => devices.listDevices(user.email));
    return yield* json({ devices: rows.map(({ pushToken: _p, ...d }) => d) });
  }),
);

export const revokeDeviceRoute = HttpRouter.add(
  "DELETE",
  "/api/link/devices/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const ok = yield* Effect.promise(() => devices.setDeviceStatus(user.email, id ?? "", "revoked"));
    if (!ok) return yield* error("Device not found.", 404);
    return yield* json({ ok: true });
  }),
);

export const pushTokenRoute = HttpRouter.add(
  "POST",
  "/api/link/push-token",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = request.headers["authorization"] ?? "";
    const device = auth.startsWith("Bearer ") ? yield* Effect.promise(() => devices.authenticateDevice(auth.slice(7))) : null;
    if (!device) return yield* error("Pair this device first (Settings → Devices).", 400);
    const body = yield* safeBody<{ pushToken?: string }>();
    if (!body || typeof body.pushToken !== "string") return yield* error("`pushToken` is required.", 400);
    yield* Effect.promise(() => devices.setPushToken(user.email, device.id, body.pushToken!));
    return yield* json({ ok: true });
  }),
);

/** Pending approvals: served here on the box; proxied to the box on a desktop. */
async function proxyToBox(method: "GET" | "POST", path: string): Promise<{ status: number; body: unknown }> {
  const cookie = boxSessionCookie();
  if (!cookie) return { status: 409, body: { error: "Connect to Labee first (Settings → Connection)." } };
  const res = await fetch(`${proxyServerBase()}${path}`, { method, headers: { cookie, accept: "application/json" } });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}

export const pendingDevicesRoute = HttpRouter.add(
  "GET",
  "/api/link/pending",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    if (isDesktop()) {
      const r = yield* Effect.promise(() => proxyToBox("GET", "/api/link/pending"));
      return yield* json(r.body, r.status);
    }
    const rows = yield* Effect.promise(() => devices.listDevices(user.email, "pending"));
    return yield* json({ devices: rows.map(({ pushToken: _p, ...d }) => d) });
  }),
);

export const decideDeviceRoute = HttpRouter.add(
  "POST",
  "/api/link/pending/:id/:decision",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id, decision } = yield* params;
    if (decision !== "approve" && decision !== "reject") return yield* error("Decision must be approve or reject.", 400);
    if (isDesktop()) {
      const r = yield* Effect.promise(() => proxyToBox("POST", `/api/link/pending/${id}/${decision}`));
      return yield* json(r.body, r.status);
    }
    const ok = yield* Effect.promise(() => devices.setDeviceStatus(user.email, id ?? "", decision === "approve" ? "approved" : "revoked"));
    if (!ok) return yield* error("Device not found.", 404);
    return yield* json({ ok: true });
  }),
);

/** Desktop: is this Mac linked to labee.online, and as whom? */
export const linkStatusRoute = HttpRouter.add(
  "GET",
  "/api/link/status",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    if (!isDesktop()) return yield* json({ desktop: false });
    const cookie = boxSessionCookie();
    let account: string | null = null;
    if (cookie) {
      account = yield* Effect.promise(() =>
        fetch(`${proxyServerBase()}/api/me`, { headers: { cookie, accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => ((j as { user?: { email?: string } } | null)?.user?.email ?? null))
          .catch(() => null),
      );
    }
    return yield* json({
      desktop: true,
      server: proxyServerBase(),
      hostId: stableHostId(),
      connected: Boolean(cookie),
      account,
      link: linkState(),
    });
  }),
);

export const linkRoutes = [
  linkStatusRoute,
  hostTokenRoute,
  hostSocketRoute,
  tunnelRoute,
  listHostsRoute,
  createDeviceRoute,
  listDevicesRoute,
  revokeDeviceRoute,
  pushTokenRoute,
  pendingDevicesRoute,
  decideDeviceRoute,
];
