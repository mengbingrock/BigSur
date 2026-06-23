import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { currentUser, readSession, type CurrentUser, type SessionData } from "./services/session";

/** Read and unseal the session cookie off the current request. */
export const sessionData: Effect.Effect<SessionData, never, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cookie = request.headers["cookie"] ?? request.headers["Cookie"];
    return yield* Effect.promise(() => readSession(cookie));
  });

/** Current user or null (not signed in). */
export const sessionUser: Effect.Effect<
  CurrentUser | null,
  never,
  HttpServerRequest.HttpServerRequest
> = Effect.map(sessionData, currentUser);

/** Parsed request URL (for query params); falls back to a dummy origin. */
export const requestUrl: Effect.Effect<URL, never, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    return Option.getOrElse(url, () => new URL("http://localhost/"));
  });

/** Read the JSON body as `T` (caller asserts the shape). */
export const bodyJson = <T>(): Effect.Effect<T, unknown, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return (yield* request.json) as T;
  });

export const json = (data: unknown, status = 200) =>
  HttpServerResponse.json(data, { status });

export const error = (message: string, status: number) =>
  HttpServerResponse.json({ error: message }, { status });

/** Map a thrown Error to an HTTP status, honouring the `code` convention the
 *  ported services use (READ_ONLY, NOT_FOUND, EXISTS, INVALID). */
export function statusForError(e: unknown): { status: number; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | undefined)?.code;
  switch (code) {
    case "NOT_FOUND":
      return { status: 404, message };
    case "READ_ONLY":
    case "FORBIDDEN":
      return { status: 403, message };
    case "EXISTS":
      return { status: 409, message };
    case "INVALID":
      return { status: 400, message };
    default:
      return { status: 500, message };
  }
}

/** Run a (possibly throwing) service call and convert failures to JSON errors. */
export const attempt = <A>(thunk: () => A | Promise<A>) =>
  Effect.tryPromise({ try: async () => await thunk(), catch: (e) => e }).pipe(
    Effect.flatMap((value) => json(value)),
    Effect.catch((e) => {
      const { status, message } = statusForError(e);
      return error(message, status);
    }),
  );
