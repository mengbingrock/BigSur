// Shapes and small helpers for protocol search across the two pools — the
// person's own protocols and the shared library — as the server returns them.

export type Scope = "mine" | "library" | "all";
export type Grain = "section" | "step" | "summary";

export interface UnifiedHit {
  pool: "mine" | "library";
  /** Own protocol: its slug. Library protocol: "library:<id>". */
  slug: string;
  id?: string;
  name: string;
  score: number;
  heading: string;
  snippet: string;
  path: string;
  grain: Grain;
  source?: string;
  url?: string;
  license?: string;
  category?: string;
  /** Set on an own protocol saved from the library: the original's id. */
  shadows?: string;
}

export interface SearchResponse {
  mode: "semantic" | "lexical";
  hits: UnifiedHit[];
  /** False when the library on labee.online could not be reached. */
  libraryReachable?: boolean;
}

export interface Citation {
  n: number;
  slug: string;
  name: string;
  heading: string;
  quote: string;
  path: string;
  grain: Grain;
  pool: "mine" | "library";
  source?: string;
  url?: string;
  license?: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  available: boolean;
  confidence: number | null;
}

const LIBRARY_PREFIX = "library:";

export function isLibrarySlug(slug: string): boolean {
  return slug.startsWith(LIBRARY_PREFIX);
}

export function libraryIdOf(slug: string): string {
  return isLibrarySlug(slug) ? slug.slice(LIBRARY_PREFIX.length) : slug;
}

/** "Reaction › step 3", "Materials", or "" for a summary match. */
export function whereLabel(hit: { heading: string; path: string; grain: Grain }): string {
  if (hit.grain === "summary") return "";
  if (hit.grain === "step" && hit.path) {
    const n = hit.path.split(".").pop();
    return hit.heading ? `${hit.heading} › step ${n}` : `step ${n}`;
  }
  return hit.heading;
}

/** How to word a confidence, when there is one. */
export function confidenceLabel(c: number | null): { text: string; low: boolean } | null {
  if (c === null) return null;
  const pct = Math.round(c * 100);
  if (c < 0.5) return { text: `Low confidence (${pct}%) — check the source`, low: true };
  return { text: `Confidence ${pct}%`, low: false };
}
