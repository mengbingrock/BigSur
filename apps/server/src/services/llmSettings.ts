// Per-user LLM settings: which provider/model, and per-provider credential
// mode + (encrypted) own API keys. Reads/writes the user_llm_settings table
// and resolves the effective credential to run a turn with.
import type {
  CredentialMode,
  LlmSettings,
  LlmSettingsUpdate,
  Provider,
  ProviderAccount,
} from "@labee/contracts";
import { getDb } from "./db";
import { decryptSecret, encryptSecret } from "./secrets";
import { readCodexConnection } from "./codex";
import { readClaudeConnection } from "./claudeAuth";

interface SettingsRow {
  email: string;
  provider: string;
  model: string;
  anthropic_mode: string;
  openai_mode: string;
  anthropic_api_key_enc: string | null;
  openai_api_key_enc: string | null;
  updated_at: string;
}

const DEFAULT_PROVIDER: Provider = "anthropic";
const DEFAULT_MODEL = "opus";
const CREDENTIAL_MODES: CredentialMode[] = ["own_api_key", "own_subscription", "provided"];
const PROVIDERS: Provider[] = ["anthropic", "openai"];

function coerceProvider(v: unknown): Provider {
  return v === "openai" ? "openai" : "anthropic";
}
function coerceMode(v: unknown, fallback: CredentialMode): CredentialMode {
  return typeof v === "string" && (CREDENTIAL_MODES as string[]).includes(v)
    ? (v as CredentialMode)
    : fallback;
}

async function readRow(email: string): Promise<SettingsRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM user_llm_settings WHERE email = ?").get(email);
  return (row as SettingsRow | undefined) ?? null;
}

/** Public settings for the client (secrets reduced to has/has-not booleans). */
export async function getSettings(email: string): Promise<LlmSettings> {
  const row = await readRow(email);
  const provider = row ? coerceProvider(row.provider) : DEFAULT_PROVIDER;
  const model = row?.model || DEFAULT_MODEL;
  const accounts: ProviderAccount[] = PROVIDERS.map((p) => ({
    provider: p,
    mode:
      p === "anthropic"
        ? coerceMode(row?.anthropic_mode, "provided")
        : coerceMode(row?.openai_mode, "own_api_key"),
    hasOwnApiKey: Boolean(p === "anthropic" ? row?.anthropic_api_key_enc : row?.openai_api_key_enc),
    subscriptionConnected: false, // OAuth connect flow is scaffolded
  }));
  return { provider, model, accounts };
}

/** Apply a patch (upsert). API-key fields: string sets, null clears, undefined leaves. */
export async function updateSettings(email: string, patch: LlmSettingsUpdate): Promise<LlmSettings> {
  const db = await getDb();
  const existing = await readRow(email);

  const provider = patch.provider ? coerceProvider(patch.provider) : coerceProvider(existing?.provider);
  const model = patch.model?.trim() || existing?.model || DEFAULT_MODEL;
  const anthropicMode = patch.anthropicMode
    ? coerceMode(patch.anthropicMode, "provided")
    : coerceMode(existing?.anthropic_mode, "provided");
  const openaiMode = patch.openaiMode
    ? coerceMode(patch.openaiMode, "own_api_key")
    : coerceMode(existing?.openai_mode, "own_api_key");

  const anthropicEnc =
    patch.anthropicApiKey === undefined
      ? (existing?.anthropic_api_key_enc ?? null)
      : patch.anthropicApiKey === null
        ? null
        : encryptSecret(patch.anthropicApiKey);
  const openaiEnc =
    patch.openaiApiKey === undefined
      ? (existing?.openai_api_key_enc ?? null)
      : patch.openaiApiKey === null
        ? null
        : encryptSecret(patch.openaiApiKey);

  db.prepare(
    "INSERT INTO user_llm_settings " +
      "(email, provider, model, anthropic_mode, openai_mode, anthropic_api_key_enc, openai_api_key_enc, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET " +
      "provider = excluded.provider, model = excluded.model, " +
      "anthropic_mode = excluded.anthropic_mode, openai_mode = excluded.openai_mode, " +
      "anthropic_api_key_enc = excluded.anthropic_api_key_enc, " +
      "openai_api_key_enc = excluded.openai_api_key_enc, updated_at = excluded.updated_at",
  ).run(
    email,
    provider,
    model,
    anthropicMode,
    openaiMode,
    anthropicEnc,
    openaiEnc,
    new Date().toISOString(),
  );

  return getSettings(email);
}

export interface ResolvedCredential {
  provider: Provider;
  mode: CredentialMode;
  /** Decrypted API key to use, or null when relying on host OAuth / provided env. */
  apiKey: string | null;
  /** True when no usable credential could be resolved (caller should error). */
  unavailable: boolean;
  /** Human-readable reason when unavailable. */
  reason?: string;
  /** OpenAI subscription: run inference through the codex CLI (ChatGPT login). */
  useCodex?: boolean;
  /** Connected ChatGPT plan label, for display. */
  planLabel?: string;
}

/** Server-side env key Labee provides for a provider (the paid/official account). */
export function providedKey(provider: Provider): string | null {
  if (provider === "openai") {
    return process.env.LABEE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
  }
  return process.env.LABEE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
}

/** Is a Labee-provided credential available for this provider?
 *  Anthropic always is (the host's claude.ai OAuth via the claude CLI). */
export function providedAvailable(provider: Provider): boolean {
  if (provider === "anthropic") return true;
  return Boolean(providedKey(provider));
}

/** Resolve the credential to actually run a turn with for a user + provider. */
export async function resolveCredential(
  email: string,
  provider: Provider,
): Promise<ResolvedCredential> {
  const settings = await getSettings(email);
  const account = settings.accounts.find((a) => a.provider === provider);
  const mode: CredentialMode = account?.mode ?? (provider === "anthropic" ? "provided" : "own_api_key");
  const row = await readRow(email);

  if (mode === "own_api_key") {
    const enc = provider === "anthropic" ? row?.anthropic_api_key_enc : row?.openai_api_key_enc;
    const apiKey = decryptSecret(enc);
    if (!apiKey) {
      return {
        provider,
        mode,
        apiKey: null,
        unavailable: true,
        reason: `No ${provider} API key on file. Add one in Settings, or switch to the provided account.`,
      };
    }
    return { provider, mode, apiKey, unavailable: false };
  }

  if (mode === "own_subscription") {
    if (provider === "anthropic") {
      // Claude Pro/Max via the claude CLI's claude.ai sign-in (no API key).
      const claude = readClaudeConnection();
      if (claude.connected) {
        return { provider, mode, apiKey: null, unavailable: false, ...(claude.planLabel ? { planLabel: claude.planLabel } : {}) };
      }
      return {
        provider,
        mode,
        apiKey: null,
        unavailable: true,
        reason: "Connect your Claude account under Settings → Connection first.",
      };
    }
    // OpenAI subscription runs through the codex CLI's ChatGPT login.
    const conn = readCodexConnection();
    if (conn.connected && conn.kind === "subscription") {
      return {
        provider,
        mode,
        apiKey: null,
        unavailable: false,
        useCodex: true,
        ...(conn.planLabel ? { planLabel: conn.planLabel } : {}),
      };
    }
    return {
      provider,
      mode,
      apiKey: null,
      unavailable: true,
      reason: "Connect your ChatGPT account under Settings → Connection first.",
    };
  }

  // provided
  const key = providedKey(provider);
  if (provider === "anthropic") {
    // host claude.ai OAuth works even without an env key
    return { provider, mode, apiKey: key, unavailable: false };
  }
  if (!key) {
    return {
      provider,
      mode,
      apiKey: null,
      unavailable: true,
      reason: "Labee doesn't have a provided OpenAI account configured on this server.",
    };
  }
  return { provider, mode, apiKey: key, unavailable: false };
}
