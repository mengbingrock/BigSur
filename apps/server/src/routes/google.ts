import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { json, requestUrl } from "../httpKit";
import {
  buildAuthUrl,
  clearStateCookie,
  exchangeCode,
  fetchProfile,
  isGoogleEnabled,
  readStateCookie,
  resolveRedirectUri,
  sealStateCookie,
  type OAuthState,
} from "../services/google";
import { sealSessionCookie } from "../services/session";
import { upsertGoogleUser } from "../services/users";

/** Only allow same-site relative redirect targets (guards against open
 *  redirects via the `next` query param). */
function safeNext(next: string | null | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/chat";
}

/** Reconstruct the browser-visible origin from the incoming request. */
const requestOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const proto = (request.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  const host = request.headers["host"] ?? "localhost:3000";
  return `${proto}://${host}`;
});

// A 302 carrying at most one Set-Cookie. The Effect Headers map stores a single
// value per name, so we never emit more than one cookie per response (the OAuth
// state cookie is single-use and self-expires via its short Max-Age).
const redirectTo = (location: string, cookie?: string) =>
  Effect.sync(() => {
    const res = HttpServerResponse.redirect(location, { status: 302 });
    return cookie ? HttpServerResponse.setHeader(res, "set-cookie", cookie) : res;
  });

const loginError = (message: string) =>
  redirectTo(`/login?error=${encodeURIComponent(message)}`, clearStateCookie());

/** GET /api/auth/google — start the OAuth redirect flow. */
export const googleStartRoute = HttpRouter.add(
  "GET",
  "/api/auth/google",
  Effect.gen(function* () {
    if (!isGoogleEnabled()) return yield* loginError("Google sign-in is not configured.");

    const url = yield* requestUrl;
    const origin = yield* requestOrigin;
    const redirectUri = resolveRedirectUri(origin);
    const state = crypto.randomUUID();
    const next = safeNext(url.searchParams.get("next"));

    const cookie = yield* Effect.promise(() =>
      sealStateCookie({ state, next, redirectUri } satisfies OAuthState),
    );
    return yield* redirectTo(buildAuthUrl({ state, redirectUri }), cookie);
  }),
);

/** GET /api/auth/google/callback — exchange the code, sign the user in. */
export const googleCallbackRoute = HttpRouter.add(
  "GET",
  "/api/auth/google/callback",
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const request = yield* HttpServerRequest.HttpServerRequest;

    const oauthError = url.searchParams.get("error");
    if (oauthError) return yield* loginError(`Google sign-in was cancelled (${oauthError}).`);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const saved = yield* Effect.promise(() =>
      readStateCookie(request.headers["cookie"] ?? request.headers["Cookie"]),
    );

    if (!code || !state || !saved || saved.state !== state) {
      return yield* loginError("Google sign-in could not be verified. Please try again.");
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        const { accessToken } = await exchangeCode({
          code,
          redirectUri: saved.redirectUri,
        });
        const profile = await fetchProfile(accessToken);
        if (!profile.emailVerified) {
          throw new Error("Your Google email address is not verified.");
        }
        const user = await upsertGoogleUser({ googleId: profile.sub, email: profile.email });
        return user;
      },
      catch: (e) => e,
    }).pipe(
      Effect.map((user) => ({ ok: true as const, user })),
      Effect.catch((e) =>
        Effect.succeed({
          ok: false as const,
          message: e instanceof Error ? e.message : "Google sign-in failed.",
        }),
      ),
    );

    if (!result.ok) return yield* loginError(result.message);

    const sessionCookie = yield* Effect.promise(() =>
      sealSessionCookie({ email: result.user.email, isAdmin: result.user.isAdmin }),
    );
    return yield* redirectTo(safeNext(saved.next), sessionCookie);
  }),
);

/** GET /api/auth/providers — which third-party sign-in options are enabled. */
export const authProvidersRoute = HttpRouter.add(
  "GET",
  "/api/auth/providers",
  Effect.gen(function* () {
    return yield* json({ google: isGoogleEnabled() });
  }),
);

export const googleRoutes = [
  googleStartRoute,
  googleCallbackRoute,
  authProvidersRoute,
] as const;
