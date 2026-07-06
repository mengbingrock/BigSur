import path from "node:path";
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, requestUrl, sessionUser } from "../httpKit";
import {
  createSkill,
  deleteSkill,
  getAllSkills,
  getAllSources,
  getSkillBySlug,
  importSkill,
  listSkillFiles,
  saveSkill,
  saveSkillFile,
  type SkillUpdate,
} from "../services/skills";
import { getAgent } from "../services/agents";
import { syncSkillsFromServer } from "../services/remoteSkills";

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
    return yield* attempt(() => ({ skill: createSkill(body, user.email) }));
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
    return yield* attempt(() => ({ skill: saveSkill(slug ?? "", body, user.email) }));
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
    return yield* attempt(() => {
      deleteSkill(slug ?? "", user.email);
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

// Longer/static paths before parametric ones so exact matches win.
export const skillsRoutes = [
  syncSkillsRoute,
  importSkillRoute,
  saveSkillFileRoute,
  listSkillsRoute,
  createSkillRoute,
  getSkillRoute,
  updateSkillRoute,
  deleteSkillRoute,
] as const;
