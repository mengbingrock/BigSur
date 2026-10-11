// Protocol lint: the checks that need no model.
//
// The first verification layer — what BioProAgent calls K_p, the physical
// rule engine — is a handful of rules a person could apply with a ruler:
// every number has a unit, every reagent a step uses is listed under
// Materials, steps are numbered without gaps, no section is empty, nothing
// is physically impossible. Cheap enough to run on every save, and it catches
// the typos a model would otherwise be asked to find. `halt` is for a value
// that cannot be right; `warn` for what a person should look at.
import { allSections, allSteps, materialsOf, parseTree, type ProtocolTree } from "../protocolTree";

export type LintSeverity = "warn" | "halt";

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  /** Tree path of the step or section ("2.3", "2"), "" for the whole file. */
  path: string;
  message: string;
  /** The text the finding is about, short. */
  excerpt: string;
}

export interface LintReport {
  findings: LintFinding[];
  halts: number;
  warns: number;
}

/** Units a number may carry. Lower-case; matched after optional whitespace. */
const UNITS = [
  "%", "°c", "°", "c", "k", "ul", "µl", "ml", "l", "ug", "µg", "mg", "g", "kg", "ng", "pg",
  "mm", "um", "µm", "nm", "cm", "m", "kb", "bp", "mb", "kda", "da",
  "mm", "um", "µm", "nm", "pm", "fm", "m", "mol", "mmol", "umol", "µmol", "nmol", "pmol",
  "rpm", "rcf", "v", "kv", "ma", "a", "w", "mw",
  "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "s", "sec", "secs", "second", "seconds",
  "d", "day", "days", "week", "weeks", "x", "×", "fold", "u", "units", "unit", "od", "ph", "cycles", "cycle",
  "times", "wells", "plates", "tubes", "ml/min", "ul/min", "mg/ml", "ug/ml", "ng/ul", "u/ul", "ug/ul", "mg/l", "g/l",
  "cells", "colonies", "reactions", "rxns", "preps",
];
const UNIT_SET = new Set(UNITS);

/** Words before a number that make it a label, not a measurement. */
const LABEL_BEFORE = /\b(step|steps|day|days|option|options|figure|table|section|phase|passage|p|od|cycle|cycles|round|rounds|tube|tubes|lane|lanes|plate|plates|well|wells|x|×|#|no\.|number|version|v|pH|ph)\s*$/i;

/** A number in running text: not part of a word, an identifier, a ratio, a
 *  time, or a decimal already consumed. */
const NUMBER = /(?<![\w.:/×x-])(\d+(?:[.,]\d+)?)(?![\w.:/])/g;

function numbersWithoutUnits(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 12), start);
    const after = text.slice(end, end + 14);
    if (LABEL_BEFORE.test(before)) continue;
    // A range "30-60 s": the first number's unit comes after the second.
    const range = /^\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?\s*([^\s\d,.;:)]+)?/.exec(after);
    if (range) {
      if (range[1] && UNIT_SET.has(range[1].toLowerCase().replace(/[.,;:)]$/, ""))) continue;
      if (!range[1]) continue; // the second number is checked on its own
    }
    const unit = /^\s*([^\s\d,.;:)]+)/.exec(after)?.[1]?.toLowerCase().replace(/[.,;:)]$/, "");
    if (unit && (UNIT_SET.has(unit) || /^(?:x|×)$/.test(unit) || /^[a-z]+\/[a-z]+$/.test(unit))) continue;
    if (/^\s*[%:]/.test(after)) continue;
    if (/^\s*(?:x|×)\s*\d/.test(after)) continue; // "3.8 x 10^6"
    if (/\^\s*$/.test(before) || /^\^/.test(after)) continue; // exponents
    out.push(m[0]);
  }
  return out;
}

/** Things a step can name that belong under Materials. A small lexicon,
 *  because the alternative is a model, and this layer is the one without. */
const REAGENT = /\b(?:[a-z]+ase|buffer|medium|media|agar|agarose|broth|lb|soc|pbs|tbs|tae|tbe|te|dmem|rpmi|fbs|serum|trypsin|trizol|chloroform|phenol|isopropanol|ethanol|methanol|glycerol|lysozyme|tris|edta|nacl|kcl|mgcl2|sds|triton|tween|dmso|imidazole|ipt?g|ampicillin|kanamycin|chloramphenicol|tetracycline|streptomycin|puromycin|hygromycin|penicillin|dntps?|primers?|oligos?|plasmid|vector|insert|template|ladder|stain|dye|antibody|antibodies|bsa|milk|pei|lipofectamine|chloroquine|sucrose|glucose|yeast extract|tryptone|peptone|water)\b/gi;

function reagentsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(REAGENT)) out.add(m[0].toLowerCase());
  return out;
}

/** Physical limits. A value past one of these is a typo, not a choice. */
const LIMITS: Array<{ re: RegExp; test: (n: number) => boolean; message: string }> = [
  { re: /(-?\d+(?:\.\d+)?)\s*(?:°\s*c|°c|\bc\b|degrees)/gi, test: (n) => n > 150 || n < -200, message: "temperature outside anything a protocol can mean" },
  { re: /(\d+(?:\.\d+)?)\s*%\s*co2/gi, test: (n) => n > 20, message: "CO2 above what an incubator delivers" },
  { re: /(\d+(?:[.,]\d+)?)\s*rpm\b/gi, test: (n) => n > 30000, message: "rpm beyond any bench centrifuge" },
  { re: /(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*g\b/gi, test: (n) => n > 150000, message: "relative centrifugal force beyond an ultracentrifuge" },
  { re: /\bph\s*(\d+(?:\.\d+)?)/gi, test: (n) => n > 14 || n < 0, message: "pH outside 0–14" },
  { re: /(\d+(?:\.\d+)?)\s*%(?!\s*co2)/gi, test: (n) => n > 100, message: "a percentage over 100" },
];

const num = (s: string) => Number(s.replace(/,/g, ""));

export function lintTree(tree: ProtocolTree, opts: { materials?: readonly string[] } = {}): LintReport {
  const findings: LintFinding[] = [];
  const add = (f: LintFinding) => findings.push(f);
  const sections = allSections(tree);
  const steps = allSteps(tree);

  // -- structure -----------------------------------------------------------
  for (const s of sections) {
    if (!s.prose.trim() && s.steps.length === 0 && s.children.length === 0) {
      add({ ruleId: "empty-section", severity: "warn", path: s.path, message: `"${s.title}" has nothing in it.`, excerpt: s.title });
    }
  }
  if (sections.length > 0 && steps.length === 0) {
    add({ ruleId: "no-steps", severity: "warn", path: "", message: "No numbered steps anywhere. A protocol is a sequence; number it.", excerpt: "" });
  }
  const seen = new Map<string, string>();
  for (const { step } of steps) {
    const key = step.text.toLowerCase().replace(/\s+/g, " ").trim();
    const prev = seen.get(key);
    if (prev) add({ ruleId: "duplicate-step", severity: "warn", path: step.path, message: `Same as step ${prev}.`, excerpt: step.text.slice(0, 80) });
    else seen.set(key, step.path);
  }

  // -- numbers and units ---------------------------------------------------
  for (const { step } of steps) {
    const bare = numbersWithoutUnits(step.text);
    if (bare.length) {
      add({
        ruleId: "number-without-unit",
        severity: "warn",
        path: step.path,
        message: `${bare.length === 1 ? "A number" : "Numbers"} with no unit: ${bare.join(", ")}.`,
        excerpt: step.text.slice(0, 80),
      });
    }
    for (const limit of LIMITS) {
      for (const m of step.text.matchAll(limit.re)) {
        const n = num(m[1]!);
        if (Number.isFinite(n) && limit.test(n)) {
          add({ ruleId: "implausible-value", severity: "halt", path: step.path, message: `${m[0].trim()}: ${limit.message}.`, excerpt: step.text.slice(0, 80) });
        }
      }
    }
  }

  // -- reagents vs materials -----------------------------------------------
  const materials = opts.materials ?? materialsOf(tree);
  const used = new Map<string, string>();
  for (const { section, step } of steps) {
    if (/^materials?\b/i.test(section.title)) continue;
    for (const r of reagentsIn(step.text)) if (!used.has(r)) used.set(r, step.path);
  }
  if (materials.length > 0) {
    const listed = materials.join("\n").toLowerCase();
    for (const [r, path] of used) {
      if (r === "water") continue;
      if (!listed.includes(r)) {
        add({ ruleId: "reagent-not-in-materials", severity: "warn", path, message: `"${r}" is used here but not listed under Materials.`, excerpt: r });
      }
    }
  } else if (used.size >= 3) {
    add({ ruleId: "materials-missing", severity: "warn", path: "", message: `Steps name ${used.size} reagents but there is no Materials section.`, excerpt: [...used.keys()].slice(0, 5).join(", ") });
  }

  const halts = findings.filter((f) => f.severity === "halt").length;
  return { findings, halts, warns: findings.length - halts };
}

/** Lint a protocol's markdown body. Source numbering is checked here, since
 *  the tree renumbers by position and would hide a gap. */
export function lintProtocol(body: string): LintReport {
  const tree = parseTree(body);
  const report = lintTree(tree);
  // Gaps in the numbering as written: "1. 2. 4." A reader counts steps; a
  // skipped number is either a deleted step or a step someone forgot.
  let expected = 1;
  let sectionPath = "0";
  let si = 0;
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      expected = 1;
      si += 1;
      sectionPath = String(si);
      continue;
    }
    const m = /^(\d+)[.)]\s/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n !== expected && !(n === 1 && expected > 1)) {
      report.findings.push({
        ruleId: "step-numbering-gap",
        severity: "warn",
        path: sectionPath,
        message: `Step ${expected} is followed by step ${n} in the source.`,
        excerpt: line.slice(0, 80),
      });
      report.warns += 1;
    }
    expected = n + 1;
  }
  return report;
}
