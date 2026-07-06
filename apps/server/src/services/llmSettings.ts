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
import fs from "node:fs";
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
  /** Local-first "provided": point the local claude/OpenAI at this Labee
   *  inference proxy base URL (with `apiKey` used as the Bearer proxy token)
   *  instead of the vendor. Set only when running as the desktop app against a
   *  connected Labee account. */
  proxyBaseUrl?: string;
}

// --- Labee inference proxy (local-first "provided") --------------------------
// On the desktop the box env key isn't present, so a "provided" turn runs the
// local CLI but routes inference to the hosted Labee proxy. We mint a
// short-lived token from the box (auth via the persisted box session) and cache
// it per provider.
interface ProxyCred {
  token: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  fetchedAt: number;
}
let proxyCache: ProxyCred | null = null;
const PROXY_CACHE_MS = 45 * 60 * 1000; // refetch before the 1h server TTL

/** True when this server is the local desktop instance (vs the hosted box). */
function isDesktop(): boolean {
  return process.env.LABEE_MODE === "desktop";
}

function proxyServerBase(): string {
  return (process.env.LABEE_SKILLS_SERVER || "https://labee.online").replace(/\/+$/, "");
}

/** The box session the desktop persisted at "Connect to Labee", as a Cookie. */
function boxSessionCookie(): string | null {
  const file = process.env.LABEE_REMOTE_SESSION_FILE;
  if (!file) return null;
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value ? `monterey_session=${value}` : null;
  } catch {
    return null;
  }
}

/** When the desktop is connected to a hosted Labee account, billing lives on
 *  that account (that's where "provided" inference is metered and credits are
 *  deducted). Returns the base URL + session cookie to forward billing requests
 *  there, or null when this isn't a connected desktop (→ serve billing locally). */
export function remoteLabeeSession(): { base: string; cookie: string } | null {
  if (!isDesktop()) return null;
  const cookie = boxSessionCookie();
  if (!cookie) return null;
  return { base: proxyServerBase(), cookie };
}

/** Fetch (or reuse a cached) Labee proxy token + base URLs. Null when the user
 *  hasn't connected their Labee account or the box rejects the session. */
async function getProxyCred(force = false): Promise<ProxyCred | null> {
  if (!force && proxyCache && Date.now() - proxyCache.fetchedAt < PROXY_CACHE_MS) {
    return proxyCache;
  }
  const cookie = boxSessionCookie();
  if (!cookie) return null;
  try {
    const res = await fetch(`${proxyServerBase()}/api/llm/proxy-token`, {
      headers: { accept: "application/json", cookie },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      token: string;
      anthropicBaseUrl: string;
      openaiBaseUrl: string;
    };
    proxyCache = { ...data, fetchedAt: Date.now() };
    return proxyCache;
  } catch {
    return null;
  }
}

/** Build a proxy-backed ResolvedCredential for a provided turn on the desktop:
 *  run the local CLI but route inference to the hosted Labee box, which meters
 *  the call and debits the account's credit balance. */
async function providedViaProxy(provider: Provider): Promise<ResolvedCredential | null> {
  const cred = await getProxyCred();
  if (!cred) return null;
  const proxyBaseUrl = provider === "anthropic" ? cred.anthropicBaseUrl : cred.openaiBaseUrl;
  return { provider, mode: "provided", apiKey: cred.token, proxyBaseUrl, unavailable: false };
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
  // Desktop (local-first): run the local CLI but route inference to the hosted
  // Labee proxy, so a provided agent still operates the user's local files.
  if (isDesktop()) {
    const viaProxy = await providedViaProxy(provider);
    if (viaProxy) return viaProxy;
    return {
      provider,
      mode,
      apiKey: null,
      unavailable: true,
      reason:
        "Connect your Labee account (Agents → Sync from Labee) to use Labee-provided models here, " +
        "or switch this provider to your own subscription in Settings.",
    };
  }

  // Hosted box: use Labee's server-side account directly.
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
