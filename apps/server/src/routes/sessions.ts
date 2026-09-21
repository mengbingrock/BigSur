// Server-owned chat sessions (design §4.3): CRUD, turns, cancel, answer,
// queue, diff, and the replay-then-tail SSE stream any device can attach to.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { AskUserAnswer, TurnRequest } from "@labee/session-core";
import { bodyJson, error, json, requestUrl, sessionUser } from "../httpKit";
import * as sdb from "../services/sessions/db";
import * as runner from "../services/sessions/runner";

const params = HttpRouter.params;

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

export function toSummary(s: sdb.SessionRow, queued = 0) {
  return {
    id: s.id,
    title: s.title,
    agentId: s.agentId,
    cwd: s.cwd,
    engine: s.engine,
    provider: s.provider,
    model: s.model,
    status: s.status,
    activeTurn: s.activeTurn,
    pendingQuestion: s.pendingQuestion,
    lastSeq: s.lastSeq,
    costUsd: s.costUsd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
    queued,
  };
}

export const createSessionRoute = HttpRouter.add(
  "POST",
  "/api/sessions",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ agentId?: string; title?: string }>();
    const session = yield* Effect.promise(() =>
      sdb.createSession({
        email: user.email,
        agentId: typeof body?.agentId === "string" ? body.agentId : null,
        ...(typeof body?.title === "string" ? { title: body.title } : {}),
      }),
    );
    return yield* json({ session: toSummary(session) }, 201);
  }),
);

export const listSessionsRoute = HttpRouter.add(
  "GET",
  "/api/sessions",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const url = yield* requestUrl;
    const status = url.searchParams.get("status") as sdb.SessionStatus | null;
    const includeArchived = url.searchParams.get("archived") === "1";
    const sessions = yield* Effect.promise(async () => {
      const rows = await sdb.listSessions(user.email, {
        ...(status ? { status } : {}),
        includeArchived,
      });
      return Promise.all(rows.map(async (r) => toSummary(r, (await sdb.listQueue(r.id)).length)));
    });
    return yield* json({ sessions });
  }),
);

export const getSessionRoute = HttpRouter.add(
  "GET",
  "/api/sessions/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const result = yield* Effect.promise(async () => {
      const s = await sdb.getSession(user.email, id ?? "");
      if (!s) return null;
      const [messages, queue] = await Promise.all([sdb.listMessages(s.id), sdb.listQueue(s.id)]);
      return { session: toSummary(s, queue.length), messages, queue: queue.map((q) => ({ id: q.id, text: String(q.body.text ?? ""), createdAt: q.createdAt })) };
    });
    if (!result) return yield* error("Session not found.", 404);
    return yield* json(result);
  }),
);

export const patchSessionRoute = HttpRouter.add(
  "PATCH",
  "/api/sessions/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const body = yield* safeBody<{ title?: string; archived?: boolean }>();
    const s = yield* Effect.promise(() => sdb.getSession(user.email, id ?? ""));
    if (!s) return yield* error("Session not found.", 404);
    yield* Effect.promise(() =>
      sdb.updateSession(s.id, {
        ...(typeof body?.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
        ...(typeof body?.archived === "boolean" ? { archived: body.archived } : {}),
      }),
    );
    const updated = yield* Effect.promise(() => sdb.getSessionById(s.id));
    return yield* json({ session: toSummary(updated!) });
  }),
);

export const deleteSessionRoute = HttpRouter.add(
  "DELETE",
  "/api/sessions/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const s = yield* Effect.promise(() => sdb.getSession(user.email, id ?? ""));
    if (!s) return yield* error("Session not found.", 404);
    if (runner.getHandle(s.id)) return yield* error("Stop the running turn first.", 409);
    yield* Effect.promise(() => sdb.deleteSession(s.id));
    return yield* json({ ok: true });
  }),
);

export const startTurnRoute = HttpRouter.add(
  "POST",
  "/api/sessions/:id/turns",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const body = yield* safeBody<TurnRequest>();
    if (!body || typeof body.text !== "string") return yield* error("Body must include `text`.", 400);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const device = body.device ?? req.headers["x-labee-device"];
    const result = yield* Effect.promise(() =>
      runner.startTurn(user.email, id ?? "", { ...body, ...(device ? { device } : {}) }),
    );
    if (!result.ok) return yield* error(result.message, result.status);
    return yield* json(result, 202);
  }),
);

export const cancelTurnRoute = HttpRouter.add(
  "POST",
  "/api/sessions/:id/cancel",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const r = yield* Effect.promise(() => runner.cancelTurn(user.email, id ?? ""));
    if (!r.ok) return yield* error(r.message ?? "Cannot cancel.", 409);
    return yield* json({ ok: true });
  }),
);

export const removeQueuedRoute = HttpRouter.add(
  "DELETE",
  "/api/sessions/:id/queue/:queueId",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id, queueId } = yield* params;
    const removed = yield* Effect.promise(() => runner.removeQueued(user.email, id ?? "", queueId ?? ""));
    if (!removed) return yield* error("Not queued.", 404);
    return yield* json({ ok: true });
  }),
);

export const answerRoute = HttpRouter.add(
  "POST",
  "/api/sessions/:id/answer",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const body = yield* safeBody<{ answers?: AskUserAnswer[]; device?: string; voice?: boolean }>();
    if (!body || !Array.isArray(body.answers) || body.answers.length === 0) {
      return yield* error("Body must include non-empty `answers`.", 400);
    }
    const req = yield* HttpServerRequest.HttpServerRequest;
    const device = body.device ?? req.headers["x-labee-device"];
    const r = yield* Effect.promise(() =>
      runner.answerQuestion(user.email, id ?? "", body.answers!, {
        ...(device ? { device } : {}),
        ...(body.voice !== undefined ? { voice: body.voice } : {}),
      }),
    );
    if (!r.ok) return yield* error(r.message, r.status);
    return yield* json(r, 202);
  }),
);

/** Host-computed diff of the session's working directory: uncommitted changes,
 *  or the last commit when the tree is clean. */
export const diffRoute = HttpRouter.add(
  "GET",
  "/api/sessions/:id/diff",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const s = yield* Effect.promise(() => sdb.getSession(user.email, id ?? ""));
    if (!s) return yield* error("Session not found.", 404);
    if (!s.cwd) return yield* json({ isRepo: false, diff: "", files: [] });
    const result = yield* Effect.promise(() => gitDiff(s.cwd!));
    return yield* json(result);
  }),
);

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, out: String(stdout ?? "") });
    });
  });
}

export async function gitDiff(cwd: string): Promise<{
  isRepo: boolean;
  clean?: boolean;
  files: { path: string; status: string }[];
  diff: string;
}> {
  const exists = await fs.stat(cwd).then((st) => st.isDirectory()).catch(() => false);
  if (!exists) return { isRepo: false, files: [], diff: "" };
  const top = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (top.code !== 0) return { isRepo: false, files: [], diff: "" };
  const status = await git(cwd, ["status", "--porcelain"]);
  const files = status.out
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
  if (files.length > 0) {
    const diff = await git(cwd, ["diff", "HEAD", "--"]);
    const untracked = files.filter((f) => f.status === "??");
    let extra = "";
    for (const f of untracked.slice(0, 20)) {
      const d = await git(cwd, ["diff", "--no-index", "--", "/dev/null", f.path]);
      extra += d.out;
    }
    return { isRepo: true, clean: false, files, diff: (diff.out + extra).slice(0, 512 * 1024) };
  }
  const last = await git(cwd, ["show", "--stat", "--format=%h %s (%ar)", "HEAD"]);
  return { isRepo: true, clean: true, files, diff: last.out.slice(0, 64 * 1024) };
}

const TERMINAL = new Set(["turn_ended", "turn_cancelled"]);

export const sessionEventsRoute = HttpRouter.add(
  "GET",
  "/api/sessions/:id/events",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { id } = yield* params;
    const s = yield* Effect.promise(() => sdb.getSession(user.email, id ?? ""));
    if (!s) return yield* error("Session not found.", 404);
    const url = yield* requestUrl;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const lastEventId = request.headers["last-event-id"];
    const after = Number(url.searchParams.get("after") ?? lastEventId ?? 0) || 0;
    const coalesceMs = Math.min(Number(url.searchParams.get("coalesce") ?? 0) || 0, 2000);
    // `once=1` closes after the current turn ends (or immediately when idle)
    // instead of tailing forever — handy for mobile screens that resubscribe.
    const once = url.searchParams.get("once") === "1";

    const encoder = new TextEncoder();
    const sessionId = s.id;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        const send = (evt: runner.SessionEventEnvelope) => {
          const idField = evt.seq > 0 ? `id: ${evt.seq}\n` : "";
          write(`${idField}event: session_event\ndata: ${JSON.stringify(evt)}\n\n`);
        };

        // Coalescing: merge consecutive text deltas for slow links.
        let pendingDelta: runner.SessionEventEnvelope | null = null;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushDelta = () => {
          if (pendingDelta) send(pendingDelta);
          pendingDelta = null;
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = null;
        };
        const emitCoalesced = (evt: runner.SessionEventEnvelope) => {
          if (coalesceMs > 0 && evt.type === "delta" && evt.seq === 0) {
            if (pendingDelta && pendingDelta.turnId === evt.turnId) {
              pendingDelta = { ...pendingDelta, data: { ...pendingDelta.data, text: String(pendingDelta.data.text ?? "") + String(evt.data.text ?? "") } };
            } else {
              flushDelta();
              pendingDelta = evt;
            }
            if (!flushTimer) flushTimer = setTimeout(flushDelta, coalesceMs);
            return;
          }
          flushDelta();
          send(evt);
        };

        const seen = new Set<number>();
        const pending: runner.SessionEventEnvelope[] = [];
        let replaying = true;
        let cleanup = () => {};
        const unsubscribe = runner.subscribe(sessionId, (evt) => {
          if (replaying) {
            pending.push(evt);
            return;
          }
          if (evt.seq > 0 && seen.has(evt.seq)) return;
          if (evt.seq > 0) seen.add(evt.seq);
          emitCoalesced(evt);
          if (once && TERMINAL.has(evt.type)) setTimeout(cleanup, 50);
        });

        const rows = await sdb.listEventsAfter(sessionId, after);
        for (const row of rows) {
          seen.add(row.seq);
          send({ seq: row.seq, sessionId, turnId: row.turnId, type: row.type, ts: row.ts, data: (row.data ?? {}) as Record<string, unknown> });
        }
        replaying = false;
        for (const evt of pending) {
          if (evt.seq > 0 && seen.has(evt.seq)) continue;
          if (evt.seq > 0) seen.add(evt.seq);
          emitCoalesced(evt);
        }

        const isLive = Boolean(runner.getHandle(sessionId));
        const current = await sdb.getSessionById(sessionId);
        // Always tell the client where things stand right now.
        send({
          seq: 0,
          sessionId,
          turnId: current?.activeTurn ?? null,
          type: "session_status",
          ts: new Date().toISOString(),
          data: { status: current?.status ?? "idle", live: isLive, lastSeq: current?.lastSeq ?? 0 },
        });
        if (once && !isLive) {
          unsubscribe();
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
          return;
        }

        const heartbeat = setInterval(() => write(`: ping\n\n`), 25_000);
        cleanup = () => {
          if (closed) return;
          flushDelta();
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
      },
      cancel() {
        // Client went away: nothing to do — the turn keeps running.
      },
    });

    return HttpServerResponse.stream(
      Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }),
      {
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
      },
    );
  }),
);

export const sessionRoutes = [
  createSessionRoute,
  listSessionsRoute,
  getSessionRoute,
  patchSessionRoute,
  deleteSessionRoute,
  startTurnRoute,
  cancelTurnRoute,
  removeQueuedRoute,
  answerRoute,
  diffRoute,
  sessionEventsRoute,
];
