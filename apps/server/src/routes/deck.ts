import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import Mime from "@effect/platform-node/Mime";
import { attempt, bodyJson, error, requestUrl, sessionUser } from "../httpKit";

const params = HttpRouter.params;
import {
  createDeckDir,
  deleteDeckEntry,
  getMaxUploadBytes,
  listDeck,
  listDeckSubdir,
  readDeckFile,
  saveDeckFile,
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

/** GET /api/deck/file?path=… — download a deck file (binary). */
export const downloadDeckFileRoute = HttpRouter.add(
  "GET",
  "/api/deck/file",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    const rel = url.searchParams.get("path");
    if (!rel) return yield* error("path is required.", 400);
    const file = yield* Effect.tryPromise({
      try: () => readDeckFile(user.email, rel),
      catch: (e) => e,
    }).pipe(Effect.map((f) => ({ ok: true as const, f })), Effect.catch(() =>
      Effect.succeed({ ok: false as const }),
    ));
    if (!file.ok) return yield* error("File not found.", 404);
    const contentType = Mime.getType(rel) ?? "application/octet-stream";
    return HttpServerResponse.uint8Array(new Uint8Array(file.f.data), {
      status: 200,
      contentType,
    });
  }),
);

/** POST /api/deck/upload — JSON { name, contentBase64, subdir? }. The SPA
 *  controls both ends, so a base64 body avoids multipart parsing. */
export const uploadDeckFileRoute = HttpRouter.add(
  "POST",
  "/api/deck/upload",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ name: string; contentBase64: string; subdir?: string }>();
    if (!body?.name || typeof body.contentBase64 !== "string") {
      return yield* error("name and contentBase64 are required.", 400);
    }
    const data = Buffer.from(body.contentBase64, "base64");
    if (data.byteLength > getMaxUploadBytes()) {
      return yield* error("File exceeds the upload size limit.", 413);
    }
    return yield* attempt(async () => ({
      file: await saveDeckFile(
        user.email,
        body.name,
        data,
        body.subdir ? { subdir: body.subdir } : undefined,
      ),
    }));
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
  uploadDeckFileRoute,
  downloadDeckFileRoute,
  createDeckDirRoute,
  listDeckRoute,
  deleteDeckEntryRoute,
  listProjectsRoute,
  createProjectRoute,
] as const;
