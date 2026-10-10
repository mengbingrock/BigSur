// Wires the library MCP server (src/mcp/libraryMcp.ts) into a claude turn as
// a stdio server: the same binary that is running this server, started with
// --mcp-library, pointed back at this server by env. The session it carries
// is sealed for the account whose turn it is, so every tool call is scoped
// exactly as a page request from that person would be.
import { sealSession } from "./session";

export interface McpServerEntry {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Where a child on this machine reaches this server. */
function selfBase(): string {
  const explicit = process.env.LABEE_MCP_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = process.env.LABEE_PORT?.trim() || "3000";
  return `http://127.0.0.1:${port}`;
}

/**
 * The `mcpServers` entry for the library server, for `email`'s turn.
 * `readOnly` turns (chat, plan) get a server that refuses to save.
 */
export async function libraryMcpServer(email: string, opts: { readOnly: boolean }): Promise<McpServerEntry> {
  const cookie = await sealSession({ email });
  return {
    type: "stdio",
    command: process.execPath,
    args: [process.argv[1]!, "--mcp-library"],
    env: {
      LABEE_MCP_BASE: selfBase(),
      LABEE_MCP_COOKIE: cookie,
      ...(opts.readOnly ? { LABEE_MCP_READONLY: "1" } : {}),
    },
  };
}

/** One `--mcp-config` for the claude CLI carrying every server given. */
export function mcpConfigArgs(servers: Record<string, McpServerEntry | null | undefined>): string[] {
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) if (entry) mcpServers[name] = entry;
  if (Object.keys(mcpServers).length === 0) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers })];
}
