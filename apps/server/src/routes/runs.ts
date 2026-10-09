// Protocol runs (docs/protocol-run-design.md §2.3). Box-answered: a desktop
// connected to a Labee account forwards these to the box, the way billing
// does, so run state lives in one place and survives the Mac sleeping. A
// desktop with no account keeps them locally.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { anyHost, getHost, requestParse } from "../services/deviceLink/hosts";
import { stableHostId } from "../services/deviceLink/client";
import { boxSessionCookie, isDesktop } from "../services/llmSettings";
import { answerAmount } from "../services/runs/amount";
import * as rdb from "../services/runs/db";
import type { RunRow, RunScale } from "../services/runs/db";
import { parseProtocol } from "../services/runs/parse";
import * as runs from "../services/runs/service";
import { RunError, viewOf } from "../services/runs/service";
import * as sdb from "../services/sessions/db";
import { getSkillBySlug } from "../services/skills";
import { forwardToBox } from "./link";

const params = HttpRouter.params;
const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** A connected desktop hands the request to the box. */
function viaBox() {
  return Effect.gen(function* () {
    if (!isDesktop() || !boxSessionCookie()) return null;
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* forwardToBox(request, request.url);
  });
}

function fail(e: unknown) {
  if (e instanceof RunError) return error(e.message, e.status);
  return error(e instanceof Error ? e.message : String(e), 500);
}

/** The run plus the derived view, as clients expect it. */
async function payload(run: RunRow) {
  const view = await viewOf(run);
  return { run, view: { ...view, run: undefined } };
}

/** Resolve a run id, or "active" for the one in progress. */
async function resolveRun(email: string, id: string): Promise<RunRow | null> {
  if (id === "active") {
    const [open] = await rdb.listRuns(email, { status: ["running", "paused"], limit: 1 });
    return open ?? null;
  }
  return rdb.getRunForUser(email, id);
}

export const createRunRoute = HttpRouter.add(
  "POST",
  "/api/runs",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ protocolSlug?: string; hostId?: string; sessionId?: string; scale?: RunScale | null }>();
    const slug = typeof body?.protocolSlug === "string" ? body.protocolSlug.trim() : "";
    if (!slug) return yield* error("`protocolSlug` is required.", 400);

    // A connected desktop: the box owns runs; say which Mac holds the session.
    if (isDesktop() && boxSessionCookie()) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const forwarded = { ...body, hostId: stableHostId() };
      return yield* forwardToBoxWithBody(request, "/api/runs", forwarded);
    }

    const result = yield* Effect.tryPromise({ try: async () => {
      // On the box, the protocol lives on a Mac: ask it to parse and to make
      // the session. Without a host the box's own copy (or a desktop's) is used.
      const hostId = typeof body?.hostId === "string" && body.hostId ? body.hostId : null;
      const host = hostId ? getHost(user.email, hostId) : isDesktop() ? undefined : anyHost(user.email);
      if (hostId && !host) throw new RunError(503, "Your Mac is asleep, so the run can't start. Open Labee on it and try again.");
      let snapshot;
      let sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
      let protocolName: string;
      let ownerHost: string | null = null;
      if (host) {
        const parsed = await requestParse(host, { protocolSlug: slug, ...(sessionId ? { sessionId } : {}), user: user.email });
        if (parsed.error || !parsed.snapshot || !parsed.sessionId) throw new RunError(503, parsed.error ?? "The Mac could not parse the protocol.");
        snapshot = parsed.snapshot as unknown as ReturnType<typeof parseProtocol>;
        sessionId = parsed.sessionId;
        protocolName = parsed.protocolName ?? slug;
        ownerHost = host.hostId;
      } else {
        const skill = getSkillBySlug(slug, user.email);
        if (!skill || skill.artifactKind !== "protocol") throw new RunError(404, "Protocol not found.");
        snapshot = parseProtocol(skill.body);
        protocolName = skill.name;
        if (!sessionId) {
          const s = await sdb.createSession({ email: user.email, title: skill.name, lastBody: { skillSlugs: [skill.slug] } });
          sessionId = s.id;
        }
      }
      const scale = body?.scale && typeof body.scale === "object" ? body.scale : snapshot.base && body?.scale === undefined ? null : null;
      const run = await runs.createRun({ email: user.email, sessionId, hostId: ownerHost, protocolSlug: slug, protocolName, snapshot, scale });
      return payload(run);
    }, catch: (e) => e }).pipe(
      Effect.map((v) => ({ ok: true as const, v })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) return yield* fail(result.e);
    return yield* json(result.v, 201);
  }),
);

/** forwardToBox with a replaced body (the desktop adds its host id). */
function forwardToBoxWithBody(request: HttpServerRequest.HttpServerRequest, path: string, body: unknown) {
  return Effect.gen(function* () {
    const cookie = boxSessionCookie();
    if (!cookie) return yield* error("Connect to Labee first (Settings → Connection).", 409);
    const { proxyServerBase } = yield* Effect.promise(() => import("../services/llmSettings"));
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${proxyServerBase()}${path}`, {
          method: request.method,
          headers: { cookie, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      catch: (e) => e,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!res) return yield* error("labee.online is unreachable.", 502);
    const text = yield* Effect.promise(() => res.text().catch(() => ""));
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    return yield* json(parsed, res.status);
  });
}

export const listRunsRoute = HttpRouter.add(
  "GET",
  "/api/runs",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const fwd = yield* viaBox();
    if (fwd) return fwd;
    const rows = yield* Effect.promise(() => rdb.listRuns(user.email, { limit: 100 }));
    const items = yield* Effect.promise(() =>
      Promise.all(
        rows.map(async (r) => {
          const view = await viewOf(r);
          return {
            id: r.id,
            sessionId: r.sessionId,
            hostId: r.hostId,
            protocolSlug: r.protocolSlug,
            protocolName: r.protocolName,
            status: r.status,
            current: r.current,
            total: r.snapshot.steps.length,
            startedAt: r.startedAt,
            updatedAt: r.updatedAt,
            finishedAt: r.finishedAt,
            elapsedSeconds: view.elapsedSeconds,
            timerEndsAt: view.timers.find((t) => t.state === "running")?.endsAt ?? null,
            notes: view.notes.length,
          };
        }),
      ),
    );
    return yield* json({ runs: items });
  }),
);

export const getRunRoute = HttpRouter.add(
  "GET",
  "/api/runs/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const fwd = yield* viaBox();
    if (fwd) return fwd;
    const { id } = yield* params;
    const run = yield* Effect.promise(() => resolveRun(user.email, id ?? ""));
    if (!run) return yield* error(id === "active" ? "No run is in progress." : "Run not found.", 404);
    const after = Number(new URL(`http://x${(yield* HttpServerRequest.HttpServerRequest).url}`).searchParams.get("after") ?? 0) || 0;
    const [p, events] = yield* Effect.promise(() => Promise.all([payload(run), rdb.listRunEvents(run.id, after)]));
    return yield* json({ ...p, events });
  }),
);

type Action = "advance" | "back" | "skip" | "note" | "timer" | "pause" | "resume" | "finish" | "abandon" | "jump" | "scale" | "timer-done";

function actionRoute(action: Action) {
  return HttpRouter.add(
    "POST",
    `/api/runs/:id/${action}`,
    Effect.gen(function* () {
      const user = yield* sessionUser;
      if (!user) return yield* error("Unauthorized.", 401);
      const fwd = yield* viaBox();
      if (fwd) return fwd;
      const { id } = yield* params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* safeBody<Record<string, unknown>>()) ?? {};
      const device = typeof body.device === "string" ? body.device : (request.headers["x-labee-device"] as string | undefined);
      const run = yield* Effect.promise(() => resolveRun(user.email, id ?? ""));
      if (!run) return yield* error(id === "active" ? "No run is in progress." : "Run not found.", 404);
      const result = yield* Effect.tryPromise({ try: async () => {
        switch (action) {
          case "advance": {
            const r = await runs.advance(run, device);
            return { ...(await payload(r.run)), done: r.done, next: r.next };
          }
          case "back": {
            const r = await runs.back(run, device);
            return { ...(await payload(r.run)), step: r.step };
          }
          case "skip": {
            const r = await runs.skip(run, typeof body.reason === "string" ? body.reason : undefined, device);
            return { ...(await payload(r.run)), skipped: r.skipped, next: r.next };
          }
          case "jump": {
            const n = Number(body.step);
            if (!Number.isInteger(n)) throw new RunError(400, "`step` must be a step number.");
            return payload(await runs.jumpTo(run, n, device));
          }
          case "note": {
            if (typeof body.text !== "string") throw new RunError(400, "`text` is required.");
            return payload(await runs.note(run, body.text, typeof body.step === "number" ? body.step : undefined, device));
          }
          case "timer": {
            const r = await runs.startTimer(run, {
              ...(typeof body.seconds === "number" ? { seconds: body.seconds } : {}),
              ...(typeof body.label === "string" ? { label: body.label } : {}),
              ...(typeof body.step === "number" ? { step: body.step } : {}),
              ...(device ? { device } : {}),
            });
            return { ...(await payload(r.run)), timer: r.timer };
          }
          case "timer-done": {
            if (typeof body.timerId !== "string") throw new RunError(400, "`timerId` is required.");
            return payload(await runs.timerDone(run, body.timerId));
          }
          case "pause":
            return payload(await runs.pause(run));
          case "resume":
            return payload(await runs.resume(run));
          case "finish":
            return payload(await runs.finish(run, device));
          case "abandon":
            return payload(await runs.abandon(run, typeof body.reason === "string" ? body.reason : undefined));
          case "scale": {
            const scale = body.scale && typeof body.scale === "object" ? (body.scale as RunScale) : null;
            return payload(await runs.setScale(run, scale));
          }
        }
      }, catch: (e) => e }).pipe(
        Effect.map((v) => ({ ok: true as const, v })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
      );
      if (!result.ok) return yield* fail(result.e);
      return yield* json(result.v);
    }),
  );
}

export const cancelTimerRoute = HttpRouter.add(
  "DELETE",
  "/api/runs/:id/timer/:timerId",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const fwd = yield* viaBox();
    if (fwd) return fwd;
    const { id, timerId } = yield* params;
    const run = yield* Effect.promise(() => resolveRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const result = yield* Effect.tryPromise({ try: () => runs.cancelTimer(run, timerId ?? "").then(payload), catch: (e) => e }).pipe(
      Effect.map((v) => ({ ok: true as const, v })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) return yield* fail(result.e);
    return yield* json(result.v);
  }),
);

/** Tier 1 of "how much X?" (design §4.2): the protocol's own words. */
export const amountRoute = HttpRouter.add(
  "POST",
  "/api/runs/:id/amount",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const fwd = yield* viaBox();
    if (fwd) return fwd;
    const { id } = yield* params;
    const body = yield* safeBody<{ material?: string; step?: number }>();
    const material = typeof body?.material === "string" ? body.material.trim() : "";
    if (!material) return yield* error("`material` is required.", 400);
    const run = yield* Effect.promise(() => resolveRun(user.email, id ?? ""));
    if (!run) return yield* error(id === "active" ? "No run is in progress." : "Run not found.", 404);
    return yield* json(answerAmount(run, material, typeof body?.step === "number" ? body.step : undefined));
  }),
);

export const runRoutes = [
  createRunRoute,
  listRunsRoute,
  getRunRoute,
  cancelTimerRoute,
  amountRoute,
  ...(["advance", "back", "skip", "note", "timer", "pause", "resume", "finish", "abandon", "jump", "scale", "timer-done"] as Action[]).map(actionRoute),
];
