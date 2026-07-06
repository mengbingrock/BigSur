import { Schema } from "effect";

/** LLM providers Labee can talk to. */
export const Provider = Schema.Literals(["anthropic", "openai"]);
export type Provider = typeof Provider.Type;

/**
 * Where the credential for a provider comes from:
 *  - own_api_key:      the user's own API key (stored encrypted, per-user)
 *  - own_subscription: the user's own subscription / OAuth (Claude Pro/Max,
 *                      ChatGPT) — connect flow is scaffolded
 *  - provided:         Labee-provided credentials (the paid/official account)
 */
export const CredentialMode = Schema.Literals(["own_api_key", "own_subscription", "provided"]);
export type CredentialMode = typeof CredentialMode.Type;

/** A selectable model in a provider's catalog. */
export const ModelInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  provider: Provider,
});
export type ModelInfo = typeof ModelInfo.Type;

/** Per-provider credential configuration as exposed to the client.
 *  Secrets never cross the wire — only whether one is on file. */
export const ProviderAccount = Schema.Struct({
  provider: Provider,
  mode: CredentialMode,
  hasOwnApiKey: Schema.Boolean,
  subscriptionConnected: Schema.Boolean,
});
export type ProviderAccount = typeof ProviderAccount.Type;

/** The user's effective LLM settings (GET /api/llm/settings). */
export const LlmSettings = Schema.Struct({
  provider: Provider,
  model: Schema.String,
  accounts: Schema.Array(ProviderAccount),
});
export type LlmSettings = typeof LlmSettings.Type;

/** Patch for PUT /api/llm/settings. API-key fields are write-only:
 *  a string sets it, null clears it, omitted leaves it unchanged. */
export const LlmSettingsUpdate = Schema.Struct({
  provider: Schema.optional(Provider),
  model: Schema.optional(Schema.String),
  anthropicMode: Schema.optional(CredentialMode),
  openaiMode: Schema.optional(CredentialMode),
  anthropicApiKey: Schema.optional(Schema.NullOr(Schema.String)),
  openaiApiKey: Schema.optional(Schema.NullOr(Schema.String)),
});
export type LlmSettingsUpdate = typeof LlmSettingsUpdate.Type;

/** One provider's catalog entry (GET /api/llm/providers). */
export const ProviderCatalogEntry = Schema.Struct({
  provider: Provider,
  label: Schema.String,
  models: Schema.Array(ModelInfo),
  /** Is a Labee-provided (server-side) credential configured for this provider? */
  providedAvailable: Schema.Boolean,
  supportsApiKey: Schema.Boolean,
  supportsSubscription: Schema.Boolean,
  /** Subscription/OAuth connect flow is scaffolded, not yet wired. */
  subscriptionComingSoon: Schema.Boolean,
  /** Does this provider run the full agentic toolset in-app (vs plain chat)? */
  agentic: Schema.Boolean,
});
export type ProviderCatalogEntry = typeof ProviderCatalogEntry.Type;

export const ProviderCatalog = Schema.Struct({
  providers: Schema.Array(ProviderCatalogEntry),
});
export type ProviderCatalog = typeof ProviderCatalog.Type;

/** A provider account connection brokered through that provider's CLI:
 *  OpenAI/ChatGPT via the `codex` CLI (AgentScience's mechanism), Anthropic/
 *  Claude via the `claude` CLI's claude.ai sign-in. */
export const AccountConnection = Schema.Struct({
  /** Is the broker CLI available to start/clear a sign-in? */
  available: Schema.Boolean,
  /** Is an account currently signed in? */
  connected: Schema.Boolean,
  /** "subscription" (claude.ai / ChatGPT) or "apiKey". */
  kind: Schema.optional(Schema.Literals(["subscription", "apiKey"])),
  /** e.g. "Claude Max Subscription", "ChatGPT Plus Subscription". */
  planLabel: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
export type AccountConnection = typeof AccountConnection.Type;

/** Connection status for both providers (GET /api/llm/connection). */
export const Connections = Schema.Struct({
  openai: AccountConnection,
  anthropic: AccountConnection,
});
export type Connections = typeof Connections.Type;
