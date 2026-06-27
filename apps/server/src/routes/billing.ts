import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { attempt, bodyJson, error, json, sessionUser, statusForError } from "../httpKit";
import {
  createCheckout,
  createPortalSession,
  getBillingState,
  handleWebhook,
} from "../services/billing";
import type { CheckoutRequest } from "@labee/contracts";

const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** Absolute base URL for Checkout return links. Prefers LABEE_PUBLIC_URL, then
 *  the request Origin, then reconstructs from forwarded-proto + host headers. */
function appOrigin(request: HttpServerRequest.HttpServerRequest): string {
  const env = process.env.LABEE_PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const origin = request.headers["origin"];
  if (origin) return origin.replace(/\/+$/, "");
  const host = request.headers["host"] ?? "localhost:3000";
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}`;
}

/** GET /api/billing — the caller's plan/credits + the purchasable catalog. */
export const getBillingRoute = HttpRouter.add(
  "GET",
  "/api/billing",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* attempt(() => getBillingState(user.email));
  }),
);

/** POST /api/billing/checkout — start a hosted Stripe Checkout; returns a URL. */
export const checkoutRoute = HttpRouter.add(
  "POST",
  "/api/billing/checkout",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* safeBody<CheckoutRequest>();
    if (!body?.productId) return yield* error("productId is required.", 400);
    const origin = appOrigin(request);
    return yield* attempt(async () => ({
      url: await createCheckout(user.email, body.productId, origin),
    }));
  }),
);

/** POST /api/billing/portal — open the Stripe customer billing portal. */
export const portalRoute = HttpRouter.add(
  "POST",
  "/api/billing/portal",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = appOrigin(request);
    return yield* attempt(async () => ({
      url: await createPortalSession(user.email, origin),
    }));
  }),
);

/** POST /api/billing/webhook — Stripe event sink. No session; authenticated by
 *  the Stripe signature over the RAW body (so this must read text, not json). */
export const webhookRoute = HttpRouter.add(
  "POST",
  "/api/billing/webhook",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const signature = request.headers["stripe-signature"];
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const result = yield* Effect.tryPromise({
      try: () => handleWebhook(raw, signature),
      catch: (e) => e,
    }).pipe(
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* json({ received: true });
  }),
);

// Static paths before parametric; webhook is unauthenticated by design.
export const billingRoutes = [
  getBillingRoute,
  checkoutRoute,
  portalRoute,
  webhookRoute,
] as const;
