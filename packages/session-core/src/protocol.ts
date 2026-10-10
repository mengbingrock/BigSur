// Turn a protocol's markdown into the frozen step snapshot a run carries
// (docs/protocol-run-design.md §2.1). Pure text work, no model: a quantity in
// the snapshot is always the protocol's own number, and a step with no number
// for something has none. Siri reads `say`; the app shows `text`. Shared by
// the server (which freezes the snapshot) and the app (which previews it).

/** FNV-1a over the text, 16 hex chars: enough to tell "changed" from "same". */
function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export interface Amount {
  /** The number as written ("5", "0.2-0.5", "10"). */
  qty: string;
  /** Canonical unit ("µL", "mL", "°C", "%", "min" …). */
  unit: string;
  /** What it applies to, when the sentence says ("TSS", "culture volume"). */
  of: string | null;
  /** A proportion of something else (percent, "x" multiples), not an absolute. */
  ratio: boolean;
}

export interface StepTimer {
  seconds: number;
  /** Spoken range when the text gave one ("10 to 15 minutes"). */
  label: string;
}

export interface Step {
  n: number;
  /** The protocol's words, verbatim, sub-bullets joined on new lines. */
  text: string;
  /** Spoken form: units expanded, ranges kept. */
  say: string;
  /** The protocol's own note that names this step, if any. */
  note: string | null;
  amounts: Amount[];
  timer: StepTimer | null;
}

export interface Material {
  name: string;
  /** The amount next to it, when the materials list or table gave one. */
  amount: Amount | null;
  /** The line as written. */
  text: string;
}

export interface BaseQuantity {
  qty: number;
  unit: string;
  /** The phrase it was found in. */
  text: string;
}

export interface ProtocolSnapshot {
  steps: Step[];
  materials: Material[];
  /** A volume/mass the procedure is written for, for scaling (design §4.2). */
  base: BaseQuantity | null;
  /** True when no numbered list was found and paragraphs were used instead. */
  loose: boolean;
  /** Content hash, so a run can say whether the protocol changed under it. */
  hash: string;
  /** Which heading the steps came from. */
  section: string | null;
}

// --- units --------------------------------------------------------------------

/** Written form → canonical unit. */
const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(µl|ul|μl|microlit(?:er|re)s?)$/i, "µL"],
  [/^(ml|millilit(?:er|re)s?)$/i, "mL"],
  [/^(l|lit(?:er|re)s?)$/i, "L"],
  [/^(µg|ug|μg|microgram(?:s)?)$/i, "µg"],
  [/^(mg|milligram(?:s)?)$/i, "mg"],
  [/^(ng|nanogram(?:s)?)$/i, "ng"],
  [/^(g|gram(?:s)?)$/i, "g"],
  [/^(µm|um|μm)$/i, "µM"],
  [/^(mm)$/i, "mM"],
  [/^(nm)$/i, "nM"],
  [/^(m)$/, "M"],
  [/^(%|percent)$/i, "%"],
  [/^(rpm)$/i, "rpm"],
  [/^(×g|xg|x g)$/i, "×g"],
  [/^(°c|c|celsius|degrees?(?: c| celsius)?)$/i, "°C"],
  [/^(min|mins|minutes?)$/i, "min"],
  [/^(h|hr|hrs|hours?)$/i, "h"],
  [/^(s|sec|secs|seconds?)$/i, "s"],
  [/^(bp)$/i, "bp"],
  [/^(kb)$/i, "kb"],
  [/^(v|volts?)$/i, "V"],
  [/^(u\/µl|u\/ul|u\/μl)$/i, "U/µL"],
  [/^(x|×|fold)$/i, "×"],
];

const SPOKEN_UNIT: Record<string, [string, string]> = {
  "µL": ["microlitre", "microlitres"],
  mL: ["millilitre", "millilitres"],
  L: ["litre", "litres"],
  "µg": ["microgram", "micrograms"],
  mg: ["milligram", "milligrams"],
  ng: ["nanogram", "nanograms"],
  g: ["gram", "grams"],
  "µM": ["micromolar", "micromolar"],
  mM: ["millimolar", "millimolar"],
  nM: ["nanomolar", "nanomolar"],
  M: ["molar", "molar"],
  "%": ["percent", "percent"],
  rpm: ["rpm", "rpm"],
  "×g": ["times g", "times g"],
  "°C": ["degrees", "degrees"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  s: ["second", "seconds"],
  bp: ["base pairs", "base pairs"],
  kb: ["kilobases", "kilobases"],
  V: ["volt", "volts"],
  "U/µL": ["units per microlitre", "units per microlitre"],
  "×": ["times", "times"],
};

function canonicalUnit(raw: string): string | null {
  const r = raw.trim();
  for (const [re, unit] of UNIT_ALIASES) if (re.test(r)) return unit;
  return null;
}

/** A number or a range, followed by a unit word. Groups: qty, unit. */
const QTY_RE =
  /(?<![\w.])(\d+(?:[.,]\d+)?(?:\s?(?:-|–|to)\s?\d+(?:[.,]\d+)?)?)\s?(µl|ul|μl|microlit(?:er|re)s?|ml|millilit(?:er|re)s?|µg|ug|μg|microgram(?:s)?|mg|milligram(?:s)?|ng|nanogram(?:s)?|µm|um|μm|mm|nm|%|percent|rpm|×g|xg|x g|°c|celsius|degrees?(?: c| celsius)?|mins?|minutes?|hrs?|hours?|secs?|seconds?|bp|kb|volts?|u\/µl|u\/ul|u\/μl|fold|[cgshlmvx×])(?![\w])/gi;

const RANGE_SPLIT = /\s?(?:-|–|to)\s?/;

/** "10-15" → [10, 15]; "5" → [5, 5]. */
export function rangeOf(qty: string): [number, number] {
  const parts = qty.split(RANGE_SPLIT).map((p) => Number(p.replace(",", ".")));
  const a = parts[0] ?? 0;
  const b = parts.length > 1 ? (parts[1] ?? a) : a;
  return [a, b];
}

export function spokenNumber(qty: string): string {
  return qty.replace(RANGE_SPLIT, " to ").replace(",", ".");
}

export function spokenUnit(unit: string, qty: string): string {
  const [one, many] = SPOKEN_UNIT[unit] ?? [unit, unit];
  const [a, b] = rangeOf(qty);
  return a === 1 && b === 1 ? one : many;
}

// --- amounts ------------------------------------------------------------------

/** Words that never name a material. */
const STOP = new Set([
  "at", "for", "to", "in", "on", "the", "a", "an", "and", "or", "of", "with", "into",
  "per", "each", "about", "roughly", "then", "until", "from", "by", "as", "is", "are",
]);

/** The noun phrase a quantity applies to: "5 µL of T4 ligase" → "T4 ligase";
 *  "TSS at 10%" → "TSS"; "100 µL into the tubes" → null. */
function subjectFor(sentence: string, matchIndex: number, matchLength: number, ratio: boolean): string | null {
  const after = sentence.slice(matchIndex + matchLength);
  const ofMatch = after.match(/^\s*of\s+(?:the\s+)?([A-Za-z0-9][\w%.'-]*(?:\s+[A-Za-z0-9][\w%.'-]*){0,3})/);
  const before = sentence.slice(0, matchIndex).trim();
  const beforeMatch = before.match(/([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,2})\s+(?:at|to|in|with)$/);
  // "TSS at 10% of the culture volume": a ratio's subject is what comes
  // before it; the "of" phrase is what it is a proportion of.
  if (ratio && beforeMatch) {
    const c = clipTail(beforeMatch[1]!);
    if (c) return c;
  }
  if (ofMatch) return clip(ofMatch[1]!);
  if (beforeMatch) {
    const c = clipTail(beforeMatch[1]!);
    if (c) return c;
  }
  // "2.5 ul buffer" / "1 ul DMSO": a bare noun right after the unit.
  const bare = after.match(/^\s+(?!of\b|at\b|for\b|to\b|in\b|on\b|into\b|per\b|and\b|or\b|until\b|then\b)([A-Z][\w'-]*(?:\s+[a-z][\w'-]*){0,1})/);
  if (bare) return clip(bare[1]!);
  return null;
}

function clip(phrase: string): string {
  const out: string[] = [];
  for (const w of phrase.split(/\s+/)) {
    const bare = w.replace(/[.,;:]+$/, "");
    if (STOP.has(bare.toLowerCase())) {
      if (out.length) break;
      continue;
    }
    out.push(bare);
    if (/[.,;:]$/.test(w)) break;
  }
  return out.join(" ");
}

/** The noun phrase at the END of a run of words: "Resuspend in TSS" → "TSS". */
function clipTail(phrase: string): string {
  const words = phrase.split(/\s+/).map((w) => w.replace(/[.,;:]+$/, ""));
  let start = 0;
  words.forEach((w, i) => {
    if (STOP.has(w.toLowerCase())) start = i + 1;
  });
  return words.slice(start).join(" ");
}

export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  for (const sentence of text.split(/(?<=[.;])\s+|\n/)) {
    for (const m of sentence.matchAll(QTY_RE)) {
      const qty = m[1]!;
      const unit = canonicalUnit(m[2]!);
      if (!unit) continue;
      // "7 x 10 cm" is a dimension, not a multiple.
      if (unit === "×" && /^\s*\d/.test(sentence.slice(m.index! + m[0].length))) continue;
      const ratio = unit === "%" || unit === "×";
      const of = subjectFor(sentence, m.index!, m[0].length, ratio);
      out.push({ qty, unit, of: of || null, ratio });
    }
  }
  return out;
}

const DURATION_UNITS = new Set(["s", "min", "h"]);

export function extractTimer(text: string): StepTimer | null {
  for (const a of extractAmounts(text)) {
    if (!DURATION_UNITS.has(a.unit)) continue;
    const [lo] = rangeOf(a.qty);
    const mult = a.unit === "h" ? 3600 : a.unit === "min" ? 60 : 1;
    const seconds = Math.round(lo * mult);
    if (seconds <= 0) continue;
    return { seconds, label: `${spokenNumber(a.qty)} ${spokenUnit(a.unit, a.qty)}` };
  }
  return null;
}

/** Spoken form of a step: units expanded, ranges as "to", symbols spelled. */
export function spokenForm(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/(?<![\w])-(\d+)\s?(°c|c)\b/gi, "minus $1 $2")
    .replace(QTY_RE, (whole, qty: string, unitRaw: string) => {
      const unit = canonicalUnit(unitRaw);
      if (!unit) return whole;
      if (unit === "×") return whole;
      return `${spokenNumber(qty)} ${spokenUnit(unit, qty)}`;
    })
    .replace(/\bOD600\b/g, "OD six hundred")
    .replace(/\bddH2O\b/gi, "double-distilled water")
    .replace(/\s+/g, " ")
    .trim();
}

// --- sections -----------------------------------------------------------------

interface Section {
  heading: string;
  body: string;
}

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section = { heading: "", body: "" };
  for (const line of markdown.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) {
      if (current.heading || current.body.trim()) out.push(current);
      current = { heading: h[1]!, body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.heading || current.body.trim()) out.push(current);
  return out;
}

const STEP_HEADINGS = /^(procedure|steps?|method|protocol|cycling|reaction|workflow)\b/i;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET = /^\s+[-*•]\s+(.*)$/;

interface RawStep {
  n: number;
  lines: string[];
}

/** Numbered items with their indented continuation and sub-bullets. */
function numberedList(body: string): RawStep[] {
  const steps: RawStep[] = [];
  let cur: RawStep | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(NUMBERED);
    if (m) {
      cur = { n: steps.length + 1, lines: [m[2]!.trim()] };
      steps.push(cur);
      continue;
    }
    if (!cur || !line.trim()) continue;
    const b = line.match(BULLET);
    if (b) {
      cur.lines.push(`- ${b[1]!.trim()}`);
      continue;
    }
    if (/^\s{2,}\S/.test(line)) {
      const last = cur.lines.length - 1;
      cur.lines[last] = `${cur.lines[last]} ${line.trim()}`;
      continue;
    }
    // Unindented prose after the list: the list is over.
    cur = null;
  }
  return steps;
}

/** "TSS buffer chilled at 4 C" → "TSS buffer"; strips a leading quantity. */
function materialName(text: string): string {
  const t = text.replace(/^(one|two|three|\d+(?:[.,]\d+)?)\s+[\w%°µ/]+\s+(?:of\s+)?/i, "");
  const cut = t.split(/\s+(?:chilled|at|in|on|per|for|with)\s+|\s*\(|,/)[0] ?? t;
  return cut.replace(/\s+/g, " ").trim();
}

/** The materials list: a "Materials" section's prose and any component table. */
function materialsFrom(secs: Section[]): Material[] {
  const out: Material[] = [];
  const mat = secs.find((s) => /^materials?\b|^reagents?\b|^equipment\b/i.test(s.heading));
  if (mat) {
    const prose = mat.body.replace(/\s+/g, " ").trim();
    for (const part of prose.split(/,\s*(?:and\s+)?|\s+and\s+|;\s*/)) {
      const text = part.replace(/\.$/, "").trim();
      if (!text) continue;
      out.push({ name: materialName(text), amount: extractAmounts(text)[0] ?? null, text });
    }
  }
  for (const s of secs) {
    const rows = s.body.split("\n").filter((l) => /^\|/.test(l));
    if (rows.length < 3) continue;
    if (!/component|reagent|material|item/i.test(rows[0]!)) continue;
    for (const row of rows.slice(2)) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      out.push({ name: materialName(cells[0]!), amount: extractAmounts(cells[1]!)[0] ?? null, text: cells.join(" · ") });
    }
  }
  return out;
}

function noteFor(n: number, notes: string): string | null {
  const sentences = notes.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((s) => new RegExp(`\\bstep\\s+${n}\\b`, "i").test(s));
  return hits.length ? hits.join(" ").trim() : null;
}

/** The working volume the first steps are written for: the largest volume
 *  that names a culture, medium or reaction ("25-50 ml of fresh LB" over the
 *  "5 ml seed culture" it was grown from). */
function baseFrom(steps: Step[]): BaseQuantity | null {
  let best: BaseQuantity | null = null;
  const re =
    /(\d+(?:[.,]\d+)?(?:\s?(?:-|–|to)\s?\d+(?:[.,]\d+)?)?)\s?(ml|mL|l|L|µl|ul|mg|g)\b\s+(?:of\s+)?(?:fresh\s+)?(?:\w+\s+){0,3}(?:culture|medium|media|LB|broth|reaction|sample|cells)/g;
  for (const s of steps.slice(0, 2)) {
    for (const m of s.text.matchAll(re)) {
      const [lo, hi] = rangeOf(m[1]!);
      const qty = hi || lo;
      if (!best || qty > best.qty) best = { qty, unit: canonicalUnit(m[2]!) ?? m[2]!, text: m[0] };
    }
    if (best) return best;
  }
  return best;
}

/** Parse a protocol body (markdown without frontmatter). */
export function parseProtocol(markdown: string): ProtocolSnapshot {
  const secs = sections(markdown);
  const notesText = secs.filter((s) => /^notes?\b|^tips?\b/i.test(s.heading)).map((s) => s.body).join("\n");

  let stepSection: Section | null = null;
  let raw: RawStep[] = [];
  const preferred = secs.filter((s) => STEP_HEADINGS.test(s.heading));
  for (const s of [...preferred, ...secs]) {
    const list = numberedList(s.body);
    if (list.length > 0) {
      stepSection = s;
      raw = list;
      break;
    }
  }

  let loose = false;
  if (raw.length === 0) {
    loose = true;
    const src = preferred[0] ?? secs.find((s) => s.body.trim()) ?? null;
    stepSection = src;
    const paras = (src?.body ?? markdown)
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter((p) => p && !/^\|/.test(p) && !/^\*Adapted/.test(p));
    raw = paras.map((p, i) => ({ n: i + 1, lines: [p] }));
  }

  const steps: Step[] = raw.map((r) => {
    const text = r.lines.join("\n");
    return {
      n: r.n,
      text,
      say: spokenForm(text.replace(/\n- /g, "; ")),
      note: noteFor(r.n, notesText),
      amounts: extractAmounts(text),
      timer: extractTimer(text),
    };
  });

  return {
    steps,
    materials: materialsFrom(secs),
    base: baseFrom(steps),
    loose,
    hash: contentHash(markdown),
    section: stepSection?.heading ?? null,
  };
}

/** Seconds → "4:12" / "1:02:30". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
