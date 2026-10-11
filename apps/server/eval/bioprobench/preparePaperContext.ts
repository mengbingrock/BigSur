/** Separate paper-context ablation. Run in a new directory; never rewrites
 * baseline indexes or imports task records into the corpus. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { canonicalProtocolText, paperChunks, paperProfile, paperProfiles, selectPaperPassages, taskQuery, type PaperProfile } from "./contextProfiles";

const get = (flag: string) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const source = get("--source"), output = get("--out"), selectionFile = get("--selection");
if (!source || !output || !selectionFile) throw new Error("--source --out --selection <baseline manifest or report> required; optional --manifest");
const root = path.resolve(output);
if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error("Use a new, empty output directory; existing evaluation artifacts are preserved");
fs.mkdirSync(root, { recursive: true });
process.env.LABEE_DATA_DIR = path.join(root, "app-data");
process.env.SKILLS_ROOTS = path.join(root, "skills");
process.env.LABEE_SEED_PROTOCOLS = "false";
delete process.env.LABEE_DB_PATH;
const { loadCorpus } = await import("./corpus");
const { ftsExpression } = await import("../../src/services/artifactIndex/index");
const corpus = loadCorpus(source, get("--manifest"));
const frozen = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
if (JSON.stringify(frozen.sourceAudit) !== JSON.stringify(corpus.audit)) throw new Error("Frozen baseline corpus audit differs; context-only comparison requires identical sources");
const tasks = ["PQA", "ORD", "ERR", "GEN"];
const selection: Record<string, unknown> = {};
const samples: Record<string, any[]> = {};
const checksums = { ...corpus.checksums };
// Validate all frozen inputs before constructing the indexes.
for (const task of tasks) {
  const file = `${task}_test.json`, bytes = fs.readFileSync(path.join(source, "Data", file));
  checksums[file] = createHash("sha256").update(bytes).digest("hex");
  if (checksums[file] !== frozen.checksums[file]) throw new Error(`Frozen task checksum changed: ${task}`);
  const selected = frozen.selection[task]?.selected;
  if (!Array.isArray(selected) || !selected.length || new Set(selected.map((s: any) => s.id)).size !== selected.length) throw new Error(`Invalid frozen selection: ${task}`);
  const all = new Map((JSON.parse(bytes.toString()) as any[]).map((s) => [s.id, s]));
  samples[task] = selected.map((s: any) => {
    const row = all.get(s.id);
    if (!row || row.type !== s.type || (task === "ERR" && row.is_correct !== s.is_correct)) throw new Error(`Frozen sample changed: ${s.id}`);
    return row;
  });
  selection[task] = frozen.selection[task];
}
const counts: Record<string, number> = {};
const dbs = new Map<PaperProfile, Database>();
for (const profile of Object.keys(paperProfiles) as PaperProfile[]) {
  const db = new Database(path.join(root, `paper-${profile}.sqlite`));
  // First six columns/weights exactly match the flat baseline. Offsets are
  // unindexed audit metadata and never contribute to BM25 document length.
  db.exec("PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE chunks USING fts5(protocol_id UNINDEXED,title UNINDEXED,path UNINDEXED,grain UNINDEXED,heading,text,startChar UNINDEXED,endChar UNINDEXED,tokenize='unicode61 remove_diacritics 2')");
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)");
  let count = 0;
  db.transaction(() => {
    for (const record of corpus.records) {
      for (const chunk of paperChunks(canonicalProtocolText(record), profile)) {
        insert.run(record.id, record.title, "", "section", "", chunk.text, chunk.startChar, chunk.endChar);
        count++;
      }
    }
  })();
  db.exec("INSERT INTO chunks(chunks) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE)");
  counts[profile] = count;
  dbs.set(profile, db);
  console.log(JSON.stringify({ profile, protocols: corpus.records.length, chunks: count }));
}
const jobs: any[] = [];
for (const task of tasks) {
  const profile = paperProfile(task), db = dbs.get(profile)!;
  for (const sample of samples[task]!) {
    const start = performance.now();
    const expression = ftsExpression(taskQuery(task, sample));
    const candidates = expression ? db.query("SELECT protocol_id,title,path,grain,heading,text,startChar,endChar,bm25(chunks,0,0,0,0,2,1,0,0) score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT 300").all(expression) : [];
    const passages = selectPaperPassages(candidates, task);
    // Actual Python prompt serialization is measured in run.py, without a cap.
    jobs.push({ task, variant: "paper-context", contextProfile: profile, sample, passages, retrievalMs: performance.now() - start });
  }
  console.log(JSON.stringify({ task, selected: samples[task]!.length, jobs: jobs.length }));
}
for (const db of dbs.values()) db.close();
fs.writeFileSync(path.join(root, "source-aliases.json"), JSON.stringify(corpus.aliases));
fs.writeFileSync(path.join(root, "jobs.json"), JSON.stringify(jobs));
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
  date: new Date().toISOString(), upstreamRevision: frozen.upstreamRevision,
  protocols: corpus.records.length, sourceAudit: corpus.audit, checksums, selection,
  variants: ["paper-context"], model: "claude-opus-5-5", counts,
  indexFiles: { "paper-context": ["paper-small.sqlite", "paper-large.sqlite"] },
  contextProfiles: paperProfiles, taskProfiles: Object.fromEntries(tasks.map((t) => [t, paperProfile(t)])),
  contextPolicyVersion: "paper-context-v1",
  contextPolicySource: "https://raw.githubusercontent.com/mlresearch/v306/main/assets/liu26cu/liu26cu.pdf#page=15",
  assumptions: "Fixed Unicode-code-point windows, half-open offsets into title + newline + description + newline + body (same canonical text as flat baseline). Exact splitter unspecified in paper. Whole ranked chunks including overlap; no merging, summarization, identity routing or character cap. Metadata uses unchanged runner serialization.",
  retrieval: "BM25 only, same FTS tokenizer and heading/text weights as flat, 300 candidates. PQA/ERR: 2000 characters, 400 overlap, top 5; ORD/GEN: 5000 characters, 1000 overlap, top 3. Dense/hybrid retrieval deferred.",
  split: "Frozen previous sample IDs; development context-policy comparison, not a fresh holdout",
  scope: "Context-policy reconstruction only, not original ProAgent replication. Same verified corpus and task files as baseline; no reference answers enter indexes or retrieval queries.",
  frozenSelectionSha256: createHash("sha256").update(fs.readFileSync(selectionFile)).digest("hex"),
}, null, 2));
console.log(JSON.stringify({ ready: true, root, jobs: jobs.length, counts }));
