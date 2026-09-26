// Protocol-search MCP proxy — the public face of the labee-mcp service.
//
// The MCP server itself authenticates with one static shared secret
// (PROTOCOLS_MCP_TOKEN), which is fine on-box but can't be handed to a desktop
// build: a secret inside a shipped bundle is extractable, unattributable and
// unrevokable. So external clients never talk to it directly. They mint a
// short-lived per-user token from their Labee session and send it here; this
// route verifies it and forwards the JSON-RPC body to the MCP service using the
// static secret, which never leaves the box.
//
// Structurally this mirrors routes/llmProxy.ts, which does the same thing for
// vendor inference calls.

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { error, json, sessionUser } from "../httpKit";
import { addCredits, hasPaidEntitlement, reserveProtocolSearch } from "../services/billing";
import { oauthPrincipal } from "../services/oauth";
import { clientIp, consume } from "../services/rateLimit";
import { MCP_TOKEN_TTL, readMcpToken, sealMcpToken } from "../services/session";

const HOUR_MS = 60 * 60 * 1000;

/** Requests per hour, by tier. 0 = unmetered. */
const ANON_LIMIT = Number(process.env.PROTOCOLS_MCP_ANON_LIMIT ?? 20);
const USER_LIMIT = Number(process.env.PROTOCOLS_MCP_USER_LIMIT ?? 200);

interface Tier {
  /** Rate-limit bucket key. */
  key: string;
  limit: number;
  /** Present when the caller is a known account. */
  email?: string;
}

/** Where the labee-mcp service listens. Loopback by default. */
const UPSTREAM = (process.env.PROTOCOLS_MCP_URL || "http://127.0.0.1:3001/mcp").trim();
/** The MCP service's own shared secret. Never sent to a client. */
const UPSTREAM_TOKEN = process.env.PROTOCOLS_MCP_TOKEN?.trim();

export function mcpCallCounts(raw: string): { searches: number; toolCalls: number } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    let searches = 0;
    let toolCalls = 0;
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const value = message as { method?: unknown; params?: { name?: unknown } };
      if (value.method !== "tools/call") continue;
      toolCalls += 1;
      if (value.params?.name === "search") searches += 1;
    }
    return { searches, toolCalls };
  } catch {
    return { searches: 0, toolCalls: 0 };
  }
}

function rpcErrorBody(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
}

function authChallenge(): string {
  return `Bearer resource_metadata="${requestOriginStub()}/.well-known/oauth-protected-resource", scope="protocols:search"`;
}

function requestOriginStub(): string {
  return (process.env.LABEE_PUBLIC_URL || "https://labee.online").replace(/\/+$/, "");
}

/** Reconstruct the browser-visible origin (honours the reverse proxy). */
function requestOrigin(request: HttpServerRequest.HttpServerRequest): string {
  const env = process.env.LABEE_PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto = (request.headers["x-forwarded-proto"] ?? "https").split(",")[0]!.trim();
  const host = request.headers["host"] ?? "labee.online";
  return `${proto}://${host}`;
}

/**
 * GET /api/protocols/mcp-token — mint a short-lived MCP token for the caller's
 * session, plus the URL a client should point its MCP config at.
 */
export const mcpTokenRoute = HttpRouter.add(
  "GET",
  "/api/protocols/mcp-token",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = yield* Effect.promise(() => sealMcpToken(user.email));
    return yield* json({
      token,
      expiresIn: MCP_TOKEN_TTL,
      url: `${requestOrigin(request)}/api/protocols/mcp`,
    });
  }),
);

/**
 * POST /api/protocols/mcp — authenticate a scoped token, then forward the
 * JSON-RPC message to the MCP service verbatim and return its reply.
 *
 * The body is a small JSON envelope either way, so this buffers rather than
 * streams: the expensive work (search, PDF extraction) happens in the MCP
 * process, which keeps its own heap.
 */
export const mcpProxyRoute = HttpRouter.add(
  "POST",
  "/api/protocols/mcp",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = request.headers["authorization"] ?? request.headers["Authorization"];
    const presented = auth?.replace(/^Bearer\s+/i, "");
    const legacyEmail = yield* Effect.promise(() => readMcpToken(presented));
    const oauth = legacyEmail ? null : yield* Effect.promise(() => oauthPrincipal(presented));
    const email = legacyEmail ?? oauth?.email ?? null;

    // A token that was presented but didn't verify is an error, not a silent
    // demotion to the anonymous tier — otherwise an expired token looks like it
    // still works, just mysteriously throttled.
    if (presented && !email) {
      return HttpServerResponse.text(rpcErrorBody(-32001, "Invalid or expired MCP token."), {
        status: 401,
        contentType: "application/json",
        headers: { "www-authenticate": authChallenge() },
      });
    }

    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const { searches, toolCalls } = mcpCallCounts(body);
    let tier: Tier;
    if (email) {
      const paid = yield* Effect.promise(() => hasPaidEntitlement(email));
      tier = { key: `mcp:user:${email}`, limit: paid ? 0 : USER_LIMIT, email };
    } else {
      tier = { key: `mcp:ip:${clientIp(request.headers)}`, limit: ANON_LIMIT };
    }

    // MCP clients create fresh processes frequently. Initialization,
    // notifications, and tool discovery are bootstrap traffic, not protocol
    // retrieval, and must remain available after the caller exhausts their
    // anonymous tool-call quota so `labee_auth` can still be discovered.
    const quota = toolCalls > 0
      ? consume(tier.key, tier.limit, HOUR_MS)
      : {
          allowed: true,
          limit: Infinity,
          remaining: Infinity,
          resetAt: Date.now(),
          retryAfterSeconds: 0,
        };
    if (toolCalls > 0 && !quota.allowed) {
      const hint = tier.email
        ? "Add credits in Settings → Billing to lift this limit."
        : "Sign in at labee.online for a higher limit.";
      const needsAuth = !tier.email;
      return HttpServerResponse.text(
        rpcErrorBody(-32029, `Rate limit exceeded (${quota.limit}/hour). ${hint}`),
        {
          status: needsAuth ? 401 : 429,
          contentType: "application/json",
          headers: {
            ...(needsAuth ? { "www-authenticate": authChallenge() } : {}),
            "retry-after": String(quota.retryAfterSeconds),
            "x-ratelimit-limit": String(quota.limit),
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(quota.resetAt / 1000)),
          },
        },
      );
    }

    let reserved = 0;
    if (email && searches > 0) {
      const credit = yield* Effect.promise(() => reserveProtocolSearch(email, searches));
      if (!credit.allowed) {
        return HttpServerResponse.text(
          rpcErrorBody(-32030, "Search credit exhausted. Add credits in Labee Settings → Billing."),
          { status: 402, contentType: "application/json" },
        );
      }
      reserved = credit.charged;
    }

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(UPSTREAM, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(UPSTREAM_TOKEN ? { authorization: `Bearer ${UPSTREAM_TOKEN}` } : {}),
          },
          body,
        }),
      catch: (e) => e,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    if (!res) {
      if (email && reserved > 0) yield* Effect.promise(() => addCredits(email, reserved, "adjustment"));
      return yield* error("The protocol-search service is unavailable.", 503);
    }

    const text = yield* Effect.promise(() => res.text().catch(() => ""));
    if (!res.ok && email && reserved > 0) {
      yield* Effect.promise(() => addCredits(email, reserved, "adjustment"));
    }
    // 202 (notification accepted) legitimately has no body.
    return HttpServerResponse.text(text, {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      headers: Number.isFinite(quota.limit)
        ? {
            "x-ratelimit-limit": String(quota.limit),
            "x-ratelimit-remaining": String(quota.remaining),
            "x-ratelimit-reset": String(Math.floor(quota.resetAt / 1000)),
          }
        : {},
    });
  }),
);
