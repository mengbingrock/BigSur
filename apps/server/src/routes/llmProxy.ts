// LLM inference proxy — the "remote brain" for local-first "Labee Provided"
// agents. A Provided agent runs on the user's Mac (local files/tools/MCP), but
// its model calls are pointed at these endpoints instead of the vendor. The
// proxy authenticates a short-lived scoped token, checks the caller is entitled
// (active plan or credits), swaps in Labee's real vendor key, and streams the
// vendor's response straight back — a transparent passthrough so the claude CLI
// and OpenAI client behave exactly as if they talked to the vendor directly.
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { error, json, sessionUser } from "../httpKit";
import { hasPaidEntitlement } from "../services/billing";
import { PROXY_TOKEN_TTL, readProxyToken, sealProxyToken } from "../services/session";

const params = HttpRouter.params;

const ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
const OPENAI_UPSTREAM = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(
  /\/v1\/?$/,
  "",
);

function labeeKey(provider: "anthropic" | "openai"): string | null {
  if (provider === "anthropic") {
    return process.env.LABEE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
  }
  return process.env.LABEE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
}

/** GET /api/llm/proxy-token — mint a short-lived token for the caller's session,
 *  plus the base URLs the local runtime should point claude / OpenAI at. */
export const proxyTokenRoute = HttpRouter.add(
  "GET",
  "/api/llm/proxy-token",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origin = requestOrigin(request);
    const token = yield* Effect.promise(() => sealProxyToken(user.email));
    return yield* json({
      token,
      expiresIn: PROXY_TOKEN_TTL,
      anthropicBaseUrl: `${origin}/api/llm/anthropic`,
      openaiBaseUrl: `${origin}/api/llm/openai/v1`,
    });
  }),
);

/** Reconstruct the browser-visible origin (honours the reverse proxy). */
function requestOrigin(request: HttpServerRequest.HttpServerRequest): string {
  const env = process.env.LABEE_PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto = (request.headers["x-forwarded-proto"] ?? "https").split(",")[0]!.trim();
  const host = request.headers["host"] ?? "labee.online";
  return `${proto}://${host}`;
}

/** Verify the Bearer proxy token off the request → email, or null. */
const proxyAuth = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = request.headers["authorization"] ?? request.headers["Authorization"];
  const token = auth?.replace(/^Bearer\s+/i, "");
  return yield* Effect.promise(() => readProxyToken(token));
});

/** Shared passthrough: authenticate, gate on entitlement, forward the raw body
 *  to the vendor with Labee's key, and stream the response back verbatim. */
function makeProxy(
  provider: "anthropic" | "openai",
  upstreamBase: string,
  buildHeaders: (incoming: Record<string, string | undefined>, key: string) => Record<string, string>,
) {
  return Effect.gen(function* () {
    const email = yield* proxyAuth;
    if (!email) return yield* error("Invalid or expired proxy token.", 401);

    const entitled = yield* Effect.promise(() => hasPaidEntitlement(email));
    if (!entitled) {
      return yield* error(
        "Your Labee plan doesn't cover this request. Add a plan or credits in Settings → Billing.",
        402,
      );
    }

    const key = labeeKey(provider);
    if (!key) {
      return yield* error(`Labee has no ${provider} account configured on this server.`, 503);
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const rest = (yield* params)["*"] ?? "";
    const url = yield* requestUrlSuffix;
    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));

    const upstream = `${upstreamBase}/${rest}${url}`;
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(upstream, {
          method: "POST",
          headers: buildHeaders(request.headers, key),
          body,
        }),
      catch: (e) => e,
    }).pipe(Effect.catch((e) => Effect.succeed(vendorError(e))));

    // TODO(metering): parse the vendor `usage` (from the SSE stream or JSON) and
    // debit billing.consumeCredits(email, cents) with a per-model price table.
    // v1 gates on entitlement only.

    const ct = res.headers.get("content-type") ?? "application/json";
    if (!res.body) {
      const text = yield* Effect.promise(() => res.text().catch(() => ""));
      return HttpServerResponse.text(text, { status: res.status, contentType: ct });
    }
    return HttpServerResponse.stream(
      Stream.fromReadableStream({
        evaluate: () => res.body as ReadableStream<Uint8Array>,
        onError: (cause) => cause,
      }),
      { status: res.status, contentType: ct },
    );
  });
}

/** Preserve the request's query string for the upstream call. */
const requestUrlSuffix = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const q = request.url.indexOf("?");
  return q >= 0 ? request.url.slice(q) : "";
});

function vendorError(e: unknown): Response {
  const message = e instanceof Error ? e.message : "upstream request failed";
  return new Response(JSON.stringify({ error: { message } }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

/** POST /api/llm/anthropic/* — forward to api.anthropic.com with Labee's key. */
export const anthropicProxyRoute = HttpRouter.add(
  "POST",
  "/api/llm/anthropic/*",
  makeProxy("anthropic", ANTHROPIC_UPSTREAM, (incoming, key) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": incoming["anthropic-version"] ?? "2023-06-01",
    };
    // Forward the beta flags the CLI relies on (tools, fine-grained streaming…).
    const beta = incoming["anthropic-beta"];
    if (beta) headers["anthropic-beta"] = beta;
    return headers;
  }),
);

/** POST /api/llm/openai/* — forward to the OpenAI API with Labee's key. */
export const openaiProxyRoute = HttpRouter.add(
  "POST",
  "/api/llm/openai/*",
  makeProxy("openai", OPENAI_UPSTREAM, (_incoming, key) => ({
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  })),
);

export const llmProxyRoutes = [proxyTokenRoute, anthropicProxyRoute, openaiProxyRoute] as const;
