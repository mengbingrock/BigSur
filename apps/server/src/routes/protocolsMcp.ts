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
import { MCP_TOKEN_TTL, readMcpToken, sealMcpToken } from "../services/session";

/** Where the labee-mcp service listens. Loopback by default. */
const UPSTREAM = (process.env.PROTOCOLS_MCP_URL || "http://127.0.0.1:3001/mcp").trim();
/** The MCP service's own shared secret. Never sent to a client. */
const UPSTREAM_TOKEN = process.env.PROTOCOLS_MCP_TOKEN?.trim();

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
    const email = yield* Effect.promise(() =>
      readMcpToken(auth?.replace(/^Bearer\s+/i, "")),
    );
    if (!email) return yield* error("Invalid or expired MCP token.", 401);

    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));

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
      return yield* error("The protocol-search service is unavailable.", 503);
    }

    const text = yield* Effect.promise(() => res.text().catch(() => ""));
    // 202 (notification accepted) legitimately has no body.
    return HttpServerResponse.text(text, {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
    });
  }),
);
