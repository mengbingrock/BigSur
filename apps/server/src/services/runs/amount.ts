// Tier 1 of "how much X?" (docs/protocol-run-design.md §4.2): the protocol's
// own words, matched by text, never inferred. With a scale on the run, a
// ratio gets the computed figure after the words, labelled as computed.
import type { RunRow } from "./db";
import type { Amount, Step } from "./parse";
import { rangeOf, spokenNumber, spokenUnit } from "./parse";

export interface AmountAnswer {
  found: boolean;
  /** The sentence to show / speak. Always honest when nothing was found. */
  text: string;
  /** Spoken form. */
  say: string;
  /** The step the answer came from (null for the materials list). */
  step: number | null;
  /** Present when a ratio was scaled to the run's actual quantity. */
  computed: { qty: number; unit: string; text: string } | null;
  /** Where the words came from. */
  source: "step" | "note" | "materials" | "other-step" | "none";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%µ]+/g, " ").trim();

function mentions(haystack: string, material: string): boolean {
  const h = norm(haystack);
  const m = norm(material);
  if (!m) return false;
  if (h.includes(m)) return true;
  // "TSS buffer" also answers "TSS"; "nuclease-free water" answers "water".
  const words = m.split(" ").filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => h.includes(w));
}

function sentenceWith(text: string, material: string): string | null {
  for (const s of text.split(/(?<=[.;])\s+|\n/)) if (mentions(s, material)) return s.replace(/^- /, "").trim();
  return null;
}

function amountFor(step: Step, material: string): Amount | null {
  return step.amounts.find((a) => a.of && mentions(a.of, material)) ?? null;
}

function scaled(run: RunRow, a: Amount): AmountAnswer["computed"] {
  if (!a.ratio || !run.scale) return null;
  const [lo, hi] = rangeOf(a.qty);
  const pct = a.unit === "%" ? lo / 100 : lo;
  const qty = Math.round(run.scale.actual.qty * pct * 100) / 100;
  const top = hi !== lo ? Math.round(run.scale.actual.qty * (a.unit === "%" ? hi / 100 : hi) * 100) / 100 : null;
  const unit = run.scale.actual.unit;
  const text = top ? `${qty} to ${top} ${unit}` : `${qty} ${unit}`;
  return { qty, unit, text };
}

function spokenQty(a: Amount): string {
  return `${spokenNumber(a.qty)} ${spokenUnit(a.unit, a.qty)}`;
}

export function answerAmount(run: RunRow, material: string, stepN?: number): AmountAnswer {
  const steps = run.snapshot.steps;
  const n = stepN ?? run.current;
  const step = steps.find((s) => s.n === n) ?? null;
  const say = (s: string) => s;

  const fromStep = (s: Step, source: AmountAnswer["source"]): AmountAnswer | null => {
    const a = amountFor(s, material);
    const sentence = sentenceWith(s.text, material);
    if (!a && !sentence) return null;
    const computed = a ? scaled(run, a) : null;
    const lead = `Step ${s.n}: ${sentence ?? s.text}`;
    const tail = computed ? ` For your ${run.scale!.actual.qty} ${run.scale!.actual.unit}, ${computed.text}.` : "";
    const spoken = a
      ? `Step ${s.n}: ${material}, ${spokenQty(a)}${a.ratio && a.of ? ` of ${a.of === material ? "it" : a.of}` : ""}.${
          computed ? ` For your ${run.scale!.actual.qty} ${spokenUnit(run.scale!.actual.unit, String(run.scale!.actual.qty))}, ${computed.text.replace(/ (\S+)$/, (m, u) => ` ${spokenUnit(u, String(computed.qty))}`)}.` : ""
        }`
      : `Step ${s.n} says: ${s.say}`;
    return { found: true, text: lead + tail, say: say(spoken), step: s.n, computed, source };
  };

  if (step) {
    const hit = fromStep(step, "step");
    if (hit) return hit;
    if (step.note && mentions(step.note, material)) {
      return { found: true, text: `Step ${step.n}, from the notes: ${step.note}`, say: `From the notes on step ${step.n}: ${step.note}`, step: step.n, computed: null, source: "note" };
    }
  }
  const mat = run.snapshot.materials.find((m) => mentions(m.name, material) || mentions(m.text, material));
  if (mat) {
    const amountText = mat.amount ? `${mat.amount.qty} ${mat.amount.unit}` : null;
    const text = amountText ? `Materials: ${mat.text}` : `The materials list says "${mat.text}" but gives no amount.`;
    const spoken = amountText ? `The materials list: ${mat.name}, ${spokenQty(mat.amount!)}.` : `The materials list mentions ${mat.name} but gives no amount.`;
    return { found: Boolean(amountText), text, say: spoken, step: null, computed: null, source: "materials" };
  }
  for (const s of steps) {
    if (step && s.n === step.n) continue;
    const hit = fromStep(s, "other-step");
    if (hit) return { ...hit, text: `${hit.text} (step ${s.n}, not the current one)` };
  }
  const where = step ? `in step ${step.n}` : "in this protocol";
  return {
    found: false,
    text: `The protocol doesn't give an amount of ${material} ${where}, or in the materials list.`,
    say: `The protocol doesn't give an amount of ${material} ${where}, or in the materials list.`,
    step: step?.n ?? null,
    computed: null,
    source: "none",
  };
}
