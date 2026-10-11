// The shared protocol library's HTTP surface.
//
// Reads (status, search, passages, one protocol) are served from the box's
// tables; on a desktop they are forwarded to the box, so a phone attached to
// a Mac can still reach the library through it. Saving is the one write, and
// it writes to wherever the caller's own protocols live — the desktop's
// folder on a desktop — which is why it is never forwarded.
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, json, requestUrl, sessionUser } from "../httpKit";
import { isDesktop, remoteLabeeSession } from "../services/llmSettings";
import { libraryStatus, type LibraryStatus } from "../services/library/store";
import { libraryPassages, searchLibrary } from "../services/library/search";
import { fetchLibraryProtocol, importLibraryProtocol } from "../services/library/importToMine";

const params = HttpRouter.params;
const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** On a desktop, answer a library read by asking the box. */
async function fromBox<T>(path: string): Promise<T | null> {
  const remote = remoteLabeeSession();
  if (!remote) return null;
  const res = await fetch(`${remote.base}${path}`, { headers: { accept: "application/json", cookie: remote.cookie } });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** GET /api/library/status — how much is in the library and how much is embedded. */
export const libraryStatusRoute = HttpRouter.add(
  "GET",
  "/api/library/status",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    if (isDesktop()) {
      const r = yield* Effect.promise(() => fromBox<LibraryStatus>("/api/library/status"));
      return r ? yield* json(r) : yield* error("The library on labee.online is not reachable from this Mac.", 503);
    }
    return yield* attempt(() => libraryStatus());
  }),
);

/** GET /api/library/search?q=&limit= — one row per library protocol. */
export const librarySearchRoute = HttpRouter.add(
  "GET",
  "/api/library/search",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    const q = url.searchParams.get("q") ?? "";
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    if (isDesktop()) {
      const r = yield* Effect.promise(() => fromBox<unknown>(`/api/library/search?q=${encodeURIComponent(q)}&limit=${limit}`));
      return r ? yield* json(r) : yield* error("The library on labee.online is not reachable from this Mac.", 503);
    }
    return yield* attempt(async () => (await searchLibrary(q, { limit, email: user.email })) ?? { mode: "lexical", hits: [] });
  }),
);

/** GET /api/library/passages?q=&limit= — top chunks, for Ask across pools. */
export const libraryPassagesRoute = HttpRouter.add(
  "GET",
  "/api/library/passages",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    const q = url.searchParams.get("q") ?? "";
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 4;
    if (isDesktop()) {
      const r = yield* Effect.promise(() => fromBox<unknown>(`/api/library/passages?q=${encodeURIComponent(q)}&limit=${limit}`));
      return r ? yield* json(r) : yield* json({ passages: [] });
    }
    return yield* attempt(async () => ({ passages: await libraryPassages(q, { limit, email: user.email }) }));
  }),
);

/** POST /api/library/import { id, category? } — save a library protocol as the caller's own. */
export const libraryImportRoute = HttpRouter.add(
  "POST",
  "/api/library/import",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ id?: string; category?: string }>();
    if (!body?.id?.trim()) return yield* error("id is required.", 400);
    return yield* attempt(() =>
      importLibraryProtocol(body.id!.trim(), user.email, body.category ? { category: body.category } : {}),
    );
  }),
);

/** GET /api/library/:id — one library protocol in full. */
export const libraryGetRoute = HttpRouter.add(
  "GET",
  "/api/library/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const protocol = yield* Effect.promise(() => fetchLibraryProtocol(id ?? ""));
    if (!protocol) return yield* error("Library protocol not found.", 404);
    return yield* json({ protocol });
  }),
);

export const libraryRoutes = [
  libraryStatusRoute,
  librarySearchRoute,
  libraryPassagesRoute,
  libraryImportRoute,
  libraryGetRoute,
] as const;
