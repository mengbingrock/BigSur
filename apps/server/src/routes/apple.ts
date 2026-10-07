// POST /api/auth/apple — native Sign in with Apple (App Store guideline 4.8).
// The iOS app runs Apple's own sheet, then posts the identity token here. The
// sealed session comes back in the body (the app keeps it in the keychain and
// sends it as `x-labee-session`, as it does after Google sign-in) and as a
// cookie for any browser-based caller.
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { bodyJson, error } from "../httpKit";
import { exchangeAppleCode, verifyAppleIdentityToken } from "../services/apple";
import { grantSignupCredits } from "../services/billing";
import { encryptSecret } from "../services/secrets";
import { sealSession, sealSessionCookie } from "../services/session";
import { setAppleRefreshToken, shouldAutoPromoteFirstUser, upsertAppleUser } from "../services/users";

interface AppleSignInBody {
  identityToken?: string;
  /** One-time code; exchanged for a refresh token so deletion can revoke it. */
  authorizationCode?: string;
}

export const appleSignInRoute = HttpRouter.add(
  "POST",
  "/api/auth/apple",
  Effect.gen(function* () {
    const body = (yield* bodyJson<AppleSignInBody>().pipe(
      Effect.catch(() => Effect.succeed({} as AppleSignInBody)),
    )) as AppleSignInBody;
    const token = typeof body.identityToken === "string" ? body.identityToken.trim() : "";
    if (!token) return yield* error("`identityToken` is required.", 400);

    const result = yield* Effect.tryPromise({
      try: async () => {
        const identity = await verifyAppleIdentityToken(token);
        const user = await upsertAppleUser(
          { appleId: identity.sub, email: identity.email },
          { autoPromoteFirst: shouldAutoPromoteFirstUser() },
        );
        await grantSignupCredits(user.email);
        // Best effort: a failed exchange must not block sign-in.
        if (typeof body.authorizationCode === "string" && body.authorizationCode) {
          const refresh = await exchangeAppleCode(body.authorizationCode).catch(() => null);
          if (refresh) await setAppleRefreshToken(user.email, encryptSecret(refresh));
        }
        return user;
      },
      catch: (e) => e,
    }).pipe(
      Effect.map((user) => ({ ok: true as const, user })),
      Effect.catch((e) =>
        Effect.succeed({ ok: false as const, message: e instanceof Error ? e.message : "Apple sign-in failed." }),
      ),
    );
    if (!result.ok) return yield* error(result.message, 401);

    const session = { email: result.user.email, isAdmin: result.user.isAdmin };
    const sealed = yield* Effect.promise(() => sealSession(session));
    const cookie = yield* Effect.promise(() => sealSessionCookie(session));
    const res = yield* HttpServerResponse.json({ ok: true, ...session, session: sealed });
    return HttpServerResponse.setHeader(res, "set-cookie", cookie);
  }),
);

export const appleRoutes = [appleSignInRoute] as const;
