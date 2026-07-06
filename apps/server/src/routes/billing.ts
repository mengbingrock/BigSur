import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { attempt, error, json, sessionUser, statusForError } from "../httpKit";
import {
  createCheckout,
  createPortalSession,
  getBillingState,
  getUsageSummary,
  handleWebhook,
  redeemCoupon,
} from "../services/billing";
import { remoteLabeeSession } from "../services/llmSettings";
import type { CheckoutRequest, RedeemRequest } from "@labee/contracts";

/** Parse a JSON request body, or null when absent/malformed. */
function safeParse<T>(raw: string): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** When the desktop is connected to a hosted Labee account, billing (balance,
 *  spend, checkout, coupons) belongs to that account — that's where "provided"
 *  usage is metered and credits are debited. Forward the request there with the
 *  box session and relay the response verbatim. Returns null when billing should
 *  be served locally (the hosted box itself, or an unconnected desktop). */
function forwardToLabee(
  request: HttpServerRequest.HttpServerRequest,
  rawBody: string | null,
): Effect.Effect<HttpServerResponse.HttpServerResponse> | null {
  const target = remoteLabeeSession();
  if (!target) return null;
  return Effect.gen(function* () {
    const headers: Record<string, string> = { cookie: target.cookie, accept: "application/json" };
    const origin = request.headers["origin"];
    if (origin) headers["origin"] = origin;
    if (rawBody != null) headers["content-type"] = "application/json";
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${target.base}${request.url}`, {
          method: request.method,
          headers,
          ...(rawBody != null ? { body: rawBody } : {}),
        }),
      catch: (e) => e,
    }).pipe(
      Effect.catch((e) =>
        Effect.succeed(
          new Response(
            JSON.stringify({
              error: e instanceof Error ? e.message : "Billing service is unreachable.",
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const text = yield* Effect.promise(() => res.text().catch(() => ""));
    const ct = res.headers.get("content-type") ?? "application/json";
    return HttpServerResponse.text(text, { status: res.status, contentType: ct });
  });
}

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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const remote = forwardToLabee(request, null);
    if (remote) return yield* remote;
    return yield* attempt(() => getBillingState(user.email));
  }),
);

/** GET /api/billing/usage — the caller's spend summary + recent credit ledger. */
export const usageRoute = HttpRouter.add(
  "GET",
  "/api/billing/usage",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const remote = forwardToLabee(request, null);
    if (remote) return yield* remote;
    return yield* attempt(() => getUsageSummary(user.email));
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
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const remote = forwardToLabee(request, raw);
    if (remote) return yield* remote;
    const body = safeParse<CheckoutRequest>(raw);
    if (!body?.productId) return yield* error("productId is required.", 400);
    const origin = appOrigin(request);
    return yield* attempt(async () => ({
      url: await createCheckout(user.email, body.productId, origin, body.amountCents),
    }));
  }),
);

/** POST /api/billing/redeem — redeem a coupon code for a complimentary plan. */
export const redeemRoute = HttpRouter.add(
  "POST",
  "/api/billing/redeem",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const remote = forwardToLabee(request, raw);
    if (remote) return yield* remote;
    const body = safeParse<RedeemRequest>(raw);
    if (!body?.code) return yield* error("A coupon code is required.", 400);
    return yield* attempt(() => redeemCoupon(user.email, body.code));
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
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const remote = forwardToLabee(request, raw);
    if (remote) return yield* remote;
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
  usageRoute,
  checkoutRoute,
  redeemRoute,
  portalRoute,
  webhookRoute,
] as const;
