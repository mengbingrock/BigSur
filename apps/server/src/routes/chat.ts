import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { bodyJson, error, sessionUser } from "../httpKit";
import { prepareTurn, singleErrorStream, type ChatRequest } from "../services/turnBuilder";

// One-shot chat turn (legacy path, still used for edit mode): build the turn
// with the shared turn builder and stream its SSE bytes straight back. Server-
// owned sessions (routes/sessions.ts) are the attachable path.
export const chatRoute = HttpRouter.add(
  "POST",
  "/api/chat",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);

    const body = yield* bodyJson<ChatRequest>().pipe(
      Effect.catch(() => Effect.succeed(null as ChatRequest | null)),
    );
    if (!body) return yield* error("Invalid JSON body.", 400);

    const prepared = yield* Effect.promise(() => prepareTurn(user.email, body));
    const sseHeaders = {
      contentType: "text/event-stream; charset=utf-8",
      headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    };
    if (!prepared.ok) {
      if (prepared.kind === "invalid") return yield* error(prepared.message, 400);
      return HttpServerResponse.stream(
        Stream.fromReadableStream({
          evaluate: () => singleErrorStream(prepared.message),
          onError: (cause) => cause,
        }),
        sseHeaders,
      );
    }
    return HttpServerResponse.stream(
      Stream.fromReadableStream({ evaluate: prepared.makeStream, onError: (cause) => cause }),
      sseHeaders,
    );
  }),
);
