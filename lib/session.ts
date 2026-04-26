import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

export interface SessionData {
  email?: string;
  isAdmin?: boolean;
}

function getPassword(): string {
  const pw = process.env.SESSION_PASSWORD;
  if (pw && pw.length >= 32) return pw;
  // Dev fallback — warns once, does not fail the server. In production, set
  // SESSION_PASSWORD to a 32+ char random string.
  if (!process.env.__MONTEREY_SESSION_WARNED__) {
    process.env.__MONTEREY_SESSION_WARNED__ = "1";
    console.warn(
      "[monterey] SESSION_PASSWORD is unset or too short; using an insecure dev default. " +
        "Set SESSION_PASSWORD to a 32+ char random string for production.",
    );
  }
  return "dev-insecure-session-password-please-set-SESSION_PASSWORD-env-var";
}

// Whether to set the Secure cookie flag. Default: match NODE_ENV in prod.
// Override with COOKIE_SECURE=true | false. Must be false when serving over
// plain HTTP — browsers silently drop Secure cookies on HTTP, which causes
// a login → redirect → login refresh loop.
function cookieSecure(): boolean {
  const v = process.env.COOKIE_SECURE;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV === "production";
}

export const sessionOptions: SessionOptions = {
  password: getPassword(),
  cookieName: "monterey_session",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  },
};

export async function getSession() {
  return getIronSession<SessionData>(cookies(), sessionOptions);
}

export async function getCurrentEmail(): Promise<string | null> {
  const session = await getSession();
  return session.email ?? null;
}

export interface CurrentUser {
  email: string;
  isAdmin: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession();
  if (!session.email) return null;
  return { email: session.email, isAdmin: Boolean(session.isAdmin) };
}
