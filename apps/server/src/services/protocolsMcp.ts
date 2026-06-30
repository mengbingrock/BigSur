// Locates the bundled protocol-search MCP server (@labee/mcp-protocols) and
// produces the `claude` CLI flags that load it. The server is a self-contained
// `dist/index.mjs`; if it hasn't been built (or can't be found) we return no
// flags, so chat keeps working exactly as before — the tool is purely additive.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string[] | null | undefined;

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
  const config = {
    mcpServers: {
      protocols: { command: process.execPath, args: [entry] },
    },
  };
  cached = ["--mcp-config", JSON.stringify(config)];
  return cached;
}

/** True when the protocol-search MCP server is wired into chat this run. */
export function protocolsMcpAvailable(): boolean {
  return protocolsMcpArgs().length > 0;
}
