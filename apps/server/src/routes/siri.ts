// The Siri router (docs/siri-design.md §3.3). Host-answered: the sessions
// live here. `route` only decides; `send` decides and posts the turn, so an
// intent makes one call and reads the destination back.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import type { TurnRequest } from "@labee/session-core";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import * as sdb from "../services/sessions/db";
import * as runner from "../services/sessions/runner";
import { ensureSiriSession, route, type RouteKind } from "../services/siri/router";
import { markReturnsRead, unreadReturns } from "../services/siri/delivery";
import { sayToLabee } from "../services/siri/planner";

const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

interface RouteBody {
  text?: string;
  kind?: RouteKind;
  sessionId?: string;
  protocolSlug?: string;
  device?: string;
}

const KINDS: RouteKind[] = ["tell", "ask", "answer", "start"];

export const siriRouteRoute = HttpRouter.add(
  "POST",
  "/api/siri/route",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<RouteBody>();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const kind = KINDS.includes(body?.kind as RouteKind) ? (body!.kind as RouteKind) : "tell";
    if (!text && kind !== "start") return yield* error("`text` is required.", 400);
    if (kind === "start" && !body?.protocolSlug) return yield* error("`protocolSlug` is required to start a run.", 400);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const device = body?.device ?? (request.headers["x-labee-device"] as string | undefined);
    const r = yield* Effect.promise(() =>
      route(user.email, {
        text,
        kind,
        ...(body?.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body?.protocolSlug ? { protocolSlug: body.protocolSlug } : {}),
        ...(device ? { device } : {}),
      }),
    );
    return yield* json(r);
  }),
);

/** Route, then post the message as a turn in the destination (creating the
 *  chat when the router says new). Returns the destination and the turn. */
export const siriSendRoute = HttpRouter.add(
  "POST",
  "/api/siri/send",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<RouteBody & { voice?: boolean; forceNew?: boolean }>();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return yield* error("`text` is required.", 400);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const device = body?.device ?? (request.headers["x-labee-device"] as string | undefined) ?? "Siri";
    const kind: RouteKind = body?.kind === "ask" ? "ask" : "tell";

    const result = yield* Effect.tryPromise({ try: async () => {
      const siri = await ensureSiriSession(user.email);
      // The exchange's id ties the delegated turn's return back to this phrase.
      const siriTurnId = sdb.newId("siri");
      let sessionId: string | null = null;
      let title: string | null = null;
      let created = false;
      if (body?.forceNew) {
        const s = await sdb.createSession({ email: user.email, title: text.length > 48 ? `${text.slice(0, 48)}…` : text });
        sessionId = s.id;
        title = s.title;
        created = true;
        await runner.emitSystemMessage(siri.id, `→ new chat "${title}" · said: "${text.slice(0, 120)}"`, { kind, via: "new", sessionId, device, siriTurnId });
      } else {
        const r = await route(user.email, { text, kind, ...(body?.sessionId ? { sessionId: body.sessionId } : {}), device });
        if (r.action === "choose") return { needsChoice: true as const, candidates: r.candidates, siriSessionId: r.siriSessionId };
        if (r.action === "new" || !r.sessionId) {
          const s = await sdb.createSession({ email: user.email, title: r.title ?? text.slice(0, 48) });
          sessionId = s.id;
          title = s.title;
          created = true;
        } else {
          sessionId = r.sessionId;
          title = r.title;
        }
      }
      const turn: TurnRequest = { text, device, voice: body?.voice !== false, origin: { kind: "siri", siriTurnId, said: text } };
      const started = await runner.startTurn(user.email, sessionId!, turn);
      if (!started.ok) throw Object.assign(new Error(started.message), { status: started.status });
      return { needsChoice: false as const, sessionId, title, created, queued: started.queued, siriSessionId: siri.id, siriTurnId };
    }, catch: (e) => e }).pipe(
      Effect.map((v) => ({ ok: true as const, v })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const e = result.e as Error & { status?: number };
      return yield* error(e.message ?? "Could not send.", e.status ?? 500);
    }
    return yield* json(result.v, result.v.needsChoice ? 200 : 202);
  }),
);

/** The Siri agent (siri-agent design §3): say anything; the planner answers
 *  within Siri's budget, acts, or delegates and reports back later. */
export const siriSayRoute = HttpRouter.add(
  "POST",
  "/api/siri/say",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ text?: string; device?: string; confirmId?: string; yes?: boolean }>();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text && !body?.confirmId) return yield* error("`text` is required.", 400);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const device = body?.device ?? (request.headers["x-labee-device"] as string | undefined) ?? "Siri";
    const result = yield* Effect.tryPromise({
      try: () =>
        Promise.race([
          sayToLabee(user.email, text, { device, ...(body?.confirmId ? { confirmId: body.confirmId, yes: body.yes === true } : {}) }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The Siri agent took too long.")), 15_000)),
        ]),
      catch: (e) => e,
    }).pipe(Effect.map((v) => ({ ok: true as const, v })), Effect.catch((e) => Effect.succeed({ ok: false as const, e })));
    if (!result.ok) return yield* error(result.e instanceof Error ? result.e.message : String(result.e), 500);
    return yield* json(result.v);
  }),
);

/** "Any news from Labee?": the returns not yet heard, newest first. */
export const siriNewsRoute = HttpRouter.add(
  "GET",
  "/api/siri/news",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const items = yield* Effect.promise(() => unreadReturns(user.email));
    return yield* json({ items });
  }),
);

export const siriNewsReadRoute = HttpRouter.add(
  "POST",
  "/api/siri/news/read",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ idx?: number[] }>();
    const idxs = Array.isArray(body?.idx) ? body!.idx.filter((n): n is number => Number.isInteger(n)) : [];
    const read = yield* Effect.promise(() => markReturnsRead(user.email, idxs));
    return yield* json({ ok: true, read });
  }),
);

export const siriRoutes = [siriRouteRoute, siriSendRoute, siriSayRoute, siriNewsRoute, siriNewsReadRoute] as const;
