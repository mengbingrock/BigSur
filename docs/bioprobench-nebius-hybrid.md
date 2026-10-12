# BioProBench hybrid retrieval with Nebius

This evaluation adds real `Qwen/Qwen3-Embedding-8B` embeddings from Nebius Token
Factory to the existing paper-context corpus. It uses the same frozen 96
questions and `claude-opus-5-5` generator as the preceding experiment. Production
retrieval is unchanged.

## Index and retrieval

| Setting | Implementation |
|---|---|
| Corpus | Same 14,361 verified records as the repaired-corpus baseline |
| PQA / ERR index | 56,957 chunks; 2,000 characters, 400 overlap |
| ORD / GEN index | 26,046 chunks; 5,000 characters, 1,000 overlap |
| Embeddings | Nebius `Qwen/Qwen3-Embedding-8B`, 4,096 dimensions |
| Vector index | FAISS `IndexFlatL2`, float32, locally L2-normalized vectors |
| Initial retrieval | 60 nearest chunks from the task's index |
| Lexical ranking | `rank-bm25` BM25Okapi; statistics fitted to the whole task index |
| Fusion | 0.6 normalized semantic score + 0.4 normalized BM25 score |
| Final evidence | 5 whole chunks for PQA/ERR; 3 for ORD/GEN; no character cap |

`buildNebiusIndex.py` verifies source counts and hashes before contacting Nebius.
Only corpus chunks are embedded into the document indexes. Identical text is
embedded once and reused across records and profiles, while each original chunk
still gets its own FAISS row and source mapping. Raw text remains in the original
SQLite indexes. A separate content-addressed SQLite cache stores vectors and
successful response token counts transactionally.

Each successful batch is reusable after interruption. Concurrent requests are
bounded; transient errors receive at most five attempts, with exponential delays
and numeric `Retry-After` honored up to 60 seconds. Permanent authentication
errors stop immediately. Other successful in-flight batches are committed even
when one fails. A crash after the provider returns but before the transaction
commits can charge an unrecorded batch again; recorded usage is not an invoice.
Cost estimates multiply recorded input tokens by the
[advertised starting rate of $0.01 per million](https://nebius.com/services/token-factory/models/qwen-models-inference),
excluding generator calls, retries and any account-specific pricing.

Both FAISS files and source-address mappings are written atomically. The manifest
becomes `ready` only after every chunk has a vector and source hashes are checked
again. Source, model, dimensions, preprocessing and dependency versions must match
on resume. Ready artifacts are checksum-verified before reuse. A single-writer
lock prevents concurrent processes from spending on the same missing vectors.

`prepareNebiusHybrid.py` verifies the frozen questions against the official task
files and constructs queries using the same visible fields as earlier runs.
Following the [Qwen model instructions](https://huggingface.co/Qwen/Qwen3-Embedding-8B),
documents receive no instruction prefix. Queries use:

```text
Instruct: Given a web search query, retrieve relevant passages that answer the query
Query:<visible task query>
```

The query is embedded with the same model, normalized and searched in FAISS.
Within the 60 returned candidates, semantic similarity is `1 - squaredL2 / 2`.
Semantic and BM25 scores are independently min-max scaled over those candidates;
a constant score channel contributes zero. The final score is their 60/40 weighted
sum. Ties use smaller L2 distance, then original source row order. BM25 does not
introduce chunks outside the dense candidate set.

BM25 uses Unicode casefolding and `\w+` word tokens, without stemming or stopword
removal, and BM25Okapi defaults `k1=1.5`, `b=0.75`, `epsilon=0.25`. The library
[expects caller-provided tokens](https://github.com/dorianbrown/rank_bm25).
Reports preserve source offsets, dense rank, distance, both raw/scaled scores,
the fused score and the query embedding input hash. Retrieval timing excludes
cached query embedding time and index/BM25 loading.

## What this matches in the paper

The chunk sizes/overlaps, Qwen embedding family, FAISS index type, dense candidate
count, `rank-bm25`, 60/40 weighting and task-specific final k match
[Appendix C.3](https://raw.githubusercontent.com/mlresearch/v306/main/assets/liu26cu/liu26cu.pdf#page=15).
The paper does not specify the Qwen model size, query instruction, vector
normalization, lexical tokenizer, BM25 parameters, score scaling or exact source
serialization. Those are explicit reconstruction choices here. Its public
[retrieval source](https://github.com/YuyangSunshine/bioproagent/blob/e18586ab4a2a851433bedc0e6940b77470355fd6/src/capabilities/retrieval/knowledge_sources.py)
does not contain an executable original ranker.

The corpus remains smaller than the paper's approximately 27,000 protocols, and
this evaluation retains Opus 5.5 instead of the paper's task-specific generator
models. This is a paper-style retrieval reconstruction, not an exact replication
of the authors' original ProAgent or a fresh holdout evaluation. See the
[coverage audit](bioprobench-corpus-repair.md) and
[previous paper-context results](bioprobench-paper-context.md).

## Reproduce

Run from this worktree. Keep the API key in an owner-readable file outside Git,
or set `NEBIUS_API_KEY`; never include its value in a command or report. The
[Nebius embeddings endpoint](https://docs.tokenfactory.nebius.com/api-reference/inference/create-embeddings)
is `https://api.tokenfactory.nebius.com/v1/embeddings`.

```sh
uv venv --python 3.12 /private/tmp/labee-nebius-venv
uv pip install --python /private/tmp/labee-nebius-venv/bin/python \
  -r apps/server/eval/bioprobench/requirements-nebius.txt

/private/tmp/labee-nebius-venv/bin/python apps/server/eval/bioprobench/buildNebiusIndex.py \
  --base /private/tmp/labee-bioprobench-paper-context \
  --out /private/tmp/labee-bioprobench-nebius-index

/private/tmp/labee-nebius-venv/bin/python apps/server/eval/bioprobench/buildNebiusIndex.py \
  --base /private/tmp/labee-bioprobench-paper-context \
  --out /private/tmp/labee-bioprobench-nebius-index \
  --api-key-file /private/tmp/labee-nebius-api-key --workers 12 --live

/private/tmp/labee-nebius-venv/bin/python apps/server/eval/bioprobench/prepareNebiusHybrid.py \
  --base /private/tmp/labee-bioprobench-paper-context \
  --embeddings /private/tmp/labee-bioprobench-nebius-index \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-hybrid \
  --api-key-file /private/tmp/labee-nebius-api-key --live

python3 apps/server/eval/bioprobench/run.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-hybrid \
  --model claude-opus-5-5 --workers 4 --live

python3 apps/server/eval/bioprobench/report.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-hybrid \
  --baseline-report docs/bioprobench-paper-context-evaluation.json \
  --report docs/bioprobench-nebius-hybrid-evaluation.json
```

The first builder command is a read-only inventory. Repeat the live command to
resume; `--offline` requires every document vector already cached. Preparation
requires an empty output directory, and without `--live` requires all query
embeddings cached. Model calls resume through the existing checkpointed runner.
Failures and provider refusals remain in the selected denominator, with no
resampling or selective reruns. The baseline report is reused only after corpus,
task checksums, selected question identities and generator model match.

Pinned dependencies are in
[`requirements-nebius.txt`](../apps/server/eval/bioprobench/requirements-nebius.txt).
The 11 Python tests include real FAISS candidate gating, score fusion, cache
resume, partial failure recovery, response validation and a complete synthetic
build/retrieval round trip. No synthetic embedding option is exposed in the live
CLI.

## Completed index build

The build completed on October 11, 2026 (Los Angeles time) in 35.2 minutes,
including a checkpointed restart to increase concurrency. Both indexes contain
all 14,361 protocol IDs. Every stored vector was checked for finite values and
unit norm; all passed. Reopening through the builder in offline mode validated
both artifact checksums without making API calls.

| Measurement | Recorded value |
|---|---:|
| Total FAISS rows | 83,003 |
| Unique document embedding inputs | 78,903 |
| Document input tokens | 56,414,302 |
| Query embedding inputs | 96 |
| Query input tokens | 11,886 |
| Combined recorded input tokens | 56,426,188 |
| Estimated embedding cost at $0.01/M | $0.5643 |
| FAISS files, combined | 1,359,921,242 bytes |
| Embedding cache, including queries | 1,341,521,920 bytes |

Usage counts include successfully validated and checkpointed responses. Two tiny
connection checks and any in-flight responses lost at the restart are outside
this ledger. These estimates exclude generator usage and are not an invoice.

All 96 retrieval jobs preserve the frozen question identities, with exactly five
passages for PQA/ERR and three for ORD/GEN. Each retained dense rank is at most
60 and every saved fusion score passes the 60/40 arithmetic check. Eighty-five
jobs exceed 8,000 serialized characters; shorter jobs reflect complete short
chunks, with no artificial character cap.

The 11 Python tests pass. A regression run of the report generator preserves the
previous paper-context scores, official metrics, failure counts, performance and
source coverage exactly.

## Same-suite Opus 5.5 results

All 96 new predictions completed, with no reused predictions. Every response's
model usage confirms `claude-opus-5-5`. The
[machine-readable report](bioprobench-nebius-hybrid-evaluation.json) verifies the
same corpus, task checksums, model and selected question identities before
comparing with the stored paper-context baseline. There were 14 provider biology
refusals (PQA 0, ORD 4, ERR 5, GEN 5) and no other call failures, versus 17 refusals
in the preceding run. Refusals were retained without selective reruns.

All-selected scores count call/parse failures as zero. Each task has 24 questions;
GEN uses the official dependency-free token-overlap F1, which does not measure
scientific validity or laboratory success.

| Metric | Flat | Hierarchy | Expanded | Paper-context | Nebius hybrid |
|---|---:|---:|---:|---:|---:|
| PQA accuracy | 75.0% | 70.8% | 66.7% | 75.0% (18/24) | **83.3% (20/24)** |
| ORD exact ordering | 41.7% | 41.7% | 41.7% | **50.0% (12/24)** | 45.8% (11/24) |
| ERR accuracy | 58.3% | 66.7% | **70.8%** | 58.3% (14/24) | 58.3% (14/24) |
| GEN token F1 | 0.241 | 0.230 | 0.243 | 0.2493 | 0.2542 |

Against paper-context, PQA has two wins and no losses; ORD has one win and two
losses; ERR has one win and one loss; GEN has ten wins and nine losses. These are
single draws on 24 previously analyzed development questions per task, not
evidence of a reliable general improvement.

The two PQA wins (`TEST-PQA-000717`, `TEST-PQA-000011`) are both prior provider
refusals becoming correct answers. All 22 questions answered in both runs retain
the same correctness, 18/22. The aggregate QA improvement therefore does not
establish better retrieval-driven reasoning. ORD's gain (`TEST-ORD-001153`) also
comes from a prior refusal. Its two losses (`TEST-ORD-000121`,
`TEST-ORD-000356`) were answered in both runs; these are the same two questions
that improved when moving from flat to paper-context. Their source titles remain
unresolved in the corpus audit.

For transparency, restricting to questions with no call error in either run gives:

| Task | Paired questions | Paper-context | Nebius hybrid |
|---|---:|---:|---:|
| PQA accuracy | 22 | 81.82% | 81.82% |
| ORD exact ordering | 19 | 63.16% | 52.63% |
| ERR accuracy | 19 | 73.68% | 73.68% |
| GEN token F1 | 18 | 0.3324 | 0.3266 |

This post-hoc subset exposes refusal effects; it does not replace the all-selected
results or constitute an independent holdout. In particular, the small aggregate
GEN increase also disappears on the commonly answered subset.

The official evaluator's own denominators and metrics are:

| Task | Total | Scored | Failed | Official metric |
|---|---:|---:|---:|---|
| PQA | 24 | 24 | 0 | Accuracy 83.33%; Brier 0.13030 |
| ORD | 24 | 20 | 4 | Exact match 55.0%; Kendall tau 0.7627 |
| ERR | 24 | 19 | 5 | Accuracy 73.68%; F1 0.7368, contains-error positive class |
| GEN | 24 | 24 | 0 | Token F1 0.2542; empty refusals receive zero overlap |

Median measured retrieval time was 28.4 ms, excluding query embedding and index
loading; median generator time was 9.21 seconds. Mean serialized evidence was
9,030 / 11,831 / 9,560 / 12,796 characters for PQA / ORD / ERR / GEN. FAISS plus
the source SQLite indexes occupy 1.783 GB; the reusable embedding cache is extra.
Provider generation token counts include CLI system/question/cache overhead and
must not be interpreted as evidence-only token counts.

## Retrieval diagnosis and recommended next experiment

Seven frozen ORD questions have a root/section title match in the available
corpus. Paper-context retrieved a matching protocol for all seven; hybrid
retrieved one for five. A cache-only audit of the actual FAISS top 60 found that
the missing targets for `TEST-ORD-001153` and `TEST-ORD-001086` were absent from
the candidate set entirely. BM25 fusion could not recover them. The other five
targets entered the dense candidate set and survived final selection, including
one whose best dense rank was 12.

Despite this retrieval coverage drop, hybrid answered all seven source-matched
ORD questions correctly, versus six previously. Answer accuracy alone therefore
does not establish source retrieval success. Exact-title matching is an
availability proxy, and these seven cases are too few for a broad recall claim.

Keep this implementation as the paper-style baseline. The next experiment should
compare it with a separate variant that unions dense and lexical candidates,
and uses the existing confident protocol-identity resolver for explicit names.
Measure target coverage at candidate and final-selection stages before changing
the generator. The observed two misses specifically motivate testing the dense
candidate bottleneck rather than merely adjusting the 60/40 weight.

Use a larger, untouched, stratified sample for the subsequent answer-quality
comparison, retain provider refusals in the primary denominator, and report the
commonly answered subset separately. Keep the incomplete corpus and reconstruction
assumptions explicit. This run does not justify promoting the hybrid ranker to
production on quality grounds.
