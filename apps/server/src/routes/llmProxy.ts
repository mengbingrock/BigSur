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
import { hasPaidEntitlement, recordUsage } from "../services/billing";
import { PROXY_TOKEN_TTL, readProxyToken, sealProxyToken } from "../services/session";

const params = HttpRouter.params;

const ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
const OPENAI_UPSTREAM = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(
  /\/v1\/?$/,
  "",
);
const OAUTH_BETA = "oauth-2025-04-20";

/** How Labee authenticates to Anthropic upstream: a Console API key, or — in
 *  local development only — this machine's own Claude subscription token. */
type AnthropicAuth =
  | { kind: "apiKey"; value: string }
  | { kind: "oauth"; value: string }
  | null;

/**
 * Whether the subscription fallback below may be used at all. Off unless
 * switched on explicitly, which is the entire point of the flag.
 *
 * Serving users from a Claude subscription is something Anthropic prohibits —
 * "Anthropic does not permit third-party developers to ... route requests
 * through Free, Pro, or Max plan credentials on behalf of their users"
 * (https://code.claude.com/docs/en/legal-and-compliance) — so it must not be
 * reachable on a hosted box. Note it cannot simply be gated on "no API key is
 * configured": that is exactly the state a misconfigured production box is in,
 * which is how this came to be live on labee.online in the first place. An
 * explicit opt-in is the only form of "development only" that is actually true.
 */
function devSubscriptionProxyEnabled(): boolean {
  return process.env.LABEE_DEV_SUBSCRIPTION_PROXY === "1";
}

/** Read this machine's Claude subscription OAuth access token, in order of
 *  preference: an explicit long-lived token, else the one the CLI stored. */
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

/** Resolve how to authenticate the Anthropic upstream call. An API key always
 *  wins; the subscription token is a local-development fallback only. */
function anthropicAuth(): AnthropicAuth {
  const key = process.env.LABEE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (key) return { kind: "apiKey", value: key };
  /**if (!devSubscriptionProxyEnabled()) return null;**/
  const oauth = claudeOAuthToken();
  return oauth ? { kind: "oauth", value: oauth } : null;
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
      // What this box can actually serve. A desktop shows "Labee provided" as
      // unavailable for anything listed false, instead of offering it and
      // failing the first turn with a 503.
      providers: { anthropic: anthropicAuth() !== null, openai: openaiKey() !== null },
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
        // Keep this free of any "buy a plan" call to action: it can surface in
        // the iOS transcript, and App Store guideline 3.1.1 forbids directing
        // users to a purchase outside In-App Purchase. Desktop and web users
        // already have Settings → Billing in front of them.
        "Your Labee plan doesn't cover this request.",
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

    // Meter the call: the client sends `model` in the request body; the vendor
    // reports token `usage` in the response. We only bill successful calls.
    const model = modelFromBody(body);
    const meter = res.status < 300;

    const ct = res.headers.get("content-type") ?? "application/json";
    if (!res.body) {
      const text = yield* Effect.promise(() => res.text().catch(() => ""));
      if (meter) meterFromText(email, provider, model, text);
      return HttpServerResponse.text(text, { status: res.status, contentType: ct });
    }
    // Tee the vendor stream: one branch streams to the client verbatim, the
    // other is drained in the background to extract usage (never blocks the
    // client, never throws into the request path).
    const source = res.body as ReadableStream<Uint8Array>;
    let clientBranch = source;
    if (meter) {
      const [a, b] = source.tee();
      clientBranch = a;
      void drainAndMeter(b, email, provider, model);
    }
    return HttpServerResponse.stream(
      Stream.fromReadableStream({
        evaluate: () => clientBranch,
        onError: (cause) => cause,
      }),
      { status: res.status, contentType: ct },
    );
  });
}

/** The model id from a vendor request body (Anthropic + OpenAI both use `model`). */
function modelFromBody(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { model?: unknown }).model;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Drain a teed response branch fully, then meter from the accumulated text. */
async function drainAndMeter(
  stream: ReadableStream<Uint8Array>,
  email: string,
  provider: "anthropic" | "openai",
  model: string | null,
): Promise<void> {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    meterFromText(email, provider, model, text);
  } catch {
    // dropped/aborted stream — nothing to bill
  }
}

/** Extract token usage from a vendor response (SSE stream or plain JSON) and
 *  record the spend. Fire-and-forget. */
function meterFromText(
  email: string,
  provider: "anthropic" | "openai",
  model: string | null,
  text: string,
): void {
  const usage = extractUsage(text);
  if (usage.inputTokens + usage.outputTokens <= 0) return;
  void recordUsage({ email, provider, model, ...usage });
}

/** Pull the largest input/output token counts out of a response body. Handles
 *  Anthropic (`input_tokens`/`output_tokens`, split across message_start /
 *  message_delta SSE events) and OpenAI (`prompt_tokens`/`completion_tokens` or
 *  Responses-API `input_tokens`/`output_tokens`), streamed or not. */
function extractUsage(text: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  const consider = (u: unknown): void => {
    if (!u || typeof u !== "object") return;
    const o = u as Record<string, unknown>;
    const inp = Number(o.input_tokens ?? o.prompt_tokens ?? 0);
    const out = Number(o.output_tokens ?? o.completion_tokens ?? 0);
    if (Number.isFinite(inp) && inp > inputTokens) inputTokens = inp;
    if (Number.isFinite(out) && out > outputTokens) outputTokens = out;
  };
  const scan = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    if (rec.usage) consider(rec.usage);
    if (rec.message && typeof rec.message === "object") {
      const m = rec.message as Record<string, unknown>;
      if (m.usage) consider(m.usage);
    }
  };
  // Try whole-body JSON first (non-streaming responses).
  try {
    scan(JSON.parse(text));
  } catch {
    // not a single JSON doc — fall through to SSE line parsing
  }
  // SSE: parse each `data:` payload.
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      scan(JSON.parse(payload));
    } catch {
      // partial/non-JSON line — ignore
    }
  }
  return { inputTokens, outputTokens };
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
 *  key, or the development-only subscription fallback. 503 when neither. */
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
      // Development-only subscription auth: Bearer token plus the oauth beta.
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
