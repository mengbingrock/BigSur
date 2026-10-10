// Put pasted steps in order.
//
// The BioProBench ordering task, as a feature: a person pastes steps from a
// notebook or a paper's methods and gets them back in sequence. One model
// call; the answer is a permutation, checked to be one, and the original
// order is returned when the model fails to produce one — never a partial
// shuffle.
import { chatJSON } from "./chat";
import { resolveEmbedTarget } from "./embed";

export interface OrderResult {
  /** Indices into the input, in the order the steps should run. */
  order: number[];
  /** The steps, reordered. */
  steps: string[];
  /** False when no model credential resolved; order is then the input order. */
  available: boolean;
}

const SYSTEM = [
  "You restore the order of laboratory protocol steps that have been shuffled.",
  "Given a title and a list of steps with indices, reply with the indices in the order",
  "the steps should be performed. Every index exactly once. Reason from what each step",
  "needs (a culture before a pellet, a lysate before a column, a plate before a colony).",
  'Reply as JSON: {"order":[0,2,1]}',
].join("\n");

export async function orderSteps(
  steps: readonly string[],
  email: string,
  opts: { title?: string } = {},
): Promise<OrderResult> {
  const clean = steps.map((s) => s.trim()).filter(Boolean);
  const identity = clean.map((_, i) => i);
  if (clean.length < 2) return { order: identity, steps: clean, available: true };

  const target = await resolveEmbedTarget(email);
  if (!target) return { order: identity, steps: clean, available: false };

  const answer = (await chatJSON(
    target,
    SYSTEM,
    JSON.stringify({ title: opts.title ?? "", steps: clean.map((text, index) => ({ index, text })) }),
  )) as { order?: unknown } | null;

  const proposed = Array.isArray(answer?.order) ? answer!.order.map(Number) : [];
  const isPermutation =
    proposed.length === clean.length &&
    new Set(proposed).size === clean.length &&
    proposed.every((i) => Number.isInteger(i) && i >= 0 && i < clean.length);
  const order = isPermutation ? proposed : identity;
  return { order, steps: order.map((i) => clean[i]!), available: true };
}
