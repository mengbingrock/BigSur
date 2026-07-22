// Wires the protocol-search MCP server into the agent CLIs as a *remote*
// (Streamable HTTP) server. The server runs as its own systemd unit
// (scripts/labee-mcp.service) speaking MCP over HTTP, rather than being spawned
// as a stdio child of every chat turn.
//
// Config comes from two env vars, both provisioned into .env.production:
//   PROTOCOLS_MCP_URL   — endpoint, e.g. http://127.0.0.1:3001/mcp (loopback,
//                         since nginx already exposes it at /mcp publicly)
//   PROTOCOLS_MCP_TOKEN — shared secret sent as `Authorization: Bearer <token>`
//
// When the URL is absent we return no flags, so chat keeps working exactly as
// before — the tool stays purely additive.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let cached: string[] | null | undefined;

interface RemoteConfig {
  url: string;
  token: string | undefined;
}

/**
 * The configured remote endpoint, or null when unset/unusable. A malformed URL
 * is treated as unconfigured rather than throwing: a bad env var should cost
 * the protocol tools, not the whole chat route.
 */
function remoteConfig(): RemoteConfig | null {
  const raw = process.env.PROTOCOLS_MCP_URL?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[protocols-mcp] PROTOCOLS_MCP_URL is not a valid URL: ${raw}`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(`[protocols-mcp] PROTOCOLS_MCP_URL must be http(s): ${raw}`);
    return null;
  }

  const token = process.env.PROTOCOLS_MCP_TOKEN?.trim() || undefined;
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (!token && !loopback) {
    // Off-box and unauthenticated would either 401 on every call or, worse,
    // work against an open endpoint. Refuse to register it.
    console.warn(
      `[protocols-mcp] refusing ${parsed.origin}: PROTOCOLS_MCP_TOKEN is required for non-loopback URLs`,
    );
    return null;
  }

  return { url: parsed.toString(), token };
}

/**
 * `claude` CLI args that register the protocol-search MCP server, or `[]` when
 * no endpoint is configured. Computed once and memoised.
 *
 * The tools surface to the model as `mcp__protocols__search` / `_fetch` /
 * `_list_sources`; under the bypassPermissions modes the chat route already
 * uses they are auto-allowed.
 */
export function protocolsMcpArgs(): string[] {
  if (cached !== undefined) return cached ?? [];
  const remote = remoteConfig();
  if (!remote) {
    cached = null;
    return [];
  }
  const config = {
    mcpServers: {
      protocols: {
        type: "http",
        url: remote.url,
        ...(remote.token
          ? { headers: { Authorization: `Bearer ${remote.token}` } }
          : {}),
      },
    },
  };
  cached = ["--mcp-config", JSON.stringify(config)];
  return cached;
}

/** True when the protocol-search MCP server is wired into chat this run. */
export function protocolsMcpAvailable(): boolean {
  return protocolsMcpArgs().length > 0;
}

/** Test seam: drop the memoised flags so a changed env is picked up. */
export function resetProtocolsMcpCache(): void {
  cached = undefined;
}

// --- Codex (~/.codex/config.toml) --------------------------------------------
// The codex CLI loads MCP servers from a persistent TOML config, not an inline
// flag. We manage a marker-delimited `[mcp_servers.protocols]` block so codex
// exec turns can call the same remote server the claude path uses.
//
// codex reads the bearer token from an env var at call time
// (`bearer_token_env_var`) rather than storing it in the file — so the secret
// never lands on disk, and the spawned codex inherits PROTOCOLS_MCP_TOKEN from
// this process.

const CODEX_BEGIN = "# >>> labee: protocols mcp (managed) >>>";
const CODEX_END = "# <<< labee: protocols mcp (managed) <<<";
const CODEX_TOKEN_ENV = "PROTOCOLS_MCP_TOKEN";

function codexConfigPath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Register the protocol-search MCP with the codex CLI by writing a managed block
 * into `~/.codex/config.toml`. Idempotent and non-destructive: it rewrites only
 * its own marker-delimited block, and bails out if no endpoint is configured or
 * the user already defines their own unmanaged `[mcp_servers.protocols]`.
 */
export function ensureCodexProtocolsMcp(enabled = true): void {
  const cfgPath = codexConfigPath();

  let existing = "";
  try {
    existing = readFileSync(cfgPath, "utf8");
  } catch {
    /* new file */
  }

  // Drop any block we wrote previously.
  const managedRe = new RegExp(
    `\\n*${escapeRe(CODEX_BEGIN)}[\\s\\S]*?${escapeRe(CODEX_END)}\\n*`,
    "g",
  );
  const withoutManaged = existing.replace(managedRe, "\n");

  // Toggled off (or no endpoint): remove our managed block if present and stop.
  const remote = enabled ? remoteConfig() : null;
  if (!remote) {
    if (withoutManaged !== existing) {
      try {
        writeFileSync(cfgPath, withoutManaged.trim() ? `${withoutManaged.trim()}\n` : "", "utf8");
      } catch {
        /* best-effort */
      }
    }
    return;
  }

  // Never clobber a user-defined server of the same name.
  if (/^\s*\[mcp_servers\.protocols\]/m.test(withoutManaged)) return;

  const block =
    `${CODEX_BEGIN}\n` +
    `[mcp_servers.protocols]\n` +
    `url = ${tomlStr(remote.url)}\n` +
    (remote.token ? `bearer_token_env_var = ${tomlStr(CODEX_TOKEN_ENV)}\n` : "") +
    `${CODEX_END}\n`;

  const head = withoutManaged.trim();
  const next = head ? `${head}\n\n${block}` : block;

  try {
    mkdirSync(path.dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, next, "utf8");
  } catch {
    /* best-effort: codex just won't have the tool */
  }
}
