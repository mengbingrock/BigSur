import { DatabaseSync } from "node:sqlite";
import { spec, Ctx, walk, readJson } from "./interp.mjs";
const db = new DatabaseSync("/Users/martin/Git/BigSur/data/labee.sqlite");
const RID = "run_678864fbbc87eae767";
const rows = db.prepare(
  "SELECT stage, role, model, cost_usd, status, started_at FROM research_tasks WHERE run_id=? ORDER BY started_at, id"
).all(RID);

let bad = 0;
const say = (o, m) => { if (!o) bad++; console.log(`  ${o ? "PASS" : "FAIL"}  ${m}`); };

console.log("CHECK A — role coverage");
const dbRoles = [...new Set(rows.map((r) => r.role))];
say(dbRoles.every((r) => spec.roles[r]), `all ${dbRoles.length} executed roles are declared: ` +
    (dbRoles.filter((r) => !spec.roles[r]).join(",") || "none missing"));
const onGraph = Object.keys(spec.roles).filter((r) => !spec.roles[r].offGraph);
console.log(`  NOTE  declared but never executed: ${onGraph.filter((r) => !dbRoles.includes(r)).join(", ") || "none"}`);

console.log("\nCHECK B — model routing (spec tier vs research_tasks.model)");
const TIER = { haiku: "haiku", sonnet: "sonnet", opus: "opus" };
for (const role of dbRoles) {
  const want = spec.roles[role].model;
  const got = [...new Set(rows.filter((r) => r.role === role).map((r) => r.model))];
  say(got.length === 1 && got[0] === TIER[want], `${role}: declared ${want}, ran ${got.join("/")}`);
}

console.log("\nCHECK C — step ordering (observed stage order is a legal walk)");
const stageSeq = [];
for (const r of rows) if (stageSeq.at(-1) !== r.stage) stageSeq.push(r.stage);
const declared = spec.steps.filter((s) => s.seq).map((s) => s.seq.name);
say(JSON.stringify(stageSeq) === JSON.stringify(declared),
    `observed [${stageSeq}] vs declared [${declared}]`);

console.log("\nCHECK D — per-role invocation counts vs what the declared graph implies");
const n = (r) => rows.filter((x) => x.role === r).length;
const counts = Object.fromEntries(dbRoles.map((r) => [r, n(r)]));
say(counts.direction_auditor === 3, `direction_auditor = ${counts.direction_auditor} (interpreter predicted 3)`);
say(counts.librarian === 3, `librarian = ${counts.librarian} (interpreter predicted 1 + 2 refresh = 3)`);
say(counts.ideator === 2, `ideator = ${counts.ideator} (interpreter predicted 1 + 1 refill = 2)`);
say(counts.critic === 2, `critic = ${counts.critic} (writer loop ran 2 rounds)`);
// Drive the SPEC's writer loop and compare its emissions to the database.
const defaults = Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, v.default]));
const wctx = new Ctx(defaults);
wctx.facts.prevFlagCount = Infinity;
await walk(spec.steps.find((x) => x.seq?.name === "write").seq.body[1], wctx, async (nd, c) => {
  const r = c.scope.round;
  if (nd.type === "plugin") {
    const g = readJson(`stage3/ground/round${r}.json`);
    c.facts.prevFlagCount = c.facts.flagCount ?? Infinity;
    c.facts.flagCount = g.flags.length;
    return { ground: g };
  }
  if (nd.role === "critic") {
    const cr = readJson(`stage3/critic/round${r}.json`);
    c.facts.flagCount = (c.facts.flagCount ?? 0) + (cr.issues?.length ?? 0);
    return { critique: cr };
  }
  return {};
});
const emitted = (role) => wctx.trace.filter((t) => t.kind === "task" && t.role === role).length;
for (const role of ["critic", "resolver"]) {
  const dbn = rows.filter((r) => r.role === role && r.stage === "write").length;
  say(emitted(role) === dbn, `write stage ${role}: spec emits ${emitted(role)}, DB recorded ${dbn}`);
}

console.log("\nCHECK E — cost attribution");
const total = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
say(Math.abs(total - 21.78) < 0.01, `sum(cost_usd) = $${total.toFixed(2)} vs reported $21.78 over ${rows.length} tasks`);
say(rows.every((r) => r.status === "succeeded"), `all ${rows.length} tasks succeeded`);

console.log(`\n  ${bad} failed`);
