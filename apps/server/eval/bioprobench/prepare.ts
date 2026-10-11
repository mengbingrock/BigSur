/** Controlled BioProBench retrieval ablation. Corpus only enters indexes;
 * held-out questions/answers never do. All artifacts stay in --out. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { canonicalProtocolText } from "./contextProfiles";
const arg = (name: string, fallback?: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const source = arg("--source");
const output = arg("--out");
if (!process.argv.includes("--source") || !process.argv.includes("--out"))
  throw new Error(
    "--source <upstream checkout with corpus files> --out <isolated directory>",
  );
const root = path.resolve(output!);
fs.mkdirSync(root, { recursive: true });
process.env.LABEE_DATA_DIR = path.join(root, "app-data");
process.env.SKILLS_ROOTS = path.join(root, "skills");
process.env.LABEE_SEED_PROTOCOLS = "false";
delete process.env.LABEE_DB_PATH;
const { loadCorpus } = await import("./corpus");
const corpus = loadCorpus(source!, arg("--manifest"));
fs.writeFileSync(path.join(root, "source-aliases.json"), JSON.stringify(corpus.aliases));
const { chunkProtocol } =
  await import("../../src/services/artifactIndex/chunk");
const { ftsExpression } =
  await import("../../src/services/artifactIndex/index");
const baselineRevision = "96384e2";
for (const [repoPath, filename] of [
  ["apps/server/src/services/artifactIndex/chunk.ts", "legacy-chunk.ts"],
  ["apps/server/src/services/protocolTree.ts", "legacy-tree.ts"],
]) {
  const text = execFileSync(
    "git",
    ["show", `${baselineRevision}:${repoPath}`],
    { encoding: "utf8" },
  ).replace('"../protocolTree"', '"./legacy-tree"');
  fs.writeFileSync(path.join(root, filename!), text);
}
const legacy = await import(path.join(root, "legacy-chunk.ts"));
const variants = ["flat", "legacy", "hierarchy"] as const;
const dbs = Object.fromEntries(
  variants.map((variant) => {
    const file = path.join(root, `${variant}.sqlite`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const db = new Database(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE chunks USING fts5(protocol_id UNINDEXED,title UNINDEXED,path UNINDEXED,grain UNINDEXED,heading,text,tokenize='unicode61 remove_diacritics 2')",
    );
    return [variant, db];
  }),
);
const inserts = Object.fromEntries(
  variants.map((v) => [
    v,
    dbs[v]!.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?)"),
  ]),
);
const checksums: Record<string, string> = { ...corpus.checksums };
let protocols = 0;
const counts: Record<string, number> = { flat: 0, legacy: 0, hierarchy: 0 };
for (const record of corpus.records) {
  const protocol = { ...record, name: record.title };
  // All variants see the same source content and purpose fields.
  const flatText = canonicalProtocolText(record);
  const flat = [];
  for (let start = 0; start < flatText.length; ) {
    const end = Math.min(start + 1800, flatText.length);
    flat.push({
      text: flatText.slice(start, end),
      heading: "",
      path: "",
      grain: "section",
    });
    if (end === flatText.length) break;
    start = end - 200;
  }
  const chunkSets = {
    flat,
    legacy: legacy.chunkProtocol(protocol),
    hierarchy: chunkProtocol(protocol),
  };
  for (const variant of variants) {
    dbs[variant]!.transaction(() => {
      for (const c of chunkSets[variant]) {
        inserts[variant]!.run(
          record.id,
          record.title,
          c.path,
          c.grain,
          c.heading,
          c.text,
        );
        counts[variant]!++;
      }
    })();
  }
  protocols++;
  if (protocols % 1000 === 0)
    console.log(JSON.stringify({ protocols, counts }));
}
for (const v of variants)
  dbs[v]!.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
const take = process.argv.includes("--per-task")
  ? Number(arg("--per-task"))
  : 30;
const rank = (id: string) =>
  createHash("sha256").update(`biopro-hierarchy-v1:${id}`).digest("hex");
const jobs: unknown[] = [];
const selection: Record<string, unknown> = {};
for (const task of process.argv.includes("--index-only") ? [] : ["PQA", "ORD"]) {
  const file = `${task}_test.json`;
  const bytes = fs.readFileSync(path.join(source!, "Data", file));
  checksums[file] = createHash("sha256").update(bytes).digest("hex");
  const samples = JSON.parse(bytes.toString()) as Array<Record<string, any>>;
  // Preselected, deterministic proportional stratification. No answer or
  // retrieval success is consulted when selecting samples.
  const groups = [...new Set(samples.map((r) => r.type))].toSorted();
  let remaining = take;
  const selected = groups.flatMap((type, i) => {
    const group = samples
      .filter((r) => r.type === type)
      .toSorted((a, b) => rank(a.id).localeCompare(rank(b.id)));
    const n =
      i === groups.length - 1
        ? remaining
        : Math.round((take * group.length) / samples.length);
    remaining -= n;
    return group.slice(0, n);
  });
  selection[task] = {
    available: samples.length,
    selected: selected.map((r) => ({ id: r.id, type: r.type })),
  };
  for (const sample of selected) {
    const query =
      task === "PQA"
        ? String(sample.question)
        : `${sample.question} ${sample.wrong_steps.join(" ")}`;
    const expression = ftsExpression(query);
    for (const variant of variants) {
      const start = performance.now();
      // Same lexical ranker and weights as production library retrieval.
      const candidates = expression
        ? dbs[variant]!.prepare(
            "SELECT protocol_id,title,path,grain,heading,text,bm25(chunks,0,0,0,0,2,1) score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT 300",
          ).all(expression)
        : [];
      const passages: unknown[] = [];
      let size = 0;
      for (const candidate of candidates as any[]) {
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
        task,
        variant,
        sample,
        passages,
        contextChars: size,
        retrievalMs: performance.now() - start,
      });
    }
  }
}
const upstreamRevision = execFileSync(
  "git",
  ["-C", source!, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
fs.writeFileSync(path.join(root, "jobs.json"), JSON.stringify(jobs));
fs.writeFileSync(
  path.join(root, "manifest.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      upstreamRevision,
      baselineRevision,
      protocols,
      sourceAudit: corpus.audit,
      sourceManifest: "version 1; all required sources checksum verified",
      counts,
      checksums,
      selection,
      variants,
      retrieval:
        "BM25 only; identical weights; up to 8 passages within 8000 serialized characters; 300 candidates",
      scope:
        "Controlled index ablation, not a full agent benchmark or full BioProBench leaderboard run. No benchmark answers, corrupted-text corrections, or generated reference protocols enter the index.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ ready: true, root, protocols, counts, jobs: jobs.length }),
);
