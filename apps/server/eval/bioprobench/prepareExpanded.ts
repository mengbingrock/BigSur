/** Fresh four-task evaluation plus the previously analyzed source-covered ORD
 * development set. Selection uses IDs/subtypes only, never gold correctness. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { ftsExpression } from "../../src/services/artifactIndex/index";
import { loadCorpus } from "./corpus";
import { taskQuery } from "./contextProfiles";
import { expandProtocolEvidence, normalizeProtocolTitle, resolveProtocolIdentity } from "../../src/services/protocolRetrieval";
const get = (flag: string, fallback = "") => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1]! : fallback;
const base = get("--base"), source = get("--source"), out = get("--out");
if (!base || !source || !out) throw new Error("--base --source --out required");
fs.mkdirSync(out, { recursive: true });
const count = Number(get("--per-task", "24"));
const reuse = get("--reuse");
const priorJobs = new Map<string, any>(reuse ? JSON.parse(fs.readFileSync(path.join(reuse, "jobs.json"), "utf8")).map((j: any) => [`${j.variant}:${j.sample.id}`, j]) : []);
const variants = get("--variants", "flat,hierarchy,expanded").split(",");
const corpus = loadCorpus(source, get("--manifest") || undefined);
const original = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
if (JSON.stringify(original.sourceAudit?.map((s: any) => [s.source, s.sha256])) !== JSON.stringify(corpus.audit.map((s) => [s.source, s.sha256])))
  throw new Error("Base indexes and source manifest differ; rebuild the indexes");
if (reuse) {
  const prior = JSON.parse(fs.readFileSync(path.join(reuse, "manifest.json"), "utf8"));
  if (JSON.stringify(prior.sourceAudit) !== JSON.stringify(original.sourceAudit)) throw new Error("Cannot reuse predictions from different source data");
}
const records = new Map(corpus.records.map((r) => [r.id, r]));
const frozen = get("--selection");
const frozenManifest = frozen ? JSON.parse(fs.readFileSync(frozen, "utf8")) : null;
const headers = [...records.values()].map(({ id, title }) => ({ id, title }));
const dbs = Object.fromEntries(["flat", "hierarchy"].map((v) => [v, new Database(path.join(base, `${v}.sqlite`), { readonly: true })]));
// Cache by protocol ID in a separate metadata table, without altering baselines.
const identityFile = path.join(out, "identity.sqlite");
if (fs.existsSync(identityFile)) fs.unlinkSync(identityFile);
const identityDb = new Database(identityFile);
identityDb.exec("CREATE TABLE IF NOT EXISTS chunks(protocol_id TEXT,title TEXT,path TEXT,grain TEXT,heading TEXT,text TEXT); CREATE INDEX IF NOT EXISTS protocol_lookup ON chunks(protocol_id)");
if (!(identityDb.query("SELECT count(*) n FROM chunks").get() as any).n) {
  identityDb.exec(`ATTACH DATABASE '${path.join(base, "hierarchy.sqlite").replaceAll("'", "''")}' AS original`);
  identityDb.exec("INSERT INTO chunks SELECT protocol_id,title,path,grain,heading,text FROM original.chunks");
}
const previous = [base, get("--covered", "/private/tmp/labee-bioprobench-covered")];
const excluded = new Set(frozen ? [] : previous.flatMap((dir) => JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).map((j: any) => j.sample.id)));
const rank = (id: string) => createHash("sha256").update(`opus-expanded-v1:${id}`).digest("hex");
const selection: Record<string, unknown> = {}, jobs: any[] = [];
const taskChecksums: Record<string, string> = {};
const development = process.argv.includes("--development");
for (const task of development ? ["ORD"] : ["PQA", "ORD", "ERR", "GEN"]) {
  const bytes = fs.readFileSync(path.join(source, "Data", `${task}_test.json`));
  taskChecksums[`${task}_test.json`] = createHash("sha256").update(bytes).digest("hex");
  const all = JSON.parse(bytes.toString()) as any[];
  let selected: any[];
  if (frozenManifest) {
    const ids = frozenManifest.selection[task]?.selected.map((s: any) => s.id);
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error(`Invalid frozen selection: ${task}`);
    selected = ids.map((id: string) => {
      const row = all.find((s) => s.id === id);
      if (!row) throw new Error(`Missing frozen sample ${id}`);
      return row;
    });
    if (frozenManifest.checksums[`${task}_test.json`] !== taskChecksums[`${task}_test.json`]) throw new Error(`Frozen task checksum changed: ${task}`);
  } else if (development) {
    selected = all.filter((s) => {
      const title = /titled '(.*)' in the correct order/.exec(s.question)?.[1];
      return title && headers.some((h) => normalizeProtocolTitle(h.title) === normalizeProtocolTitle(title));
    });
  } else {
    const eligible = all.filter((s) => !excluded.has(s.id));
    const group = (s: any) => `${s.type ?? "default"}${task === "ERR" ? `:${s.is_correct}` : ""}`;
    const groups = [...new Set(eligible.map(group))].sort();
    let remaining = count;
    selected = groups.flatMap((type, i) => {
      const items = eligible.filter((s) => group(s) === type).sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
      const take = i === groups.length - 1 ? remaining : Math.min(remaining, Math.round(count * items.length / eligible.length));
      remaining -= take;
      return items.slice(0, take);
    });
  }
  selection[task] = { available: all.length, selected: selected.map(({ id, type, is_correct }) => ({ id, type, ...(task === "ERR" ? { is_correct } : {}) })) };
  for (const sample of selected) {
    // Exactly the official visible fields; never corrected text for an incorrect
    // ERR case, reference order, error_description or GEN reference output.
    const query = taskQuery(task, sample);
    const identity = resolveProtocolIdentity(query, headers);
    const expression = ftsExpression(query);
    for (const variant of variants) {
      const prior = priorJobs.get(`${variant}:${sample.id}`);
      if (prior && (variant !== "expanded" || prior.resolvedProtocolId === identity)) {
        jobs.push(prior);
        const response = path.join(reuse, "responses", `${variant}-${sample.id}.json`);
        if (fs.existsSync(response)) {
          fs.mkdirSync(path.join(out, "responses"), { recursive: true });
          fs.copyFileSync(response, path.join(out, "responses", `${variant}-${sample.id}.json`));
        }
        continue;
      }
      const started = performance.now();
      const db = dbs[variant === "expanded" ? "hierarchy" : variant]!;
      let candidates = expression ? db.prepare("SELECT protocol_id,title,path,grain,heading,text,bm25(chunks,0,0,0,0,2,1) score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT 300").all(expression) as any[] : [];
      let passages: any[] = [], size = 0;
      if (variant === "expanded") {
        if (identity) {
          const ranked = candidates.filter((c) => c.protocol_id === identity);
          candidates = ranked.length ? ranked : identityDb.query("SELECT *,0 score FROM chunks WHERE protocol_id=? AND grain!='summary'").all(identity) as any[];
        }
        const ids = [...new Set(candidates.map((c) => c.protocol_id))];
        for (const id of ids) {
          const r = records.get(id)!;
          const seeds = candidates.filter((c) => c.protocol_id === id && c.grain !== "summary").map((c) => `${c.grain}:${c.path}`);
          const nodes = r.hierarchy ?? [];
          const evidence = expandProtocolEvidence({ id, title: r.title, nodes }, seeds.length ? seeds.slice(0, 3) : nodes.filter((n) => !n.parentId).map((n) => n.id), query, 8000 - size);
          passages.push(...evidence.map((e) => ({ ...e, protocol_id: id })));
          size += JSON.stringify(evidence).length;
          if (size >= 7800) break;
        }
      } else {
        for (const c of candidates) {
          const cost = JSON.stringify({ protocol: c.title, path: c.path, heading: c.heading, text: c.text }).length;
          if (size + cost > 8000) continue;
          passages.push(c); size += cost;
          if (passages.length === 8) break;
        }
      }
      jobs.push({ task, variant, sample, passages, contextChars: size, retrievalMs: performance.now() - started, resolvedProtocolId: variant === "expanded" ? identity : null });
    }
  }
  console.log(JSON.stringify({ task, selected: selected.length, jobs: jobs.length }));
}
if (reuse) {
  const prior = JSON.parse(fs.readFileSync(path.join(reuse, "manifest.json"), "utf8"));
  const checksums = { ...original.checksums, ...taskChecksums };
  if (JSON.stringify(prior.sourceAudit) !== JSON.stringify(original.sourceAudit) || prior.upstreamRevision !== original.upstreamRevision || Object.entries(prior.checksums).some(([file, hash]) => checksums[file] !== hash))
    throw new Error("Cannot reuse predictions from different source data");
}
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ ...original, checksums: { ...original.checksums, ...taskChecksums }, retrieval: "BM25 with 300 global candidates. Baselines: up to 8 passages / 8000 serialized characters. Expanded: explicit unique title/ID routing, 3 ranked seed nodes, source-ordered tree expansion within 8000 serialized characters; no passage-count cap. No dense vectors.", date: new Date().toISOString(), selection, variants, model: "claude-opus-5-5", ...(reuse ? { followup: "Post-hoc explicit-title precedence correction; unchanged model/prompt checkpoints reused, changed evidence reevaluated once. Original evaluation retained separately." } : {}), split: frozen ? "Frozen previous sample IDs; corpus coverage follow-up, not a fresh holdout" : development ? "root-title-matched development audit; root matches only" : "fresh deterministic stratified holdout excluding all previous pilot IDs", scope: "Four-task lexical retrieval ablation; source identity + hierarchy expansion. No real dense embeddings or end-to-end router in this experiment." }, null, 2));
fs.writeFileSync(path.join(out, "jobs.json"), JSON.stringify(jobs));
