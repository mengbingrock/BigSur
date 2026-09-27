// Folders the person has granted Labee access to. A grant makes the protocols
// inside a folder part of the library: listed, indexed for search, and
// writable. Revoking one removes the row and nothing else — files stay put.
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, requestUrl, sessionUser } from "../httpKit";
import { addUserFolder, listUserFolders, removeUserFolder } from "../services/userFolders";

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** GET /api/folders — the caller's granted folders. */
export const listFoldersRoute = HttpRouter.add(
  "GET",
  "/api/folders",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* attempt(async () => ({ folders: await listUserFolders(user.email) }));
  }),
);

/** POST /api/folders — grant access to one. */
export const addFolderRoute = HttpRouter.add(
  "POST",
  "/api/folders",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ path?: string; label?: string }>();
    return yield* attempt(async () => ({
      folder: await addUserFolder(user.email, body?.path ?? "", body?.label),
    }));
  }),
);

/** DELETE /api/folders?path=… — revoke a grant. */
export const removeFolderRoute = HttpRouter.add(
  "DELETE",
  "/api/folders",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    return yield* attempt(async () => {
      await removeUserFolder(user.email, url.searchParams.get("path") ?? "");
      return { ok: true };
    });
  }),
);

export const folderRoutes = [listFoldersRoute, addFolderRoute, removeFolderRoute] as const;
