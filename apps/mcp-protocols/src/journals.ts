// Scholarly-API search for the protocol journals (STAR Protocols, Nature
// Protocols). Crossref and Europe PMC are free, keyless, and reliable — they
// index these journals directly, so we get real protocol titles, DOIs, and
// links without scraping the paywalled/bot-blocked publisher sites. Crossref
// is primary; Europe PMC is the fallback.

import {
  type ProviderOptions,
  type RawResult,
  fetchWithTimeout,
} from "./providers/types.ts";
import type { JournalInfo } from "./vendors.ts";

const DEFAULT_TIMEOUT_MS = 9000;
// Identifies us to Crossref's "polite pool" for better reliability.
const CONTACT = process.env.PROTOCOLS_CONTACT_EMAIL || "labee-mcp-protocols@example.com";

export interface JournalSearchOutcome {
  results: RawResult[];
  source: string;
  error?: string;
}

interface CrossrefResponse {
  message?: {
    items?: {
      title?: string[];
      URL?: string;
      DOI?: string;
      abstract?: string;
      "container-title"?: string[];
    }[];
  };
}

function cleanAbstract(raw?: string): string {
  if (!raw) return "";
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function crossref(
  journal: JournalInfo,
  query: string,
  limit: number,
  opts: ProviderOptions,
): Promise<RawResult[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url =
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
    `&filter=container-title:${encodeURIComponent(journal.crossrefContainer)}` +
    `&rows=${limit}&select=title,DOI,URL,abstract&sort=relevance` +
    `&mailto=${encodeURIComponent(CONTACT)}`;
  const res = await fetchWithTimeout(
    doFetch,
    url,
    { headers: { Accept: "application/json", "User-Agent": `labee-mcp-protocols (mailto:${CONTACT})` } },
    timeoutMs,
  );
  if (res.status !== 200) throw new Error(`Crossref HTTP ${res.status}`);
  const json = (await res.json()) as CrossrefResponse;
  return (json.message?.items ?? [])
    .map((it) => ({
      title: (it.title?.[0] ?? "").trim(),
      url: it.URL ?? (it.DOI ? `https://doi.org/${it.DOI}` : ""),
      snippet: cleanAbstract(it.abstract),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, limit);
}

interface EuropePmcResponse {
  resultList?: {
    result?: { title?: string; doi?: string; abstractText?: string; id?: string; source?: string }[];
  };
}

async function europepmc(
  journal: JournalInfo,
  query: string,
  limit: number,
  opts: ProviderOptions,
): Promise<RawResult[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const q = `${query} AND JOURNAL:"${journal.europepmcJournal}"`;
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}` +
    `&format=json&pageSize=${limit}&resultType=lite`;
  const res = await fetchWithTimeout(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs);
  if (res.status !== 200) throw new Error(`Europe PMC HTTP ${res.status}`);
  const json = (await res.json()) as EuropePmcResponse;
  return (json.resultList?.result ?? [])
    .map((r) => ({
      title: (r.title ?? "").replace(/<[^>]+>/g, "").trim(),
      url: r.doi ? `https://doi.org/${r.doi}` : r.id ? `https://europepmc.org/article/MED/${r.id}` : "",
      snippet: cleanAbstract(r.abstractText),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, limit);
}

/** Search a protocol journal: Crossref first, Europe PMC on failure/empty. */
export async function searchJournal(
  journal: JournalInfo,
  query: string,
  limit: number,
  opts: ProviderOptions = {},
): Promise<JournalSearchOutcome> {
  let crossrefError = "";
  try {
    const results = await crossref(journal, query, limit, opts);
    if (results.length > 0) return { results, source: "crossref" };
    crossrefError = "crossref returned no results";
  } catch (err) {
    crossrefError = err instanceof Error ? err.message : "crossref failed";
  }
  try {
    const results = await europepmc(journal, query, limit, opts);
    if (results.length > 0) return { results, source: "europepmc" };
    return { results: [], source: "europepmc", error: `${crossrefError}; europepmc returned no results` };
  } catch (err) {
    const e2 = err instanceof Error ? err.message : "europepmc failed";
    return { results: [], source: "europepmc", error: `${crossrefError}; ${e2}` };
  }
}
