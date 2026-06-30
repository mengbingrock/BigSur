// DuckDuckGo HTML-endpoint client.
//
// DuckDuckGo exposes two server-rendered (no-JS) search endpoints we can parse
// from a plain Node process:
//   - lite.duckduckgo.com/lite/  — minimal table markup, the most bot-tolerant
//   - html.duckduckgo.com/html/  — richer markup, used as a fallback
// Both rate-limit: when an IP looks bot-like they answer a 202 CAPTCHA
// ("select all squares containing a duck") instead of results. We try lite
// first, fall back to html, and retry each with backoff and a rotating
// browser User-Agent. When everything is rate-limited the caller still has the
// deterministic vendor search URLs to fall back on.

export interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

const ENDPOINTS = [
  "https://lite.duckduckgo.com/lite/",
  "https://html.duckduckgo.com/html/",
];
const DEFAULT_TIMEOUT_MS = 9000;
const MAX_ATTEMPTS_PER_ENDPOINT = 2;

function headers(seed: number): Record<string, string> {
  return {
    "User-Agent": USER_AGENTS[seed % USER_AGENTS.length]!,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://duckduckgo.com/",
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Decode the handful of HTML entities that show up in DuckDuckGo titles/urls. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Pull the real destination out of a DuckDuckGo result href. Result links are
 * sometimes wrapped as `/l/?uddg=<encoded-url>&...` (occasionally protocol-
 * relative) and sometimes bare absolute URLs. Returns "" when no usable URL is
 * present (e.g. an internal ad/feedback link).
 */
function unwrapHref(href: string): string {
  const decoded = decodeEntities(href);
  const m = decoded.match(/[?&]uddg=([^&]+)/);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  if (decoded.startsWith("//")) return "https:" + decoded;
  return "";
}

function push(out: RawResult[], seen: Set<string>, r: RawResult, limit: number): void {
  if (out.length >= limit || !r.url || !r.title || seen.has(r.url)) return;
  seen.add(r.url);
  out.push(r);
}

interface Anchor {
  href: string;
  text: string;
  /** Offset of the anchor in the source, for pairing with later snippets. */
  index: number;
}

/**
 * Match every `<a>` whose class list contains `cls`, regardless of attribute
 * order (DuckDuckGo's two endpoints order `href`/`class` differently), and
 * pull out its href and inner text.
 */
function matchAnchors(html: string, cls: string): Anchor[] {
  const re = new RegExp(
    `<a\\b((?:[^>]*?\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*?))>([\\s\\S]*?)<\\/a>`,
    "g",
  );
  const out: Anchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const hrefMatch = m[1]!.match(/\bhref="([^"]+)"/);
    out.push({ href: hrefMatch ? hrefMatch[1]! : "", text: m[2]!, index: m.index });
  }
  return out;
}

/** Parse the rich `html.duckduckgo.com/html/` results markup. */
export function parseHtmlResults(html: string, limit: number): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  const snippetRe =
    /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]!));

  let i = 0;
  for (const a of matchAnchors(html, "result__a")) {
    if (out.length >= limit) break;
    const idx = i++;
    push(
      out,
      seen,
      { title: stripTags(a.text), url: unwrapHref(a.href), snippet: snippets[idx] ?? "" },
      limit,
    );
  }
  return out;
}

/** Parse the minimal `lite.duckduckgo.com/lite/` table markup. */
export function parseLiteResults(html: string, limit: number): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  // Title links carry class `result-link`; the snippet sits in the following
  // `td.result-snippet`. We walk title anchors and grab the nearest snippet
  // cell that comes after each.
  const snippetRe = /<td\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets: { index: number; text: string }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push({ index: sm.index, text: stripTags(sm[1]!) });
  }
  const snippetAfter = (pos: number): string => {
    for (const s of snippets) if (s.index > pos) return s.text;
    return "";
  };

  for (const a of matchAnchors(html, "result-link")) {
    if (out.length >= limit) break;
    push(
      out,
      seen,
      { title: stripTags(a.text), url: unwrapHref(a.href), snippet: snippetAfter(a.index) },
      limit,
    );
  }
  return out;
}

export interface DdgSearchOptions {
  limit?: number;
  timeoutMs?: number;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DdgSearchResult {
  results: RawResult[];
  /** HTTP status of the last attempt. */
  status: number;
  /** Set when no results came back after all retries/endpoints. */
  error?: string;
}

/**
 * Run a single DuckDuckGo query (already including any `site:` operators),
 * trying the lite endpoint then the html endpoint, retrying each on rate-limit
 * / empty-challenge responses. Resolves with whatever results were parsed plus
 * diagnostics; never throws.
 */
export async function ddgSearch(
  query: string,
  opts: DdgSearchOptions = {},
): Promise<DdgSearchResult> {
  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastStatus = 0;
  let lastError = "";
  let seed = 0;
  for (const endpoint of ENDPOINTS) {
    const isLite = endpoint.includes("/lite");
    const url = `${endpoint}?q=${encodeURIComponent(query)}&kl=us-en`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
      if (seed > 0) await sleep(350 * Math.pow(2, attempt)); // 350ms, 700ms
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          headers: headers(seed++),
          redirect: "follow",
          signal: controller.signal,
        });
        lastStatus = res.status;
        const body = await res.text();
        const results = isLite
          ? parseLiteResults(body, limit)
          : parseHtmlResults(body, limit);
        if (results.length > 0) return { results, status: res.status };
        lastError =
          res.status === 200
            ? "no results (or rate-limited challenge page)"
            : `search returned HTTP ${res.status}`;
      } catch (err) {
        lastError =
          err instanceof Error && err.name === "AbortError"
            ? `search timed out after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : "search failed";
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { results: [], status: lastStatus, error: lastError };
}
