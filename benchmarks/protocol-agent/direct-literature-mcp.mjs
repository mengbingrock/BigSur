#!/usr/bin/env node

/** Minimal benchmark-only Crossref search MCP; independent of Labee/protocol code. */

const cutoff = process.env.LITERATURE_RESULT_CUTOFF?.trim() ?? "2026-07-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
  throw new Error("LITERATURE_RESULT_CUTOFF must be YYYY-MM-DD");
}

const serverInfo = { name: "cutoff-literature-search", version: "1.0.0" };
const searchTool = {
  name: "search",
  title: "Search scholarly metadata before the benchmark cutoff",
  description: `Search Crossref scholarly metadata. Results are fail-closed to publicationDate < ${cutoff}. No article fetch or protocol skill is available.`,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function dateParts(item) {
  return item?.["published-online"]?.["date-parts"]?.[0]
    ?? item?.["published-print"]?.["date-parts"]?.[0]
    ?? item?.published?.["date-parts"]?.[0]
    ?? item?.issued?.["date-parts"]?.[0]
    ?? null;
}

function clearlyBefore(item) {
  const parts = dateParts(item);
  if (!Array.isArray(parts) || !parts[0]) return false;
  const [year, month, day] = parts;
  const [cutoffYear, cutoffMonth, cutoffDay] = cutoff.split("-").map(Number);
  if (year !== cutoffYear) return year < cutoffYear;
  if (month == null) return false;
  if (month !== cutoffMonth) return month < cutoffMonth;
  if (day == null) return false;
  return day < cutoffDay;
}

function displayDate(item) {
  const [year, month, day] = dateParts(item);
  return [year, month, day].filter((part) => part != null).join("-");
}

function clean(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function search(args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { content: [{ type: "text", text: "Error: query is required" }], isError: true };
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("filter", `until-pub-date:${cutoff}`);
  url.searchParams.set("rows", String(Math.max(40, limit * 5)));
  url.searchParams.set("select", "DOI,title,abstract,published,published-online,published-print,issued,container-title,URL,type");
  const response = await fetch(url, {
    headers: { "User-Agent": "direct-react-benchmark/1.0" },
  });
  if (!response.ok) throw new Error(`Crossref returned HTTP ${response.status}`);
  const data = await response.json();
  const items = (data?.message?.items ?? []).filter(clearlyBefore).slice(0, limit);
  const lines = [
    `# Literature metadata search: ${JSON.stringify(query)}`,
    `Cutoff rule: publicationDate < ${cutoff}`,
    "",
  ];
  for (const item of items) {
    const title = clean(item.title?.[0]) || "Untitled";
    const journal = clean(item["container-title"]?.[0]);
    const abstract = clean(item.abstract).slice(0, 600);
    lines.push(`- ${title}`);
    lines.push(`  \`doi:${String(item.DOI).toLowerCase()}\` · published ${displayDate(item)}${journal ? ` · ${journal}` : ""}`);
    if (abstract) lines.push(`  Abstract: ${abstract}`);
  }
  if (items.length === 0) lines.push("No unambiguously pre-cutoff results.");
  return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
}

async function dispatch(request) {
  const id = request.id ?? null;
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo,
    },
  };
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list") return {
    jsonrpc: "2.0",
    id,
    result: { tools: [searchTool] },
  };
  if (request.method === "tools/call") {
    try {
      if (request.params?.name !== "search") throw new Error("unknown tool");
      return { jsonrpc: "2.0", id, result: await search(request.params?.arguments ?? {}) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true },
      };
    }
  }
  if (request.id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      dispatch(request).then((result) => {
        if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
      });
    } catch {
      // Ignore malformed input; the benchmark client sends JSONL.
    }
  }
});
process.stderr.write(`[cutoff-literature-search] ready; publicationDate < ${cutoff}\n`);
