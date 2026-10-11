/** Secondary audit: all official ORD questions with an exact source-title
 * match in the downloaded corpus, selected without consulting gold order. */
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ftsExpression } from "../../src/services/artifactIndex/index";
const args = process.argv;
const get = (name: string) => args[args.indexOf(name) + 1]!;
for (const flag of ["--base", "--source", "--out"])
  if (!args.includes(flag)) throw new Error(`${flag} required`);
const base = path.resolve(get("--base")),
  root = path.resolve(get("--out"));
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "responses"), { recursive: true });
const variants = ["flat", "legacy", "hierarchy"] as const;
const dbs = Object.fromEntries(
  variants.map((v) => {
    const file = path.join(root, `${v}.sqlite`);
    if (!fs.existsSync(file))
      fs.symlinkSync(path.join(base, `${v}.sqlite`), file);
    return [v, new Database(file, { readonly: true })];
  }),
);
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
const titles = new Set(
  dbs
    .hierarchy!.prepare("SELECT DISTINCT title FROM chunks")
    .all()
    .map((r: any) => normalize(r.title)),
);
const original = JSON.parse(
  fs.readFileSync(path.join(get("--source"), "Data/ORD_test.json"), "utf8"),
) as any[];
const selected = original.filter((r) => {
  const title = /titled '(.*)' in the correct order/.exec(r.question)?.[1];
  return title && titles.has(normalize(title));
});
const jobs: unknown[] = [];
for (const sample of selected) {
  const expression = ftsExpression(
    `${sample.question} ${sample.wrong_steps.join(" ")}`,
  );
  for (const variant of variants) {
    const start = performance.now();
    const candidates = dbs[variant]!.prepare(
      "SELECT protocol_id,title,path,grain,heading,text,bm25(chunks,0,0,0,0,2,1) score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT 300",
    ).all(expression) as any[];
    const passages: unknown[] = [];
    let size = 0;
    for (const candidate of candidates) {
      const text = JSON.stringify({
        protocol: candidate.title,
        path: candidate.path,
        heading: candidate.heading,
        text: candidate.text,
      });
      if (size + text.length > 8000) continue;
      passages.push(candidate);
      size += text.length;
      if (passages.length === 8) break;
    }
    jobs.push({
      task: "ORD",
      variant,
      sample,
      passages,
      contextChars: size,
      retrievalMs: performance.now() - start,
    });
    const saved = path.join(base, "responses", `${variant}-${sample.id}.json`);
    if (fs.existsSync(saved))
      fs.copyFileSync(
        saved,
        path.join(root, "responses", `${variant}-${sample.id}.json`),
      );
  }
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
);
fs.writeFileSync(
  path.join(root, "manifest.json"),
  JSON.stringify(
    {
      ...manifest,
      date: new Date().toISOString(),
      selection: {
        ORD: {
          available: original.length,
          sourceCovered: selected.length,
          selected: selected.map((r) => ({ id: r.id, type: r.type })),
        },
      },
      scope:
        "Secondary source-covered ORD audit: ALL official ordering questions whose exact normalized protocol title exists in the same downloaded source corpus. Selected by source availability, not reference answers. Same indexes, ranking, evidence budgets and model as the first pilot. Not directly comparable with the full BioProBench leaderboard.",
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(root, "jobs.json"), JSON.stringify(jobs));
console.log(JSON.stringify({ selected: selected.length, jobs: jobs.length }));
