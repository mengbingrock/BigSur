import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { json, requestUrl } from "../httpKit";
import {
  buildAuthUrl,
  clearStateCookie,
  exchangeCode,
  fetchProfile,
  generatePkce,
  isGoogleEnabled,
  isLoopbackCallback,
  readStateCookie,
  resolveRedirectUri,
  sealStateCookie,
  type OAuthState,
} from "../services/google";
import { sealSession, sealSessionCookie } from "../services/session";
import { upsertGoogleUser } from "../services/users";

/** In the desktop app the server is a forked child with an IPC channel; the
 *  OAuth callback runs in the system browser, so we can't set the session
 *  cookie on the Electron window directly. Instead we hand the sealed session
 *  back to the main process, which injects it into the window's cookie jar. */
const desktopHandoff = (): boolean =>
  process.env.LABEE_MODE === "desktop" && typeof process.send === "function";

const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1c1c1c;background:#fafaf7}div{text-align:center}</style>
<div><h1>You're signed in to Labee</h1><p>You can close this tab and return to the app.</p></div>`;

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
    const { verifier, challenge } = generatePkce();
    // Desktop remote mode: a loopback URL to deliver the session back to the app.
    const desktopParam = url.searchParams.get("desktop");
    const desktop = isLoopbackCallback(desktopParam) ? desktopParam! : undefined;

    const cookie = yield* Effect.promise(() =>
      sealStateCookie({
        state,
        next,
        redirectUri,
        codeVerifier: verifier,
        ...(desktop ? { desktop } : {}),
      } satisfies OAuthState),
    );
    return yield* redirectTo(
      buildAuthUrl({ state, redirectUri, codeChallenge: challenge }),
      cookie,
    );
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
          codeVerifier: saved.codeVerifier,
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

    const next = safeNext(saved.next);
    const session = { email: result.user.email, isAdmin: result.user.isAdmin };

    // Desktop remote mode: the OAuth ran in the system browser; redirect the
    // sealed session to the app's one-shot loopback listener (validated as a
    // loopback URL when the flow started).
    if (saved.desktop && isLoopbackCallback(saved.desktop)) {
      const value = yield* Effect.promise(() => sealSession(session));
      const sep = saved.desktop.includes("?") ? "&" : "?";
      const location = `${saved.desktop}${sep}session=${encodeURIComponent(
        value,
      )}&next=${encodeURIComponent(next)}`;
      return yield* redirectTo(location, clearStateCookie());
    }

    // Desktop (embedded): hand the sealed session to the Electron main process
    // over IPC and show a "return to the app" page in the system browser.
    if (desktopHandoff()) {
      const value = yield* Effect.promise(() => sealSession(session));
      yield* Effect.sync(() => process.send?.({ type: "labee:google-session", value, next }));
      return HttpServerResponse.text(DONE_HTML, {
        contentType: "text/html; charset=utf-8",
      });
    }

    const sessionCookie = yield* Effect.promise(() => sealSessionCookie(session));
    return yield* redirectTo(next, sessionCookie);
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
