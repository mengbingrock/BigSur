// Protocol review: the second verification layer, with a model.
//
// What BioProAgent calls K_s, the scientific reviewer, done the way the
// BioProBench error task frames it: each step is judged in context — its
// purpose, the step before, the step after — for exactly three kinds of
// mistake. An OPERATION that is wrong or out of order; a REAGENT that is
// wrong or missing; a PARAMETER (temperature, time, concentration, volume,
// speed) inconsistent with its context or with typical practice. "Typical
// practice" is not the model's memory: it is passages retrieved from the
// person's other protocols, so the review is grounded in this lab's habits.
import { allSteps, parseTree, type Section } from "../protocolTree";
import { chatJSON } from "./chat";
import { resolveEmbedTarget } from "./embed";
import { ensureIndexed, retrievePassages } from "./index";

export type ReviewClass = "operation" | "reagent" | "parameter";

export interface ReviewFinding {
  /** The step's tree path, "2.3". */
  path: string;
  class: ReviewClass;
  /** What is wrong, in one sentence. */
  message: string;
  /** What it should probably be, when the reviewer can say. */
  suggestion: string;
  /** 0–1, the reviewer's own. */
  confidence: number;
  /** The step text, so the finding reads on its own. */
  excerpt: string;
}

export interface ReviewReport {
  findings: ReviewFinding[];
  /** How many steps were looked at. */
  steps: number;
  /** False when no model credential resolved; findings are then empty. */
  available: boolean;
}

/** Steps per model call. */
const BATCH = 25;
/** Evidence passages per step. */
const EVIDENCE = 3;

const SYSTEM = [
  "You review a laboratory protocol one step at a time, as an experienced bench scientist.",
  "For each step you are given its purpose (the protocol and section it serves), the step",
  "before it, the step after it, and passages of typical practice taken from this lab's",
  "other protocols.",
  "",
  "Look for exactly three kinds of error:",
  "- operation: the action is wrong, or out of order given its neighbours;",
  "- reagent: a reagent is wrong, missing, or inconsistent with the rest of the protocol;",
  "- parameter: a temperature, time, concentration, volume, speed or ratio is inconsistent",
  "  with its context or with typical practice — pay meticulous attention to numbers.",
  "",
  "Worked example. Step: \"Maintain hESCs in a humidified incubator (37 C, 10% CO2).\"",
  "Prior: \"Preparation of vitronectin-coated plates.\" Next: \"Daily medium exchange.\"",
  "Typical practice: \"...incubator at 37 C, 5% CO2...\". Finding: class parameter —",
  "10% CO2 is double the usual 5% and would shift the medium's pH; suggestion 5% CO2.",
  "",
  "Report only genuine problems; a step that is fine gets no finding. Never invent a",
  "value the evidence does not support. Reply as JSON:",
  '{"findings":[{"path","class","message","suggestion","confidence"}]}',
].join("\n");

interface StepContext {
  path: string;
  text: string;
  purpose: string;
  prior: string;
  next: string;
  evidence: string[];
}

function purposeOf(name: string, description: string, section: Section): string {
  const where = section.heading ? ` — ${section.heading}` : "";
  return `${name}${where}. ${description}`.trim();
}

/**
 * Review a protocol's markdown. `name` and `description` give each step its
 * purpose; `email` scopes the evidence to that person's library; `excludeSlug`
 * keeps the protocol under review from being its own evidence.
 */
export async function reviewProtocol(
  body: string,
  opts: { name: string; description?: string; email: string; excludeSlug?: string },
): Promise<ReviewReport> {
  const tree = parseTree(body);
  const steps = allSteps(tree);
  if (steps.length === 0) return { findings: [], steps: 0, available: true };

  const target = await resolveEmbedTarget(opts.email);
  if (!target) return { findings: [], steps: steps.length, available: false };
  await ensureIndexed(opts.email);

  // Evidence is gathered per section, not per step: the steps of one section
  // share a context, and one retrieval per section keeps this cheap.
  const evidenceBySection = new Map<string, string[]>();
  for (const { section } of steps) {
    if (evidenceBySection.has(section.path)) continue;
    const query = `${opts.name} ${section.heading}`.trim();
    // Retrieve well past what is kept: the protocol under review matches its
    // own query best and can fill the top slots on its own, and it is filtered
    // out below.
    const passages = (await retrievePassages(query, opts.email, { kind: "protocol", limit: 24 })) ?? [];
    evidenceBySection.set(
      section.path,
      passages
        .filter((p) => p.slug !== opts.excludeSlug && p.grain !== "summary")
        .slice(0, EVIDENCE)
        .map((p) => `${p.name} › ${p.heading}: ${p.text}`),
    );
  }

  const contexts: StepContext[] = steps.map(({ section, step }, i) => ({
    path: step.path,
    text: step.text,
    purpose: purposeOf(opts.name, opts.description ?? "", section),
    prior: steps[i - 1]?.step.text ?? "(start of protocol)",
    next: steps[i + 1]?.step.text ?? "(end of protocol)",
    evidence: evidenceBySection.get(section.path) ?? [],
  }));

  const findings: ReviewFinding[] = [];
  const byPath = new Map(steps.map(({ step }) => [step.path, step.text]));
  for (let i = 0; i < contexts.length; i += BATCH) {
    const batch = contexts.slice(i, i + BATCH);
    const answer = (await chatJSON(target, SYSTEM, JSON.stringify({ steps: batch }))) as {
      findings?: Array<{ path?: string; class?: string; message?: string; suggestion?: string; confidence?: number }>;
    } | null;
    for (const f of answer?.findings ?? []) {
      const path = String(f.path ?? "");
      const excerpt = byPath.get(path);
      if (!excerpt) continue;
      const cls = f.class === "operation" || f.class === "reagent" || f.class === "parameter" ? f.class : null;
      if (!cls || !f.message?.trim()) continue;
      findings.push({
        path,
        class: cls,
        message: f.message.trim(),
        suggestion: (f.suggestion ?? "").trim(),
        confidence: Math.min(1, Math.max(0, Number(f.confidence ?? 0.5))),
        excerpt: excerpt.slice(0, 120),
      });
    }
  }
  findings.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { findings, steps: steps.length, available: true };
}
