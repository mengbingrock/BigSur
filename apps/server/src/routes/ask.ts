// Quick answers for Siri (docs/siri-design.md §3.2): the HTTP face of
// `services/siri/quick.ts`. Past the budget, or when the model says so, the
// caller sends the question to the session instead.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { quickAnswer } from "../services/siri/quick";

const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

export const quickAskRoute = HttpRouter.add(
  "POST",
  "/api/ask/quick",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ q?: string; sessionId?: string; runId?: string; device?: string }>();
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    if (!q) return yield* error("`q` is required.", 400);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const device = body?.device ?? (request.headers["x-labee-device"] as string | undefined);
    const result = yield* Effect.promise(() =>
      quickAnswer(user.email, q, {
        ...(body?.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body?.runId ? { runId: body.runId } : {}),
        ...(device ? { device } : {}),
      }),
    );
    return yield* json(result);
  }),
);

export const askRoutes = [quickAskRoute] as const;
