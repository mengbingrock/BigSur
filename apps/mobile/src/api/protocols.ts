// The protocol library: the artifacts the account owns, the shared library on
// labee.online, a search over either or both, a question answered from them
// with citations, and the checks on one protocol. These ride the host prefix
// like everything else, so they read the protocols on whichever Mac is
// selected — or the box's own, when running direct; the Mac reaches the
// library on the box with the account's session.
import { apiGet, apiSend, type Target } from "./client";

/** An artifact as the server lists it. Only the fields this app shows. */
export interface Protocol {
  slug: string;
  name: string;
  description: string;
  body: string;
  artifactKind: "skill" | "protocol";
  category?: string;
  sourceLabel: string;
  updatedAt?: string;
  fileCount?: number;
  problem?: string;
  method?: string;
  application?: string;
  domains?: string[];
  keywords?: string[];
  origin?: { kind: string; id?: string; source?: string; url?: string; license?: string };
}

export type Scope = "mine" | "library" | "all";
export type Grain = "section" | "step" | "summary";

/** One search hit, from either pool. */
export interface SearchHit {
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
  shadows?: string;
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
  /** False when the box has no model credential; `answer` is then empty. */
  available: boolean;
  confidence: number | null;
}

export interface IndexStatus {
  total: number;
  indexed: number;
  pending: number;
  model: string;
  /** False when no credential resolves — search is then lexical, not semantic. */
  available: boolean;
  error: string | null;
}

export interface LibraryProtocol {
  id: string;
  source: string;
  sourceUrl: string;
  license: string;
  title: string;
  description: string;
  category?: string;
  domains: string[];
  keywords: string[];
  problem?: string;
  method?: string;
  application?: string;
  body: string;
}

export interface LintFinding {
  ruleId: string;
  severity: "warn" | "halt";
  path: string;
  message: string;
  excerpt: string;
}
export interface ReviewFinding {
  path: string;
  class: "operation" | "reagent" | "parameter";
  message: string;
  suggestion: string;
  confidence: number;
  excerpt: string;
}

export const LIBRARY_PREFIX = "library:";
export const isLibrarySlug = (slug: string) => slug.startsWith(LIBRARY_PREFIX);
export const libraryIdOf = (slug: string) => (isLibrarySlug(slug) ? slug.slice(LIBRARY_PREFIX.length) : slug);

/** "Reaction › step 3", "Materials", or "" for a summary match. */
export function whereLabel(h: { heading: string; path: string; grain: Grain }): string {
  if (h.grain === "summary") return "";
  if (h.grain === "step" && h.path) return h.heading ? `${h.heading} › step ${h.path.split(".").pop()}` : `step ${h.path.split(".").pop()}`;
  return h.heading;
}

export const listProtocols = async (t: Target): Promise<Protocol[]> => {
  const r = await apiGet<{ skills: Protocol[] }>(t, "/api/skills");
  return r.skills.filter((s) => s.artifactKind === "protocol");
};

export const getProtocol = (t: Target, slug: string) =>
  apiGet<{ skill: Protocol }>(t, `/api/skills/${encodeURIComponent(slug)}`);

export const searchProtocols = (t: Target, q: string, scope: Scope = "mine", limit = 30) =>
  apiGet<{ mode: "semantic" | "lexical"; hits: SearchHit[]; libraryReachable?: boolean }>(
    t,
    `/api/skills/search?kind=protocol&scope=${scope}&limit=${limit}&q=${encodeURIComponent(q)}`,
  );

export const askProtocols = (t: Target, q: string, scope: Scope = "mine") =>
  apiSend<AskResult>(t, "POST", "/api/skills/ask", { q, kind: "protocol", scope });

export const indexStatus = (t: Target) => apiGet<IndexStatus>(t, "/api/skills/index/status");

export const getLibraryProtocol = (t: Target, id: string) =>
  apiGet<{ protocol: LibraryProtocol }>(t, `/api/library/${encodeURIComponent(id)}`);

export const saveFromLibrary = (t: Target, id: string, category?: string) =>
  apiSend<{ skill: Protocol; already: boolean }>(t, "POST", "/api/library/import", { id, ...(category ? { category } : {}) });

export const lintProtocol = (t: Target, slug: string) =>
  apiSend<{ findings: LintFinding[]; halts: number; warns: number }>(t, "POST", `/api/skills/${encodeURIComponent(slug)}/lint`);

export const reviewProtocol = (t: Target, slug: string) =>
  apiSend<{ findings: ReviewFinding[]; steps: number; available: boolean }>(t, "POST", `/api/skills/${encodeURIComponent(slug)}/review`);
