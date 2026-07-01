import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import Mime from "@effect/platform-node/Mime";
import type { AgentUpdate } from "@labee/contracts";
import { bodyJson, error, json, requestUrl, sessionUser, statusForError } from "../httpKit";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "../services/agents";
import { agentRoots, listAgentDir, readAgentFile } from "../services/agentFiles";
import { initializeAgent, rebuildAgentMemory } from "../services/agentInit";
import { availableEngines } from "../services/engines";
import { syncAgentsFromServer } from "../services/remoteAgents";

const params = HttpRouter.params;
const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** GET /api/agents — the caller's saved agents. */
export const listAgentsRoute = HttpRouter.add(
  "GET",
  "/api/agents",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const agents = yield* Effect.promise(() => listAgents(user.email));
    return yield* json({ agents });
  }),
);

/** GET /api/agents/engines — which local agent CLIs are installed. */
export const agentEnginesRoute = HttpRouter.add(
  "GET",
  "/api/agents/engines",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    return yield* json(availableEngines());
  }),
);

/** GET /api/agents/:id — one saved agent. */
export const getAgentRoute = HttpRouter.add(
  "GET",
  "/api/agents/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const agent = yield* Effect.promise(() => getAgent(user.email, id ?? ""));
    if (!agent) return yield* error("Agent not found.", 404);
    return yield* json({ agent });
  }),
);

/** POST /api/agents — create a saved agent. */
export const createAgentRoute = HttpRouter.add(
  "POST",
  "/api/agents",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const body = yield* safeBody<AgentUpdate>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    const result = yield* Effect.tryPromise({
      try: () => createAgent(user.email, body),
      catch: (e) => e,
    }).pipe(
      Effect.map((agent) => ({ ok: true as const, agent })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    // Scaffold init files + build the reference memory in the background so
    // creation stays fast; the files appear in the working directory shortly.
    const created = result.agent;
    yield* Effect.sync(() => {
      void initializeAgent(user.email, created).catch(() => {});
    });
    return yield* json({ agent: created });
  }),
);

/** POST /api/agents/:id/initialize — (re)build init files + reference memory. */
export const initializeAgentRoute = HttpRouter.add(
  "POST",
  "/api/agents/:id/initialize",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const agent = yield* Effect.promise(() => getAgent(user.email, id ?? ""));
    if (!agent) return yield* error("Agent not found.", 404);
    // Do the fast work (sync skills + scaffold) synchronously; defer the slow
    // LLM memory digest to the background so this response returns promptly and
    // doesn't trip the proxy/client idle timeout.
    const result = yield* Effect.tryPromise({
      try: () => initializeAgent(user.email, agent, { buildMemory: false }),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    void rebuildAgentMemory(user.email, agent).catch(() => {});
    return yield* json(result.r);
  }),
);

/** PUT /api/agents/:id — update a saved agent. */
export const updateAgentRoute = HttpRouter.add(
  "PUT",
  "/api/agents/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const body = yield* safeBody<AgentUpdate>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    const result = yield* Effect.tryPromise({
      try: () => updateAgent(user.email, id ?? "", body),
      catch: (e) => e,
    }).pipe(
      Effect.map((agent) => ({ ok: true as const, agent })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* json({ agent: result.agent });
  }),
);

/** DELETE /api/agents/:id — remove a saved agent. */
export const deleteAgentRoute = HttpRouter.add(
  "DELETE",
  "/api/agents/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    yield* Effect.promise(() => deleteAgent(user.email, id ?? ""));
    return yield* json({ ok: true });
  }),
);

/** GET /api/agents/:id/roots — the agent's working dir + reference folders. */
export const agentRootsRoute = HttpRouter.add(
  "GET",
  "/api/agents/:id/roots",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const result = yield* Effect.tryPromise({
      try: () => agentRoots(user.email, id ?? ""),
      catch: (e) => e,
    }).pipe(
      Effect.map((roots) => ({ ok: true as const, roots })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* json({ roots: result.roots });
  }),
);

/** GET /api/agents/:id/files?path=… — list files under one of the agent's roots. */
export const agentFilesRoute = HttpRouter.add(
  "GET",
  "/api/agents/:id/files",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const url = yield* requestUrl;
    const p = url.searchParams.get("path") ?? undefined;
    const result = yield* Effect.tryPromise({
      try: () => listAgentDir(user.email, id ?? "", p),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* json(result.r);
  }),
);

/** GET /api/agents/:id/download?path=… — download a file from an agent root. */
export const agentDownloadRoute = HttpRouter.add(
  "GET",
  "/api/agents/:id/download",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const url = yield* requestUrl;
    const p = url.searchParams.get("path");
    if (!p) return yield* error("path is required.", 400);
    const file = yield* Effect.tryPromise({
      try: () => readAgentFile(user.email, id ?? "", p),
      catch: (e) => e,
    }).pipe(
      Effect.map((f) => ({ ok: true as const, f })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    );
    if (!file.ok) return yield* error("File not found.", 404);
    const contentType = Mime.getType(file.f.name) ?? "application/octet-stream";
    return HttpServerResponse.uint8Array(new Uint8Array(file.f.data), {
      status: 200,
      contentType,
    });
  }),
);

/** POST /api/agents/sync — pull the caller's saved agents from the hosted Labee
 *  server into this (local) instance's DB. Used by the local-first desktop. */
export const syncAgentsRoute = HttpRouter.add(
  "POST",
  "/api/agents/sync",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const result = yield* Effect.tryPromise({
      try: () => syncAgentsFromServer(user.email),
      catch: (e) => e,
    }).pipe(
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, e })),
    );
    if (!result.ok) {
      const { status, message } = statusForError(result.e);
      return yield* error(message, status);
    }
    return yield* json(result.r);
  }),
);

export const agentRoutes = [
  syncAgentsRoute,
  listAgentsRoute,
  agentEnginesRoute,
  getAgentRoute,
  createAgentRoute,
  updateAgentRoute,
  deleteAgentRoute,
  initializeAgentRoute,
  agentRootsRoute,
  agentFilesRoute,
  agentDownloadRoute,
] as const;
