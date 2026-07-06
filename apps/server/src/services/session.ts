// Framework-agnostic session handling. The Next version leaned on
// `next/headers` + `getIronSession`; here we use iron-session's stateless
// seal/unseal primitives so the Effect HTTP layer can read the cookie off the
// request and write a Set-Cookie header on the response itself.
import { sealData, unsealData } from "iron-session";

export interface SessionData {
  email?: string;
  isAdmin?: boolean;
}

export const COOKIE_NAME = "monterey_session";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getPassword(): string {
  const pw = process.env.SESSION_PASSWORD;
  if (pw && pw.length >= 32) return pw;
  if (!process.env.__MONTEREY_SESSION_WARNED__) {
    process.env.__MONTEREY_SESSION_WARNED__ = "1";
    console.warn(
      "[labee] SESSION_PASSWORD is unset or too short; using an insecure dev default. " +
        "Set SESSION_PASSWORD to a 32+ char random string for production.",
    );
  }
  return "dev-insecure-session-password-please-set-SESSION_PASSWORD-env-var";
}

// Secure flag must be false over plain HTTP (loopback desktop), else browsers
// drop the cookie and the login redirect loops. Override with COOKIE_SECURE.
function cookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV === "production";
}

/** Parse the session out of a raw `Cookie` request header. */
export async function readSession(cookieHeader: string | undefined): Promise<SessionData> {
  if (!cookieHeader) return {};
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return {};
  const sealed = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
  if (!sealed) return {};
  try {
    return await unsealData<SessionData>(sealed, { password: getPassword() });
  } catch {
    return {};
  }
}

/** Seal a session into the raw token value (no cookie attributes). Used by the
 *  desktop OAuth handoff, which injects the value into Electron's cookie jar. */
export async function sealSession(data: SessionData): Promise<string> {
  return sealData(data, { password: getPassword(), ttl: TTL_SECONDS });
}

/** A short-lived, scoped token for the LLM inference proxy. Sealed with the same
 *  session password so any Labee server can verify it; carries only the email +
 *  a scope tag so it can't be replayed as a full session cookie. */
export interface ProxyToken {
  email: string;
  scope: "llm-proxy";
}
const PROXY_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour; the client refetches on expiry

export async function sealProxyToken(email: string): Promise<string> {
  return sealData({ email, scope: "llm-proxy" } satisfies ProxyToken, {
    password: getPassword(),
    ttl: PROXY_TOKEN_TTL_SECONDS,
  });
}

/** Unseal + validate a proxy token, returning the email or null. */
export async function readProxyToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const data = await unsealData<ProxyToken>(token, { password: getPassword() });
    return data.scope === "llm-proxy" && data.email ? data.email : null;
  } catch {
    return null;
  }
}

export const PROXY_TOKEN_TTL = PROXY_TOKEN_TTL_SECONDS;

/** How long a sealed session stays valid, in seconds. */
export const SESSION_TTL_SECONDS = TTL_SECONDS;

/** Build a `Set-Cookie` header value carrying the sealed session. */
export async function sealSessionCookie(data: SessionData): Promise<string> {
  const sealed = await sealSession(data);
  return cookieAttrs(`${COOKIE_NAME}=${encodeURIComponent(sealed)}`, TTL_SECONDS);
}

/** Build a `Set-Cookie` header that clears the session. */
export function clearSessionCookie(): string {
  return cookieAttrs(`${COOKIE_NAME}=`, 0);
}

function cookieAttrs(pair: string, maxAge: number): string {
  const parts = [pair, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export interface CurrentUser {
  email: string;
  isAdmin: boolean;
}

export function currentUser(data: SessionData): CurrentUser | null {
  if (!data.email) return null;
  return { email: data.email, isAdmin: Boolean(data.isAdmin) };
}
