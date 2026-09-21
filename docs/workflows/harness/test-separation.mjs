// THE REAL TEST: drive the separated spec through a generic interpreter and
// assert the emitted execution matches what the shipped engine actually did in
// run_678864fbbc87eae767.
//
// The interpreter (interp.mjs) contains zero ScientistOne knowledge. Every role
// name, loop bound, break condition, artifact path and gate comes from the YAML.
// Task/plugin RESULTS come from the recorded run's own artifacts — we are
// testing whether the declared graph reproduces the observed execution, not
// whether an LLM is deterministic.
//
// IMPORTANT: every control-flow fragment below is READ OUT OF spec.steps by
// path. Nothing is transcribed into this file. If the YAML changes, these tests
// change with it — that is what makes this a test of the spec rather than of
// the algebra.

import fs from "node:fs";
import path from "node:path";
import {
  spec, Ctx, walk, declareArtifact, readJson, tree, recordedAudit, liveBranchesAt, RUN,
} from "./interp.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const defaults = Object.fromEntries(
  Object.entries(spec.params).map(([k, v]) => [k, v.default]),
);

/**
 * Pull a node out of the real spec graph by dotted path, rooted at a STAGE NAME
 * rather than a top-level index — e.g. at("investigate.5"). Index-rooted paths
 * silently break the moment a step is added ahead of them, which is exactly
 * what happened when `labee.run.persistSpec` was prepended.
 */
function at(p) {
  const [stage, ...rest] = p.split(".");
  const seq = spec.steps.find((s) => s.seq?.name === stage);
  if (!seq) throw new Error(`no stage named "${stage}"`);
  return rest.reduce((n, k) => n[k], seq.seq.body);
}

console.log(`spec: ${spec.name} (${spec.apiVersion})`);
console.log(`roles: ${Object.keys(spec.roles).length}  artifacts: ${Object.keys(spec.artifacts).length}  plugins: ${Object.keys(spec.plugins).length}\n`);

// ============================================================ TEST 1 ========
// The direction-audit loop, TAKEN FROM THE SPEC (steps[0].seq.body[5]).
// Real run: two directions, ONE broke on pass:true after round 1, the OTHER
// exhausted maxRounds still failing. The same declared node must produce both.
console.log("TEST 1 — per-direction audit loop, driven from the investigate stage");
{
  const auditMap = at("investigate.5");
  ok("node under test is the audit map", auditMap.map?.as === "direction");

  const ctx = new Ctx(defaults);
  ctx.facts.directions = [
    { key: "vectorized-fast-rebalance" },
    { key: "predictive-ewma-forecasting" },
  ];
  await walk(auditMap, ctx, async (n, c) => {
    if (n.role === "direction_auditor") {
      const rec = recordedAudit(c.scope.direction.key, c.scope.round);
      return { audit: rec ?? { pass: false, literatureGaps: ["(no record)"] } };
    }
    // the targeted-refresh arm: the real run's librarian/researcher calls
    if (n.role === "librarian") return { picks: [] };
    return {};
  });

  const emitted = ctx.trace
    .filter((t) => t.kind === "artifact" && t.key === "direction_audit")
    .map((a) => a.path).sort();
  const actual = fs.readdirSync(path.join(RUN, "stage1/audit"))
    .map((f) => `stage1/audit/${f}`).sort();
  ok("emitted audit artifact paths == real files on disk",
     JSON.stringify(emitted) === JSON.stringify(actual),
     `\n        emitted: ${JSON.stringify(emitted)}\n        actual:  ${JSON.stringify(actual)}`);

  const breaks = ctx.trace.filter((t) => t.kind === "loopBreak");
  ok("both termination mechanisms fired (break AND maxRounds)",
     breaks.some((b) => b.reason === "break") && breaks.some((b) => b.reason === "maxRounds"),
     JSON.stringify(breaks));
  ok("direction_auditor invoked exactly 3 times (1 + 2)",
     ctx.trace.filter((t) => t.kind === "task" && t.role === "direction_auditor").length === 3);

  // the declared refresh branch must fire ONLY under the failing direction
  const refresh = ctx.trace.filter((t) => t.kind === "task" && t.role === "librarian");
  ok("targeted-refresh fired only under the failing direction",
     refresh.length > 0 && refresh.every((t) => t.scope.direction.key === "predictive-ewma-forecasting"),
     JSON.stringify(refresh.map((t) => `${t.scope.direction.key}@r${t.scope.round}`)));
  // FINDING: the branch is evaluated before the loop's break, so the final
  // failing round still fetches literature nothing will ever read.
  ok("refresh also runs on the LAST failing round (declared, and wasteful)",
     refresh.some((t) => t.scope.round === defaults.auditRoundsPerDirection),
     JSON.stringify(refresh.map((t) => t.scope.round)));
}

// ============================================================ TEST 2 ========
// The PEE loop, TAKEN FROM THE SPEC (steps[2].seq.body[1]): map over branches
// whose membership CHANGES between iterations, with mid-loop refill ideation.
// Real tree: b1,b2 @ iter1 → b1 survives → refill makes b3 (buildsOn b1) →
// b1,b3 @ iter2.
console.log("\nTEST 2 — PEE loop, driven from the discover stage");
{
  const peeLoop = at("discover.1");
  ok("node under test is the PEE iteration loop", peeLoop.loop?.as === "iteration");

  // the real run was configured branches=2, iterations=2, keepK=1
  // the real run supplied a command evaluator (the ADRS scorer)
  const ctx = new Ctx({ ...defaults, iterations: 2, branches: 2, keepK: 1 },
                      { evaluator: { kind: "command" } });
  ctx.facts.liveBranches = liveBranchesAt(1);
  ctx.facts.refillCount = 0;

  await walk(peeLoop, ctx, async (n, c) => {
    if (n.type === "plugin" && n.id === "labee.pee.select") {
      const next = liveBranchesAt(c.scope.iteration + 1);
      const survivors = next.filter((b) => !b.buildsOn);
      c.facts.refillCount = next.filter((b) => b.buildsOn).length;
      return { liveBranches: next, survivors, tree };
    }
    return {};
  });

  const solverScopes = ctx.trace.filter((t) => t.kind === "task" && t.role === "solver")
    .map((t) => `${t.scope.branch.id}@i${t.scope.iteration}`);
  ok("solver ran on the real (branch, iteration) pairs",
     JSON.stringify(solverScopes) === JSON.stringify(["b1@i1", "b2@i1", "b1@i2", "b3@i2"]),
     JSON.stringify(solverScopes));

  const logs = [...new Set(ctx.trace.filter((t) => t.key === "node_log").map((t) => t.path))].sort();
  const realNodes = fs.readdirSync(path.join(RUN, "stage2/nodes")).sort()
    .map((b) => `stage2/nodes/${b}/experimental_log.md`);
  ok("node_log paths resolve to the real node dirs",
     JSON.stringify(logs) === JSON.stringify(realNodes), JSON.stringify(logs));

  const evals = [...new Set(ctx.trace.filter((t) => t.key === "node_eval").map((t) => t.path))].sort();
  const realEvals = [];
  for (const b of fs.readdirSync(path.join(RUN, "stage2/nodes"))) {
    const vd = path.join(RUN, "stage2/nodes", b, "versions");
    if (fs.existsSync(vd)) for (const v of fs.readdirSync(vd))
      realEvals.push(`stage2/nodes/${b}/versions/${v}/eval.json`);
  }
  ok("eval.json paths match the real versions/ tree",
     JSON.stringify(evals) === JSON.stringify(realEvals.sort()),
     `\n        emitted: ${JSON.stringify(evals)}\n        actual:  ${JSON.stringify(realEvals)}`);

  ok("refill ideation fired exactly once",
     ctx.trace.filter((t) => t.kind === "task" && t.role === "ideator").length === 1);

  // Gap 2 fix must be present IN THE SPEC, not just in this test
  const refill = at("discover.1.loop.body.seq.2");
  ok("refill step declares `in: [survivors]` (Gap 2 fix)",
     JSON.stringify(refill.branch?.then?.in) === JSON.stringify(["survivors"]),
     JSON.stringify(refill.branch?.then));
}

// ============================================================ TEST 3 ========
// Writer repair loop from the write stage. Real run wrote ground and
// critic rounds 1+2, with round 2 at ratio 1.0 and zero flags.
console.log("\nTEST 3 — writer repair loop, driven from the write stage");
{
  const writeLoop = at("write.1");
  ok("node under test is the writer round loop", writeLoop.loop?.as === "round");

  const ctx = new Ctx(defaults);
  ctx.facts.prevFlagCount = Infinity;
  await walk(writeLoop, ctx, async (n, c) => {
    const r = c.scope.round;
    if (n.type === "plugin") {
      const g = readJson(`stage3/ground/round${r}.json`);
      c.facts.prevFlagCount = c.facts.flagCount ?? Infinity;
      c.facts.flagCount = g.flags.length;
      return { ground: g };
    }
    if (n.role === "critic") {
      const cr = readJson(`stage3/critic/round${r}.json`);
      c.facts.flagCount = (c.facts.flagCount ?? 0) + (cr.issues?.length ?? 0);
      return { critique: cr };
    }
    return {};
  });
  const grounds = ctx.trace.filter((t) => t.key === "ground_report").map((t) => t.path).sort();
  const realGrounds = fs.readdirSync(path.join(RUN, "stage3/ground"))
    .sort().map((f) => `stage3/ground/${f}`);
  ok("ground round artifacts match the real files",
     JSON.stringify(grounds) === JSON.stringify(realGrounds), JSON.stringify(grounds));
  ok("loop terminated within declared writerRounds",
     ctx.trace.filter((t) => t.kind === "task" && t.role === "critic").length <= defaults.writerRounds);
  // pinned against research_tasks: critic n=2 but resolver@write n=1
  const nCritic = ctx.trace.filter((t) => t.kind === "task" && t.role === "critic").length;
  const nResolver = ctx.trace.filter((t) => t.kind === "task" && t.role === "resolver").length;
  ok(`repair is conditional: critic ran ${nCritic}x, resolver ${nResolver}x (DB: 2 and 1)`,
     nCritic === 2 && nResolver === 1);
}

// ============================================================ TEST 4 ========
// Fail-closed gates, TAKEN FROM THE SPEC (steps[4].seq.body[2]).
console.log("\nTEST 4 — fail-closed gate, driven from the write stage");
{
  const gate = at("write.2");
  ok("node under test is GROUNDING_GATE", gate.gate?.failCode === "GROUNDING_GATE");

  const g = readJson("stage3/ground/round2.json");
  const ctxPass = new Ctx(defaults);
  ctxPass.facts.ground = g;
  await walk(gate, ctxPass, async () => ({}));
  ok(`passes at the real grounding ratio ${g.groundingRatio}`,
     ctxPass.trace.some((t) => t.kind === "gate" && t.passed));

  const ctxFail = new Ctx(defaults);
  ctxFail.facts.ground = { groundingRatio: 0.4 };
  let threw = null;
  try { await walk(gate, ctxFail, async () => ({})); } catch (e) { threw = e.message; }
  ok("aborts below the declared threshold", threw?.includes("GROUNDING_GATE"), String(threw));
}

// ============================================================ TEST 5 ========
// Verify loop from the verify stage — the refinement arm.
console.log("\nTEST 5 — verify loop, driven from the verify stage");
{
  const verifyLoop = at("verify.0");
  const ctx = new Ctx(defaults);
  ctx.facts.blocking = [{ id: "seed" }];
  await walk(verifyLoop, ctx, async (n, c) => {
    if (n.type === "plugin") {
      // the recorded report is a BARE ARRAY, and "blocking" is `verdict`,
      // not `status` — both were wrong on the first run of this test.
      const raw = readJson(`stage3/verify/claims.round${c.scope.round}.json`);
      const claims = Array.isArray(raw) ? raw : (raw.claims ?? []);
      const blocking = claims.filter((x) => x.verdict === "blocking");
      return { claims, blocking };
    }
    return {};
  });
  const claimFiles = ctx.trace.filter((t) => t.key === "claims_report").map((t) => t.path).sort();
  const realClaims = fs.readdirSync(path.join(RUN, "stage3/verify"))
    .filter((f) => f.startsWith("claims.round")).sort().map((f) => `stage3/verify/${f}`);
  ok("claims round artifacts match the real files",
     JSON.stringify(claimFiles) === JSON.stringify(realClaims),
     `\n        emitted: ${JSON.stringify(claimFiles)}\n        actual:  ${JSON.stringify(realClaims)}`);
  ok("resolver ran exactly once (DB: resolver@verify n=1)",
     ctx.trace.filter((t) => t.kind === "task" && t.role === "resolver").length === 1,
     String(ctx.trace.filter((t) => t.kind === "task" && t.role === "resolver").length));
  ok("refinement arm produced stage3/draft/paper.refined.md",
     fs.existsSync(path.join(RUN, "stage3/draft/paper.refined.md")) ===
       ctx.trace.some((t) => t.key === "draft_refined"),
     `resolver fired: ${ctx.trace.some((t) => t.key === "draft_refined")}`);

  // failure path: blocking survives every round -> gate fires INSIDE the loop,
  // so no extra resolver call is burned before failing closed.
  const bad = new Ctx(defaults);
  let boom = null;
  try {
    await walk(verifyLoop, bad, async (n) =>
      n.type === "plugin" ? { claims: [], blocking: [{ id: "x" }] } : {});
  } catch (e) { boom = e.message; }
  ok("fails closed with VERIFICATION_GATE when blocking survives",
     boom?.includes("VERIFICATION_GATE"), String(boom));
  ok("and burns only writerRounds-1 resolver calls, not one per round",
     bad.trace.filter((t) => t.kind === "task" && t.role === "resolver").length ===
       defaults.verifyRounds - 1,
     String(bad.trace.filter((t) => t.kind === "task" && t.role === "resolver").length));
}

// ============================================================ TEST 6 ========
// Static lint of the WHOLE graph — every node, not just the ones exercised.
console.log("\nTEST 6 — whole-graph static lint");
{
  const roleKeys = new Set(Object.keys(spec.roles));
  const artKeys = new Set(Object.keys(spec.artifacts));
  const pluginKeys = new Set(Object.keys(spec.plugins));
  const badRoles = [], badPlugins = [], ambiguousOut = [], usedRoles = new Set(), callbackRoles = new Set();

  (function lint(n, p) {
    if (Array.isArray(n)) return n.forEach((x, i) => lint(x, `${p}.${i}`));
    if (!n || typeof n !== "object") return;
    const k = Object.keys(n)[0], b = n[k];
    if (k === "task") {
      const role = typeof b === "string" ? b : b.role;
      usedRoles.add(role);
      if (!roleKeys.has(role)) badRoles.push(`${p}: ${role}`);
    }
    if (k === "plugin") {
      if (!pluginKeys.has(b.use)) badPlugins.push(`${p}: ${b.use}`);
      // a plugin may invoke a role as a callback (`with: {judge: {role: ...}}`);
      // such a role is reachable but invisible in the step graph.
      JSON.stringify(b.with ?? {}, (kk, vv) => {
        if (kk === "role" && typeof vv === "string") { usedRoles.add(vv); callbackRoles.add(vv); }
        return vv;
      });
    }
    const outMap = k === "plugin" ? b.out : n.out;
    for (const [f, t] of Object.entries(outMap ?? {}))
      if (!artKeys.has(t)) ambiguousOut.push(`${p}: ${f} -> ${t}`);
    for (const sub of ["body", "then", "else"]) {
      if (b && b[sub]) lint(b[sub], `${p}.${k}.${sub}`);
      if (n[sub] && k !== sub) lint(n[sub], `${p}.${sub}`);
    }
    if (Array.isArray(b)) lint(b, `${p}.${k}`);
  })(spec.steps, "steps");

  ok("every task references a declared role", badRoles.length === 0, JSON.stringify(badRoles));
  ok("every plugin is declared", badPlugins.length === 0, JSON.stringify(badPlugins));

  const badCwd = Object.entries(spec.roles)
    .filter(([, r]) => r.cwd?.artifact && !artKeys.has(r.cwd.artifact));
  ok("every role cwd references a declared artifact", badCwd.length === 0, JSON.stringify(badCwd));
  ok("outputs.final references a declared artifact", artKeys.has(spec.outputs.final));

  const policies = new Set(Object.keys(spec.toolPolicies));
  const badDeny = Object.entries(spec.roles)
    .filter(([, r]) => typeof r.tools === "object" && r.tools.deny && !policies.has(r.tools.deny));
  ok("every role deny-list references a declared policy", badDeny.length === 0, JSON.stringify(badDeny));

  const observed = ["literature_filter","librarian","researcher","pi","subdomain_writer",
    "island_consolidator","direction_auditor","brief_writer","brief_critic","ideator",
    "solver","report_writer","ablation","conceive","critic","resolver","composer_section",
    "entailment_judge"];
  ok(`all ${observed.length} roles seen in the real run are declared`,
     observed.every((r) => roleKeys.has(r)),
     JSON.stringify(observed.filter((r) => !roleKeys.has(r))));
  const onGraph = [...roleKeys].filter((r) => !spec.roles[r].offGraph);
  ok("every on-graph role is reachable from the graph",
     onGraph.every((r) => usedRoles.has(r)),
     JSON.stringify(onGraph.filter((r) => !usedRoles.has(r))));
  console.log(`  NOTE  ${callbackRoles.size} role(s) are reachable only as plugin callbacks,`);
  console.log(`        invisible in the step graph: ${[...callbackRoles].join(", ")}`);

  // NOT an assertion — a report. `out:` is overloaded and this is the evidence.
  console.log(`  NOTE  ${ambiguousOut.length} of the graph's out-bindings name something that is`);
  console.log(`        NOT a declared artifact, so they silently bind an in-memory fact instead:`);
  for (const a of ambiguousOut) console.log(`          ${a}`);
}

console.log(`\n${"=".repeat(56)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(56)}`);
process.exit(fail === 0 ? 0 : 1);
