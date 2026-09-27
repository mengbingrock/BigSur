// Thin fetch wrapper around the Effect server's /api/* routes. In dev, Vite
// proxies these to the server; in the packaged app they're same-origin.
//
// On labee.online a person can also point the whole app at one of their linked
// Macs, the way the iOS app does: every call is then prefixed with
// /api/hosts/:hostId and the box relays it over the Device Link tunnel. That is
// how a browser reaches a Claude subscription — the CLI login lives on the Mac
// and completes through Anthropic's own flow, so no credential ever reaches the
// box. See apps/server/src/routes/link.ts for the tunnel itself.

import { isDesktop } from "./desktop";

const HOST_KEY = "labee:hostId";

/** Paths that are always served by labee.online itself, even when a Mac is
 *  selected. Two kinds: the account (who you are, what you pay) lives on the
 *  box, and the relay's own control plane would be nonsense to send through the
 *  tunnel it manages. `/api/hosts/` is here so an already-addressed path is
 *  never prefixed twice. */
const BOX_ONLY = [
  /^\/api\/me\b/,
  /^\/api\/logout\b/,
  /^\/api\/auth\//,
  /^\/api\/link\//,
  /^\/api\/hosts\//,
  /^\/api\/billing\//,
  /^\/api\/admin\//,
  /^\/api\/llm\/proxy-token\b/,
];

function readStoredHost(): string | null {
  try {
    return localStorage.getItem(HOST_KEY) || null;
  } catch {
    return null; // private mode / blocked storage — stay on the box
  }
}

let hostId: string | null = readStoredHost();
const listeners = new Set<() => void>();

/** The Mac every relayable call is currently routed to, or null for the box. */
export function getHostId(): string | null {
  return hostId;
}

/** Choose a Mac (or null for "this server"). Persisted to this browser only —
 *  a per-device choice, like the phone's, so signing in elsewhere doesn't
 *  silently start driving someone's laptop. */
export function setHostId(next: string | null): void {
  hostId = next && next.trim() ? next.trim() : null;
  try {
    if (hostId) localStorage.setItem(HOST_KEY, hostId);
    else localStorage.removeItem(HOST_KEY);
  } catch {
    // Not persisting is survivable; the choice still holds for this page.
  }
  for (const l of listeners) l();
}

export function subscribeHostId(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Map an app-relative /api path onto the server that should answer it.
 *  Exported because several call sites use `fetch` directly (FormData uploads,
 *  EventSource) and must route the same way. */
export function resolve(path: string): string {
  // The desktop app *is* the Mac; relaying to one would be a loop.
  if (!hostId || isDesktop()) return path;
  if (!path.startsWith("/api/")) return path;
  if (BOX_ONLY.some((re) => re.test(path))) return path;
  return `/api/hosts/${encodeURIComponent(hostId)}${path}`;
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

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // not JSON
  }
  return `Request failed (${res.status})`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(resolve(path), { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

export async function apiSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(resolve(path), {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Open an SSE POST stream (chat). Yields parsed `{ event, data }` frames. */
export async function* ssePost(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await fetch(resolve(path), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await readError(res));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let dataRaw = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
      }
      if (!dataRaw) continue;
      let data: unknown = dataRaw;
      try {
        data = JSON.parse(dataRaw);
      } catch {
        // keep raw string
      }
      yield { event, data };
    }
  }
}
