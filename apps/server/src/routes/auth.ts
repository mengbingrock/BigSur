import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { bodyJson, error, sessionUser } from "../httpKit";
import {
  clearSessionCookie,
  sealSessionCookie,
} from "../services/session";
import {
  createUser,
  isSignupEnabled,
  toPublic,
  verifyCredentials,
} from "../services/users";

interface Credentials {
  email?: string;
  password?: string;
}

const withCookie = (data: unknown, cookie: string, status = 200) =>
  HttpServerResponse.json(data, { status }).pipe(
    Effect.map((res) => HttpServerResponse.setHeader(res, "set-cookie", cookie)),
  );

export const loginRoute = HttpRouter.add(
  "POST",
  "/api/auth/login",
  Effect.gen(function* () {
    const body = (yield* bodyJson<Credentials>().pipe(
      Effect.catch(() => Effect.succeed({} as Credentials)),
    )) as Credentials;
    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) return yield* error("Email and password are required.", 400);

    const user = yield* Effect.promise(() => verifyCredentials(email, password));
    if (!user) return yield* error("Invalid email or password.", 401);

    const cookie = yield* Effect.promise(() =>
      sealSessionCookie({ email: user.email, isAdmin: user.isAdmin }),
    );
    return yield* withCookie({ ok: true, email: user.email, isAdmin: user.isAdmin }, cookie);
  }),
);

export const signupRoute = HttpRouter.add(
  "POST",
  "/api/auth/signup",
  Effect.gen(function* () {
    if (!isSignupEnabled()) return yield* error("Sign-up is disabled.", 403);
    const body = (yield* bodyJson<Credentials>().pipe(
      Effect.catch(() => Effect.succeed({} as Credentials)),
    )) as Credentials;
    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) return yield* error("Email and password are required.", 400);

    const created = yield* Effect.tryPromise({
      try: () => createUser(email, password, { autoPromoteFirst: true }),
      catch: (e) => e,
    }).pipe(Effect.map((u) => ({ ok: true as const, user: u })), Effect.catch((e) =>
      Effect.succeed({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
    ));
    if (!created.ok) return yield* error(created.message, 400);

    const pub = toPublic(created.user);
    const cookie = yield* Effect.promise(() =>
      sealSessionCookie({ email: pub.email, isAdmin: pub.isAdmin }),
    );
    return yield* withCookie({ ok: true, email: pub.email, isAdmin: pub.isAdmin }, cookie);
  }),
);

export const logoutRoute = HttpRouter.add(
  "POST",
  "/api/auth/logout",
  HttpServerResponse.json({ ok: true }).pipe(
    Effect.map((res) => HttpServerResponse.setHeader(res, "set-cookie", clearSessionCookie())),
  ),
);

export const meRoute = HttpRouter.add(
  "GET",
  "/api/me",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    return yield* HttpServerResponse.json({ user });
  }),
);

export const authRoutes = [loginRoute, signupRoute, logoutRoute, meRoute] as const;
