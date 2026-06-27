// Google OAuth 2.0 (Authorization Code flow), library-free. We hit Google's
// documented OIDC endpoints with fetch and verify identity by calling the
// userinfo endpoint with the issued access token (HTTPS + bearer token), so no
// JWT-verification dependency is needed. CSRF is covered by a short-lived,
// iron-session-sealed `state` cookie that we compare against the callback's
// `state` query parameter.
import { sealData, unsealData } from "iron-session";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

export const OAUTH_STATE_COOKIE = "monterey_oauth_state";
const STATE_TTL_SECONDS = 60 * 10; // 10 minutes to complete the round-trip

export function isGoogleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not configured.");
  return v;
}

function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_CLIENT_SECRET is not configured.");
  return v;
}

// Reuse the session password for sealing the state cookie. Imported lazily to
// avoid a circular dependency between this module and session.ts.
function statePassword(): string {
  const pw = process.env.SESSION_PASSWORD;
  if (pw && pw.length >= 32) return pw;
  return "dev-insecure-session-password-please-set-SESSION_PASSWORD-env-var";
}

function cookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Resolve the OAuth redirect URI. Prefer an explicit `GOOGLE_REDIRECT_URI`
 * (required in dev when the browser sits on the Vite origin); otherwise derive
 * it from the incoming request's origin, which is correct for same-origin
 * production deployments. Must exactly match an authorized redirect URI in the
 * Google Cloud console.
 */
export function resolveRedirectUri(requestOrigin: string): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI;
  if (explicit) return explicit;
  return `${requestOrigin.replace(/\/$/, "")}/api/auth/google/callback`;
}

export interface OAuthState {
  state: string;
  next: string;
  redirectUri: string;
}

/** Build the `Set-Cookie` value carrying the sealed OAuth state. */
export async function sealStateCookie(data: OAuthState): Promise<string> {
  const sealed = await sealData(data, { password: statePassword(), ttl: STATE_TTL_SECONDS });
  const parts = [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(sealed)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL_SECONDS}`,
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Build a `Set-Cookie` value that clears the OAuth state cookie. */
export function clearStateCookie(): string {
  const parts = [`${OAUTH_STATE_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Read and unseal the OAuth state cookie from a raw `Cookie` header. */
export async function readStateCookie(cookieHeader: string | undefined): Promise<OAuthState | null> {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
  if (!match) return null;
  const sealed = decodeURIComponent(match.slice(OAUTH_STATE_COOKIE.length + 1));
  if (!sealed) return null;
  try {
    return await unsealData<OAuthState>(sealed, { password: statePassword() });
  } catch {
    return null;
  }
}

/** Build the Google authorization URL the browser is redirected to. */
export function buildAuthUrl(opts: { state: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange an authorization code for an access token. */
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}).`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google token exchange returned no access token.");
  return { accessToken: data.access_token };
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/** Fetch the verified profile for an access token. */
export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google profile (${res.status}).`);
  }
  const data = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
  };
  if (!data.sub || !data.email) {
    throw new Error("Google profile is missing an id or email.");
  }
  return {
    sub: data.sub,
    email: data.email,
    emailVerified: data.email_verified === true || data.email_verified === "true",
  };
}
