// The retrieval harness: a fixed set of questions over the starter protocols,
// scored so a change to chunking, ranking or prompting can be judged by a
// number rather than by feel.
//
//   hit@1 / hit@3   search returns the right protocol first / in the top 3
//   answerInTop3    for a question with a known answer, the answer's text is
//                   in one of the top three passages retrieved for Ask
//   askAnswered     Ask's reply contains the answer (fake-mode replies quote
//                   a passage, so this is a floor, not the real figure)
//
// Runs offline against the fake embedder (LABEE_EMBED_PROVIDER=fake) in CI,
// and against the real one locally for the number that matters. The fixtures
// are hand-written over the twelve bundled starters; nothing in them comes
// from a benchmark with a licence to worry about.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllSkills } from "../src/services/skills";
import { ensureIndexed, retrievePassages, search } from "../src/services/artifactIndex";
import { askLibrary } from "../src/services/artifactIndex/ask";

export interface EvalQuestion {
  id: string;
  type: "parameter" | "procedural" | "goal";
  /** The protocol's `name`, which is stable across slug schemes. */
  name: string;
  q: string;
  /** Text that must appear in the right passage / answer, when there is one. */
  answer?: string;
}

export interface EvalMiss {
  id: string;
  type: EvalQuestion["type"];
  q: string;
  want: string;
  top: string[];
  /** Which checks failed. */
  failed: Array<"hit@1" | "hit@3" | "answerInTop3" | "askAnswered">;
}

export interface EvalReport {
  total: number;
  withAnswer: number;
  hitAt1: number;
  hitAt3: number;
  answerInTop3: number;
  askAnswered: number;
  byType: Record<EvalQuestion["type"], { n: number; hitAt3: number }>;
  misses: EvalMiss[];
  mode: string;
  /** Mean |confidence − correct| over Ask answers that carried a confidence;
   *  0 is perfectly calibrated, 1 is confidently wrong. Null when Ask was
   *  not exercised or gave no confidence. */
  calibration: number | null;
}

export function loadQuestions(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/questions.json")): EvalQuestion[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as EvalQuestion[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export async function runEval(
  email: string,
  questions: EvalQuestion[],
  opts: { ask?: boolean } = {},
): Promise<EvalReport> {
  // Reading the library delivers the starters; indexing makes them searchable.
  const skills = getAllSkills(email).filter((s) => s.artifactKind === "protocol");
  await ensureIndexed(email);
  const slugByName = new Map(skills.map((s) => [s.name, s.slug]));

  const report: EvalReport = {
    total: questions.length,
    withAnswer: questions.filter((q) => q.answer).length,
    hitAt1: 0,
    hitAt3: 0,
    answerInTop3: 0,
    askAnswered: 0,
    byType: {
      parameter: { n: 0, hitAt3: 0 },
      procedural: { n: 0, hitAt3: 0 },
      goal: { n: 0, hitAt3: 0 },
    },
    misses: [],
    mode: "",
    calibration: null,
  };
  const calibration: number[] = [];

  for (const question of questions) {
    const want = slugByName.get(question.name);
    if (!want) throw new Error(`fixture names a protocol that is not in the library: ${question.name}`);
    const failed: EvalMiss["failed"] = [];
    report.byType[question.type].n += 1;

    const result = await search(question.q, email, { kind: "protocol", limit: 5 });
    report.mode = result?.mode ?? report.mode;
    const top = (result?.hits ?? []).map((h) => h.slug);
    if (top[0] === want) report.hitAt1 += 1;
    else failed.push("hit@1");
    if (top.slice(0, 3).includes(want)) {
      report.hitAt3 += 1;
      report.byType[question.type].hitAt3 += 1;
    } else failed.push("hit@3");

    if (question.answer) {
      const passages = (await retrievePassages(question.q, email, { kind: "protocol", limit: 3 })) ?? [];
      if (passages.some((p) => p.slug === want && norm(p.text).includes(norm(question.answer!)))) {
        report.answerInTop3 += 1;
      } else failed.push("answerInTop3");

      if (opts.ask) {
        const asked = await askLibrary(question.q, email, { kind: "protocol" });
        const correct = asked.available && norm(asked.answer).includes(norm(question.answer));
        if (correct) report.askAnswered += 1;
        else failed.push("askAnswered");
        if (asked.confidence !== null) calibration.push(Math.abs(asked.confidence - (correct ? 1 : 0)));
      }
    }

    if (failed.length) report.misses.push({ id: question.id, type: question.type, q: question.q, want, top: top.slice(0, 3), failed });
  }
  if (calibration.length) report.calibration = calibration.reduce((a, b) => a + b, 0) / calibration.length;
  return report;
}

export function formatReport(r: EvalReport): string {
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
  const lines = [
    `retrieval harness — ${r.total} questions, mode: ${r.mode}`,
    `  hit@1          ${pct(r.hitAt1, r.total)}  (${r.hitAt1}/${r.total})`,
    `  hit@3          ${pct(r.hitAt3, r.total)}  (${r.hitAt3}/${r.total})`,
    `  answer in top3 ${pct(r.answerInTop3, r.withAnswer)}  (${r.answerInTop3}/${r.withAnswer})`,
    `  ask answered   ${pct(r.askAnswered, r.withAnswer)}  (${r.askAnswered}/${r.withAnswer})`,
    `  calibration    ${r.calibration === null ? "n/a" : r.calibration.toFixed(2)}  (mean |confidence − correct|, lower is better)`,
    `  by type        ` +
      (Object.entries(r.byType) as Array<[string, { n: number; hitAt3: number }]>)
        .map(([t, v]) => `${t} ${pct(v.hitAt3, v.n)}`)
        .join(" · "),
  ];
  if (r.misses.length) {
    lines.push("  misses:");
    for (const m of r.misses) lines.push(`    ${m.id} [${m.failed.join(",")}] ${m.q} → got ${m.top.join(", ") || "nothing"}`);
  }
  return lines.join("\n");
}
