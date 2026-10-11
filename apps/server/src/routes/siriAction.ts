import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { actionAtOwner, type ActionRequest } from "../services/siri/actions";
export const siriActionRoute = HttpRouter.add(
  "POST",
  "/api/siri/action",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* bodyJson<ActionRequest>().pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!body || !["inspect", "execute"].includes(body.mode))
      return yield* error("Invalid action request.", 400);
    const r = yield* Effect.tryPromise({
      try: () => actionAtOwner(user.email, body),
      catch: (e) => e,
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!r.ok)
      return yield* error(
        r.e instanceof Error ? r.e.message : "Action unavailable.",
        409,
      );
    return yield* json(r.value);
  }),
);
