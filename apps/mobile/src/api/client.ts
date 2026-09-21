// HTTP client for a Labee host. A Target is either the desktop server reached
// directly (dev / LAN) or a Mac reached through the labee.online Device Link
// relay, in which case every path is prefixed with /api/hosts/:hostId.
import { Platform } from "react-native";

export interface Target {
  /** Origin of the server we talk to, e.g. https://labee.online or http://192.168.1.5:3000 */
  base: string;
  /** When set, requests are tunneled to this desktop through the relay. */
  hostId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let deviceToken: string | null = null;
export function setDeviceToken(t: string | null) {
  deviceToken = t;
}
/** Sealed labee session obtained via Google sign-in (native only; web uses the cookie). */
let sessionToken: string | null = null;
export function setSessionToken(t: string | null) {
  sessionToken = t;
}
export function getSessionToken() {
  return sessionToken;
}
export function getDeviceToken() {
  return deviceToken;
}

export function deviceLabel(): string {
  if (Platform.OS === "ios") return Platform.isPad ? "iPad" : "iPhone";
  if (Platform.OS === "android") return "Android";
  return "web";
}

export function urlFor(target: Target, path: string): string {
  const base = target.base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return target.hostId ? `${base}/api/hosts/${encodeURIComponent(target.hostId)}${p}` : `${base}${p}`;
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "x-labee-device": deviceLabel() };
  if (deviceToken) h.authorization = `Bearer ${deviceToken}`;
  if (sessionToken) h["x-labee-session"] = sessionToken;
  return h;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // not JSON
  }
  return `Request failed (${res.status})`;
}

export async function apiGet<T>(target: Target, path: string): Promise<T> {
  const res = await fetch(urlFor(target, path), { credentials: "include", headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

export async function apiSend<T>(
  target: Target,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(urlFor(target, path), {
    method,
    credentials: "include",
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function apiText(target: Target, path: string): Promise<string> {
  const res = await fetch(urlFor(target, path), { credentials: "include", headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return res.text();
}
