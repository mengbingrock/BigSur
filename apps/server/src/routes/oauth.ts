import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { bodyJson, error, requestUrl, sessionUser } from "../httpKit";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  issueAuthorizationCode,
  mcpResource,
  oauthIssuer,
  oauthPrincipal,
  registerOAuthClient,
  subjectFor,
  validateAuthorizationRequest,
  type AuthorizationRequest,
} from "../services/oauth";

const json = (data: unknown, status = 200) =>
  HttpServerResponse.json(data, { status }).pipe(
    Effect.map((res) => HttpServerResponse.setHeader(res, "cache-control", "no-store")),
  );

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]!);
}

function hidden(name: string, value: string | undefined): string {
  return value == null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function consentHtml(req: AuthorizationRequest): string {
  let host = "Labee";
  try { host = new URL(req.redirectUri).hostname; } catch { /* validated already */ }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Labee</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f3;color:#1d1d1b;margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(420px,calc(100vw - 40px));background:#fff;border:1px solid #dddcd5;border-radius:16px;padding:28px;box-shadow:0 12px 40px #00000012}h1{font-size:25px;margin:0 0 10px}p{line-height:1.5;color:#555}ul{padding-left:22px;line-height:1.7}.buttons{display:flex;gap:10px;margin-top:24px}button{border:0;border-radius:9px;padding:11px 16px;font:inherit;cursor:pointer}.allow{background:#181817;color:#fff}.deny{background:#ecece7;color:#333}</style></head><body><main class="card"><h1>Connect ${escapeHtml(req.clientName)} to Labee?</h1><p><strong>${escapeHtml(host)}</strong> is requesting permission to use your Labee account.</p><ul><li>Search laboratory protocol publishers</li><li>Use and display your Labee search-credit balance</li></ul><p>You can revoke the connection by signing out of the plugin.</p><form method="post" action="/oauth/authorize">${hidden("response_type", "code")}${hidden("client_id", req.clientId)}${hidden("redirect_uri", req.redirectUri)}${hidden("state", req.state)}${hidden("code_challenge", req.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("resource", req.resource)}${hidden("scope", req.scope)}<div class="buttons"><button class="allow" name="decision" value="allow">Allow</button><button class="deny" name="decision" value="deny">Cancel</button></div></form></main></body></html>`;
}

function redirect(url: URL) {
  return HttpServerResponse.redirect(url.toString(), { status: 302 });
}

function authorizationRedirect(req: AuthorizationRequest, values: Record<string, string>): URL {
  const target = new URL(req.redirectUri);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
  if (req.state) target.searchParams.set("state", req.state);
  target.searchParams.set("iss", oauthIssuer());
  return target;
}

export const oauthMetadataRoute = HttpRouter.add(
  "GET",
  "/.well-known/oauth-authorization-server",
  json({
    issuer: oauthIssuer(),
    authorization_endpoint: `${oauthIssuer()}/oauth/authorize`,
    token_endpoint: `${oauthIssuer()}/oauth/token`,
    registration_endpoint: `${oauthIssuer()}/oauth/register`,
    userinfo_endpoint: `${oauthIssuer()}/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["protocols:search", "openid", "email"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  }),
);

export const protectedResourceRoute = HttpRouter.add(
  "GET",
  "/.well-known/oauth-protected-resource",
  json({
    resource: mcpResource(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: ["protocols:search"],
    resource_documentation: `${oauthIssuer()}/marketplace`,
  }),
);

// RFC 9728 path-aware discovery form for clients that derive the well-known
// URI from the complete MCP resource path instead of using the challenge URL.
export const protectedMcpResourceRoute = HttpRouter.add(
  "GET",
  "/.well-known/oauth-protected-resource/api/protocols/mcp",
  json({
    resource: mcpResource(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: ["protocols:search"],
    resource_documentation: `${oauthIssuer()}/marketplace`,
  }),
);

export const oauthRegisterRoute = HttpRouter.add(
  "POST",
  "/oauth/register",
  Effect.gen(function* () {
    const input = yield* bodyJson<Record<string, unknown>>().pipe(
      Effect.catch(() => Effect.succeed({})),
    );
    const result = yield* Effect.tryPromise({
      try: () => registerOAuthClient(input),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((client) => ({ ok: true as const, client })),
      Effect.catch((cause) => Effect.succeed({
        ok: false as const,
        message: cause instanceof Error ? cause.message : String(cause),
      })),
    );
    if (!result.ok) return yield* json({ error: "invalid_client_metadata", error_description: result.message }, 400);
    return yield* json({
      client_id: result.client.clientId,
      client_name: result.client.clientName,
      redirect_uris: result.client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, 201);
  }),
);

export const oauthAuthorizeGetRoute = HttpRouter.add(
  "GET",
  "/oauth/authorize",
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const validated = yield* Effect.tryPromise({
      try: () => validateAuthorizationRequest(url.searchParams),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((request) => ({ ok: true as const, request })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, message: cause instanceof Error ? cause.message : String(cause) })),
    );
    if (!validated.ok) return yield* error(validated.message, 400);
    const user = yield* sessionUser;
    if (!user) {
      const next = `${url.pathname}${url.search}`;
      return HttpServerResponse.redirect(`/login?next=${encodeURIComponent(next)}`, { status: 302 });
    }
    return HttpServerResponse.text(consentHtml(validated.request), { contentType: "text/html; charset=utf-8" });
  }),
);

export const oauthAuthorizePostRoute = HttpRouter.add(
  "POST",
  "/oauth/authorize",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const params = new URLSearchParams(raw);
    const validated = yield* Effect.tryPromise({
      try: () => validateAuthorizationRequest(params),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((auth) => ({ ok: true as const, auth })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, message: cause instanceof Error ? cause.message : String(cause) })),
    );
    if (!validated.ok) return yield* error(validated.message, 400);
    const user = yield* sessionUser;
    if (!user) {
      const query = new URLSearchParams(params);
      query.delete("decision");
      return HttpServerResponse.redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`, { status: 302 });
    }
    if (params.get("decision") !== "allow") {
      return redirect(authorizationRedirect(validated.auth, { error: "access_denied" }));
    }
    const code = yield* Effect.promise(() => issueAuthorizationCode(user.email, validated.auth));
    return redirect(authorizationRedirect(validated.auth, { code }));
  }),
);

export const oauthTokenRoute = HttpRouter.add(
  "POST",
  "/oauth/token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
    const body = new URLSearchParams(raw);
    const grantType = body.get("grant_type");
    const clientId = body.get("client_id") ?? "";
    const resource = body.get("resource") ?? mcpResource();
    const attempt = grantType === "authorization_code"
      ? exchangeAuthorizationCode({
          code: body.get("code") ?? "",
          clientId,
          redirectUri: body.get("redirect_uri") ?? "",
          codeVerifier: body.get("code_verifier") ?? "",
          resource,
        })
      : grantType === "refresh_token"
        ? exchangeRefreshToken({ refreshToken: body.get("refresh_token") ?? "", clientId, resource })
        : Promise.reject(new Error("unsupported_grant_type"));
    const result = yield* Effect.tryPromise({ try: () => attempt, catch: (cause) => cause }).pipe(
      Effect.map((tokens) => ({ ok: true as const, tokens })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, message: cause instanceof Error ? cause.message : String(cause) })),
    );
    if (!result.ok) {
      const code = result.message === "unsupported_grant_type" ? "unsupported_grant_type" : "invalid_grant";
      return yield* json({ error: code, error_description: "The OAuth grant is invalid or expired." }, 400);
    }
    return yield* json(result.tokens);
  }),
);

export const oauthUserInfoRoute = HttpRouter.add(
  "GET",
  "/oauth/userinfo",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const value = (request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const principal = yield* Effect.promise(() => oauthPrincipal(value));
    if (!principal) return yield* json({ error: "invalid_token" }, 401);
    return yield* json({
      sub: subjectFor(principal.email),
      email: principal.email,
      email_verified: true,
    });
  }),
);

export const oauthRoutes = [
  oauthMetadataRoute,
  protectedResourceRoute,
  protectedMcpResourceRoute,
  oauthRegisterRoute,
  oauthAuthorizeGetRoute,
  oauthAuthorizePostRoute,
  oauthTokenRoute,
  oauthUserInfoRoute,
] as const;
