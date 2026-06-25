// Provider catalog + small helpers shared by the chat/extract/edit routes.
// The two execution backends live elsewhere: the agentic claude CLI (in the
// chat route + buildChatStream) and the OpenAI HTTP client (./openai.ts).
import type { ModelInfo, Provider, ProviderCatalogEntry } from "@labee/contracts";
import type { ResolvedCredential } from "./llmSettings";
import { providedAvailable } from "./llmSettings";
import { codexAvailable } from "./codex";

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "opus", label: "Claude Opus (most capable)", provider: "anthropic" },
  { id: "sonnet", label: "Claude Sonnet (balanced)", provider: "anthropic" },
  { id: "haiku", label: "Claude Haiku (fastest)", provider: "anthropic" },
];

export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "openai" },
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
  return provider === "openai" ? "gpt-4o-mini" : "haiku";
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
 *  When an API key is resolved we hand it to the CLI; otherwise the CLI falls
 *  back to the host's claude.ai OAuth (the "provided"/subscription path). */
export function claudeEnvForCredential(cred: ResolvedCredential): NodeJS.ProcessEnv {
  if (cred.apiKey) return { ANTHROPIC_API_KEY: cred.apiKey };
  // Ensure no stale key forces API-key mode when we want OAuth.
  return {};
}
