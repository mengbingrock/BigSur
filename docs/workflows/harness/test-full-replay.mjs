// FULL END-TO-END REPLAY.
//
// test-separation.mjs drives six control-flow subtrees. This drives the WHOLE
// spec — all six top-level steps, start to finish — and reconciles the result
// against the complete ledger of the recorded run:
//
//   * 53 rows in research_tasks (49 logical + 4 validation-repair attempts)
//   * 42 rows in research_artifacts
//   * the ordered research_events log
//
// The comparison is exhaustive, not a spot check: every task the spec emits must
// appear in the ledger in the same order, and the set of artifact paths must
// match exactly — no orphans in either direction.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spec, Ctx, walk, readJson, tree, recordedAudit, liveBranchesAt, RUN } from "./interp.mjs";

const db = new DatabaseSync("/Users/martin/Git/BigSur/data/labee.sqlite");
const RID = "run_678864fbbc87eae767";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "\n        " + d : ""}`); }
};

// ------------------------------------------------------------ ground truth --
const allTasks = db.prepare(
  "SELECT stage, role, branch, attempt FROM research_tasks WHERE run_id=? ORDER BY started_at, id",
).all(RID);
const logical = allTasks.filter((t) => t.attempt === 1);
const repairs = allTasks.filter((t) => t.attempt > 1);
const dbArtifacts = db.prepare(
  "SELECT stage, kind, rel_path FROM research_artifacts WHERE run_id=?",
).all(RID);

console.log(`ledger: ${allTasks.length} task rows = ${logical.length} logical + ${repairs.length} validation repairs`);
console.log(`        ${dbArtifacts.length} artifacts\n`);

// ------------------------------------------------------------- the oracle ---
// Supplies what each task/plugin RETURNED in the real run. Structural facts
// (how many picks, how many directions) come from the run's own artifacts.

const noteSlugs = fs.readdirSync(path.join(RUN, "stage1/notes"))
  .map((f) => f.replace(/^note_/, "").replace(/\.md$/, ""));
let slugCursor = 0;
const nextPicks = (n) =>
  Array.from({ length: n }, () => ({ refIdSlug: noteSlugs[slugCursor++ % noteSlugs.length] }));

const DIRECTIONS = [               // DB order: ewma is audited first
  { key: "predictive-ewma-forecasting" },
  { key: "vectorized-fast-rebalance" },
];

function makeOracle() {
  let investigationRound = 0, briefRound = 0;
  return async (n, c) => {
    // ---- plug-ins
    if (n.type === "plugin") {
      switch (n.id) {
        case "labee.run.persistSpec":
          return {};
        case "labee.research.citationCrawl":
          return { seeds: [1, 2, 3], candidates: Array.from({ length: 249 }, (_, i) => i) };
        case "labee.research.tier": {
          const t = readJson("stage1/filter/tiers.json");
          return {
            coreAdjacent: Array.from({ length: t.counts.core + t.counts.adjacent }),
            elitePool: Array.from({ length: 250 }),
            tiers: t,
          };
        }
        case "labee.research.selectWinner":
          return { winner: DIRECTIONS[1] };            // vectorized — the audit-passing one
        case "labee.evidence.partition":
          return { verified: readJson("stage1/brief.refs.json") };
        case "labee.eval.command":
          return { score: 0.25 };
        case "labee.pee.select": {
          const next = liveBranchesAt(c.scope.iteration + 1);
          c.facts.refillCount = next.filter((b) => b.buildsOn).length;
          return { liveBranches: next, survivors: next.filter((b) => !b.buildsOn), tree };
        }
        case "labee.research.bestRun":
          return { best: readJson("stage2/best.json") };
        case "labee.fs.copyDir":
          return {};
        case "labee.claims.ground": {
          const g = readJson(`stage3/ground/round${c.scope.round}.json`);
          c.facts.prevFlagCount = c.facts.flagCount ?? Infinity;
          c.facts.flagCount = g.flags.length;
          return { ground: g };
        }
        case "labee.claims.verify": {
          const raw = readJson(`stage3/verify/claims.round${c.scope.round}.json`);
          const claims = Array.isArray(raw) ? raw : (raw.claims ?? []);
          return { claims, blocking: claims.filter((x) => x.verdict === "blocking") };
        }
        case "labee.doc.assemble":
          return { draft: "…" };
        case "labee.doc.promote":
          return { paper: "…" };
        default:
          throw new Error(`oracle has no answer for plugin ${n.id}`);
      }
    }
    // ---- agent roles
    switch (n.role) {
      case "literature_filter": return { scores: [] };
      case "pi":                return { roundGoal: "…" };
      case "librarian":
        // investigation round 1 picked 2 papers; each targeted refresh picked 3
        return { picks: c.scope.direction ? nextPicks(3) : nextPicks(2) };
      case "researcher":        return { note: "…" };
      case "subdomain_writer":  return { proposed: DIRECTIONS };
      case "island_consolidator":
        investigationRound++;
        c.facts.unread = [];                       // breaks the investigation loop after r1
        return { directions: DIRECTIONS };
      case "direction_auditor": {
        const rec = recordedAudit(c.scope.direction.key, c.scope.round);
        return { audit: rec ?? { pass: false, literatureGaps: ["(none recorded)"] } };
      }
      case "brief_writer":      return { brief: "…", references: [] };
      case "brief_critic":
        briefRound++;
        return { critique: { pass: briefRound >= 2 } };   // converged on round 2
      case "ideator":           return { ideas: readJson("stage2/ideas.json") };
      case "solver":            return { summary: "…" };
      case "report_writer":     return { report: "…" };
      case "ablation":          return { ablations: readJson("stage2/ablations/ablations.json") };
      case "conceive":          return { representation: "…" };
      case "critic": {
        const cr = readJson(`stage3/critic/round${c.scope.round}.json`);
        c.facts.flagCount = (c.facts.flagCount ?? 0) + (cr.issues?.length ?? 0);
        return { critique: cr };
      }
      case "resolver":          return { representation: "…", draft: "…" };
      case "composer_section":  return { section: "…" };
      case "evaluator_rubric":  return { score: 0.25 };
      default:
        throw new Error(`oracle has no answer for role ${n.role}`);
    }
  };
}

// ------------------------------------------------------------- the replay ---
console.log("REPLAY — walking all of spec.steps end to end");
const ctx = new Ctx(
  { ...Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, v.default])),
    iterations: 2, branches: 2, keepK: 1, writerRounds: 2, verifyRounds: 2 },
  { evaluator: { kind: "command" }, question: "…", seeds: [1, 2, 3] },
);
ctx.facts.prevFlagCount = Infinity;
ctx.facts.unread = [1];
ctx.facts.liveBranches = liveBranchesAt(1);
ctx.facts.refillCount = 0;
ctx.facts.blocking = [{ id: "seed" }];

let replayError = null;
try {
  await walk(spec.steps, ctx, makeOracle());
} catch (e) {
  replayError = e;
}
ok("the whole spec walks to completion without error", replayError === null,
   replayError ? `${replayError.message}` : "");

// ------------------------------------------------------- task reconciliation
console.log("\nTASK LEDGER — every emitted task vs research_tasks (attempt=1)");
const emittedRoles = ctx.trace.filter((t) => t.kind === "task").map((t) => t.role);
const dbRoles = logical.map((t) => t.role);

ok(`emitted ${emittedRoles.length} tasks, ledger has ${dbRoles.length} logical tasks`,
   emittedRoles.length === dbRoles.length);

let firstDiff = -1;
for (let i = 0; i < Math.max(emittedRoles.length, dbRoles.length); i++)
  if (emittedRoles[i] !== dbRoles[i]) { firstDiff = i; break; }
ok("emitted task ORDER matches the ledger exactly", firstDiff === -1,
   firstDiff === -1 ? "" :
   `first divergence at #${firstDiff + 1}: spec emitted "${emittedRoles[firstDiff]}", ledger has "${dbRoles[firstDiff]}"\n` +
   `        spec   …${emittedRoles.slice(Math.max(0, firstDiff - 3), firstDiff + 4).join(", ")}\n` +
   `        ledger …${dbRoles.slice(Math.max(0, firstDiff - 3), firstDiff + 4).join(", ")}`);

const tally = (a) => a.reduce((m, r) => (m[r] = (m[r] ?? 0) + 1, m), {});
const te = tally(emittedRoles), td = tally(dbRoles);
const roleDiff = [...new Set([...Object.keys(te), ...Object.keys(td)])]
  .filter((r) => (te[r] ?? 0) !== (td[r] ?? 0))
  .map((r) => `${r}: spec ${te[r] ?? 0} vs ledger ${td[r] ?? 0}`);
ok("per-role invocation counts match", roleDiff.length === 0, roleDiff.join("\n        "));

// --------------------------------------------------- artifact reconciliation
console.log("\nARTIFACT LEDGER — every emitted path vs research_artifacts");
const emittedPaths = new Set(ctx.trace.filter((t) => t.kind === "artifact").map((t) => t.path));
const dbPaths = new Set(dbArtifacts.map((a) => a.rel_path));
const missing = [...dbPaths].filter((p) => !emittedPaths.has(p)).sort();
const orphan = [...emittedPaths].filter((p) => !dbPaths.has(p)).sort();

ok(`spec emits ${emittedPaths.size} distinct paths, ledger has ${dbPaths.size}`,
   emittedPaths.size === dbPaths.size);
ok("no artifact in the ledger is unproduced by the spec", missing.length === 0,
   missing.map((p) => `MISSING  ${p}`).join("\n        "));
ok("no artifact produced by the spec is absent from the ledger", orphan.length === 0,
   orphan.map((p) => `ORPHAN   ${p}`).join("\n        "));

// ------------------------------------------------------- scope propagation --
// research_tasks.branch encodes the scope each task ran under. Parse it and
// check it against the scope the interpreter resolved — this tests scope
// propagation independently of role ordering.
console.log("\nSCOPE — resolved scope vs the label recorded in research_tasks.branch");
const emittedTasks = ctx.trace.filter((t) => t.kind === "task");
const pairs = emittedTasks.map((t, i) => ({ t, db: logical[i] }));
const scopeChecks = [
  { role: "solver", parse: (b) => b.match(/^b(\d+)\.i(\d+)$/),
    get: (sc, m) => sc.branch?.id === `b${m[1]}` && sc.iteration === Number(m[2]) },
  { role: "direction_auditor", parse: (b) => [b],
    get: (sc, m) => sc.direction?.key === m[0] },
  { role: "composer_section", parse: (b) => [b],
    get: (sc, m) => String(sc.section).toLowerCase().replace(/\s+/g, "-") === m[0] },
  { role: "critic", parse: (b) => b.match(/^round(\d+)$/),
    get: (sc, m) => sc.round === Number(m[1]) },
];
for (const chk of scopeChecks) {
  const subject = pairs.filter((p) => p.db.role === chk.role);
  const bad = subject.filter((p) => {
    const m = chk.parse(p.db.branch ?? "");
    return !m || !chk.get(p.t.scope, m);
  });
  ok(`${chk.role}: all ${subject.length} tasks resolved the scope the ledger records`,
     subject.length > 0 && bad.length === 0,
     bad.map((p) => `ledger branch="${p.db.branch}" but scope=${JSON.stringify({
       branch: p.t.scope.branch?.id, iteration: p.t.scope.iteration,
       direction: p.t.scope.direction?.key, section: p.t.scope.section, round: p.t.scope.round })}`).join("\n        "));
}

// --------------------------------------------------------- what's not modelled
console.log("\nNOT MODELLED BY THE SPEC (reported, not asserted)");
console.log(`  ${repairs.length} validation-repair attempts (runStructuredTask maxAttempts=2,`);
console.log(`     a hardcoded literal; each links to its parent via parent_task_id):`);
for (const r of repairs) console.log(`       ${r.stage}/${r.role} branch=${r.branch}`);
const branchLabels = [...new Set(logical.map((t) => t.branch).filter(Boolean))];
console.log(`  ${branchLabels.length} distinct scope labels in research_tasks.branch, built by ad-hoc`);
console.log(`     string concatenation at each call site and declared nowhere:`);
console.log(`       ${branchLabels.join(", ")}`);

console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
process.exit(fail === 0 ? 0 : 1);
