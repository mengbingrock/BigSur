import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { retrieveContext } from "../services/context/service";
export const contextRoute = HttpRouter.add(
  "POST",
  "/api/context",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* bodyJson<unknown>().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const r = yield* Effect.tryPromise({
      try: () => retrieveContext(user.email, body),
      catch: (e) => e,
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!r.ok) {
      const e = r.e as Error & { status?: number };
      return yield* error(e.message ?? "Context unavailable.", e.status ?? 503);
    }
    return yield* json(r.value);
  }),
);
