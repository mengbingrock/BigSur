# BioProBench source corpus repair

> Generated JSON reports and downloaded datasets are local artifacts excluded from Git.
> References and commands below use local report paths; Markdown summaries remain in the repository.

The two-file evaluation loader omitted Bio-protocol. The official Hugging Face
release currently contains Protocol Exchange and protocols.io raw files; the
[public mirror](https://huggingface.co/datasets/bowenxian/BioProBench/tree/c9ae37cac1b789eda6f3ffa62047fce92c286fbb)
also contains Bio-protocol. The other two mirror files have the same SHA-256
hashes as our original official-release downloads.

## Rebuilt corpus

| Collection | Raw records | Indexed records | Empty procedures | Identical duplicates removed |
|---|---:|---:|---:|---:|
| Protocol Exchange | 933 | 933 | 0 | 0 |
| protocols.io | 9,585 | 9,271 | 159 | 155 |
| Bio-protocol | 4,157 | 4,157 | 0 | 0 |
| Total | 14,675 | 14,361 | 159 | 155 |

The original 10,359 count included duplicate records. There are now 14,361
indexed source records representing 14,311 distinct upstream source IDs:
50 conflicting versions are preserved with content-hash revision IDs. Previously,
FTS could retain multiple versions under one ID while the expansion lookup's Map
silently kept the last one. Identical mapped records now appear once; differing
source content is never silently overwritten.

All three indexes contain exactly the same 14,361 source IDs: 58,612 flat chunks,
532,560 legacy chunks, and 542,973 hierarchy chunks. The build uses the existing
source-preserving hierarchy; no benchmark questions or reference answers enter
the corpus.

The loader now consumes `apps/server/eval/bioprobench/sources.json`, verifies
every required file's pinned checksum and record count, rejects task-shaped
records, and records accepted, rejected, duplicate and version counts. Missing
collections fail the build. `fetchCorpus.py` reproducibly downloads the manifest
and verifies bytes before replacing a local file. Additional collections can be
added explicitly to the manifest without another loader code change.

## Coverage correction

The earlier audit matched only whole-protocol titles. Child-step ordering
questions often name a subsection, so that understated source availability.
The new audit matches normalized root **or section** titles and retains source
IDs, node IDs, paths and ambiguity. It never consults the gold step order.

| Exact title coverage proxy | Original two collections | Three collections |
|---|---:|---:|
| All 1,161 ORD questions | 140 (12.1%) | 363 (31.3%) |
| Whole-protocol title matches | 35 | 111 |
| Additional subsection-only matches | 105 | 252 |
| Frozen 24-question ORD subset | 1 | 7 |
| Unresolved across all ORD questions | 1,021 | 798 |

Of the 363 matches, 117 match more than one indexed source/version. A title match
is an availability proxy, not verified source identity. An unmatched title means
**unresolved**, not proven absent. Retrieved target-source IDs are reported
separately; merely adding a document does not guarantee it appears in evidence.
All three retrieval variants return at least one matching source ID for all seven
matched questions in the frozen subset, versus one of 24 previously. One of the
seven has ambiguous title matches, so this is not verified source recall.
PQA, ERR and GEN do not have sufficient source labels for the same coverage audit.

This repairs the omitted public collection, not the entire upstream coverage
gap. The [paper's public release description](https://arxiv.org/html/2505.07889v2#S2)
names these three publicly released source collections, while its larger corpus
also includes other publishers. We have not obtained those original source
files or a complete test-to-source mapping. The remaining 798 unresolved titles
need that mapping and/or additional verified source releases. They must not be
filled by indexing benchmark reference outputs.

Full aggregate counts, checksums, newly matched IDs, unresolved IDs and the frozen
subset's source matches are in `bioprobench-corpus-coverage.json`.

## Reproduce

Run from this worktree. `BIOPRO_SOURCE` is an isolated upstream checkout at
`cf00fecd62583b98350cc48e26a29c92d3f21e5d` containing `Data/` and `Scripts/`.
Use new output directories for changed corpora.

```sh
python3 apps/server/eval/bioprobench/fetchCorpus.py --out "$BIOPRO_SOURCE"
bun run apps/server/eval/bioprobench/prepare.ts \
  --source "$BIOPRO_SOURCE" --out "$BIOPRO_INDEX" --index-only
python3 apps/server/eval/bioprobench/coverage.py \
  --index "$BIOPRO_INDEX" --questions "$BIOPRO_SOURCE/Data/ORD_test.json" \
  --out "$BIOPRO_INDEX/coverage.json"
bun run apps/server/eval/bioprobench/prepareExpanded.ts \
  --source "$BIOPRO_SOURCE" --base "$BIOPRO_INDEX" --out "$BIOPRO_RUN" \
  --selection docs/bioprobench-opus-title-fix-evaluation.json
python3 apps/server/eval/bioprobench/run.py \
  --source "$BIOPRO_SOURCE" --out "$BIOPRO_RUN" \
  --model claude-opus-5-5 --workers 4 --live
python3 apps/server/eval/bioprobench/report.py \
  --source "$BIOPRO_SOURCE" --base "$BIOPRO_INDEX" --out "$BIOPRO_RUN" \
  --report "$BIOPRO_RUN/report.json"
```

This remains an isolated lexical retrieval evaluation. Dense embedding quality
and production library ingestion are not measured by this run. The source
manifest preserves the benchmark-only license designation; it does not change
the production library license allowlist.

## Same-suite Opus 5.5 replay

Ran 288 fresh predictions: the same 96 question IDs (24 each for PQA, ORD, ERR,
GEN), the same task-file checksums, model `claude-opus-5-5`, official prompts,
and retrieval settings. All returned model-usage metadata names Opus 5.5.
This is a corpus-and-duplicate-repair follow-up on previously analyzed questions,
not a new holdout or a run of the original BioProAgent.

The table counts call failures as zero over all 24 selected questions per task.
PQA uses exact answer accuracy, ORD exact ordering, ERR correctness accuracy,
and GEN core token F1. The official BioProBench profile supplies normalization.

| Task | Flat before → after | Hierarchy before → after | Expanded before → after |
|---|---:|---:|---:|
| QA accuracy | 75.0% → 75.0% | 66.7% → 70.8% | 70.8% → 66.7% |
| Exact ordering | 41.7% → 41.7% | 41.7% → 41.7% | 41.7% → 41.7% |
| Error detection accuracy | 54.2% → 58.3% | 66.7% → 66.7% | 54.2% → 70.8% |
| Generation token F1 | 0.209 → 0.241 | 0.202 → 0.230 | 0.202 → 0.243 |

The seven title-matched ORD questions scored 6/7 both before and after for every
variant. The six newly retrieved source matches therefore improved evidence
availability without changing exact ordering accuracy in this small subset.
Single model draws, corpus expansion and duplicate repair all changed together;
these observations do not isolate a statistically established causal benefit.
Generation token overlap does not measure scientific correctness.

There were 45 provider biology refusals and zero other call failures; refusals
were retained without retries. Official evaluator scored/failed counts below
are each out of 24. Its GEN core scorer accepts empty predictions and assigns
zero overlap, so those call failures appear separately in the report.

| Task | Flat scored / failed | Hierarchy scored / failed | Expanded scored / failed |
|---|---:|---:|---:|
| PQA | 23 / 1 | 21 / 3 | 21 / 3 |
| ORD | 20 / 4 | 22 / 2 | 21 / 3 |
| ERR | 18 / 6 | 20 / 4 | 21 / 3 |
| GEN | 24 / 0 | 24 / 0 | 24 / 0 |

Detailed metrics, common-scorable comparisons, per-case hashes and source
references: replay report (`bioprobench-corpus-followup-evaluation.json`, local artifact).

Validation: 343 server tests passed across 48 files; the Python coverage unit
test passed; server typecheck passed. A three-collection integration smoke test
verified that index-only builds need no task files and include every source ID
in all three representations. Full-corpus per-file row accounting reconciled,
and all three indexes contain 14,361 distinct indexed source IDs.

The rebuilt index is at `/private/tmp/labee-bioprobench-expanded-corpus-index`;
raw verified files are at `/private/tmp/labee-bioprobench-complete-corpus` (the
name is historical and does not imply full upstream coverage); predictions and
checkpoints are at `/private/tmp/labee-bioprobench-corpus-followup`. Committed
manifests and commands recreate these artifacts. No production corpus was
modified and nothing was pushed or deployed.

Next: obtain the authors' source-to-question mapping and remaining original
source files, then use source-ID coverage to distinguish ingestion gaps from
retrieval misses. Evaluate a fresh, source-linked split before tuning retrieval
further on these already analyzed questions.

The separate [paper-context follow-up](bioprobench-paper-context.md) evaluates the
paper's task-specific chunk lengths, overlaps and top-k counts on the same repaired
corpus and frozen 96 questions, holding BM25 ranking fixed.
