# @labee/mcp-protocols

An MCP (Model Context Protocol) stdio server — and standalone CLI — that
searches laboratory-protocol and reagent vendors for a technique, kit, reagent,
or product, and returns ranked links per vendor.

## Why this exists

Direct/automated search of the target vendor sites is **not reliably usable**.
Fetching their search pages from a non-browser client returns, depending on the
site and the moment:

| Site | Direct fetch result |
| --- | --- |
| cell.com/star-protocols | 403 Forbidden |
| nature.com/nprot | 303 → login/paywall |
| thermofisher.com | 503 / intermittent 200 |
| qiagen.com | 200 (homepage only) |
| neb.com | 403 / intermittent 200 |
| bio-rad.com | 403 |
| sigmaaldrich.com / emdmillipore.com | 503 / intermittent 200 |
| takarabio.com | 403 |
| promega.com | 200 but JS-rendered (no results in HTML) |
| idtdna.com | connection blocked |

A browser `User-Agent` recovers a few of them intermittently, but the protection
(Akamai/Cloudflare) is inconsistent and several sites stay hard-blocked.
General web search scoped to these domains also surfaces little. So instead of
ten brittle per-vendor scrapers, this server uses **one** search backend that
*does* index all of them — DuckDuckGo — scoped per vendor with `site:`
operators, and always pairs each vendor with a deterministic on-site search URL
that never gets blocked (it's a URL, not a fetch).

## How it works

- **Combined queries.** Vendors are batched into a single
  `(site:a OR site:b ...) <query>` request (DuckDuckGo rate-limits per-request
  fan-out), and results are bucketed back to each vendor by hostname.
- **Endpoint fallback + retries.** Tries `lite.duckduckgo.com` (most
  bot-tolerant) then `html.duckduckgo.com`, with backoff and rotating
  User-Agents. When DuckDuckGo rate-limits, the response is marked `partial`
  and the always-valid vendor search URLs carry the result.

## Tools

- `search_protocols({ query, vendors?, limit? })` — search across vendors.
  `vendors` is an optional subset of vendor ids; `limit` is per-vendor (1–10,
  default 5).
- `list_protocol_vendors()` — the vendor catalog with ids and descriptions.

## Use as a CLI

```sh
node dist/index.mjs --query "RNA extraction from FFPE"
node dist/index.mjs --query "Gibson assembly" --vendors neb,star-protocols --limit 3
node dist/index.mjs --query "Q5 polymerase" --json
node dist/index.mjs --list-vendors
```

In dev you can skip the build with `node --experimental-strip-types src/index.ts --query "..."`.

## Use as an MCP server

With no `--query`, the process speaks MCP over stdio (newline-delimited
JSON-RPC). Register it with any MCP client, e.g. the `claude` CLI:

```jsonc
{
  "mcpServers": {
    "protocols": { "command": "node", "args": ["<abs>/apps/mcp-protocols/dist/index.mjs"] }
  }
}
```

The Labee chat route wires this in automatically (see
`apps/server/src/services/protocolsMcp.ts`); override the path with
`PROTOCOLS_MCP_PATH` if needed.

## Develop

```sh
bun run build      # bundle to dist/index.mjs (self-contained, no runtime deps)
bun run test       # vitest (parsers, search bucketing, MCP handshake)
bun run typecheck
```
