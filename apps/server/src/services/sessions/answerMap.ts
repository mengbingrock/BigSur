// Map what a person said onto the agent's pending AskUserQuestion
// (docs/siri-design.md §3.3): an option's label, its ordinal ("the second
// one"), yes/no for a two-option question, else free text through "Other".
// One implementation for Siri, the notification action and in-app voice.
import type { AskUserAnswer, AskUserQuestionItem } from "@labee/session-core";

const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, one: 1,
  second: 2, "2nd": 2, two: 2,
  third: 3, "3rd": 3, three: 3,
  fourth: 4, "4th": 4, four: 4,
  fifth: 5, "5th": 5, five: 5,
  last: -1,
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function pickOption(q: AskUserQuestionItem, spoken: string): string | null {
  const text = norm(spoken);
  const labels = q.options.map((o) => o.label);
  // Exact label, then a label contained in the utterance, then an utterance
  // contained in a label ("rubric" → "LLM rubric").
  const exact = labels.find((l) => norm(l) === text);
  if (exact) return exact;
  const contained = labels.filter((l) => text.includes(norm(l)));
  if (contained.length === 1) return contained[0]!;
  const containing = labels.filter((l) => norm(l).includes(text) && text.length >= 3);
  if (containing.length === 1) return containing[0]!;
  // Ordinals: "the second one", "option 2", "number two".
  const words = text.split(" ");
  for (const w of words) {
    const n = ORDINALS[w] ?? (/^\d+$/.test(w) ? Number(w) : undefined);
    if (n === undefined) continue;
    const idx = n === -1 ? labels.length - 1 : n - 1;
    if (idx >= 0 && idx < labels.length) return labels[idx]!;
  }
  // Yes / no on a two-option question: yes is the first option.
  if (labels.length === 2) {
    if (/^(yes|yeah|yep|sure|ok|okay|go ahead|approve|do it)\b/.test(text)) return labels[0]!;
    if (/^(no|nope|nah|reject|don t|do not)\b/.test(text)) return labels[1]!;
  }
  return null;
}

/** Answers for every question in the prompt. A single utterance answers the
 *  first question; with several questions the same utterance is tried on
 *  each, and whatever does not match becomes free text. */
export function mapSpokenAnswer(questions: AskUserQuestionItem[], spoken: string): { answers: AskUserAnswer[]; matched: boolean } {
  const text = spoken.trim();
  let matched = false;
  const answers = questions.map((q) => {
    const label = pickOption(q, text);
    if (label) matched = true;
    return { question: q.question, answer: label ?? text };
  });
  return { answers, matched };
}
