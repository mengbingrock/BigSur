// Orchestrates a protocol search across vendors.
//
// Rather than one DuckDuckGo request per vendor (which trips DuckDuckGo's
// rate-limiter fast), we batch vendors into combined `(site:a OR site:b ...)`
// queries — a handful of sites per request — then bucket the returned results
// back to each vendor by URL. Every vendor is also paired with its
// deterministic, never-blocked on-site search URL, so the tool is useful even
// when result extraction is rate-limited.

import { ddgSearch, type DdgSearchOptions, type RawResult } from "./ddg.ts";
import { resolveVendors, type Vendor } from "./vendors.ts";

export interface VendorResults {
  id: string;
  name: string;
  /** Deterministic deep link into the vendor's own search page. */
  searchUrl: string;
  results: RawResult[];
  /** Present when live result extraction returned nothing for this vendor. */
  error?: string;
}

export interface SearchResponse {
  query: string;
  vendors: VendorResults[];
  unknownVendors: string[];
  /** True when at least one batch came back rate-limited/empty. */
  partial: boolean;
}

export interface SearchOptions {
  vendors?: readonly string[];
  /** Max results per vendor (default 5, clamped to 1..10). */
  limit?: number;
  /** Vendors per combined DuckDuckGo query (default 6). */
  batchSize?: number;
  /** Forwarded to the DuckDuckGo client (timeout, fetch injection). */
  ddg?: DdgSearchOptions;
}

/** Normalize a URL to `host/path` without the `www.` prefix, lowercased. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return host + u.pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Find the vendor a result URL belongs to. Matches by `ddgSite` prefix and
 * prefers the most specific (longest) match so `cell.com/star-protocols` wins
 * over a bare-domain vendor on the same host.
 */
function matchVendor(url: string, vendors: readonly Vendor[]): Vendor | undefined {
  const norm = normalizeUrl(url);
  let best: Vendor | undefined;
  for (const v of vendors) {
    const site = v.ddgSite.replace(/^www\./, "").toLowerCase();
    if ((norm === site || norm.startsWith(site + "/") || norm.startsWith(site)) &&
        (!best || v.ddgSite.length > best.ddgSite.length)) {
      // Guard: a bare host match must align on a host boundary, not a substring
      // of a longer host (e.g. "neb.com" must not match "neb.com.evil.com").
      const host = norm.split("/")[0]!;
      const siteHost = site.split("/")[0]!;
      if (host === siteHost) best = v;
    }
  }
  return best;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function searchProtocols(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const { vendors, unknown } = resolveVendors(opts.vendors);
  if (!trimmed) {
    return { query: "", vendors: [], unknownVendors: unknown, partial: false };
  }
  const limit = Math.max(1, Math.min(10, Math.floor(opts.limit ?? 5)));
  const batchSize = Math.max(1, opts.batchSize ?? 6);

  // Seed every vendor's bucket so the response shape is stable even when a
  // batch is rate-limited.
  const buckets = new Map<string, VendorResults>(
    vendors.map((v) => [
      v.id,
      { id: v.id, name: v.name, searchUrl: v.searchUrl(trimmed), results: [] },
    ]),
  );

  let partial = false;
  // Batches run sequentially: DuckDuckGo rate-limits concurrent requests from
  // one IP hard, so a couple of serial requests is both faster (no 202 retry
  // storms) and gentler than a parallel fan-out.
  for (const group of chunk(vendors, batchSize)) {
    const sites = group.map((v) => `site:${v.ddgSite}`).join(" OR ");
    const combined = group.length === 1 ? `${sites} ${trimmed}` : `(${sites}) ${trimmed}`;
    const res = await ddgSearch(combined, {
      ...opts.ddg,
      limit: limit * group.length,
    });
    if (res.results.length === 0) {
      partial = true;
      const reason =
        res.error ?? "no indexed results (open the vendor search URLs to search directly)";
      for (const v of group) {
        const bucket = buckets.get(v.id)!;
        if (bucket.results.length === 0) bucket.error = reason;
      }
      continue;
    }
    for (const r of res.results) {
      const vendor = matchVendor(r.url, group);
      if (!vendor) continue;
      const bucket = buckets.get(vendor.id)!;
      if (bucket.results.length < limit) bucket.results.push(r);
    }
  }

  return {
    query: trimmed,
    vendors: Array.from(buckets.values()),
    unknownVendors: unknown,
    partial,
  };
}

/** Render a SearchResponse as compact, model-friendly markdown. */
export function renderMarkdown(resp: SearchResponse): string {
  if (!resp.query) return "No query provided.";
  const lines: string[] = [`# Protocol search: "${resp.query}"`, ""];
  if (resp.unknownVendors.length > 0) {
    lines.push(`> Unknown vendor ids ignored: ${resp.unknownVendors.join(", ")}`, "");
  }
  let totalHits = 0;
  for (const v of resp.vendors) {
    lines.push(`## ${v.name}`);
    lines.push(`Search page: ${v.searchUrl}`);
    if (v.results.length === 0) {
      lines.push(`_No extractable results${v.error ? ` (${v.error})` : ""}._`, "");
      continue;
    }
    for (const r of v.results) {
      totalHits++;
      lines.push(`- [${r.title}](${r.url})`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
    }
    lines.push("");
  }
  const note = resp.partial
    ? " Some vendors were rate-limited by the search backend — use their search pages directly."
    : "";
  lines.push(
    `_${totalHits} result${totalHits === 1 ? "" : "s"} across ${resp.vendors.length} vendor${
      resp.vendors.length === 1 ? "" : "s"
    }. Vendor search pages always work even when extraction is blocked.${note}_`,
  );
  return lines.join("\n");
}
