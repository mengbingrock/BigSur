// Provider catalog + small helpers shared by the chat/extract/edit routes.
// The two execution backends live elsewhere: the agentic claude CLI (in the
// chat route + buildChatStream) and the OpenAI HTTP client (./openai.ts).
import type { ModelInfo, Provider, ProviderCatalogEntry } from "@labee/contracts";
import type { ResolvedCredential } from "./llmSettings";
import { providedAvailable } from "./llmSettings";
import { codexAvailable } from "./codex";

// The claude CLI's opus/sonnet/haiku aliases always resolve to the latest of
// each tier, so the id stays an alias (robust) while the label names the
// current version.
export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "opus", label: "Claude Opus 4.8 (most capable)", provider: "anthropic" },
  { id: "sonnet", label: "Claude Sonnet 4.6 (balanced)", provider: "anthropic" },
  { id: "haiku", label: "Claude Haiku 4.5 (fastest)", provider: "anthropic" },
];

export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-5.5", label: "GPT-5.5 (most capable)", provider: "openai" },
  { id: "gpt-5.4", label: "GPT-5.4 (balanced)", provider: "openai" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini (fastest)", provider: "openai" },
];

export function modelsFor(provider: Provider): ModelInfo[] {
  return provider === "openai" ? OPENAI_MODELS : ANTHROPIC_MODELS;
}

/** Clamp a requested model to one valid for the provider (default = first). */
export function validModel(provider: Provider, model: string | undefined): string {
  const list = modelsFor(provider);
  const hit = list.find((m) => m.id === model);
  return hit ? hit.id : list[0]!.id;
}

/** Default auxiliary (extract/edit) model per provider — cheap + fast. */
export function auxModel(provider: Provider): string {
  return provider === "openai" ? "gpt-5.4-mini" : "haiku";
}

/** Provider catalog returned by GET /api/llm/providers. */
export function buildCatalog(): ProviderCatalogEntry[] {
  return [
    {
      provider: "anthropic",
      label: "Anthropic — Claude",
      models: ANTHROPIC_MODELS,
      providedAvailable: providedAvailable("anthropic"),
      supportsApiKey: true,
      supportsSubscription: true, // Claude Pro/Max via the host claude.ai login
      subscriptionComingSoon: false, // "own_subscription" maps to the host OAuth today
      agentic: true,
    },
    {
      provider: "openai",
      label: "OpenAI — GPT",
      models: OPENAI_MODELS,
      providedAvailable: providedAvailable("openai"),
      supportsApiKey: true,
      supportsSubscription: true,
      // ChatGPT subscription works when the codex CLI is available to broker it.
      subscriptionComingSoon: !codexAvailable(),
      agentic: false, // HTTP chat API path — no Bash/file tools (subscription path is agentic)
    },
  ];
}

/** Extra env for the claude CLI based on the resolved credential.
 *  - Proxy (local-first "provided"): point the CLI at the Labee inference proxy
 *    (ANTHROPIC_BASE_URL) authenticated with the minted token (ANTHROPIC_AUTH_TOKEN,
 *    sent as `Authorization: Bearer`). Clear ANTHROPIC_API_KEY so the token path wins.
 *  - Own API key: hand the key to the CLI.
 *  - Otherwise: no key — the CLI falls back to the host claude.ai OAuth. */
export function claudeEnvForCredential(cred: ResolvedCredential): NodeJS.ProcessEnv {
  if (cred.proxyBaseUrl) {
    return {
      ANTHROPIC_BASE_URL: cred.proxyBaseUrl,
      ANTHROPIC_AUTH_TOKEN: cred.apiKey ?? "",
      ANTHROPIC_API_KEY: "",
    };
  }
  if (cred.apiKey) return { ANTHROPIC_API_KEY: cred.apiKey };
  // Ensure no stale key forces API-key mode when we want OAuth.
  return {};
}
