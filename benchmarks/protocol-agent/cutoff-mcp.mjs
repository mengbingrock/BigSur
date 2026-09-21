#!/usr/bin/env node

/**
 * Benchmark-only launcher for the installed Labee protocol-search MCP.
 *
 * The production MCP does not currently expose publication-date filters and
 * its rendered search results omit dates. For hidden-answer retrieval tests,
 * this launcher enforces a strict Crossref publication cutoff before the
 * response reaches the agent. It also pins journal lookup to Crossref so a
 * fallback provider cannot bypass the filter.
 *
 * Usage:
 *   PROTOCOLS_RESULT_CUTOFF=2026-07-01 \
 *     node benchmarks/protocol-agent/cutoff-mcp.mjs --http --port 3001
 */

const cutoff = process.env.PROTOCOLS_RESULT_CUTOFF?.trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff ?? "")) {
  throw new Error("PROTOCOLS_RESULT_CUTOFF must be an ISO date (YYYY-MM-DD).");
}

const nativeFetch = globalThis.fetch.bind(globalThis);

function crossrefDateParts(item) {
  return item?.["published-online"]?.["date-parts"]?.[0]
    ?? item?.["published-print"]?.["date-parts"]?.[0]
    ?? item?.published?.["date-parts"]?.[0]
    ?? item?.issued?.["date-parts"]?.[0]
    ?? null;
}

/**
 * Crossref's until-pub-date filter can admit records whose primary published
 * field has only year/month precision. For example, a July 2026 record may be
 * treated as July 1 even when published-online says July 14. Fail closed: keep
 * only records whose best publication date is unambiguously before cutoff.
 */
function clearlyPublishedBefore(item, exclusiveCutoff) {
  const parts = crossrefDateParts(item);
  if (!Array.isArray(parts) || !parts[0]) return false;
  const [year, month, day] = parts;
  const [cutoffYear, cutoffMonth, cutoffDay] = exclusiveCutoff.split("-").map(Number);
  if (year !== cutoffYear) return year < cutoffYear;
  if (month == null) return false;
  if (month !== cutoffMonth) return month < cutoffMonth;
  if (day == null) return false;
  return day < cutoffDay;
}

globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return nativeFetch(input, init);
  }

  if (url.hostname === "api.crossref.org" && url.pathname === "/works") {
    const existing = url.searchParams.get("filter") ?? "";
    const filters = existing
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => !value.startsWith("until-pub-date:"));
    filters.push(`until-pub-date:${cutoff}`);
    url.searchParams.set("filter", filters.join(","));
    const selected = new Set(
      (url.searchParams.get("select") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    for (const field of ["published", "published-online", "published-print", "issued"]) {
      selected.add(field);
    }
    url.searchParams.set("select", [...selected].join(","));
    const response = await nativeFetch(url, init);
    if (!response.ok) return response;

    const data = await response.json();
    if (Array.isArray(data?.message?.items)) {
      data.message.items = data.message.items.filter((item) => clearlyPublishedBefore(item, cutoff));
      data.message["items-per-page"] = data.message.items.length;
    }
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return nativeFetch(input, init);
};

// A fallback provider would not receive the Crossref cutoff above.
process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";

process.stderr.write(
  `[cutoff-mcp] returning only journal results published before ${cutoff}; provider=crossref\n`,
);

await import("../../node_modules/@mengbingrock/labee-protocol-searcher/dist/index.mjs");
