// Read-only filesystem browser for the folder pickers. Lists the immediate
// subdirectories of a path, and with `?files=1` the document files too, so a
// single protocol can be picked as well as a whole folder. Confined to under
// the user's home directory, so an authenticated request cannot enumerate the
// whole machine.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import type { FsBrowse, FsDir } from "@labee/contracts";
import { bodyJson, error, json, requestUrl, sessionUser } from "../httpKit";

function homeDir(): string {
  return os.homedir();
}

/** Confine `p` to under home; anything else falls back to home. */
function confine(p: string | null): string {
  const home = homeDir();
  if (!p) return home;
  const resolved = path.resolve(p);
  const rel = path.relative(home, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  return home;
}

/** Document extensions worth offering as a protocol. Anything else would only
 *  be noise in the picker: a protocol has to be readable text. */
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst"]);

/** GET /api/fs/browse?path=…&files=1 — subdirectories, and optionally the
 *  document files, of a folder (default: home). */
export const fsBrowseRoute = HttpRouter.add(
  "GET",
  "/api/fs/browse",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const url = yield* requestUrl;
    const target = confine(url.searchParams.get("path"));
    const home = homeDir();
    const wantFiles = url.searchParams.get("files") === "1";

    const result = yield* Effect.tryPromise({
      try: async (): Promise<FsBrowse> => {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        const dirs: FsDir[] = [];
        const files: FsDir[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          let isDir = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              isDir = (await fsp.stat(path.join(target, entry.name))).isDirectory();
            } catch {
              isDir = false;
            }
          }
          const full = path.join(target, entry.name);
          if (!isDir) {
            if (wantFiles && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
              files.push({ name: entry.name, path: full });
            }
            continue;
          }
          dirs.push({ name: entry.name, path: full });
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));
        const parent = target === home ? null : path.dirname(target);
        return { path: target, parent, home, dirs, ...(wantFiles ? { files } : {}) };
      },
      catch: (e) => e,
    }).pipe(
      Effect.map((b) => ({ ok: true as const, b })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!result.ok) return yield* error("Could not read that folder.", 400);
    return yield* json(result.b);
  }),
);

/** POST /api/fs/mkdir — create a subfolder inside a browsed directory. */
export const fsMkdirRoute = HttpRouter.add(
  "POST",
  "/api/fs/mkdir",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* bodyJson<{ path?: string; name?: string }>().pipe(
      Effect.catch(() => Effect.succeed(null as { path?: string; name?: string } | null)),
    );
    const parent = confine(body?.path ?? null);
    const name = (body?.name ?? "").trim();
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name === "." ||
      name === ".." ||
      name.length > 255
    ) {
      return yield* error("Invalid folder name.", 400);
    }
    const target = path.join(parent, name);
    // Defense in depth: the new folder must stay inside the confined parent.
    const rel = path.relative(parent, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return yield* error("Invalid folder name.", 400);
    }
    const result = yield* Effect.tryPromise({
      try: async () => {
        await fsp.mkdir(target, { recursive: true });
        return target;
      },
      catch: (e) => e,
    }).pipe(
      Effect.map((p) => ({ ok: true as const, p })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!result.ok) return yield* error("Could not create that folder.", 400);
    return yield* json({ path: result.p });
  }),
);

export const fsRoutes = [fsBrowseRoute, fsMkdirRoute] as const;
