# Conformance: does the ScientistOne spec reproduce the run we actually observed?

**Question.** [`scientistone.workflow.yaml`](./scientistone.workflow.yaml) claims to express ScientistOne's workflow as data. Would *interpreting* it have produced the execution we recorded?

> **Scope of the corpus.** There is exactly **one** completed run on record (`research_runs` has a single row, and one workspace exists on disk). What follows is therefore *depth*, not breadth: the whole of one run reconciled task-by-task and artifact-by-artifact, not a sample across many runs. A second run with different parameters — different `iterations`/`keepK`, a rubric evaluator instead of a command one, a failing gate — would exercise paths this one never touched, and is the obvious next source of confidence.

**Method — this is now an executed test, not a reading.** A standalone interpreter ([`harness/interp.mjs`](./harness/interp.mjs), ~200 LOC) implements only the node algebra, `{{...}}` path templating, and predicate evaluation. It contains **zero ScientistOne knowledge**: every role name, loop bound, break condition, artifact path and threshold is read out of the YAML. The test ([`harness/test-separation.mjs`](./harness/test-separation.mjs)) pulls control-flow subtrees out of `spec.steps` **by path** — nothing is transcribed into the test — drives them with the outputs that actually occurred in run `run_678864fbbc87eae767`, and asserts the emitted task sequence and resolved artifact paths against that run's workspace and database.

A second harness, [`harness/test-full-replay.mjs`](./harness/test-full-replay.mjs), then walks the **entire spec end to end** and reconciles the result against the run's complete ledger — every task, every artifact, no spot checks.

```
$ node docs/workflows/harness/test-separation.mjs   →  31 passed, 0 failed   (6 control-flow subtrees)
$ node docs/workflows/harness/test-full-replay.mjs  →  11 passed, 0 failed   (whole spec vs whole ledger)
$ node docs/workflows/harness/conf2.mjs             →  27 passed, 0 failed   (spec vs database)
```

No Labee module is imported and the pipeline was not re-run, so no model calls were made and no behaviour changed. `apps/server/src/research/**` is untouched.

**Verdict: the workflow separates.** The strongest evidence is the full replay: walking the spec from `run.json` to `stage3/final/paper.md` emits **49 tasks in exactly the order `research_tasks` records them**, and **exactly the 42 artifact paths in `research_artifacts`** — no orphans in either direction. Scope propagation checks out independently: for `solver`, `direction_auditor`, `composer_section` and `critic`, the scope the interpreter resolves matches the label the engine recorded in `research_tasks.branch` (`b1.i2`, `predictive-ewma-forecasting`, `related-work`, `round2`, …).

**But that took eight corrections that reading the code had not produced.** The spec that "passed" a paper review did not survive first contact with an interpreter, and the spec that passed six subtree tests did not survive a full replay.

---

## What executing it found

### Finding 1 — the spec was not machine-readable at all

Three YAML syntax errors, invisible to review, made the file fail to load: `type: ref[]` in a flow mapping parses as a nested sequence; `minRepresentationChars:{` lacks the space YAML requires after a key; `from: claims/{grammar,ground}.ts` parses as a flow mapping. A spec nothing loads is a spec nothing validates. **Fixed** — the file now parses.

### Finding 2 — `evaluator_rubric` was unreachable, because its condition was a comment

The rubric fallback existed only as prose on the end of a line:

```yaml
- plugin:
    use: labee.eval.command    # or evaluator_rubric when evaluator.kind == none
```

The whole-graph lint reports which declared roles no step can reach, and it flagged this immediately. A declared role reachable by no path is dead configuration; the comment carried real dispatch logic. **Fixed** — it is now a `branch` on `inputs.evaluator.kind`, and the role is reachable.

### Finding 3 — the loops exit from the *middle* of their bodies

This is the substantive one, and only the database exposed it. `research_tasks` records `critic` n=2 but `resolver@write` n=1. The spec declared the writer loop as `loop {break: <predicate>}` with the body `[ground, critic, resolver]` — a trailing predicate, tested after the body — which necessarily implies **one resolver per round**, i.e. n=2. The counts disagreed.

Reading `write.ts:183-191` explains it. There are **three** exits, not the two the spec declared, and all three are evaluated *between the critic and the resolver*:

```ts
const flagCount = ground.flags.length + critique.issues.length;
if (flagCount === 0 && critique.pass) break;   // convergence
if (flagCount >= prevFlagCount) break;         // plateau
prevFlagCount = flagCount;
if (round === budget.writerRounds) break;      // ← never declared: a repair on
                                               //   the last round is never re-grounded
const resolved = await runAgentTask(ctx, { role: "resolver", ... });
```

The recorded round 2 exits by the third arm — its critic still returned `pass: false` with 11 issues, so neither convergence nor plateau fired. **No trailing predicate can express this.** The algebra needed a new node:

```yaml
- break: { when: "facts.flagCount == 0 && facts.critique.pass", reason: convergence }
- break: { when: "facts.flagCount >= facts.prevFlagCount",      reason: plateau }
- break: { when: "scope.round == params.writerRounds",          reason: lastRound }
- { task: resolver, out: { representation: representation } }
```

With the mid-body `break` node added to the interpreter and the spec rewritten, the spec now emits critic 2 / resolver 1 — matching the database exactly. **This is a required addition to the node algebra**, discovered only by executing.

The verify loop has the same shape, with a wrinkle: its `VERIFICATION_GATE` fires *inside* the loop (`verify.ts:139-151`), not after it. Declaring the gate after the loop produces the same final outcome but burns one extra resolver call on the failure path before failing closed. The spec now places the gate in-loop, guarded by `when: scope.round == params.verifyRounds`, and a test drives the failure path to confirm it fails closed without the wasted call.

### Finding 4 — `out:` is overloaded, and a typo degrades silently

`out: {fact: target}` writes an artifact when `target` names a declared artifact, and otherwise binds an in-memory fact. Identical syntax, different effect, decided by whether a lookup happens to hit. **12 of the graph's out-bindings** take the fact path:

```
steps.0.seq.body.2                     coreAdjacent, elitePool
steps.0.seq.body.4.loop.body.seq.0     roundGoal -> round_goal
steps.0.seq.body.4.loop.body.seq.1     picks
steps.0.seq.body.4.loop.body.seq.3     proposed -> directions_proposed
steps.0.seq.body.6                     winner
steps.0.seq.body.7.loop.body.seq.1     critique
steps.2.…map.body.seq.0                summary -> node_summary
steps.2.…loop.body.seq.1               liveBranches, survivors
steps.5.…loop.body.seq.0               blocking
```

Most are legitimately in-memory. But `summary -> node_summary` and `roundGoal -> round_goal` *read* like artifact keys and are not declared — under this rule they silently become facts and no file is ever written. The DSL must split these: `out:` for facts, `writes:` for artifacts (the syntax the spec already uses for `node_log`). Until it does, a one-character typo in an artifact key is undetectable.

### Finding 5 — one task can write N scoped artifacts, and the algebra could not say so

The full replay **aborted at task 14** with `scope.direction.key — Cannot read properties of undefined`. `island_consolidator` was declared `out: {directions: dossier}`, but it runs *once*, outside the direction map, while `dossier`'s path is `stage1/directions/dir_{{scope.direction.key}}.md` — and the run produced **two** dossiers. There is no scope for the template to resolve against, and no way to say "one per direction" with `out:` or `writes:`. Second required addition to the algebra:

```yaml
- task: island_consolidator
  out: { directions: directions }
  writesEach: { artifact: dossier, over: directions, as: direction }
```

### Finding 6 — a task can need a scope its position doesn't supply

With Finding 5 fixed the replay got to task 36 and aborted again: `scope.branch.id` undefined at `report_writer`. It writes `stage2/nodes/{{scope.branch.id}}/report.md` but runs *after* the PEE loop, on the winner — outside the map that would supply `scope.branch`. Third addition: a task may bind its own scope from a fact.

```yaml
- task: report_writer
  scope: { branch: "{ id: facts.best.branch }" }   # facts.best comes from bestRun
  out: { report: node_report }
```

Findings 5 and 6 are the same underlying issue seen twice: **scope is not always positional**, and the artifact path registry only pays off if scope can be supplied explicitly as well as lexically.

### Finding 7 — two artifacts were orphaned in the ledger

With the replay running to completion, the artifact reconciliation still showed two rows in `research_artifacts` that no step produced:

- **`run.json`** — persisted by the engine before any agent runs. It belongs to the run, not to a step, but leaving it undeclared means a spec-driven engine would not write it. Now declared via `labee.run.persistSpec`.
- **`stage2/ablations/work/experimental_log.md`** — the ablation agent keeps its own log inside `ablation_dir`, exactly as the solver does inside `node_dir`. The solver's log was declared; the ablation agent's was not. Now declared as `ablation_log`.

Both are the class of bug the path registry exists to prevent, and neither was visible until the full set was diffed.

### Finding 8 — 4 of 53 tasks are validation repairs the spec cannot express

`research_tasks` holds 53 rows but only **49 logical steps**. The other four have `attempt = 2` and a `parent_task_id` pointing at their first attempt — and *both* attempts are `succeeded`, so these are not failure retries. They come from `runStructuredTask` (`agentTask.ts:277-309`):

```ts
export async function runStructuredTask<A>(ctx, opts, validate, maxAttempts = 2) {
  // attempt 2 re-asks with the validation error appended to the prompt
```

A hidden, hardcoded repair loop wrapping every structured role — it fired on `subdomain_writer`, `researcher`, `solver` and `report_writer`, ~8% of all tasks and ~$0.5 of the run. The spec has no `retries:` or `repair:` construct and `maxAttempts` has no knob. The replay compares against the 49 logical tasks and *reports* the four repairs rather than asserting them, because the spec genuinely cannot produce them.

### Finding 9 — scope labels are built ad-hoc at 23 call sites

`research_tasks.branch` carries a scope label for every task — `r1`, `predictive-ewma-forecasting`, `b1.i2`, `brief-r2`, `round1`, `related-work`, `refine1` — 23 distinct values, each assembled by string concatenation at its call site and declared nowhere. These are what make the task ledger readable in the UI and greppable in logs. The spec declares artifact *paths* centrally but not these labels, so a spec-driven engine would silently lose them. The scope values themselves are correct — the harness verifies the interpreter resolves the same scope the label encodes — but the label *convention* needs the same registry treatment the paths got.

---

## Checks that passed

### Full end-to-end replay (11 assertions over the complete ledger)

Walking the entire spec — `run.json` through `stage3/final/paper.md` — against every row of the run's ledger:

| Reconciliation | Result |
|---|---|
| Spec walks to completion without error | pass |
| Emitted task **count** vs `research_tasks` (attempt=1) | 49 = 49 |
| Emitted task **order** vs the ledger, position by position | identical, no divergence |
| Per-role invocation counts | all 17 roles match |
| Emitted artifact paths vs `research_artifacts` | 42 = 42 |
| Artifacts in the ledger the spec fails to produce | none |
| Artifacts the spec produces that the ledger lacks | none |
| Scope resolved vs `research_tasks.branch` for `solver` (4), `direction_auditor` (3), `composer_section` (8), `critic` (2) | all match |

The order check is the one that carries the most weight. It is position-by-position over 49 entries across four stages, through two nested loops with changing membership, a map whose items terminate differently from one another, and three conditional branches — the kind of agreement that does not happen by accident.

### Control-flow conformance (31 assertions, all driven from `spec.steps`)

| Behaviour | Spec node | Result |
|---|---|---|
| Per-direction audit loop with **asymmetric termination** — `vectorized-fast-rebalance` breaks on `pass:true` after round 1; `predictive-ewma-forecasting` exhausts `maxRounds` still failing | `steps[0].seq.body[5]` | Emitted artifact paths equal the three real files in `stage1/audit/`; both exit reasons observed; auditor invoked exactly 3× |
| Targeted-refresh branch fires only under the failing direction | same | Confirmed — and the interpreter predicted **librarian n=3** (1 investigation + 2 refresh), which the database independently records as exactly 3 |
| PEE loop with **membership changing between rounds** and mid-loop refill | `steps[2].seq.body[1]` | Solver ran on `b1@i1, b2@i1, b1@i2, b3@i2` — the real tree; `node_log` and `versions/vN/eval.json` paths match the real directories; ideator fired 1 refill (DB: ideator n=2 = 1 initial + 1 refill) |
| Writer repair loop | `steps[4].seq.body[1]` | Ground round artifacts match; critic 2 / resolver 1 matches the DB |
| Verify loop refinement arm | `steps[5].seq.body[0]` | Both claim rounds emitted; resolver ran once; `paper.refined.md` accounted for; failure path fails closed with `VERIFICATION_GATE` |
| Fail-closed gate | `steps[4].seq.body[2]` | Passes at the real `groundingRatio: 1`; aborts at 0.4 |

### Database conformance (27 assertions)

- **Role coverage** — all 17 executed roles are declared; none fictional. Two declared roles never executed: `evaluator_rubric` (correct — the run supplied a command evaluator) and `entailment_judge` (invoked as a plugin callback, so it produces no `research_tasks` row).
- **Model routing** — all 17 roles ran on exactly the tier the spec declares (haiku/sonnet/opus), no drift.
- **Step ordering** — observed stage order `investigate → discover → write → verify` matches the declared `seq` names.
- **Cost attribution** — `sum(cost_usd)` reconciles to **$21.78** across 53 tasks, all `succeeded`.
- **Gates** — `gate_passed` events for `TOPIC_RELEVANCE_GATE` (coreAdjacent 16 ≥ 5) and `GROUNDING_GATE` (ratio 1.0 ≥ 0.85), both matching declared thresholds.

### The path registry holds

Every produced path is derivable from a declared template, with no orphans — `stage1/notes/note_{{scope.paper.refIdSlug}}.md`, `stage2/nodes/{{scope.branch.id}}/experimental_log.md`, `stage3/ground/round{{scope.round}}.json`, and the rest all resolve against real scope values. This is the check that matters most for the design: the registry can replace today's three-way string agreement between the solver prompt, `claims/ground.ts`'s `log:` resolver, and stage 3's citation instruction.

---

## Gaps that remain

### Gap A — derived fields are load-bearing

Every audit artifact carries a `total` the model never emitted (`{"pass": true, "total": 22, ...}`), computed by an inline validator summing an open-ended `scores` object, and it **drives winner selection**. This needs either a `derive:` expression (`sum(values($.scores))`) or a `postProcess` plug-in. The artifacts also carry `__taskId`, injected by `runStructuredTask`; a spec-driven writer must declare or strip it.

### Gap B — roles invisible in the graph

`entailment_judge` is reachable only as a plugin callback (`with: {judge: {role: entailment_judge}}`). It is legitimate, but it means the step graph is not a complete picture of which agents run — a static cost or permission analysis that walks only `task` nodes will miss it.

### Gap C — ordering constraints the algebra doesn't state

Compose is declared `map {concurrency: 1}` and section order is load-bearing for the assembled document. Concurrency 1 happens to be order-preserving; the spec should say *ordered* explicitly, or a future optimisation that raises concurrency silently scrambles the paper.

### Gap D — a declared-but-wasteful behaviour, now visible

Because the targeted-refresh branch sits before the audit loop's break, the final failing round still fetches literature nothing will ever read. The spec faithfully reproduces this (the test pins it), and the database confirms it happened. Making the workflow data makes the waste reviewable, which it was not when it was control flow.

---

## Conclusion

**The workflow separates from the agents, and the separated spec is executable rather than descriptive.** A generic interpreter with no domain knowledge, driven only by the YAML, reproduces the recorded run in full: 49 tasks in exact order, 42 artifacts with no orphans in either direction, correct scope on every branch, loop, section and round, and both fail-closed gates behaving as declared.

The exercise paid for itself several times over before any engine work started. Nine defects were found, and **none of them by reading**:

| # | Found by | Defect |
|---|---|---|
| 1 | loading the file | the spec did not parse |
| 2 | whole-graph lint | `evaluator_rubric` unreachable — its condition was a comment |
| 3 | database counts | loops exit mid-body, via three arms, one never declared |
| 4 | whole-graph lint | `out:` silently overloads artifacts with facts |
| 5 | full replay (aborted at task 14) | one task writes N scoped artifacts |
| 6 | full replay (aborted at task 36) | a task needs a scope its position doesn't supply |
| 7 | artifact reconciliation | `run.json` and the ablation log were orphaned |
| 8 | task-count reconciliation | a hidden 2-attempt validation-repair loop |
| 9 | branch-label inventory | 23 scope labels built ad-hoc, declared nowhere |

Four additions to the node algebra are now proven necessary **by data rather than by argument**: mid-body `break` nodes, `writesEach` for fan-out writes, task-level `scope:` binding, and `writes:` on plug-in nodes. Two more remain open: derived fields (Gap A) and a `retries`/`repair` construct (Finding 8).

What must remain code stays small and is mostly *policy*: 13 plug-ins (~900 LOC moved, not rewritten), of which the load-bearing ones are `pee.select`, `selectWinner`, `tier`, and the two `claims.*` modules.

**Confidence, stated honestly.** This is one run reconciled exhaustively — deep, not broad. It did not exercise: a failing `TOPIC_RELEVANCE_GATE`, the rubric evaluator arm, `onError: skip` on a genuinely failed task, more than 2 PEE iterations, or the human approval gates. A second run with different parameters is the cheapest large increase in confidence available, and should come before the interpreter is trusted with anything.

**Recommended next step:** build the interpreter for real, starting from `harness/interp.mjs`'s node algebra — replacing its `new Function` predicate evaluator with a non-eval one, since predicates power the fail-closed gates. Close Gap A and the `out:`/`writes:` split first; they are cheap now and expensive later. The EPLB benchmark remains the acceptance gate for any ported pipeline.

---

### Reproducing

```bash
node docs/workflows/harness/test-separation.mjs    # 6 control-flow subtrees, 31 assertions
node docs/workflows/harness/test-full-replay.mjs   # whole spec vs whole ledger, 11 assertions
node docs/workflows/harness/conf2.mjs              # spec vs database, 27 assertions
```

All three are read-only. They require the recorded run at `~/monterey-decks/menbinwan-at-gmail-com/runs/run_678864fbbc87eae767/` and `data/labee.sqlite`; paths are constants at the top of `interp.mjs` and each harness.
