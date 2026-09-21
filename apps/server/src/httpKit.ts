import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { currentUser, readSession, type CurrentUser, type SessionData } from "./services/session";
import { authenticateDevice } from "./services/deviceLink/devices";
import { isDeletedAccount } from "./services/account";
import { linkSecret } from "./services/deviceLink/secret";

/** Read and unseal the session cookie off the current request. */
export const sessionData: Effect.Effect<SessionData, never, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cookie = request.headers["cookie"] ?? request.headers["Cookie"];
    const fromCookie = yield* Effect.promise(() => readSession(cookie));
    if (fromCookie.email) return fromCookie;
    // Mobile app: the sealed session travels in a header instead of a cookie.
    const sealed = request.headers["x-labee-session"];
    if (typeof sealed === "string" && sealed) {
      return yield* Effect.promise(() => readSession(`monterey_session=${sealed}`));
    }
    return fromCookie;
  });

/** Current user or null (not signed in). Three ways in, checked in order:
 *  1. the session cookie (browsers, Electron);
 *  2. `Authorization: Bearer lbd_…` — an approved Device Link phone/tablet;
 *  3. `x-labee-link-user` + `x-labee-link-secret` — a request the box tunneled
 *     to this desktop; only honoured when the per-process secret matches. */
export const sessionUser: Effect.Effect<
  CurrentUser | null,
  never,
  HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const fromCookie = currentUser(yield* sessionData);
  // A sealed cookie is stateless; once the account is deleted it must stop
  // working immediately rather than at its 30-day expiry.
  if (fromCookie && isDeletedAccount(fromCookie.email)) return null;
  if (fromCookie) return fromCookie;
  const auth = request.headers["authorization"] ?? "";
  if (auth.startsWith("Bearer lbd_")) {
    const device = yield* Effect.promise(() => authenticateDevice(auth.slice(7)).catch(() => null));
    if (device) return { email: device.email, isAdmin: false };
  }
  const linkUser = request.headers["x-labee-link-user"];
  const secret = request.headers["x-labee-link-secret"];
  const expected = linkSecret();
  if (linkUser && secret && expected && secret === expected) return { email: linkUser, isAdmin: false };
  return null;
});

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
