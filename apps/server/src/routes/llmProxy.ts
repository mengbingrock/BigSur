// LLM inference proxy — the "remote brain" for local-first "Labee Provided"
// agents. A Provided agent runs on the user's Mac (local files/tools/MCP), but
// its model calls are pointed at these endpoints instead of the vendor. The
// proxy authenticates a short-lived scoped token, checks the caller is entitled
// (active plan or credits), swaps in Labee's real vendor key, and streams the
// vendor's response straight back — a transparent passthrough so the claude CLI
// and OpenAI client behave exactly as if they talked to the vendor directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const OAUTH_BETA = "oauth-2025-04-20";

/** How Labee authenticates to Anthropic upstream: a console API key, or a Claude
 *  subscription OAuth token (the box's own Max/Pro login — no API billing). */
type AnthropicAuth =
  | { kind: "apiKey"; value: string }
  | { kind: "oauth"; value: string }
  | null;

/** Read the box's Claude subscription OAuth access token, in order of preference:
 *  an explicit long-lived token (from `claude setup-token`), else the access
 *  token in the CLI credential store (`~/.claude/.credentials.json`). */
function claudeOAuthToken(): string | null {
  const explicit =
    process.env.LABEE_ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (explicit) return explicit.trim();
  try {
    const file = path.join(os.homedir(), ".claude", ".credentials.json");
    interface OAuthCred {
      accessToken?: string;
      expiresAt?: number;
      claudeAiOauth?: OAuthCred;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as OAuthCred;
    const o: OAuthCred = raw.claudeAiOauth ?? raw;
    // Skip an obviously-expired token (the CLI refreshes it on use, not us).
    if (o.expiresAt && o.expiresAt < Date.now()) return null;
    return o.accessToken?.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve how to authenticate the Anthropic upstream call. Prefer a real API
 *  key (clean, ToS-simple); else fall back to the box's subscription token. */
function anthropicAuth(): AnthropicAuth {
  const key = process.env.LABEE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (key) return { kind: "apiKey", value: key };
  const oauth = claudeOAuthToken();
  if (oauth) return { kind: "oauth", value: oauth };
  return null;
}

function openaiKey(): string | null {
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
 *  to the vendor with Labee's credential, and stream the response back verbatim.
 *  `buildHeaders` returns null when no Labee credential is configured (→ 503). */
function makeProxy(
  provider: "anthropic" | "openai",
  upstreamBase: string,
  buildHeaders: (incoming: Record<string, string | undefined>) => Record<string, string> | null,
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

    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = buildHeaders(request.headers);
    if (!headers) {
      return yield* error(`Labee has no ${provider} account configured on this server.`, 503);
    }

    const rest = (yield* params)["*"] ?? "";
    const url = yield* requestUrlSuffix;
    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));

    const upstream = `${upstreamBase}/${rest}${url}`;
    const res = yield* Effect.tryPromise({
      try: () => fetch(upstream, { method: "POST", headers, body }),
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

/** POST /api/llm/anthropic/* — forward to api.anthropic.com using Labee's API
 *  key, or (fallback) the box's Claude subscription OAuth token. */
export const anthropicProxyRoute = HttpRouter.add(
  "POST",
  "/api/llm/anthropic/*",
  makeProxy("anthropic", ANTHROPIC_UPSTREAM, (incoming) => {
    const auth = anthropicAuth();
    if (!auth) return null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": incoming["anthropic-version"] ?? "2023-06-01",
    };
    // Forward the beta flags the CLI relies on (tools, fine-grained streaming…).
    const betas = new Set((incoming["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter(Boolean));
    if (auth.kind === "apiKey") {
      headers["x-api-key"] = auth.value;
    } else {
      // Subscription auth: Bearer token + the oauth beta. The incoming request
      // comes from a real claude CLI, so its system prompt already leads with the
      // required "You are Claude Code…" identity block.
      headers["authorization"] = `Bearer ${auth.value}`;
      betas.add(OAUTH_BETA);
    }
    if (betas.size) headers["anthropic-beta"] = Array.from(betas).join(",");
    return headers;
  }),
);

/** POST /api/llm/openai/* — forward to the OpenAI API with Labee's key. */
export const openaiProxyRoute = HttpRouter.add(
  "POST",
  "/api/llm/openai/*",
  makeProxy("openai", OPENAI_UPSTREAM, () => {
    const key = openaiKey();
    if (!key) return null;
    return { "content-type": "application/json", authorization: `Bearer ${key}` };
  }),
);

export const llmProxyRoutes = [proxyTokenRoute, anthropicProxyRoute, openaiProxyRoute] as const;
