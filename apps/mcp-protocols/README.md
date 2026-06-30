# @labee/mcp-protocols

An MCP (Model Context Protocol) stdio server — and standalone CLI — that
searches laboratory-protocol journals and reagent vendors for a technique, kit,
reagent, or product, and returns ranked links per source.

## Why this exists

Direct/automated search of the target sites is **not reliably usable**. Fetching
their search pages from a non-browser client returns, depending on the site and
the moment, 403/503/login walls, or JavaScript-only shells with no results in
the HTML:

| Source | Direct fetch result |
| --- | --- |
| cell.com/star-protocols | 403 Forbidden |
| nature.com/nprot | 303 → login/paywall |
| thermofisher.com | 200 but results are JS-rendered |
| qiagen.com | 200 but results are JS-rendered |
| neb.com | 403 / intermittent 200 |
| bio-rad.com | 403 / 503 |
| sigmaaldrich.com / emdmillipore.com | 503 / intermittent 200 |
| takarabio.com | 403 |
| promega.com | JS-only shell |
| idtdna.com | connection blocked |

Alternative search engines don't help much either: Bing serves a results shell
with no organic results to a scraper, and Mojeek / public SearXNG instances
return 403. So this server routes each source to the backend that *actually*
works for it.

## How it works

Two routes, picked per source:

- **Protocol journals (STAR Protocols, Nature Protocols, JoVE, Bio-protocol,
  Current Protocols)** → a chain of five free, keyless scholarly APIs, tried in
  order until one answers: **Crossref → Europe PMC → OpenAlex → Semantic Scholar
  → PubMed (NCBI E-utilities)**. They index these journals directly (keyed by
  ISSN / journal name), returning real protocol titles, DOIs, and links — no
  scraping, no paywall. Because they're run by different organizations, the
  chain almost never fails: if one is down or rate-limiting (HTTP 429), it
  retries with backoff then falls through to the next. Reliable out of the box;
  reorder with `PROTOCOLS_JOURNAL_PROVIDERS`. Optional `SEMANTIC_SCHOLAR_API_KEY`
  / `NCBI_API_KEY` raise rate limits (both work without a key).

- **Reagent vendors + protocols.io** → a **web-search provider chain**, scoped
  per source with a `site:` filter and batched into combined
  `(site:a OR site:b ...)` queries (results bucketed back per source by
  hostname). protocols.io is a repository (no journal ISSN), so it's reached this
  way rather than via the scholarly chain:

  1. **Brave Search API** — if `BRAVE_API_KEY` is set (free tier).
  2. **Google Programmable Search** — if `GOOGLE_API_KEY` + `GOOGLE_CSE_CX` are set
     (free 100/day).
  3. **DuckDuckGo** (lite then html endpoints, with backoff + UA rotation) —
     keyless default; works for occasional queries but can be rate-limited
     (it serves a CAPTCHA page to flagged IPs).

  The chain tries providers in order and returns the first non-empty result, so
  a rate-limited or unconfigured provider transparently falls through.

**Set a free Brave or Google key for reliable vendor search.** Without one, vendor
results are best-effort via DuckDuckGo. Either way, every source is always paired
with its deterministic on-site search URL (a plain URL, never blocked), so the
tool stays useful even when extraction is unavailable.

## Tools

- `search_protocols({ query, vendors?, limit? })` — search across sources.
  `vendors` is an optional subset of source ids; `limit` is per-source (1–10,
  default 5).
- `list_protocol_vendors()` — the source catalog and which web-search providers
  are currently configured.

## Configuration (env)

| Var | Purpose |
| --- | --- |
| `BRAVE_API_KEY` | Enable the Brave Search provider (recommended). |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_CX` | Enable the Google Programmable Search provider. |
| `PROTOCOLS_SEARCH_PROVIDER` | Force a single vendor provider: `brave` \| `google` \| `duckduckgo`. |
| `PROTOCOLS_JOURNAL_PROVIDERS` | Reorder/limit the journal chain (comma-separated): `crossref,europepmc,openalex,semanticscholar,pubmed`. |
| `SEMANTIC_SCHOLAR_API_KEY` / `NCBI_API_KEY` | Optional; raise rate limits for those journal providers. |
| `PROTOCOLS_CONTACT_EMAIL` | Sent to the Crossref/OpenAlex/NCBI "polite pools" for reliability. |

## Use as a CLI

```sh
node dist/index.mjs --query "CRISPR knockout" --vendors star-protocols,nature-protocols
node dist/index.mjs --query "Gibson assembly" --vendors neb --limit 3
node dist/index.mjs --query "Q5 polymerase" --json
node dist/index.mjs --list-vendors
```

In dev, skip the build with `node --experimental-strip-types src/index.ts --query "..."`.

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
`PROTOCOLS_MCP_PATH`. API keys are read from the server's environment.

## Develop

```sh
bun run build      # bundle to dist/index.mjs (self-contained, no runtime deps)
bun run test       # vitest (parsers, providers, journals, search routing, MCP handshake)
bun run typecheck
```
