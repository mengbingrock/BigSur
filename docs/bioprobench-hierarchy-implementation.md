# BioProBench hierarchy implementation and evaluation

Implemented on `feat/siri-context-retrieval`. This is the BioProBench structure-first stage: original protocol hierarchy plus navigation. Automatic parent-context expansion and inferred process-dependency graphs are not part of this experiment.

## Index and navigation

`protocolHierarchy.ts` reads both flat dotted-key and nested BioProCorpus trees, preserves source text and dotted addresses, reconstructs missing structural parents, and keeps material text separate. Canonical nodes have `id`, `parentId`, `path`, `grain`, `heading`, and `text`. The library persists the original nodes in `hierarchy_json`; Markdown is a display/export representation, not the authoritative address map for imported corpus records.

Protocol search indexes a purpose summary, section text with a child outline, and individual steps/substeps. No fixed 1,800-character window splits normal protocol nodes. Only nodes exceeding a conservative 6,000-UTF-8-byte embedding input allowance get linked fragments, preferably at paragraph/line boundaries. Fragments share their original node address and do not overlap. Source reads reopen the complete node. This technical input allowance is not a document or history horizon. Provider requests are batched at 32 inputs.

Markdown parsing preserves nested headings and numbered substeps; bare numbered lists become a Procedure section. New run snapshots retain the original Markdown revision so later phases are available to retrieval even when the existing execution parser selected one phase. Older snapshots expose only their recorded steps/materials and return `sourceComplete:false`; missing original structure cannot be reconstructed from a flattened snapshot.

The context router now uses the existing federated protocol index for query searches instead of substring matching. It gets node references and can navigate via:

```json
{"tool":"protocols.search","query":"buffer preparation"}
{"tool":"protocols.read","protocolSlug":"library:source:id","part":"tree"}
{"tool":"protocols.read","protocolSlug":"library:source:id","nodeId":"step:2.4.8.3","revision":"returned-hash"}
{"tool":"runs.read","runId":"run-id","part":"tree","nodeId":"step:2.1"}
```

Tree reads return parents, ordered children, original text, and revision. Child lists paginate; long source text has a continuation offset. Follow-up protocol reads reject changed revisions. Run reads retain account ownership checks; library reads stay on the box when used from a desktop. Hierarchy paths are source addresses, not execution step numbers.

Derived artifact hashes and library index versions invalidate old chunks/vectors. Library rows rebuild in bounded batches from stored source. Reingest original BioProCorpus files to restore source paths for records ingested before `hierarchy_json` existed; old flattened display text cannot supply that information. Shared-library candidate retrieval still uses its existing lexical shortlist before dense scoring, a separate limitation this change does not claim to fix.

## Evaluation design

The upstream evaluation skill was read and used: https://github.com/YuyangSunshine/bioprobench/blob/main/skills/evaluate-protocol-outputs/SKILL.md . Upstream revision: `cf00fecd62583b98350cc48e26a29c92d3f21e5d`.

The public source files contained 10,518 records; the importer accepted 10,359 records with procedural content. The evaluator indexed that same accepted corpus in three representations: flat 1,800/200 windows; the previous multi-grain chunker/parser from `96384e2`; and the BioProBench hierarchy. Flat windows use title, description, and rendered procedure; the two protocol-aware representations also use the existing purpose-layer summary fields. Thus flat is a simple reference baseline, while legacy versus hierarchy is the closer representation comparison.

All variants use the same BM25 query expression and field weights, up to eight passages within an 8,000-character serialized evidence budget, and the authenticated Claude CLI `--model haiku` with no execution tools. The harness deliberately omits dense scores and production grain bonuses to isolate representation behavior. It tests retrieved-context answering, not the full router's iterative navigation policy. Source text can be in the retrieval corpus, as appropriate for an open-book retrieval test; reference answers/step orders never enter the index or model prompt. The model is not fine-tuned.

The first pilot preselected 30 PQA and 30 ORD questions, proportional by subtype, using a fixed hash order before retrieval. The source-covered follow-up selects all official ORD questions whose normalized protocol title is present in the same corpus, without inspecting correct orders. These are reported separately, not pooled or represented as a full BioProBench leaderboard score.

The official evaluator reports scores over parseable samples. We additionally count all excluded/refused/invalid cases as incorrect for accuracy comparisons over the complete selected set. The official ordering evaluator rejects repeated step strings because ordering values must be unique; this is reported as a benchmark/evaluator incompatibility rather than silently changing either data or evaluator. Refusals are preserved, not retried until success.

Raw source data, reference answers, prompts, model outputs and indexes remain under `/private/tmp/labee-bioprobench-*`; the repository contains reproducible scripts and reports with aggregate scores, IDs, source references and hashes. No production library was populated. Dataset licensing and reproduction steps are in `apps/server/eval/bioprobench/README.md`.

## Broad pilot results

Failures count as incorrect in this table; each task has 30 selected questions:

| Index | PQA correct | ORD exact order |
| --- | --- | --- |
| Flat windows | 17/30 (56.7%) | 11/30 (36.7%) |
| Previous multi-grain | 19/30 (63.3%) | 15/30 (50.0%) |
| BioProBench hierarchy | 17/30 (56.7%) | 13/30 (43.3%) |

The official scored-only PQA accuracies were 58.6%, 63.3%, and 56.7%, respectively. Flat PQA had one invalid confidence field. Each ORD variant had 28/30 scorable cases: the provider refused one question in all three conditions, and the official evaluator rejected a second question because its step strings were not unique. No refusals were retried or silently dropped from the all-question table.

The broad pilot does not demonstrate an accuracy improvement over the previous index. Both task deltas versus legacy are -6.7 percentage points; paired bootstrap intervals cross zero. Only 1/30 ordering titles had an exact match in the available corpus, so these ordering scores mostly test answering without the named source, not successful source retrieval. PQA lacks source identifiers, so this experiment does not invent a source-recall metric for it.

The hierarchy used 181.4 MB of SQLite storage versus 264.2 MB for legacy and 116.7 MB for flat windows. Broad-pilot median lexical retrieval was 527 ms versus 680 ms and 158 ms, respectively. These are local diagnostic timings, not a controlled service-load benchmark. Mean evidence lengths were 2,889, 4,437, and 7,792 characters; the common maximum passage count does not imply equally complete procedural context.

Full machine-readable results: `bioprobench-hierarchy-evaluation.json`.

## Source-covered ordering follow-up

Exact normalized-title matching found 35 of the full 1,161 official ORD questions whose named protocols are in the downloadable corpus. All 35 were tested; this selection uses source availability, not correct answers or prior scores. Three predictions overlapping the broad pilot were reused, so the two runs contain 285 reported predictions from 282 distinct live calls.

| Index | Correct / all 35 | Official exact match | Official Kendall tau |
| --- | --- | --- | --- |
| Flat windows | 27/35 (77.1%) | 27/34 (79.4%) | 0.825 |
| Previous multi-grain | 22/35 (62.9%) | 22/33 (66.7%) | 0.710 |
| BioProBench hierarchy | 23/35 (65.7%) | 23/34 (67.6%) | 0.754 |

One question has duplicate step strings and is rejected by the official ordering metric in all variants. One legacy call timed out at 120 seconds; it was not retried. On the 33 questions scorable in every variant, accuracy is 81.8% flat, 66.7% legacy, and 69.7% hierarchy. The hierarchy's all-question difference from legacy is +2.9 percentage points with paired bootstrap 95% interval [-8.6, +14.3]; its difference from flat is -11.4 points with interval [-25.7, +2.9]. These results do not establish a reliable accuracy advantage.

All three variants included the named protocol in the supplied evidence for only 20/35 questions. This is a concrete source-selection failure even when the source is present. The hierarchy supplied an average of 3,914 evidence characters, versus 5,114 legacy and 7,777 flat. This suggests—but does not prove—that ranking across protocols and insufficient expansion around fine-grained matches limit the hierarchy's usefulness. Correct answers without the named source can also come from model knowledge; answer accuracy is not evidence-grounding accuracy.

Full machine-readable follow-up: `bioprobench-hierarchy-covered-evaluation.json`.

## Recommended next experiment

Keep this work on the feature branch until a stronger evaluation supports deployment. The hierarchy is now usable and source-preserving, but structure alone has not demonstrated better answer accuracy.

1. Resolve explicitly named protocol titles/IDs before ranking their nodes, while retaining a global-search fallback for ambiguous or unnamed requests. Measure the current 20/35 source-in-evidence rate directly.
2. Let the agent use the existing hierarchy navigation to collect the relevant parent section, ordered siblings/substeps, and materials/notes under a token budget. Compare this with fixed top-eight evidence selection. This is where a later LabSage-style context-expansion experiment fits.
3. Improve corpus coverage and evaluate on source-linked questions. Reserve fresh questions or a held-out subset for the next experiment; these analyzed cases are now development evidence. Include exact parameters, conditions, revision isolation, source citations, and sequence completeness.
4. Run a separate real-embedding hybrid retrieval comparison and end-to-end router benchmark. The current model benchmark isolates lexical representation; fake/provider-mock unit tests establish embedding mechanics, not dense-model quality. Defer inferred process graphs until retrieval and context coverage improve.

Validation: 336 tests pass across 46 server test files; server/mobile TypeScript checks, server build, Python harness compilation, and `git diff --check` pass. Lint reports warnings without errors, and the existing `gray-matter` build warning remains. Tests cover deep hierarchy, original corpus addresses, oversized Unicode fragments, library persistence/migration, revision checks, paginated navigation, frozen-run access isolation, provider batching, and edits during embedding builds. No deployment or production-corpus embedding was performed.
