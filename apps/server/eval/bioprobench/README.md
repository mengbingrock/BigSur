# BioProBench hierarchy experiment

This is an isolated, controlled index ablation using the upstream BioProBench PQA and ORD test tasks and official evaluation skill. It is not a complete BioProBench leaderboard run, a semantic-embedding comparison, or an end-to-end router evaluation.

## Reproduce

Requires Bun, Python 3, Git, and an authenticated Claude CLI. Clone the upstream repository into an external working directory. For the recorded run, the upstream commit is `cf00fecd62583b98350cc48e26a29c92d3f21e5d`; exact dataset SHA-256 checksums are in the report. The current loader requires all three pinned raw collections in `sources.json`, including Bio-protocol from the verified mirror. Download them with `python3 apps/server/eval/bioprobench/fetchCorpus.py --out /path/to/bioprobench`. See [corpus repair](../../../../docs/bioprobench-corpus-repair.md) for provenance and coverage limits. Earlier results below used the historical two-file corpus unless explicitly labeled as repaired.

Run from the Labee worktree:

```sh
bun run apps/server/eval/bioprobench/prepare.ts --source /path/to/bioprobench --out /tmp/biopro-eval --per-task 30
python3 apps/server/eval/bioprobench/run.py --source /path/to/bioprobench --out /tmp/biopro-eval --model haiku --workers 4 --live
python3 apps/server/eval/bioprobench/report.py --source /path/to/bioprobench --out /tmp/biopro-eval --report /tmp/biopro-report.json
```

`prepare.ts` builds three indexes from the same source records: fixed 1,800-character/200-overlap windows, the multi-grain chunker/parser from commit `96384e2`, and the new BioProBench hierarchy. It uses the production lexical query expression and the same BM25 field weights for all three. Ranking here deliberately omits production grain bonuses and dense scores to isolate representation differences. Raw BioProCorpus source paths/text enter the hierarchy index; display Markdown enters the other two indexes. Corpus-only purpose metadata may enter indexes. Test questions, choices, answers, correct step orders, and generated reference protocols never enter an index.

The deterministic sample is proportional to task subtype and selected by a fixed SHA-256 ordering before retrieval. These three variants use at most eight passages and an 8,000-character serialized evidence budget. Whole retrieved fragments must fit the budget; evidence is not cropped mid-instruction. Each prediction starts a fresh CLI session with no tools. Official question prompts are used, with retrieved evidence appended; gold fields are retained only in local records for scoring. Refusals, failures, and successful calls are checkpointed and never silently retried on resume.

The official `evaluate-protocol-outputs` skill scores PQA exact match/Brier and ORD exact match/Kendall tau. It excludes unparseable rows from its denominators; report total/scored/failed counts and additionally count failures as incorrect for all-question comparisons. Paired confidence intervals and McNemar tests are descriptive for this small pilot. Model randomness is not controlled; the `haiku` alias may change over time. The test corpus is only the currently downloadable subset; it does not contain every protocol referenced by the tests.

Raw data, prompts, reference answers, model outputs, and SQLite indexes stay in the external evaluation directory. The shareable report contains aggregate metrics, sample IDs, source references, and content hashes. BioProBench's dataset license is CC BY-NC 4.0; this run is an isolated evaluation and does not install that corpus into Labee's production library. The production library's existing license allowlist is unchanged.

Upstream sources:
- https://github.com/YuyangSunshine/bioprobench
- https://github.com/YuyangSunshine/bioprobench/blob/main/skills/evaluate-protocol-outputs/SKILL.md
- https://github.com/YuyangSunshine/bioprobench/blob/main/LICENSE.MD


## Source-covered ordering follow-up

The broad pilot revealed poor source-title coverage in the downloadable corpus. A separate run uses every official ORD question with an exact normalized title match, without selecting by correct answer or prior model success:

```sh
bun run apps/server/eval/bioprobench/prepareCovered.ts --base /tmp/biopro-eval --source /path/to/bioprobench --out /tmp/biopro-covered
python3 apps/server/eval/bioprobench/run.py --source /path/to/bioprobench --out /tmp/biopro-covered --model haiku --workers 4 --live
python3 apps/server/eval/bioprobench/report.py --source /path/to/bioprobench --out /tmp/biopro-covered --report /tmp/biopro-covered-report.json
```

This reuses the same indexes and already recorded predictions for overlapping questions. Exact title coverage is an auditable availability proxy; it does not prove that protocols under different titles are absent. Flat-window inputs include title, description, and rendered procedure, whereas legacy/hierarchy also include purpose summary fields; legacy versus hierarchy is the closer controlled representation comparison.

## Opus 5.5, four tasks, and context expansion

`prepareExpanded.ts` reuses the original corpus-only indexes. By default it selects 24 **fresh** questions per task (PQA, ORD, ERR, GEN), excluding every ID used in both earlier pilots. Sampling is deterministic and stratified by subtype; ERR additionally stratifies by correct/incorrect status. It compares `flat`, `hierarchy`, and `expanded`. `expanded` uses the production identity resolver and evidence expander: an unambiguous explicit title/ID selects its protocol, then three ranked nodes seed tree expansion under an 8,000-character serialized evidence budget. Expanded evidence has no eight-passage cap. Nodes retain source order and whole text. Ambiguous names fall back to global ranking.

```sh
bun run apps/server/eval/bioprobench/prepareExpanded.ts --base /tmp/biopro-eval --covered /tmp/biopro-covered --source /path/to/bioprobench --out /tmp/biopro-opus --per-task 24
python3 apps/server/eval/bioprobench/run.py --source /path/to/bioprobench --out /tmp/biopro-opus --model claude-opus-5-5 --workers 4 --live
python3 apps/server/eval/bioprobench/report.py --source /path/to/bioprobench --base /tmp/biopro-eval --out /tmp/biopro-opus --report /tmp/biopro-opus-report.json
```

For a separate, explicitly **development-only** source-covered ordering audit, add `--development --variants hierarchy,expanded` to the preparation command and use a different output directory. It selects all 35 available exact-title matches, including cases already analyzed before implementing the changes. Do not present this as an untouched holdout.

The live harness pins the model ID, records CLI-reported model usage, and rejects cached predictions from a different model or prompt. Each run retains all refusals and failures without retrying for favorable results. A fresh output directory is required to intentionally evaluate another model. Raw provider errors stay in local checkpoints; shareable reports classify failures without incidental session metadata.

Four task metrics:

- PQA: exact-answer accuracy and confidence Brier score.
- ORD: exact permutation and Kendall tau. Duplicate reference steps can be rejected by the official scorer.
- ERR: accuracy, precision, recall, and F1, where **contains an error** is the positive class. The model sees only the official target and context, never a hidden correction or error explanation.
- GEN: the official dependency-free **token-overlap F1**, precision, recall and exact match. These measure lexical overlap, not scientific validity, semantic step recall, or experimental success. Reference output never enters the prompt or index.

`allQuestionScores` counts failed calls/parses as zero; for GEN its score is token F1, and for the other tasks it is accuracy. `commonScorable` and official `samples` expose excluded denominators. Paired bootstrap intervals are descriptive for a small, single-run sample. This is a lexical ablation, not a production dense retrieval or full BioProBench leaderboard evaluation. The flat and hierarchy indexes retain the input-field differences described above. Exact-title availability can be audited for ORD; other tasks have no dependable source IDs in the supplied test files.

The actual router is checked separately using synthetic sources and its real search/read tool loop:

```sh
bun run apps/server/eval/siriContext.ts --live --model claude-opus-5-5 --out /tmp/siri-opus-report.json
```

That check exercises old history, archived sessions, a named protocol's parameter, a parent qualification, and source step order. It is not a substitute for the BioProBench evaluation.

For the recorded post-hoc **title-precedence-only** correction, `prepareExpanded.ts --reuse /path/to/original-run` reuses questions and saved predictions whose resolution is unchanged. It rebuilds evidence only when the resolved protocol changes. This shortcut assumes the same expansion algorithm and indexes; it is not a generic cache for arbitrary retrieval changes. Corpus/test checksums must match, and `run.py` still rejects mismatched model/prompt checkpoints. Use a new output directory and no `--reuse` when changing any other retrieval behavior. Original results and corrected follow-up results are both retained.

After these experiments, production defaults expand only confidently identified protocols; broad/ambiguous queries retain ranked chunks, with explicit context expansion available to the router. The `expanded` benchmark variant deliberately evaluates unconditional expansion and must not be labeled a direct measurement of that final conditional policy.

## Separate paper-context mode

`preparePaperContext.ts` builds two additional indexes and the `paper-context`
variant. It reads the task label directly: PQA/ERR use 2,000-character chunks,
400 overlap, top 5; ORD/GEN use 5,000-character chunks, 1,000 overlap, top 3.
Whole ranked chunks reach the model without an 8,000-character cap. BM25,
official question prompts, source corpus and frozen IDs stay fixed.

```sh
bun run apps/server/eval/bioprobench/preparePaperContext.ts \
  --source /path/to/bioprobench --out /tmp/biopro-paper-context \
  --selection docs/bioprobench-corpus-followup-evaluation.json
python3 apps/server/eval/bioprobench/run.py \
  --source /path/to/bioprobench --out /tmp/biopro-paper-context \
  --model claude-opus-5-5 --workers 4 --live
python3 apps/server/eval/bioprobench/report.py \
  --source /path/to/bioprobench --out /tmp/biopro-paper-context \
  --baseline-report docs/bioprobench-corpus-followup-evaluation.json \
  --report /tmp/biopro-paper-context/report.json
```

Use an empty output directory to prepare; rerun only `run.py` to resume model
calls. `--selection` accepts a baseline manifest or report and requires exact
corpus audits, task checksums and question identities. `--baseline-report` also
checks model and complete per-case coverage. No baseline predictions are rerun.

The paper does not disclose the exact splitter implementation. Our reconstruction
uses fixed Unicode-code-point windows and the same canonical source string as
the flat baseline. Indexes retain half-open source offsets; reports retain source
IDs, offsets, profiles and revision/checksum metadata. The runner measures actual
serialized context characters/UTF-8 bytes and keeps provider token usage; those
tokens include the entire CLI request, not just retrieved evidence. This mode
does not implement the paper's dense/hybrid ranker or task-specific model choice.
See [implementation and results](../../../../docs/bioprobench-paper-context.md).

## Nebius Qwen hybrid mode

`buildNebiusIndex.py` embeds the two paper-context indexes using Nebius
`Qwen/Qwen3-Embedding-8B` and publishes resumable, checksum-verified FAISS
`IndexFlatL2` indexes. `prepareNebiusHybrid.py` creates a separate
`paper-hybrid-nebius` variant using dense top 60, `rank-bm25`, 60/40 score fusion
and task-specific top 5/top 3 evidence. It retains the frozen questions and the
existing model runner. See [implementation, assumptions and commands](../../../../docs/bioprobench-nebius-hybrid.md).

To select a fresh stratified sample, add `--per-task 50 --exclude-report` followed
by the explicit prior report paths to `prepareNebiusHybrid.py`. This keeps the
same paper-style dense top-60 ranker and requires an empty output directory.
It excludes prior IDs, verifies task checksums, allocates exact proportional
subtype counts (ERR also stratifies by correctness status), and records the
selection seed and exclusion-report hashes. Do not use `--baseline-report` to
compare different question selections as paired results. See the
[50-per-task run](../../../../docs/bioprobench-nebius-paper-50.md).
