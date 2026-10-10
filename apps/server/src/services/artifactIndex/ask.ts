// Ask the library: answer a question from the protocols, with citations.
//
// Retrieval, then one chat call over the retrieved passages. The model is told
// to answer only from what it is given and to decline otherwise, because in a
// protocol library a confident wrong answer about a concentration or an
// incubation time is worse than no answer at all.
import { ensureIndexed, retrievePassages } from "./index";
import { resolveEmbedTarget } from "./embed";
import { chatComplete } from "./chat";

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
].join("\n");

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
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  /** False when no model credential resolved; `answer` is then empty. */
  available: boolean;
}

export async function askLibrary(
  question: string,
  email: string,
  opts?: { kind?: "skill" | "protocol" },
): Promise<AskResult> {
  const q = question.trim();
  if (!q) return { answer: "", citations: [], available: true };

  await ensureIndexed(email);
  const target = await resolveEmbedTarget(email);
  if (!target) return { answer: "", citations: [], available: false };

  const passages = await retrievePassages(q, email, {
    kind: opts?.kind ?? "protocol",
    limit: PASSAGE_COUNT,
  });
  if (!passages) return { answer: "", citations: [], available: false };
  if (passages.length === 0) {
    return {
      answer: "There are no protocols to answer from yet.",
      citations: [],
      available: true,
    };
  }

  const numbered = passages.map((p, i) => ({
    n: i + 1,
    name: p.name,
    heading: p.heading,
    text: p.text,
  }));
  const answer = await chatComplete(
    target,
    SYSTEM,
    JSON.stringify({ question: q, passages: numbered }),
  );
  if (answer == null) {
    return { answer: "", citations: [], available: false };
  }

  // Only return citations the answer actually used, in the order it used them,
  // so the list under the answer matches the markers in it.
  const used: Citation[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    const p = passages[n - 1];
    if (!p || used.some((c) => c.n === n)) continue;
    used.push({ n, slug: p.slug, name: p.name, heading: p.heading, quote: p.text, path: p.path, grain: p.grain });
  }
  return { answer: answer.trim(), citations: used, available: true };
}
