// A dependency-free MCP server over the stdio transport.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per
// line on stdin, one response per line on stdout, and absolutely nothing else
// on stdout (logs go to stderr). We implement just the methods a tool-only
// server needs: initialize, tools/list, tools/call, ping. See
// https://modelcontextprotocol.io/specification for the wire format.

import { searchProtocols, renderMarkdown } from "./search.ts";
import { VENDORS, VENDOR_IDS } from "./vendors.ts";
import { providerStatus } from "./providers/registry.ts";
import { journalProviderOrder } from "./journals.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "labee-protocols", version: "0.1.0" };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const TOOLS = [
  {
    name: "search_protocols",
    description:
      "Search laboratory-protocol and reagent sources (STAR Protocols, Nature Protocols, " +
      "Thermo Fisher, QIAGEN, NEB, Bio-Rad, Sigma-Aldrich, EMD Millipore, Takara Bio, Promega, IDT) " +
      "for a technique, kit, reagent, or product. Journals are searched via scholarly APIs " +
      "(Crossref/Europe PMC); vendors via a web-search provider. Returns ranked links with snippets " +
      "per source plus a guaranteed on-site search URL for each. Use this instead of fetching the " +
      "vendor sites directly — they bot-block automated requests.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, e.g. 'RNA extraction from FFPE', 'Gibson assembly', 'Q5 polymerase'.",
        },
        vendors: {
          type: "array",
          items: { type: "string", enum: VENDOR_IDS },
          description:
            "Optional subset of vendor ids to search. Omit to search all. " +
            `Valid ids: ${VENDOR_IDS.join(", ")}.`,
        },
        limit: {
          type: "number",
          description: "Max results per vendor (1-10, default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_protocol_vendors",
    description:
      "List the protocol/reagent vendors this server can search, with their ids and what each is best for.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function toolText(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_protocol_vendors") {
    const lines = VENDORS.map(
      (v) => `- ${v.id} [${v.kind}]: ${v.name} — ${v.blurb}`,
    );
    const providers = providerStatus()
      .map((p) => `${p.id}${p.available ? "" : " (not configured)"}`)
      .join(", ");
    return toolText(
      [
        "Sources:",
        ...lines,
        "",
        `Web-search providers (vendors): ${providers}.`,
        `Journal providers (chain): ${journalProviderOrder().join(" → ")}.`,
        "Set BRAVE_API_KEY or GOOGLE_API_KEY+GOOGLE_CSE_CX for rate-limit-free vendor search.",
      ].join("\n"),
    );
  }
  if (name === "search_protocols") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return toolText("Error: `query` is required.", true);
    const vendors = Array.isArray(args.vendors)
      ? args.vendors.filter((x): x is string => typeof x === "string")
      : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const resp = await searchProtocols(query, {
      ...(vendors ? { vendors } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return toolText(renderMarkdown(resp));
  }
  return toolText(`Error: unknown tool "${name}".`, true);
}

/**
 * Pure request handler: maps a JSON-RPC request to its response, or `null` for
 * notifications (no id, or initialized) that must not be answered. Never throws
 * — tool errors are surfaced as MCP tool results with `isError: true`.
 */
export async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case "notifications/initialized":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return { jsonrpc: "2.0", id, result: await callTool(name, args) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "tool execution failed";
        return { jsonrpc: "2.0", id, result: toolText(`Error: ${message}`, true) };
      }
    }
    default:
      // Don't answer a notification we don't recognise (id is null/absent).
      if (req.id === undefined || req.id === null) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

/** Start the stdio server. Resolves when stdin closes. */
export function runMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write("[labee-protocols] MCP server ready on stdio\n");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          continue; // ignore unparseable lines
        }
        void dispatch(req).then((res) => {
          if (res) process.stdout.write(JSON.stringify(res) + "\n");
        });
      }
    });
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
}
