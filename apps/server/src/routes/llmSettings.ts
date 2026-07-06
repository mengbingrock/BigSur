import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import type { LlmSettingsUpdate } from "@labee/contracts";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { getSettings, updateSettings } from "../services/llmSettings";
import { buildCatalog } from "../services/llm";
import { codexLogout, readCodexConnection, startCodexLogin } from "../services/codex";
import { claudeLogout, readClaudeConnection, startClaudeLogin } from "../services/claudeAuth";

/** GET /api/llm/providers — provider catalog + which provided creds exist. */
export const llmProvidersRoute = HttpRouter.add(
  "GET",
  "/api/llm/providers",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    return yield* json({ providers: buildCatalog() });
  }),
);

/** GET /api/llm/settings — the signed-in user's provider/model + account state. */
export const llmSettingsGetRoute = HttpRouter.add(
  "GET",
  "/api/llm/settings",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const settings = yield* Effect.promise(() => getSettings(user.email));
    return yield* json(settings);
  }),
);

/** PUT /api/llm/settings — update provider/model, credential mode, own keys. */
export const llmSettingsPutRoute = HttpRouter.add(
  "PUT",
  "/api/llm/settings",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* bodyJson<LlmSettingsUpdate>().pipe(
      Effect.catch(() => Effect.succeed(null as LlmSettingsUpdate | null)),
    );
    if (!body || typeof body !== "object") return yield* error("Invalid JSON body.", 400);
    const settings = yield* Effect.promise(() => updateSettings(user.email, body));
    return yield* json(settings);
  }),
);

/** GET /api/llm/connection — ChatGPT (codex) + Claude connection status. */
export const llmConnectionGetRoute = HttpRouter.add(
  "GET",
  "/api/llm/connection",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const [openai, anthropic] = yield* Effect.promise(async () => [
      readCodexConnection(),
      readClaudeConnection(),
    ]);
    return yield* json({ openai, anthropic });
  }),
);

/** POST /api/llm/connection/:provider — start the browser sign-in. */
export const llmConnectionLoginRoute = HttpRouter.add(
  "POST",
  "/api/llm/connection/:provider",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { provider } = yield* HttpRouter.params;
    if (provider !== "openai" && provider !== "anthropic") {
      return yield* error("Unknown provider.", 400);
    }
    const result = yield* Effect.promise(() =>
      provider === "anthropic" ? startClaudeLogin() : startCodexLogin(),
    );
    return yield* json(result);
  }),
);

/** DELETE /api/llm/connection/:provider — disconnect (clear credentials). */
export const llmConnectionLogoutRoute = HttpRouter.add(
  "DELETE",
  "/api/llm/connection/:provider",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { provider } = yield* HttpRouter.params;
    if (provider !== "openai" && provider !== "anthropic") {
      return yield* error("Unknown provider.", 400);
    }
    const result = yield* Effect.promise(() =>
      provider === "anthropic" ? claudeLogout() : codexLogout(),
    );
    return yield* json(result);
  }),
);

export const llmRoutes = [
  llmProvidersRoute,
  llmSettingsGetRoute,
  llmSettingsPutRoute,
  llmConnectionGetRoute,
  llmConnectionLoginRoute,
  llmConnectionLogoutRoute,
] as const;
