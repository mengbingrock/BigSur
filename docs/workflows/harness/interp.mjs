// A standalone workflow interpreter — the REAL test of "the workflow separates
// from the agents".
//
// This file knows NOTHING about ScientistOne. It knows only the node algebra
// (seq / map / loop / gate / branch / task / plugin), template resolution, and
// predicate evaluation. Everything domain-specific comes from the YAML spec.
//
// Test: drive it with docs/workflows/scientistone.workflow.yaml, feeding each
// task/plugin the outputs that ACTUALLY happened in run_678864fbbc87eae767
// (read from that run's artifacts). Then assert that the task sequence and
// resolved artifact paths the interpreter emits match what the real engine did.
//
// If they match, the spec is executable, not merely descriptive.
//
// NOTE: predicate evaluation here uses new Function() over a controlled context.
// That is fine for a throwaway harness; the shipped interpreter must use a real
// non-eval expression evaluator (as the design states) since predicates power
// the fail-closed gates.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("/Users/martin/Git/BigSur/");
const yaml = require("js-yaml");

const SPEC = "/Users/martin/Git/BigSur/docs/workflows/scientistone.workflow.yaml";
const RUN = "/Users/martin/monterey-decks/menbinwan-at-gmail-com/runs/run_678864fbbc87eae767";

const spec = yaml.load(fs.readFileSync(SPEC, "utf8"));

// ---------------------------------------------------------------- runtime ---

class Ctx {
  constructor(params, inputs = {}) {
    this.params = params;
    this.inputs = inputs;
    this.facts = {};
    this.constants = spec.constants ?? {};
    this.trace = [];           // ordered emissions: tasks + artifacts
    this.scopeStack = [{}];
  }
  get scope() {
    return Object.assign({}, ...this.scopeStack);
  }
  push(bindings) { this.scopeStack.push(bindings); }
  pop() { this.scopeStack.pop(); }
  emitTask(role, extra = {}) { this.trace.push({ kind: "task", role, ...extra }); }
  emitArtifact(key, p) { this.trace.push({ kind: "artifact", key, path: p }); }
}

const HELPERS = {
  count: (x) => (Array.isArray(x) ? x.length : x == null ? 0 : Object.keys(x).length),
  length: (x) => HELPERS.count(x),
  values: (o) => (o ? Object.values(o) : []),
  sum: (a) => (a ?? []).reduce((s, v) => s + (Number(v) || 0), 0),
  take: (a, n) => (a ?? []).slice(0, n),
  chunk: (a, n) => {
    const out = [];
    for (let i = 0; i < (a ?? []).length; i += n) out.push(a.slice(i, i + n));
    return out;
  },
};

function evalExpr(expr, ctx) {
  if (typeof expr !== "string") return expr;
  const names = ["facts", "params", "scope", "constants", "inputs", ...Object.keys(HELPERS)];
  const vals = [ctx.facts, ctx.params, ctx.scope, ctx.constants, ctx.inputs, ...Object.values(HELPERS)];
  try {
    return new Function(...names, `return (${expr});`)(...vals);
  } catch (e) {
    throw new Error(`predicate failed: ${expr} — ${e.message}`);
  }
}

/** Resolve {{...}} in an artifact path template against the current scope. */
function resolvePath(template, ctx) {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref) => {
    const v = evalExpr(ref, ctx);
    if (v === undefined) throw new Error(`unresolved template var: ${ref}`);
    return String(v);
  });
}

/**
 * `out: {fact: target}` is overloaded — `target` is an artifact key if one is
 * declared, otherwise it silently degrades to an in-memory fact. Bind either
 * way, but record which happened so the lint can report the ambiguity.
 */
function bindOut(outMap, produced, ctx) {
  for (const [factKey, target] of Object.entries(outMap ?? {})) {
    ctx.facts[factKey] = produced?.[factKey];
    if (target != null && spec.artifacts?.[target]) declareArtifact(target, ctx);
    else if (target != null) ctx.trace.push({ kind: "factOnly", fact: factKey, target });
  }
}

function declareArtifact(key, ctx) {
  const decl = spec.artifacts?.[key];
  if (!decl) throw new Error(`undeclared artifact key: ${key}`);
  const p = resolvePath(decl.path, ctx);
  ctx.emitArtifact(key, p);
  return p;
}

/** `seq:` appears as both a list and a {name, body} map; map/loop bodies as either. */
function bodyOf(n) {
  if (Array.isArray(n)) return n;
  if (n && typeof n === "object" && Array.isArray(n.body) && Object.keys(n).every((k) => k === "body" || k === "name")) return n.body;
  return n;
}

/**
 * Mid-body break. `loop {break: ...}` only tests at the END of the body, but
 * real loops exit in the MIDDLE (write.ts evaluates three exits between the
 * critic and the resolver). Adding this node was forced by the trace.
 */
class LoopBreak extends Error {
  constructor(reason) { super(`loop break: ${reason}`); this.reason = reason; }
}

// ------------------------------------------------------------- the walker ---
// `oracle(node, ctx)` supplies what a task/plugin returned in the real run.

async function walk(node, ctx, oracle) {
  if (Array.isArray(node)) {
    for (const n of node) await walk(n, ctx, oracle);
    return;
  }
  const [kind] = Object.keys(node);

  if (kind === "seq") {
    // the spec uses BOTH `seq: [..]` and `seq: {name, body: [..]}`
    await walk(bodyOf(node.seq), ctx, oracle);
    return;
  }

  if (kind === "task") {
    const roleKey = typeof node.task === "string" ? node.task : node.task.role;
    if (!spec.roles[roleKey]) throw new Error(`undeclared role: ${roleKey}`);
    // A task can bind its own scope when it runs OUTSIDE the map that would
    // normally supply it (report_writer runs on the winner, after the loop).
    const bound = node.scope
      ? Object.fromEntries(Object.entries(node.scope).map(([k, v]) => [k, evalExpr(v, ctx)]))
      : null;
    if (bound) ctx.push(bound);
    ctx.emitTask(roleKey, { scope: ctx.scope });
    const out = await oracle({ type: "task", role: roleKey }, ctx);
    bindOut(node.out, out, ctx);
    for (const artKey of node.writes ?? []) declareArtifact(artKey, ctx);
    // ONE task, N scoped artifacts: island_consolidator emits a dossier per
    // direction. `writes:` cannot express it — the path template needs a scope
    // the task itself does not run under.
    for (const w of [].concat(node.writesEach ?? [])) {
      for (const item of evalExpr(`facts.${w.over}`, ctx) ?? []) {
        ctx.push({ [w.as]: item });
        try { declareArtifact(w.artifact, ctx); } finally { ctx.pop(); }
      }
    }
    if (bound) ctx.pop();
    return;
  }

  if (kind === "plugin") {
    const id = node.plugin.use;
    if (!spec.plugins?.[id]) throw new Error(`undeclared plugin: ${id}`);
    const out = await oracle({ type: "plugin", id }, ctx);
    bindOut(node.plugin.out, out, ctx);
    for (const artKey of node.plugin.writes ?? []) declareArtifact(artKey, ctx);
    return;
  }

  if (kind === "break") {
    const b = node.break;
    if (evalExpr(b.when, ctx)) throw new LoopBreak(b.reason ?? b.when);
    return;
  }

  if (kind === "gate") {
    const g = node.gate;
    if (g.when !== undefined && !evalExpr(g.when, ctx)) return;
    if (g.kind === "check") {
      const ok = evalExpr(g.check, ctx);
      ctx.trace.push({ kind: "gate", name: g.failCode, passed: !!ok });
      if (!ok) throw new Error(`GATE FAILED: ${g.failCode}`);
    } else {
      ctx.trace.push({ kind: "gate", name: g.name, human: true });
    }
    return;
  }

  if (kind === "branch") {
    if (evalExpr(node.branch.when, ctx)) await walk(node.branch.then, ctx, oracle);
    else if (node.branch.else) await walk(node.branch.else, ctx, oracle);
    return;
  }

  if (kind === "map") {
    const m = node.map;
    const items = evalExpr(m.over, ctx) ?? [];
    for (let i = 0; i < items.length; i++) {
      ctx.push({ [m.as]: items[i], index: i });
      try {
        await walk(bodyOf(m.body ?? node.body), ctx, oracle);
      } catch (e) {
        if (m.onError === "skip" || m.onError === "record") {
          ctx.trace.push({ kind: "error", handled: m.onError, msg: e.message });
        } else throw e;
      } finally {
        ctx.pop();
      }
    }
    return;
  }

  if (kind === "loop") {
    const l = node.loop;
    const max = evalExpr(l.maxRounds, ctx);
    for (let r = 1; r <= max; r++) {
      ctx.push({ [l.as ?? "round"]: r, round: r });
      try {
        await walk(bodyOf(l.body ?? node.body), ctx, oracle);
        if (l.break && evalExpr(l.break, ctx)) {
          ctx.trace.push({ kind: "loopBreak", at: r, reason: "break" });
          ctx.pop();
          return;
        }
      } catch (e) {
        if (e instanceof LoopBreak) {
          ctx.trace.push({ kind: "loopBreak", at: r, reason: "break", why: e.reason });
          ctx.pop();
          return;
        }
        throw e;
      } finally {
        if (ctx.scopeStack.length && ctx.scope[l.as ?? "round"] === r) ctx.pop();
      }
    }
    ctx.trace.push({ kind: "loopBreak", at: max, reason: "maxRounds" });
    return;
  }

  throw new Error(`unknown node kind: ${kind}`);
}

// ------------------------------------------------- oracle from the real run --

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(RUN, p), "utf8"));
const tree = readJson("stage2/tree.json");

function recordedAudit(key, round) {
  const p = `stage1/audit/dir_${key}.round${round}.json`;
  return fs.existsSync(path.join(RUN, p)) ? readJson(p) : null;
}

/** Which branches were alive going into each PEE iteration, per the real tree. */
function liveBranchesAt(iteration) {
  return tree.branches
    .filter((b) => b.versions.some((v) => v.iteration === iteration))
    .map((b) => ({ id: b.id, title: b.title, buildsOn: b.buildsOn }));
}

export { spec, Ctx, walk, bodyOf, LoopBreak, evalExpr, resolvePath, declareArtifact, readJson, tree, recordedAudit, liveBranchesAt, RUN };
