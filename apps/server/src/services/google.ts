// Google OAuth 2.0 (Authorization Code flow), library-free. We hit Google's
// documented OIDC endpoints with fetch and verify identity by calling the
// userinfo endpoint with the issued access token (HTTPS + bearer token), so no
// JWT-verification dependency is needed. CSRF is covered by a short-lived,
// iron-session-sealed `state` cookie that we compare against the callback's
// `state` query parameter.
import crypto from "node:crypto";
import { sealData, unsealData } from "iron-session";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

export const OAUTH_STATE_COOKIE = "monterey_oauth_state";
const STATE_TTL_SECONDS = 60 * 10; // 10 minutes to complete the round-trip

export function isGoogleEnabled(): boolean {
  if (!process.env.GOOGLE_CLIENT_ID) return false;
  // Confidential client (web deployment) needs a secret. The desktop app uses a
  // public "Desktop app" client with PKCE and no secret.
  if (process.env.GOOGLE_CLIENT_SECRET) return true;
  return process.env.LABEE_MODE === "desktop";
}

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not configured.");
  return v;
}

/** Generate a PKCE verifier/challenge pair (RFC 7636, S256). Used for every
 *  flow — harmless for confidential clients, required for the public desktop
 *  client. The verifier travels (sealed) in the state cookie. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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
  codeVerifier: string;
  /** Desktop (remote mode): a loopback URL to hand the sealed session back to,
   *  so system-browser sign-in can return the session to the app. */
  desktop?: string;
}

/** A safe desktop handoff target: an http loopback URL (127.0.0.1/localhost).
 *  Guards against the session being redirected anywhere off the local machine. */
export function isLoopbackCallback(u: string | null | undefined): boolean {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
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
export function buildAuthUrl(opts: {
  state: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
    access_type: "online",
    prompt: "select_account",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange an authorization code for an access token. Includes the PKCE
 *  verifier; the client secret is sent only when configured (confidential
 *  web client) and omitted for the public desktop client. */
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.codeVerifier,
  });
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (secret) body.set("client_secret", secret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let message = `Google token exchange failed (${res.status}).`;
    try {
      const parsed = JSON.parse(detail) as { error?: string; error_description?: string };
      const reason = parsed.error_description || parsed.error;
      if (reason) message = `Google sign-in failed: ${reason}.`;
    } catch {
      /* non-JSON body */
    }
    throw new Error(message);
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
