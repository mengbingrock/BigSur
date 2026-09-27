import path from "node:path";
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, requestUrl, sessionUser, statusForError } from "../httpKit";
import {
  createCategory,
  createSkill,
  deleteCategory,
  deleteSkill,
  getAllSkills,
  getAllSources,
  getSkillBySlug,
  importSkill,
  listCategories,
  listSkillFiles,
  moveSkillToCategory,
  renameCategory,
  saveSkill,
  saveSkillFile,
  searchSkills,
  type SkillUpdate,
} from "../services/skills";
import { getAgent } from "../services/agents";
import { syncSkillsFromServer } from "../services/remoteSkills";
import { importSkillFromGithub } from "../services/githubImport";
import { installSkillToAgent, type InstallTarget } from "../services/installSkill";
import {
  MARKETPLACES,
  importFromMarketplace,
  listMarketplace,
} from "../services/marketplaces";
import { importSkillFromRegistry } from "../services/registryImport";
import { checkForUpdate, updateSkill } from "../services/updateSkill";
import { suggestCategories } from "../services/artifactIndex/agent";
import { askLibrary } from "../services/artifactIndex/ask";
import {
  drain,
  enqueueArtifacts,
  ensureIndexed,
  forgetArtifact,
  indexKey,
  indexStatus,
  rebuild,
  retrieve,
} from "../services/artifactIndex";

/** Queue an artifact for re-embedding and start on it now. Queuing alone left
 *  the index stale until the next search happened to run a reconcile, so an
 *  edit did not show up in search until someone searched — which reads as
 *  "the index does not follow my changes". Fire-and-forget: the write already
 *  succeeded, and a provider hiccup is reported in the index status, not here. */
function reindexSoon(slug: string, email: string): void {
  enqueueArtifacts([slug], email);
  void drain(email).catch(() => {});
}

const params = HttpRouter.params;

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** GET /api/skills — every artifact visible to the caller + source labels.
 *  `?agent=<id>` also includes skills from that agent's working-dir `.skill`. */
export const listSkillsRoute = HttpRouter.add(
  "GET",
  "/api/skills",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    const url = yield* requestUrl;
    const agentId = url.searchParams.get("agent");
    const extraSkillDirs =
      user && agentId
        ? yield* Effect.promise(async () => {
            const agent = await getAgent(user.email, agentId);
            return agent?.workingDir ? [path.join(agent.workingDir, ".skill")] : [];
          })
        : [];
    return yield* attempt(() => {
      const skills = getAllSkills(user?.email, { extraSkillDirs });
      return { skills, sources: getAllSources(skills) };
    });
  }),
);

/** POST /api/skills — create an artifact in the caller's own folder. */
export const createSkillRoute = HttpRouter.add(
  "POST",
  "/api/skills",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<SkillUpdate>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    return yield* attempt(() => {
      const skill = createSkill(body, user.email);
      reindexSoon(skill.slug, user.email);
      return { skill };
    });
  }),
);

/** GET /api/skills/:slug — artifact detail plus its sibling files. */
export const getSkillRoute = HttpRouter.add(
  "GET",
  "/api/skills/:slug",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    const { slug } = yield* params;
    return yield* attempt(() => {
      const skill = getSkillBySlug(slug ?? "", user?.email);
      if (!skill) {
        const e = new Error("Artifact not found.") as Error & { code: string };
        e.code = "NOT_FOUND";
        throw e;
      }
      return { skill, files: listSkillFiles(skill) };
    });
  }),
);

/** PUT /api/skills/:slug — update an owned artifact. */
export const updateSkillRoute = HttpRouter.add(
  "PUT",
  "/api/skills/:slug",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const body = yield* safeBody<SkillUpdate>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    return yield* attempt(() => {
      const skill = saveSkill(slug ?? "", body, user.email);
      reindexSoon(skill.slug, user.email);
      return { skill };
    });
  }),
);

/** DELETE /api/skills/:slug — remove an owned artifact. */
export const deleteSkillRoute = HttpRouter.add(
  "DELETE",
  "/api/skills/:slug",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    // Resolve the index key before the file is gone; deleting first would
    // leave nothing to look it up by.
    const existing = getSkillBySlug(slug ?? "", user.email);
    const key = existing ? indexKey(existing) : null;
    return yield* attempt(() => {
      deleteSkill(slug ?? "", user.email);
      if (key) void forgetArtifact(key);
      return { ok: true };
    });
  }),
);

/** PUT /api/skills/:slug/files — write a single sibling file. */
export const saveSkillFileRoute = HttpRouter.add(
  "PUT",
  "/api/skills/:slug/files",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const body = yield* safeBody<{ relPath: string; content: string }>();
    if (!body?.relPath) return yield* error("relPath is required.", 400);
    return yield* attempt(() => {
      saveSkillFile(slug ?? "", body.relPath, body.content ?? "", user.email);
      reindexSoon(slug ?? "", user.email);
      return { ok: true };
    });
  }),
);

/** POST /api/skills/import — copy a public/plugin artifact into the caller's folder. */
export const importSkillRoute = HttpRouter.add(
  "POST",
  "/api/skills/import",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ slug: string }>();
    if (!body?.slug) return yield* error("slug is required.", 400);
    return yield* attempt(() => ({ skill: importSkill(body.slug, user.email) }));
  }),
);

/** POST /api/skills/import/github — fetch a skill from a GitHub repo (URL or
 *  owner/repo[@ref], optional subpath) into the caller's catalog. */
export const importGithubRoute = HttpRouter.add(
  "POST",
  "/api/skills/import/github",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{
      url?: string;
      repo?: string;
      ref?: string;
      subpath?: string;
      token?: string;
    }>();
    const input = body?.url?.trim() || body?.repo?.trim();
    if (!input) return yield* error("A GitHub url or repo is required.", 400);
    const result = yield* Effect.tryPromise({
      try: () =>
        importSkillFromGithub(
          { input, ref: body?.ref, subpath: body?.subpath, token: body?.token },
          user.email,
        ),
      catch: (e) => e,
    }).pipe(
      Effect.map((skill) => ({ ok: true as const, skill })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => ({ skill: result.skill }));
  }),
);

/** POST /api/skills/import/registry — import a package from ClawHub (or another
 *  configured registry) by name and optional semver range. */
export const importRegistryRoute = HttpRouter.add(
  "POST",
  "/api/skills/import/registry",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ registry?: string; pkg?: string; version?: string }>();
    if (!body?.pkg) return yield* error("pkg is required.", 400);
    const result = yield* Effect.tryPromise({
      try: () =>
        importSkillFromRegistry(
          { registry: body.registry, pkg: body.pkg!, version: body.version },
          user.email,
        ),
      catch: (e) => e,
    }).pipe(
      Effect.map((skill) => ({ ok: true as const, skill })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => ({ skill: result.skill }));
  }),
);

/** GET /api/skills/marketplaces — the curated first-party marketplaces. */
export const marketplacesRoute = HttpRouter.add(
  "GET",
  "/api/skills/marketplaces",
  Effect.gen(function* () {
    yield* sessionUser;
    return yield* attempt(() => ({
      marketplaces: Object.values(MARKETPLACES).map((m) => ({
        id: m.id,
        label: m.label,
        repo: m.repo,
        about: m.about,
      })),
    }));
  }),
);

/** GET /api/skills/marketplace/:id — browse a marketplace's skills. */
export const marketplaceBrowseRoute = HttpRouter.add(
  "GET",
  "/api/skills/marketplace/:id",
  Effect.gen(function* () {
    yield* sessionUser;
    const { id } = yield* params;
    const result = yield* Effect.tryPromise({
      try: () => listMarketplace(id ?? ""),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => result.r);
  }),
);

/** POST /api/skills/import/marketplace — import one entry from a marketplace. */
export const importMarketplaceRoute = HttpRouter.add(
  "POST",
  "/api/skills/import/marketplace",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ marketplace?: string; subpath?: string; token?: string }>();
    if (!body?.marketplace) return yield* error("marketplace is required.", 400);
    const result = yield* Effect.tryPromise({
      try: () =>
        importFromMarketplace(body.marketplace!, body.subpath ?? "", user.email, body.token),
      catch: (e) => e,
    }).pipe(
      Effect.map((skill) => ({ ok: true as const, skill })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => ({ skill: result.skill }));
  }),
);

/** GET /api/skills/:slug/update-check — is a newer version available upstream? */
export const updateCheckRoute = HttpRouter.add(
  "GET",
  "/api/skills/:slug/update-check",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const result = yield* Effect.tryPromise({
      try: () => checkForUpdate(user.email, slug ?? ""),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => result.r);
  }),
);

/** POST /api/skills/:slug/update — re-fetch from origin and overwrite in place. */
export const updateSkillRouteFromOrigin = HttpRouter.add(
  "POST",
  "/api/skills/:slug/update",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const result = yield* Effect.tryPromise({
      try: () => updateSkill(user.email, slug ?? ""),
      catch: (e) => e,
    }).pipe(
      Effect.map((skill) => ({ ok: true as const, skill })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => ({ skill: result.skill }));
  }),
);

/** POST /api/skills/:slug/install — install a skill into an agent's runtime
 *  folder (.claude/skills or .codex/skills) and attach it to the agent group. */
export const installSkillRoute = HttpRouter.add(
  "POST",
  "/api/skills/:slug/install",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const body = yield* safeBody<{ agentId?: string; target?: string }>();
    if (!body?.agentId) return yield* error("agentId is required.", 400);
    const target: InstallTarget | undefined =
      body.target === "claude" || body.target === "codex" ? body.target : undefined;
    const result = yield* Effect.tryPromise({
      try: () => installSkillToAgent(user.email, slug ?? "", body.agentId!, target),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* attempt(() => result.r);
  }),
);

/** POST /api/skills/sync — pull skills from the central Labee server into the
 *  local catalog (then agents copy the selected ones into their `.skill`). */
export const syncSkillsRoute = HttpRouter.add(
  "POST",
  "/api/skills/sync",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const result = yield* Effect.tryPromise({
      try: () => syncSkillsFromServer(user.email),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const msg = result.e instanceof Error ? result.e.message : String(result.e);
      return yield* error(msg, 502);
    }
    return yield* attempt(() => result.r);
  }),
);

// ---------- categories + search --------------------------------------------
//
// A category is one level of subfolder in the caller's own artifact folder.
// These four routes are the whole of it; the folder is the source of truth, so
// nothing here writes an index or a manifest.

/** GET /api/skills/categories — the caller's own category folders. */
export const listCategoriesRoute = HttpRouter.add(
  "GET",
  "/api/skills/categories",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* attempt(() => ({ categories: listCategories(user.email) }));
  }),
);

/** POST /api/skills/categories — create one. */
export const createCategoryRoute = HttpRouter.add(
  "POST",
  "/api/skills/categories",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ name?: string }>();
    return yield* attempt(() => ({ name: createCategory(body?.name ?? "", user.email) }));
  }),
);

/** PATCH /api/skills/categories/:name — rename. DELETE — remove, empty only. */
export const renameCategoryRoute = HttpRouter.add(
  "PATCH",
  "/api/skills/categories/:name",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { name } = yield* params;
    const body = yield* safeBody<{ name?: string }>();
    return yield* attempt(() => ({
      name: renameCategory(decodeURIComponent(name ?? ""), body?.name ?? "", user.email),
    }));
  }),
);

export const deleteCategoryRoute = HttpRouter.add(
  "DELETE",
  "/api/skills/categories/:name",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { name } = yield* params;
    return yield* attempt(() => {
      deleteCategory(decodeURIComponent(name ?? ""), user.email);
      return { ok: true };
    });
  }),
);

/** POST /api/skills/:slug/move — `{ category }`, null/"" for the top level. */
export const moveSkillRoute = HttpRouter.add(
  "POST",
  "/api/skills/:slug/move",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { slug } = yield* params;
    const body = yield* safeBody<{ category?: string | null }>();
    return yield* attempt(() => ({
      skill: moveSkillToCategory(slug ?? "", body?.category ?? null, user.email),
    }));
  }),
);

/**
 * GET /api/skills/search?q=&kind=&limit= — retrieval over embeddings.
 *
 * Chunks are scored by cosine against the query's vector, so "phenol
 * extraction" finds a protocol that says "organic phase separation". Falls
 * back to substring matching when no embedding credential resolves; `mode`
 * tells the client which it got, so the page can say so.
 */
export const searchSkillsRoute = HttpRouter.add(
  "GET",
  "/api/skills/search",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    const url = yield* requestUrl;
    const q = url.searchParams.get("q") ?? "";
    const kindParam = url.searchParams.get("kind");
    const kind = kindParam === "skill" || kindParam === "protocol" ? kindParam : undefined;
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
    const opts: { kind?: "skill" | "protocol"; limit?: number } = {
      ...(kind ? { kind } : {}),
      ...(limit ? { limit } : {}),
    };

    return yield* attempt(async () => {
      // Pick up anything edited on disk since the last pass, then query. On a
      // warm index this is a few hashes.
      await ensureIndexed(user?.email);
      const hits = await retrieve(q, user?.email, opts);
      if (hits) return { mode: "semantic" as const, hits };
      return { mode: "lexical" as const, hits: searchSkills(q, user?.email, opts) };
    });
  }),
);

/**
 * POST /api/skills/categories/suggest — the categorisation agent.
 *
 * Proposes a category for each uncategorised protocol: nearest centroid first
 * (free), then one batched model call, then a clustered taxonomy when there is
 * nothing to choose from. Writes nothing; the caller applies what it wants
 * through the category and move endpoints.
 */
export const suggestCategoriesRoute = HttpRouter.add(
  "POST",
  "/api/skills/categories/suggest",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ slugs?: string[]; kind?: "skill" | "protocol" }>();
    return yield* attempt(() =>
      suggestCategories(user.email, {
        ...(body?.slugs ? { slugs: body.slugs } : {}),
        ...(body?.kind ? { kind: body.kind } : {}),
      }),
    );
  }),
);

/**
 * POST /api/skills/ask — answer a question from the caller's protocols.
 *
 * Retrieval, then one chat call over the retrieved passages, with the model
 * told to answer only from them and to decline otherwise. Returns the answer
 * plus the passages it actually cited.
 */
export const askRoute = HttpRouter.add(
  "POST",
  "/api/skills/ask",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<{ q?: string; kind?: "skill" | "protocol" }>();
    return yield* attempt(() =>
      askLibrary(body?.q ?? "", user.email, { ...(body?.kind ? { kind: body.kind } : {}) }),
    );
  }),
);

/** GET /api/skills/index/status — indexing progress, for the page's notice. */
export const indexStatusRoute = HttpRouter.add(
  "GET",
  "/api/skills/index/status",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    return yield* attempt(() => indexStatus(user?.email));
  }),
);

/** POST /api/skills/index/rebuild — drop and re-embed everything visible. */
export const indexRebuildRoute = HttpRouter.add(
  "POST",
  "/api/skills/index/rebuild",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* attempt(() => rebuild(user.email));
  }),
);

// Longer/static paths before parametric ones so exact matches win.
export const skillsRoutes = [
  askRoute,
  suggestCategoriesRoute,
  indexStatusRoute,
  indexRebuildRoute,
  listCategoriesRoute,
  createCategoryRoute,
  renameCategoryRoute,
  deleteCategoryRoute,
  searchSkillsRoute,
  moveSkillRoute,
  importGithubRoute,
  importRegistryRoute,
  importMarketplaceRoute,
  marketplacesRoute,
  marketplaceBrowseRoute,
  updateCheckRoute,
  updateSkillRouteFromOrigin,
  installSkillRoute,
  syncSkillsRoute,
  importSkillRoute,
  saveSkillFileRoute,
  listSkillsRoute,
  createSkillRoute,
  getSkillRoute,
  updateSkillRoute,
  deleteSkillRoute,
] as const;
