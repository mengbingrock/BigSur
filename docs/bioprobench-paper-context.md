# BioProBench paper-context evaluation

> Generated JSON reports and downloaded datasets are local artifacts excluded from Git.
> References and commands below use local report paths; Markdown summaries remain in the repository.

This separate evaluation mode reconstructs the task-specific context settings in
[BioProBench Appendix C.3, page 15](https://raw.githubusercontent.com/mlresearch/v306/main/assets/liu26cu/liu26cu.pdf#page=15).
It leaves production retrieval behavior unchanged.

| Task | Chunk characters | Overlap | Retrieved chunks | Character cap |
|---|---:|---:|---:|---|
| PQA / ERR | 2,000 | 400 | 5 | None |
| ORD / GEN | 5,000 | 1,000 | 3 | None |

The [public BioProAgent retrieval file](https://github.com/YuyangSunshine/bioproagent/blob/e18586ab4a2a851433bedc0e6940b77470355fd6/src/capabilities/retrieval/knowledge_sources.py)
contains extension placeholders rather than the original index builder. We found
no real retrieval implementation in the published Python source/history inspected
in BioProAgent or BioProBench. This is a documented reconstruction of the paper's
context parameters, not an execution of the authors' original ProAgent.

## Controlled implementation

`contextProfiles.ts` maps official task labels directly to profiles. Splitting uses
fixed Unicode code points, with half-open offsets into the canonical string
`title + newline + description + newline + body`. That is exactly the flat
baseline's source text. Its historical splitter counts JavaScript UTF-16 units;
the new splitter preserves astral characters intact. The paper does not specify
exact splitter boundaries, Unicode counting, source serialization or formatting.

`preparePaperContext.ts` verifies all three pinned source collections and the
baseline corpus audit. It validates task-file checksums and frozen question
IDs/types before building two isolated SQLite FTS5 indexes. It uses the same
tokenizer, BM25 weights, visible query fields and 300-candidate search as the flat
baseline. Selection keeps the first k whole chunks in ranked order, including
overlap, without identity routing, merging or summarization. A short source tail
remains a short chunk, so top-k does not guarantee k times the maximum length.

There are 14,361 source records in both indexes: 56,957 small chunks and 26,046
large chunks. Source revision/checksum metadata is preserved in the manifest;
each retrieved source ID and chunk offset is preserved in the shareable report.
The existing corpus still has unresolved upstream source coverage gaps.

The model runner uses byte-identical evidence serialization to the previous
runner. It logs actual Unicode character and UTF-8 byte counts for the serialized
evidence. Provider token usage is also retained, including cached input, but those
counts include CLI system overhead and the question. An exact evidence-only token
count is unavailable; characters are not relabeled as tokens.

The paper's Qwen embeddings, FAISS dense candidates, 60/40 dense/BM25 combination,
and task-specific generation models are deferred. Holding lexical ranking fixed
makes this a context-policy comparison, rather than changing representation,
ranking and model simultaneously.

## Reproduce and validate

Use the commands in the [evaluation README](../apps/server/eval/bioprobench/README.md#separate-paper-context-mode).
The source checkout is pinned to `cf00fecd62583b98350cc48e26a29c92d3f21e5d`.
The recorded corpus is `/private/tmp/labee-bioprobench-complete-corpus` (a historical
directory name, not a claim of full corpus coverage); the official evaluator and
prompts are in `/private/tmp/labee-bioprobench-research`. New indexes, jobs and raw
checkpoints are under `/private/tmp/labee-bioprobench-paper-context`.

Validation: 347 server tests pass, including profile routing, complete ranked
selection, Unicode/overlap/offset boundaries, separate source texts and query
field isolation. Four Python tests pass, covering coverage matching, report
comparison guards, exact serialization and an offline CLI integration proving
that over 15,000 characters reach model stdin intact. Server typecheck and a
separate strict typecheck of the new evaluation TypeScript pass. All 288 stored
baseline evidence payloads serialize identically with the extracted helper.

The full build was audited for identical source ID sets, 14,361 records per
index, chunk lengths/offsets, the exact frozen 96 IDs and checksums, and top-k
counts for all questions. All 96 receive their intended passage count; 95 exceed
8,000 serialized characters.

| Task | Questions | Passages each | Mean serialized evidence characters |
|---|---:|---:|---:|
| PQA | 24 | 5 | 9,773 |
| ORD | 24 | 3 | 13,031 |
| ERR | 24 | 5 | 10,003 |
| GEN | 24 | 3 | 13,784 |

## Same-suite Opus 5.5 results

Ran 96 new predictions, 24 per task, with `claude-opus-5-5`. All 96 returned
usage records confirm that model ID. No predictions were reused for this mode;
the three comparison columns come from the stored repaired-corpus run.
The machine-readable report (`bioprobench-paper-context-evaluation.json`, local artifact) checks
identical corpus audits, task checksums, model, frozen selections and complete
case identities before comparing scores. It includes per-case hashes, source
references, offsets and paired wins/losses.

All-selected scores below count call/parse failures as zero. Each accuracy
denominator is 24; GEN is the mean dependency-free token-overlap F1 across 24.

| Metric | Flat | Hierarchy | Expanded | Paper-context |
|---|---:|---:|---:|---:|
| PQA accuracy | 75.0% (18/24) | 70.8% (17/24) | 66.7% (16/24) | 75.0% (18/24) |
| ORD exact ordering | 41.7% (10/24) | 41.7% (10/24) | 41.7% (10/24) | 50.0% (12/24) |
| ERR accuracy | 58.3% (14/24) | 66.7% (16/24) | 70.8% (17/24) | 58.3% (14/24) |
| GEN token F1 | 0.241 | 0.230 | 0.243 | 0.249 |

Against flat, ORD has two paired wins, no losses and 22 ties. Both improvements
(`TEST-ORD-000121`, `TEST-ORD-000356`) change an incorrect parsed answer into a
correct one; neither is explained by a previous call failure. Their source
titles remain unresolved in the corpus coverage audit. The seven title-matched
ORD questions still retrieve a matching source in all variants, and still score
6/7. Thus the ordering gain is not a newly established source-coverage gain.

PQA and ERR each have one win and one loss against flat. The new mode does not
improve their aggregate accuracy. Its ERR score remains below hierarchy and
expanded. GEN's improvement over flat is only +0.0085 token F1, with eight paired
wins and eleven losses; a higher mean here does not imply better scientific
validity or a consistent benefit across protocols.

The upstream `evaluate-protocol-outputs` skill, BioProBench profile, reports these
scorable-only metrics and denominators:

| Task | Total | Scored | Failed | Official metric |
|---|---:|---:|---:|---|
| PQA | 24 | 22 | 2 | Accuracy 81.82%; Brier 0.10755 |
| ORD | 24 | 20 | 4 | Exact match 60.0%; Kendall tau 0.8206 |
| ERR | 24 | 19 | 5 | Accuracy 73.68%; F1 0.7368, contains-error positive class |
| GEN | 24 | 24 | 0 | Core token F1 0.2493 |

There were 17 provider biology refusals: PQA 2, ORD 4, ERR 5, GEN 6. There were
zero other call failures, and none were retried. The GEN scorer accepts empty
predictions and assigns zero overlap, so its six refused calls appear separately
from its zero scoring failures. The official denominators must not be confused
with the all-selected table.

Combined index size is 423,354,368 bytes. Median lexical retrieval time is
341 ms; median CLI model-call latency is 8.46 seconds (including refusals).
Detailed per-task context sizes, latency and provider token usage are in the
report. These timings are descriptive of this local run.

## Interpretation and next step

The context settings are now implemented and tested separately. The ordering
result is promising, but two extra correct answers on previously analyzed
questions are insufficient to establish a general improvement. These are single
model draws against stored baselines, with different refusal patterns. The
experiment jointly changes chunk length, overlap, retrieval count and available
context; it does not identify which setting caused a difference.

Keep this as an evaluation option. Next, validate the ordering result on fresh
source-linked questions with interleaved baseline calls, then compare hierarchy
under matched per-task evidence allowances. That will help separate gains from
more available context from gains due to document structure. Keep dense/hybrid
retrieval as a separate experiment so its effect can be measured independently.
