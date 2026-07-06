// Locates the bundled protocol-search MCP server (@labee/mcp-protocols) and
// produces the `claude` CLI flags that load it. The server is a self-contained
// `dist/index.mjs`; if it hasn't been built (or can't be found) we return no
// flags, so chat keeps working exactly as before — the tool is purely additive.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string[] | null | undefined;

// Env vars the protocol-search MCP reads. Forwarded to the spawned server (via
// the claude `--mcp-config` env and the codex config.toml env) so keyed
// providers / polite-pool identification work regardless of how the runtime
// passes environment to MCP child processes.
const MCP_ENV_KEYS = [
  "PROTOCOLS_CONTACT_EMAIL",
  "PROTOCOLS_SEARCH_PROVIDER",
  "PROTOCOLS_JOURNAL_PROVIDERS",
  "BRAVE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_API_ENDPOINT",
  "GOOGLE_API_KEY",
  "GOOGLE_CSE_KEY",
  "GOOGLE_CSE_CX",
  "SEMANTIC_SCHOLAR_API_KEY",
  "NCBI_API_KEY",
] as const;

/** The subset of MCP_ENV_KEYS that are actually set, as a plain record. */
function protocolsEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of MCP_ENV_KEYS) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

function findServerEntry(): string | null {
  const candidates: string[] = [];
  if (process.env.PROTOCOLS_MCP_PATH) candidates.push(process.env.PROTOCOLS_MCP_PATH);
  // Dev: server runs from the repo root; packaged: alongside the server bundle.
  candidates.push(path.resolve(process.cwd(), "apps/mcp-protocols/dist/index.mjs"));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "../../../mcp-protocols/dist/index.mjs"));
    candidates.push(path.resolve(here, "../../mcp-protocols/dist/index.mjs"));
  } catch {
    // import.meta.url unavailable (shouldn't happen under ESM) — skip.
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * `claude` CLI args that register the protocol-search MCP server, or `[]` when
 * the server bundle isn't available. Computed once and memoised.
 *
 * The tool surfaces to the model as `mcp__protocols__search_protocols`; under
 * the bypassPermissions modes the chat route already uses it is auto-allowed.
 */
export function protocolsMcpArgs(): string[] {
  if (cached !== undefined) return cached ?? [];
  const entry = findServerEntry();
  if (!entry) {
    cached = null;
    return [];
  }
  const env = protocolsEnv();
  const config = {
    mcpServers: {
      protocols: {
        command: process.execPath,
        args: [entry],
        ...(Object.keys(env).length ? { env } : {}),
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

// --- Codex (~/.codex/config.toml) --------------------------------------------
// The codex CLI loads MCP servers from a persistent TOML config, not an inline
// flag. We manage a marker-delimited `[mcp_servers.protocols]` block so codex
// exec turns can call the same stdio server the claude path uses.

const CODEX_BEGIN = "# >>> labee: protocols mcp (managed) >>>";
const CODEX_END = "# <<< labee: protocols mcp (managed) <<<";

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
 * its own marker-delimited block, and bails out if the bundle is missing or the
 * user already defines their own unmanaged `[mcp_servers.protocols]`.
 */
export function ensureCodexProtocolsMcp(): void {
  const entry = findServerEntry();
  if (!entry) return;
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

  // Never clobber a user-defined server of the same name.
  if (/^\s*\[mcp_servers\.protocols\]/m.test(withoutManaged)) return;

  const env = protocolsEnv();
  const envBlock = Object.keys(env).length
    ? `\n[mcp_servers.protocols.env]\n` +
      Object.entries(env)
        .map(([k, v]) => `${k} = ${tomlStr(v)}`)
        .join("\n") +
      "\n"
    : "";

  const block =
    `${CODEX_BEGIN}\n` +
    `[mcp_servers.protocols]\n` +
    `command = ${tomlStr(process.execPath)}\n` +
    `args = [${tomlStr(entry)}]\n` +
    envBlock +
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
