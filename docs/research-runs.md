# Research runs

A research run is a server-side, multi-agent pipeline modeled on
**ScientistOne: Towards Human-Level Autonomous Research via Chain-of-Evidence**
(arXiv:2605.26340). It takes a research question plus 1–4 seed references and
produces a claim-verified report, with every stage communicating through
file-backed artifacts carrying provenance metadata.

## Pipeline

```
question + seeds
  → Stage 1  INVESTIGATE   citation-graph crawl (OpenAlex, evidence-cached)
                           → LLM literature filter → Core/Adjacent/Spark/Noise
                             [gate: <minCoreAdjacent Core+Adjacent papers → ABORT]
                           → 3 investigation rounds:
                               PI goal → Librarian picks → N parallel Researchers
                               (protocols-MCP full text → structured paper notes)
                               → SubdomainWriter dossiers → IslandConsolidator
                           → per-direction checklist audit (+ targeted refresh)
                           → Experiment Brief (writer ↔ critic loop, ≤5 rounds)
                             [optional human gate: approve after brief]
  → Stage 2  DISCOVER      Ideator (novelty/feasibility) seeds B branches
                           → Parallel Explore-Exploit: I iterations × B branches,
                             keep top-K, refill from survivors; each branch is a
                             solver agent in its own node workspace maintaining
                             an append-only experimental_log.md; every version
                             scored by the golden evaluator (or LLM rubric)
                           → best-run selection (errored/violating versions
                             excluded) → node report → ablations on a copy
  → Stage 3  WRITE         Conceive → research representation with inline
                           evidence tags ("provenance before prose")
                           → [Ground (deterministic) → Critic (LLM) → Resolve]
                             loop, ≤2 rounds, stops on zero flags or plateau
                             [gate: grounding ratio < groundingRatioMin → ABORT]
                           → Compose per-section (tags preserved)
  → Stage 4  VERIFY        Claim Verifier by claim type:
                             numerical → tolerance vs cited log line (±3 lines,
                               unit normalization: % ↔ fraction, ms ↔ s, k/M)
                             citation  → evidence-cache lookup + LLM entailment
                             methodological → token overlap vs cited log region
                           → bounded refinement of blocking violations
                             [gate: blocking violations survive → ABORT]
                           → strip tags, append references (retrieval-only),
                             promote stage3/final/paper.md
```

## Chain of evidence

- **Evidence cache** — every retrieval (OpenAlex HTTP call, every
  `mcp__protocols__search/fetch` observed in agent transcripts) is written to
  `evidence/ev_<hash>.json` and indexed in `research_evidence` by its stable
  ref id (`doi:…`, `pmid:…`, `openalex:W…`).
- **Retrieval-only citations** — a reference may appear in the brief or the
  final report only if an evidence row exists for its ref id in this run.
  References can never enter from model memory.
- **Claim tags** — every factual sentence in the representation/draft carries
  one tag: `{{src: log:<relPath>:<line>}}`, `{{src: cite:<refId>}}`,
  `{{src: ablation:<relPath>#<key>}}`, `{{src: brief:<sectionId>}}`, or
  `{{src: unsourced}}` (dropped at verification).
- **Deterministic vs LLM checks** — Ground and the numerical/overlap verifiers
  are plain TypeScript (`apps/server/src/research/claims/`); only the Critic,
  Resolver, and the citation entailment judge are LLM calls.

## API

```
POST /api/research/runs                    { question, seeds, evaluator?, budget?, gates?, modelTiers? }
GET  /api/research/runs                    run summaries (owner-scoped)
GET  /api/research/runs/:id                run + frozen spec + task rows
GET  /api/research/runs/:id/events?after=N SSE; replays persisted events then tails live
POST /api/research/runs/:id/cancel
POST /api/research/runs/:id/gate           { gate: "afterBrief"|"beforeWrite", approve }
GET  /api/research/runs/:id/artifacts      artifact index
GET  /api/research/runs/:id/artifacts/file?path=<rel>
GET  /api/research/runs/:id/claims         per-claim verification ledger
GET  /api/research/runs/:id/evidence       retrieval-cache index
```

The SSE stream emits one event type, `run_event`, whose payload envelope is
`{seq, runId, ts, stage, role, taskId, branch, type, data}`. Persisted events
carry `seq > 0` and set the SSE `id:` field, so `EventSource` reconnection
with `Last-Event-ID` resumes losslessly. `agent_delta`/`agent_tool` events are
live-only (full transcripts are on disk under `tasks/<taskId>.jsonl`).

## Run workspace

`<deck>/runs/<runId>/` (the user's deck panel shows it under `runs/`):

```
run.json                    frozen spec
tasks/<taskId>.jsonl        raw CLI transcript per sub-agent (audit trail)
evidence/ev_*.json          cached retrieval payloads
stage1/  seeds, candidates, filter tiers, notes/, directions/, audit/, brief.md, brief.refs.json
stage2/  ideas.json, tree.json, nodes/<branch>/{solution/,experimental_log.md,versions/}, ablations/, best.json
stage3/  representation.md, ground/, critic/, draft/, verify/, final/paper.md
```

## Evaluator

`{"kind":"command","command":"…"}` runs in the branch's node directory; the
contract is that the **last stdout line** is `{"score": <number>, …}`. With
`{"kind":"none"}` an LLM rubric scores branches for pruning only, Ground skips
the score-match check, and the report labels quantitative outcomes unverified.

## Budgets, gates, models

Defaults (override per run): I=5 iterations, B=5 branches, keep K=2, E=4
versions/node, 5 researchers/round, 3 investigation rounds, ≤5 brief-critic
rounds, ≤2 writer rounds, 4 concurrent agents (`RESEARCH_MAX_AGENTS` caps the
whole process), optional `maxCostUsd` (fail-closed `COST_CAP`). Gates:
`minCoreAdjacent=5`, `groundingRatioMin=0.85`, `numericTolerance=0.01`,
`approveAfterBrief=true`, `approveBeforeWrite=false`. Role→model-tier defaults
live in `apps/server/src/research/roles.ts` (haiku for filter/judge, sonnet
for researchers/solvers/composers, opus for PI/critics/ideation) and can be
overridden per run via `modelTiers`.

## Operational notes

- Runs execute detached from the HTTP request and survive browser closes, but
  **not a server restart** — a boot sweep marks stale rows `interrupted`.
  Stages are re-runnable from their artifacts; retry-from-stage is future work.
- Research v1 requires the Anthropic provider (claude CLI). All roles run with
  `AskUserQuestion` and web tools disallowed; only solver/ablation agents may
  write files, inside their node workspace (same trust level as full-access
  Build chat — cwd confinement is advisory, not a sandbox).
- Sub-agent fan-out is bursty: keep `maxConcurrentAgents`/`RESEARCH_MAX_AGENTS`
  conservative on rate-limited credentials and set `maxCostUsd`.
