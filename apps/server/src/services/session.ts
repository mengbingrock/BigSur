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

/** Build a `Set-Cookie` header value carrying the sealed session. */
export async function sealSessionCookie(data: SessionData): Promise<string> {
  const sealed = await sealData(data, { password: getPassword(), ttl: TTL_SECONDS });
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
