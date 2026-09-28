// The protocol library: the artifacts the account owns, a search over them,
// and a question answered from them with citations. These ride the host prefix
// like everything else, so they read the protocols on whichever Mac is
// selected — or the box's own, when running direct.
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
}

export interface SearchHit {
  slug: string;
  score: number;
  /** Semantic hits carry the heading they matched under. */
  heading?: string;
  snippet?: string;
  field?: "name" | "description" | "body";
}

export interface Citation {
  n: number;
  slug: string;
  name: string;
  heading: string;
  quote: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  /** False when the box has no model credential; `answer` is then empty. */
  available: boolean;
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

export const listProtocols = async (t: Target): Promise<Protocol[]> => {
  const r = await apiGet<{ skills: Protocol[] }>(t, "/api/skills");
  return r.skills.filter((s) => s.artifactKind === "protocol");
};

export const getProtocol = (t: Target, slug: string) =>
  apiGet<{ skill: Protocol }>(t, `/api/skills/${encodeURIComponent(slug)}`);

export const searchProtocols = (t: Target, q: string, limit = 30) =>
  apiGet<{ mode: "semantic" | "lexical"; hits: SearchHit[] }>(
    t,
    `/api/skills/search?kind=protocol&limit=${limit}&q=${encodeURIComponent(q)}`,
  );

export const askProtocols = (t: Target, q: string) =>
  apiSend<AskResult>(t, "POST", "/api/skills/ask", { q, kind: "protocol" });

export const indexStatus = (t: Target) => apiGet<IndexStatus>(t, "/api/skills/index/status");
