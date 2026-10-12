# Upstream BioProAgent versus single-call RAG

> Generated JSON reports and downloaded datasets are local artifacts excluded from Git.
> References and commands below use local report paths; Markdown summaries remain in the repository.

This experiment runs the actual cloned
[BioProAgent source](https://github.com/YuyangSunshine/bioproagent/tree/e18586ab4a2a851433bedc0e6940b77470355fd6),
calling `main_evaluate.ProAgent.process_query`. The upstream planner, finite-state
controller, drafting/reflection/revision tools and prompts, and loop
limits are unmodified. The local runner supplies the model, knowledge, and
noninteractive benchmark interfaces. It does not implement a replacement agent.

The earlier [50-per-task run](bioprobench-nebius-paper-50.md) was single-call RAG
with official BioProBench task prompts. It did not execute ProAgent. That run is
the baseline here. Both arms use the same 200 questions and Opus 5.5, with access to the same
14,361-record corpus, Qwen3-Embedding-8B vectors, FAISS IndexFlatL2, top-60 dense
candidates, 60/40 dense/BM25 fusion, and task-specific chunks/top-k. Evidence
availability is fixed; the upstream agent may choose a path that never reads it.

## What is being tested

This is an integration and agent-contribution experiment using the **public
BioProAgent repository**, associated with *BioProAgent: Neuro-Symbolic Grounding
for Constrained Scientific Planning* (ACL 2026), by Yuyang Liu and colleagues.
It is not an exact reproduction of the earlier BioProBench paper's ProAgent.
The public repository's native A/B/C/D tasks concern protocol drafting and
automation. Here we supply the existing BioProBench PQA/ORD/ERR/GEN question
prompts to its public agent entry point. In particular, QA, ordering, and error
classification are a transfer test for its protocol-oriented tools.

The baseline uses one CLI call. The agent can classify intent, plan tool calls,
retrieve evidence, draft, review, and revise. It can also bypass these tools if
its native intent classifier answers directly. Execution traces measure which
paths actually occur. Differences include the public agent's prompts and its
additional inference budget; this design cannot separate those effects or
identify the individual causal contribution of planning versus reflection.

## Integration boundaries

1. **Model transport:** The upstream `src.core.llms` interface is bound to our
   authenticated Claude CLI. All four model roles use `claude-opus-5-5`, the same
   system prompt as the baseline, fresh CLI sessions, and no CLI external tools.
   The agent's own Python tools remain available. This replaces backend/API
   transport, not any agent logic. Temperature is the CLI default, as in baseline.
2. **Frozen local retrieval:** `default_retriever.invoke` returns the exact
   stored passages for that question from our completed Qwen/FAISS/BM25 run.
   The indexes and source SQLite files were checked against their SHA-256
   manifests, and all 200 question/passage pairs were checked against baseline
   checkpoints. Planner-generated queries are logged but do not change the
   evidence. This isolates agent behavior from retrieval changes and requires
   no additional document or query embeddings. This run does not test agent
   query reformulation. The upstream web/PubMed/protocol connectors are public
   placeholders and return no additional evidence here.
   Saved `retrievalMs` values are inherited baseline measurements, not fresh
   retrieval timings. Agent latency covers its complete model/tool loop.
3. **Benchmark inputs:** Only the official question prompt enters the agent.
   Reference answers and correct ordering/generation targets remain local to
   the evaluator. The official ERR formatter selects the presented target step
   using the dataset label but never reveals that label. The complete question
   initializes `exp_info` and `global_exp_context` to avoid requiring invented
   user answers. No factual clarification answers are supplied.
4. **Draft-only endpoint:** The native
   `require_confirmation_before_code=True` option is enabled. The confirmation
   tool returns `User_Confirmed: NO`, because these four tasks request text, not
   machine-code generation. The original eight-loop, retry, and oscillation
   settings remain intact. Planner deviations are retained in traces.
5. **Output extraction:** Score `state.mem_work['draft']`, the full final draft,
   falling back to `process_query`'s response when no draft exists. The native
   UI response truncates drafts to 2,000–3,000 characters; scoring that preview
   would discard part of the generated answer. No new answer-extraction model
   call or reference-guided output selection is used.
6. **Independent memory:** Each question has a new session and empty long-term
   memory. Evaluation mode disables memory writes. This prevents cross-question
   information leakage.
7. **Provider failures:** The trial stops at the first provider failure. This
   prevents the public reflector's exception handler from converting a failed
   model call into `done`, and prevents retrying a provider refusal. Completed
   failures are checkpointed and reused. Internal tool/argument failures follow
   the upstream controller's original handling.

The clone remains outside the application repository at
`/private/tmp/labee-proagent-source`. Its revision is
`e18586ab4a2a851433bedc0e6940b77470355fd6`; no tracked source files are edited.
The authors' [non-commercial research terms and attribution requirements](https://github.com/YuyangSunshine/bioproagent/blob/e18586ab4a2a851433bedc0e6940b77470355fd6/Licenses.md)
apply to their source. This experiment does not incorporate that source into
the production application.

## Reproduce

From the worktree, using the existing baseline/index artifacts:

```sh
git clone https://github.com/YuyangSunshine/bioproagent.git /private/tmp/labee-proagent-source
git -C /private/tmp/labee-proagent-source checkout e18586ab4a2a851433bedc0e6940b77470355fd6
uv venv --python 3.12 /private/tmp/labee-proagent-venv
uv pip install --python /private/tmp/labee-proagent-venv/bin/python \
  -r apps/server/eval/bioprobench/requirements-proagent.txt

BIOPROAGENT_SOURCE=/private/tmp/labee-proagent-source \
  /private/tmp/labee-proagent-venv/bin/python -m unittest discover \
  -s apps/server/eval/bioprobench -p 'test_proagent.py' -v

/private/tmp/labee-proagent-venv/bin/python apps/server/eval/bioprobench/runProAgent.py \
  --agent-source /private/tmp/labee-proagent-source \
  --source /private/tmp/labee-bioprobench-research \
  --base /private/tmp/labee-bioprobench-nebius-paper-50 \
  --out /private/tmp/labee-proagent-paper-50 --workers 8 --live

python3 apps/server/eval/bioprobench/report.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-proagent-paper-50 \
  --report docs/bioprobench-upstream-proagent-evaluation.json \
  --baseline-report docs/bioprobench-nebius-paper-50-evaluation.json \
  --exclude-provider-refusals
```

The four initial live integration cases (one per task) are included once in the
full run, including their failures. Model-call checkpoints retain prompts,
outputs, usage, and request hashes outside Git. Resume preserves completed
trials and model calls. The shareable report contains hashes and aggregate
execution metadata, without publishing protocol texts or benchmark answers.

## Evaluation policy

Use the upstream `evaluate-protocol-outputs` skill with the BioProBench profile.
QA/ORD/ERR use accuracy; GEN uses core token-overlap F1. This GEN score is not
the paper's semantic step recall or keyword F1.

As requested, each arm's primary score excludes its provider biology refusals.
For the agent-versus-baseline difference, use **the same question IDs in both
arms**, excluding a question if either arm refused. All other failures remain
zero, including the two known duplicate-step ORD references. The report also
preserves scores over all 50 selected cases per task. Refusal exclusion is
post-response conditioning and can bias the retained sample.

Paired uncertainty uses a deterministic 10,000-resample percentile bootstrap
over per-question differences. Exact McNemar tests are reported for accuracy
tasks, without multiplicity correction. This is one draw per question on a
small, previously evaluated development sample, not a full benchmark or a
matched-compute experiment.

## Results

All **200 cases completed**, with **902 model calls** across the upstream agent's
roles (versus 200 calls for the stored baseline). There were **32 provider biology
refusals**, no other provider-call failures, and no selective retries or replacement
questions. The machine-readable evaluation (`bioprobench-upstream-proagent-evaluation.json`, local artifact)
contains all case scores, paired comparisons, source references, usage, and
sanitized execution metadata.

### Main comparison: identical non-refused questions

Exclude a question when either arm refused. This leaves **167 paired questions**.
All accuracy gaps below are percentage points; GEN gaps are token-F1 units.

| Task / metric | Paired N | Single-call RAG | Cloned BioProAgent | Agent minus baseline | Paired bootstrap 95% interval |
|---|---:|---:|---:|---:|---:|
| QA accuracy | 48 | 81.25% (39/48) | **47.92% (23/48)** | −33.33 pp | [−47.92, −18.75] pp |
| ORD exact match | 41 | 53.66% (22/41) | **46.34% (19/41)** | −7.32 pp | [−21.95, +7.32] pp |
| ERR accuracy | 44 | 75.00% (33/44) | **65.91% (29/44)** | −9.09 pp | [−22.73, +4.55] pp |
| GEN token F1 | 34 | 0.2799 | **0.1062** | −0.1737 | [−0.2310, −0.1197] |

The agent scores lower on every task in this draw. The QA and GEN intervals are
below zero; ORD and ERR intervals include zero. Accuracy-task exact McNemar
p-values are 0.000145 (QA), 0.5078 (ORD), and 0.3438 (ERR), without adjustment
for multiple comparisons. These are pipeline results with formatting failures
counted as incorrect, not isolated estimates of scientific reasoning quality.

The baseline values above can differ from the earlier report because questions
newly refused by the agent are also excluded from the baseline for pairing.
Excluding only each arm's own refusals gives the following separate-arm scores:

| Task | Baseline retained / score | Agent retained / score | Agent refusals | Agent retained but unscorable |
|---|---:|---:|---:|---:|
| QA | 48 / 81.25% | 49 / 48.98% | 1 | 17 |
| ORD | 43 / 55.81% | 41 / 46.34% | 9 | 8 |
| ERR | 45 / 75.56% | 44 / 65.91% | 6 | 4 |
| GEN | 39 / 0.2803 | 34 / 0.1062 | 16 | 0 |

The eight unscorable ORD cases include the two known duplicate-step references.
GEN's core text metric accepts arbitrary text, so zero unscorable GEN cases does
not establish that all outputs are usable protocols. The JSON also retains
all-50-denominator scores and the upstream evaluator's scorable-only metrics.

### Did the agent actually plan, reflect, and revise?

Counts are cases with actual model calls in each phase, not simply a planner
mention or an attempted tool invocation. Retrieval counts require the local
retriever to have been invoked.

| Task | Planner called | Retrieval invoked | Reflection model called | Revision model called | Oscillation stop |
|---|---:|---:|---:|---:|---:|
| QA | 21 | 21 | 4 | 0 | 21 |
| ORD | 36 | 35 | 29 | 3 | 32 |
| ERR | 38 | 36 | 31 | 4 | 30 |
| GEN | 44 | 35 | 1 | 0 | 34 |
| **Total / 200** | **139** | **127** | **65** | **7** | **117** |

The 902 model calls comprise 200 intent classifications, 509 planner calls,
83 draft-generation calls, 103 reflection calls, and 7 revision calls. The
61 cases without planner calls include both direct intent-stage answers and
provider failures; they are not all successful answers.

There were **283 tool-argument validation failures across 127 cases**. Missing
required arguments included `query`, `exp_info`, `knowledge`, `keywords`, and
`question`. The public `get_tools_description()` returns a generic description
of the release instead of enumerating the available tools' argument schemas.
That is a plausible contributor to these errors, not a separately tested causal
explanation. The native detector stops when the last four states contain no more
than two unique states; repeated tool failures therefore often ended the run
before review or revision could complete. These behaviors were preserved.

QA's largest loss is format compatibility: 17 non-refused answers cannot be
parsed in the required benchmark format. GEN frequently never reaches review;
only one generation case made an actual reflection call, and none made a
revision call. Consequently, the GEN result provides little evidence about the
potential benefit of a functioning generation-review loop.

Across the **seven actually revised, non-refused cases**, first-draft to final
scores improved in three cases, worsened in one, and stayed unchanged in three:

- ORD: one correction, one regression, one unchanged incorrect answer.
- ERR: two corrections, one unchanged incorrect answer, one unchanged correct answer.

This is a small, agent-selected subset with no randomized revision control.
It shows that revisions sometimes changed correctness, but does not establish
the causal benefit of reflection on the benchmark as a whole.

### Cost, validation, and next step

The agent used **4.51 times as many model calls**. Median per-case agent-loop
latency was **73.17 seconds**, versus **8.18 seconds** for the single-call
baseline. This is descriptive: the agent run used eight workers and the baseline
used four, so concurrency/provider load can also affect latency. Provider token
counts include CLI system/cache overhead and are retained in the JSON; they
are not evidence-only token counts. No additional embeddings were purchased.

Validation passed: 200 unique expected IDs; exact sample and passage equality
with baseline; pinned clean upstream source; unchanged runner hash throughout
the run; all reported model identities are `claude-opus-5-5`; and every failed
model call is terminal within its case. Fifteen existing/reporting Python tests
passed in the retrieval environment, and two additional offline tests passed
against the real upstream agent in its environment. The latter exercise native
plan/review/revise transitions, full draft extraction, and refusal termination.

**Recommendation:** retain this run as the unmodified upstream baseline, then
test a separately named compatibility patch that exposes real tool schemas and
preserves each benchmark task's required output format. Rerun the same fixed
evidence and questions, and confirm that review/revision paths execute before
attributing a score change to the agent architecture. The present public-source
integration does not improve the single-call baseline.
