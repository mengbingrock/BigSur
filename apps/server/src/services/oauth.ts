import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import {
  OAUTH_ACCESS_TOKEN_TTL,
  readOauthAccessToken,
  sealOauthAccessToken,
  type OauthAccessToken,
} from "./session";
import { findUser } from "./users";

export const OAUTH_SCOPES = ["protocols:search", "openid", "email"] as const;
const ALLOWED_SCOPES = new Set<string>(OAUTH_SCOPES);
const CODE_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function oauthIssuer(): string {
  return (process.env.LABEE_PUBLIC_URL || "https://labee.online").replace(/\/+$/, "");
}

export function mcpResource(): string {
  return `${oauthIssuer()}/api/protocols/mcp`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function safeRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export async function registerOAuthClient(input: {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
}): Promise<OAuthClient> {
  if (input.token_endpoint_auth_method != null && input.token_endpoint_auth_method !== "none") {
    throw new Error("Only public OAuth clients (token_endpoint_auth_method=none) are supported.");
  }
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 10) {
    throw new Error("redirect_uris must contain between 1 and 10 URLs.");
  }
  const redirectUris = input.redirect_uris.map(safeRedirectUri);
  if (redirectUris.some((uri) => !uri)) throw new Error("Every redirect URI must use HTTPS (or loopback HTTP).");
  const clientName = typeof input.client_name === "string" && input.client_name.trim()
    ? input.client_name.trim().slice(0, 120)
    : "MCP client";
  const clientId = randomUUID();
  const db = await getDb();
  db.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
  ).run(clientId, clientName, JSON.stringify(redirectUris), new Date().toISOString());
  return { clientId, clientName, redirectUris: redirectUris as string[] };
}

export async function oauthClient(clientId: string): Promise<OAuthClient | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
    | { client_id: string; client_name: string; redirect_uris: string }
    | undefined;
  if (!row) return null;
  try {
    const redirectUris = JSON.parse(row.redirect_uris) as string[];
    return { clientId: row.client_id, clientName: row.client_name, redirectUris };
  } catch {
    return null;
  }
}

export interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

export async function validateAuthorizationRequest(params: URLSearchParams): Promise<AuthorizationRequest> {
  if (params.get("response_type") !== "code") throw new Error("response_type must be code.");
  if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required.");
  const clientId = params.get("client_id") ?? "";
  const client = await oauthClient(clientId);
  if (!client) throw new Error("Unknown OAuth client.");
  const redirectUri = safeRedirectUri(params.get("redirect_uri"));
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri is not registered.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new Error("A valid PKCE code_challenge is required.");
  const resource = params.get("resource") ?? mcpResource();
  if (resource !== mcpResource()) throw new Error("The requested OAuth resource is not supported.");
  const requested = (params.get("scope") || "protocols:search openid email").split(/\s+/).filter(Boolean);
  if (requested.some((scope) => !ALLOWED_SCOPES.has(scope))) throw new Error("An unsupported OAuth scope was requested.");
  const state = params.get("state") ?? undefined;
  if (state && state.length > 1024) throw new Error("state is too long.");
  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    ...(state ? { state } : {}),
    codeChallenge,
    resource,
    scope: requested.join(" "),
  };
}

export async function issueAuthorizationCode(email: string, request: AuthorizationRequest): Promise<string> {
  const code = token("lbc");
  const db = await getDb();
  db.prepare(
    "INSERT INTO oauth_codes (code_hash, email, client_id, redirect_uri, code_challenge, resource, scope, expires_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    hash(code), email, request.clientId, request.redirectUri, request.codeChallenge,
    request.resource, request.scope, Date.now() + CODE_TTL_MS, new Date().toISOString(),
  );
  return code;
}

interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function createTokenSet(
  email: string,
  clientId: string,
  resource: string,
  scope: string,
): Promise<TokenSet> {
  const scopes = scope.split(/\s+/).filter(Boolean);
  const access = await sealOauthAccessToken({ email, clientId, resource, scopes });
  const refresh = token("lbr");
  const db = await getDb();
  db.prepare(
    "INSERT INTO oauth_refresh_tokens (token_hash, email, client_id, resource, scope, expires_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(hash(refresh), email, clientId, resource, scope, Date.now() + REFRESH_TTL_MS, new Date().toISOString());
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_TTL,
    refresh_token: refresh,
    scope,
  };
}

function pkceMatches(verifier: string, expected: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}): Promise<TokenSet> {
  const db = await getDb();
  const codeHash = hash(input.code);
  const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as
    | { email: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string; scope: string; expires_at: number }
    | undefined;
  db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
  if (!row || row.expires_at < Date.now()) throw new Error("invalid_grant");
  if (
    row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri ||
    row.resource !== input.resource || !pkceMatches(input.codeVerifier, row.code_challenge)
  ) throw new Error("invalid_grant");
  return createTokenSet(row.email, row.client_id, row.resource, row.scope);
}

export async function exchangeRefreshToken(input: {
  refreshToken: string;
  clientId: string;
  resource: string;
}): Promise<TokenSet> {
  const db = await getDb();
  const tokenHash = hash(input.refreshToken);
  const row = db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").get(tokenHash) as
    | { email: string; client_id: string; resource: string; scope: string; expires_at: number }
    | undefined;
  db.prepare("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?").run(tokenHash);
  if (!row || row.expires_at < Date.now() || row.client_id !== input.clientId || row.resource !== input.resource) {
    throw new Error("invalid_grant");
  }
  return createTokenSet(row.email, row.client_id, row.resource, row.scope);
}

/** RFC 7009-style revocation. Deliberately idempotent: callers get the same
 *  result whether the token existed, was already rotated, or was unknown. */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  const db = await getDb();
  db.prepare("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?").run(hash(refreshToken));
}

export async function oauthPrincipal(tokenValue: string | undefined): Promise<OauthAccessToken | null> {
  const tokenData = await readOauthAccessToken(tokenValue);
  if (!tokenData || tokenData.resource !== mcpResource() || !tokenData.scopes.includes("protocols:search")) return null;
  if (!(await findUser(tokenData.email))) return null;
  return tokenData;
}

export function subjectFor(email: string): string {
  return hash(`labee:${email}`);
}
