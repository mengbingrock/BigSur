import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, requestUrl, sessionUser } from "../httpKit";

const params = HttpRouter.params;
import {
  createDeckDir,
  deleteDeckEntry,
  getMaxUploadBytes,
  listDeck,
  listDeckSubdir,
} from "../services/deck";
import { createProject, listProjects } from "../services/projects";

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** GET /api/deck — list the caller's deck root (optionally a `?dir=` subdir). */
export const listDeckRoute = HttpRouter.add(
  "GET",
  "/api/deck",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    const dir = url.searchParams.get("dir");
    return yield* attempt(async () => ({
      files: dir ? await listDeckSubdir(user.email, dir) : await listDeck(user.email),
      maxBytes: getMaxUploadBytes(),
    }));
  }),
);

/** POST /api/deck/dir — create a deck subdirectory. */
export const createDeckDirRoute = HttpRouter.add(
  "POST",
  "/api/deck/dir",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ name: string }>();
    if (!body?.name) return yield* error("name is required.", 400);
    return yield* attempt(async () => {
      await createDeckDir(user.email, body.name);
      return { ok: true };
    });
  }),
);

/** DELETE /api/deck/:name — remove a deck entry (file or directory). */
export const deleteDeckEntryRoute = HttpRouter.add(
  "DELETE",
  "/api/deck/:name",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { name } = yield* params;
    return yield* attempt(async () => {
      await deleteDeckEntry(user.email, name ?? "");
      return { ok: true };
    });
  }),
);

/** GET /api/projects — deck subdirectories surfaced as projects. */
export const listProjectsRoute = HttpRouter.add(
  "GET",
  "/api/projects",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* attempt(async () => ({ projects: await listProjects(user.email) }));
  }),
);

/** POST /api/projects — create a project (deck folder). */
export const createProjectRoute = HttpRouter.add(
  "POST",
  "/api/projects",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ name: string }>();
    if (!body?.name) return yield* error("name is required.", 400);
    return yield* attempt(async () => ({ project: await createProject(user.email, body.name) }));
  }),
);

export const deckRoutes = [
  createDeckDirRoute,
  listDeckRoute,
  deleteDeckEntryRoute,
  listProjectsRoute,
  createProjectRoute,
] as const;
