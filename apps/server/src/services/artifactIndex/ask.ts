// Ask the library: answer a question from the protocols, with citations.
//
// Retrieval, then one chat call over the retrieved passages. The model is told
// to answer only from what it is given and to decline otherwise, because in a
// protocol library a confident wrong answer about a concentration or an
// incubation time is worse than no answer at all.
import { ensureIndexed, retrievePassages } from "./index";
import { resolveEmbedTarget } from "./embed";
import { chatComplete } from "./chat";
import { libraryPassagesAnywhere, type Scope } from "../library/federate";

/** How many passages the model sees. Enough for an answer that spans two
 *  sections, few enough to stay fast and cheap. */
const PASSAGE_COUNT = 8;

const SYSTEM = [
  "You answer questions about a scientist's own laboratory protocols.",
  "",
  "Rules:",
  "- Draw your answer only from the numbered passages given. Never add a step,",
  "  a reagent, a concentration or a time that is not written there.",
  "- Cite every claim with the passage number in square brackets, like [2].",
  "- When the passages do not contain the answer, say so plainly in one",
  "  sentence and stop. Do not guess and do not fall back on general knowledge.",
  "- Be brief. A few sentences, or a short list of steps when the question asks",
  "  how to do something.",
  "- End with one line exactly like `[CONFIDENCE: 0.8]` — your probability, 0 to 1,",
  "  that the answer is correct and complete given the passages. Low when the",
  "  passages only partly cover the question; near zero when you declined.",
].join("\n");

const CONFIDENCE = /\s*\[CONFIDENCE:\s*([01](?:\.\d+)?)\]\s*$/i;

/** Split a trailing confidence marker off an answer. Null when absent. */
export function splitConfidence(text: string): { answer: string; confidence: number | null } {
  const m = CONFIDENCE.exec(text);
  if (!m) return { answer: text.trim(), confidence: null };
  return { answer: text.slice(0, m.index).trim(), confidence: Math.min(1, Math.max(0, Number(m[1]))) };
}

export interface Citation {
  /** Passage number as it appears in the answer's [n] markers. */
  n: number;
  slug: string;
  name: string;
  heading: string;
  /** The passage text, so the UI can show what was cited. */
  quote: string;
  /** Where in the protocol: "2.3" for a step, "2" for a section, "" for the
   *  summary. Lets the UI say "Reaction › step 3" and open it. */
  path: string;
  grain: "section" | "step" | "summary";
  /** Own protocol, or the shared library. A library citation carries its
   *  source and licence, which is where the attribution the licence asks
   *  for is given. */
  pool: "mine" | "library";
  source?: string | undefined;
  url?: string | undefined;
  license?: string | undefined;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  /** False when no model credential resolved; `answer` is then empty. */
  available: boolean;
  /** The model's own 0–1 estimate that the answer is right and complete, or
   *  null when it gave none. The UI can say "low confidence — check the
   *  source"; the harness measures calibration. */
  confidence: number | null;
}

export async function askLibrary(
  question: string,
  email: string,
  opts?: { kind?: "skill" | "protocol"; scope?: Scope },
): Promise<AskResult> {
  const q = question.trim();
  if (!q) return { answer: "", citations: [], available: true, confidence: null };

  await ensureIndexed(email);
  const target = await resolveEmbedTarget(email);
  if (!target) return { answer: "", citations: [], available: false, confidence: null };

  // Passages from the person's own protocols, the shared library, or both.
  // With both, the person's own take the larger share: an answer about this
  // lab's practice should come from this lab's protocols when they have it.
  const scope: Scope = opts?.scope ?? "mine";
  const own =
    scope === "library"
      ? []
      : (await retrievePassages(q, email, { kind: opts?.kind ?? "protocol", limit: scope === "all" ? 5 : PASSAGE_COUNT })) ?? [];
  const lib = scope === "mine" ? [] : await libraryPassagesAnywhere(q, { limit: scope === "all" ? 3 : PASSAGE_COUNT, email });
  const passages: Array<{
    slug: string; name: string; heading: string; text: string; score: number; path: string;
    grain: "section" | "step" | "summary"; pool: "mine" | "library"; source?: string; url?: string; license?: string;
  }> = [
    ...own.map((p) => ({ ...p, pool: "mine" as const })),
    ...lib.map((p) => ({
      slug: `library:${p.id}`, name: p.title, heading: p.heading, text: p.text, score: p.score, path: p.path,
      grain: p.grain, pool: "library" as const, source: p.source, url: p.url, license: p.license,
    })),
  ].sort((a, b) => b.score - a.score);
  if (passages.length === 0) {
    return {
      answer: "There are no protocols to answer from yet.",
      citations: [],
      available: true,
      confidence: null,
    };
  }

  const numbered = passages.map((p, i) => ({
    n: i + 1,
    name: p.pool === "library" ? `${p.name} (library: ${p.source})` : p.name,
    heading: p.heading,
    text: p.text,
  }));
  const answer = await chatComplete(
    target,
    SYSTEM,
    JSON.stringify({ question: q, passages: numbered }),
  );
  if (answer == null) {
    return { answer: "", citations: [], available: false, confidence: null };
  }

  const { answer: text, confidence } = splitConfidence(answer);

  // Only return citations the answer actually used, in the order it used them,
  // so the list under the answer matches the markers in it.
  const used: Citation[] = [];
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    const p = passages[n - 1];
    if (!p || used.some((c) => c.n === n)) continue;
    used.push({
      n, slug: p.slug, name: p.name, heading: p.heading, quote: p.text, path: p.path, grain: p.grain, pool: p.pool,
      ...(p.pool === "library" ? { source: p.source, url: p.url, license: p.license } : {}),
    });
  }
  return { answer: text, citations: used, available: true, confidence };
}
