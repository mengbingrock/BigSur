# BioProBench hierarchy experiment

This is an isolated, controlled index ablation using the upstream BioProBench PQA and ORD test tasks and official evaluation skill. It is not a complete BioProBench leaderboard run, a semantic-embedding comparison, or an end-to-end router evaluation.

## Reproduce

Requires Bun, Python 3, Git, and an authenticated Claude CLI. Download the upstream repository and the two public source-corpus files into an external working directory. For the recorded run, the upstream commit is `cf00fecd62583b98350cc48e26a29c92d3f21e5d`; exact dataset SHA-256 checksums are in the report. Download URLs:

- `https://huggingface.co/datasets/BioProBench/BioProBench/resolve/main/Protocol-exchange.json`
- `https://huggingface.co/datasets/BioProBench/BioProBench/resolve/main/Protocol-io.json`

Run from the Labee worktree:

```sh
bun run apps/server/eval/bioprobench/prepare.ts --source /path/to/bioprobench --out /tmp/biopro-eval --per-task 30
python3 apps/server/eval/bioprobench/run.py --source /path/to/bioprobench --out /tmp/biopro-eval --model haiku --workers 4 --live
python3 apps/server/eval/bioprobench/report.py --source /path/to/bioprobench --out /tmp/biopro-eval --report /tmp/biopro-report.json
```

`prepare.ts` builds three indexes from the same source records: fixed 1,800-character/200-overlap windows, the multi-grain chunker/parser from commit `96384e2`, and the new BioProBench hierarchy. It uses the production lexical query expression and the same BM25 field weights for all three. Ranking here deliberately omits production grain bonuses and dense scores to isolate representation differences. Raw BioProCorpus source paths/text enter the hierarchy index; display Markdown enters the other two indexes. Corpus-only purpose metadata may enter indexes. Test questions, choices, answers, correct step orders, and generated reference protocols never enter an index.

The deterministic sample is proportional to task subtype and selected by a fixed SHA-256 ordering before retrieval. All variants use at most eight passages and an 8,000-character serialized evidence budget. Whole retrieved fragments must fit the budget; evidence is not cropped mid-instruction. Each prediction starts a fresh CLI session with no tools. Official question prompts are used, with retrieved evidence appended; gold fields are retained only in local records for scoring. Refusals, failures, and successful calls are checkpointed and never silently retried on resume.

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
