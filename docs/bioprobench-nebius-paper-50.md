# BioProBench: paper retrieval configuration, 50 questions per task

This run keeps the preceding Nebius retrieval implementation and increases the
evaluation to 50 previously unevaluated questions per task, 200 total. Following
the user's updated instruction, the candidate set remains the paper's 60 dense
neighbors. BM25 scores those candidates; no separate lexical candidate pool is
added in this experiment.

| Setting | This run |
|---|---|
| Corpus | 14,361 indexed records |
| Embedding model | Nebius `Qwen/Qwen3-Embedding-8B`, 4,096 dimensions |
| Vector index | FAISS `IndexFlatL2`, normalized float32 vectors |
| Candidate selection | 60 nearest dense chunks |
| Hybrid ranking | 60% semantic, 40% `rank-bm25`; independent min-max scaling over the 60 candidates |
| QA / ERR evidence | 2,000-character chunks, 400 overlap, top 5 |
| ORD / GEN evidence | 5,000-character chunks, 1,000 overlap, top 3 |
| Evidence character cap | None; complete ranked chunks |
| Generator | `claude-opus-5-5` for all four tasks |
| Evaluation size | 50 QA, 50 ERR, 50 ORD, 50 GEN |

The embedding family, FAISS index type, candidate count, 60/40 weighting, chunk
sizes/overlaps and final retrieval counts follow
[the paper's Appendix C.3](https://raw.githubusercontent.com/mlresearch/v306/main/assets/liu26cu/liu26cu.pdf#page=15).
The paper's approximately 27,000-source corpus and Gemini 2.5 Pro / Claude 3.7
Sonnet generators remain different. Qwen size, score normalization, tokenization
and exact serialization are reconstruction choices detailed in the
[initial Nebius report](bioprobench-nebius-hybrid.md). This is not an exact
execution of the authors' original ProAgent.

## Selection and validation

`freshSelection.py` uses seed `nebius-paper-fresh-v1`, proportional largest-remainder
allocation by subtype and SHA-256 ordering of `seed:task:id` within each stratum.
ERR additionally stratifies by the official correctness status. Selection does
not consult model responses, prior success, hidden answer content, source-title
availability or retrieval scores. It was saved before the new query embeddings
and retrieval were run.

All question IDs selected by the nine prior evaluation reports and the base
paper-context selection are excluded. Task checksums must match. The manifest
records excluded counts, subtype quotas, report hashes and a new selection hash;
it removes the inherited hash of the older frozen selection. All 200 selected IDs
are new to the recorded evaluations. This is a fresh question sample, not an
independent corpus split or a full benchmark run.

| Task | Available | Previously evaluated IDs excluded | New selection |
|---|---:|---:|---|
| QA | 1,200 | 54 | 16 operation, 17 parameter, 17 reagent |
| ORD | 1,161 | 88 | 33 child, 17 top |
| ERR | 1,200 | 24 | 25 correct; 8 operation, 9 parameter, 8 reagent errors |
| GEN | 772 | 24 | 32 easy, 13 standard, 5 difficulty |

Fourteen Python tests pass, including deterministic exact-size sampling, prior-ID
exclusion, checksum rejection, response validation, real FAISS candidate gating,
and end-to-end preparation of both frozen and fresh selections. Retrieval code
and the document embeddings are reused unchanged. New predictions use fresh CLI
sessions, the official task prompts and no external tools. Failures/refusals are
checkpointed and retained without selective retries or resampling.

## Reproduce

Use the Python environment and completed indexes described in the
[initial Nebius report](bioprobench-nebius-hybrid.md#reproduce). Run from the worktree:

```sh
/private/tmp/labee-nebius-venv/bin/python apps/server/eval/bioprobench/prepareNebiusHybrid.py \
  --base /private/tmp/labee-bioprobench-paper-context \
  --embeddings /private/tmp/labee-bioprobench-nebius-index \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-paper-50 \
  --per-task 50 --exclude-report \
    docs/bioprobench-corpus-followup-evaluation.json \
    docs/bioprobench-hierarchy-covered-evaluation.json \
    docs/bioprobench-hierarchy-evaluation.json \
    docs/bioprobench-nebius-hybrid-evaluation.json \
    docs/bioprobench-opus-development-evaluation.json \
    docs/bioprobench-opus-development-title-fix-evaluation.json \
    docs/bioprobench-opus-evaluation.json \
    docs/bioprobench-opus-title-fix-evaluation.json \
    docs/bioprobench-paper-context-evaluation.json \
  --api-key-file /private/tmp/labee-nebius-api-key --live

python3 apps/server/eval/bioprobench/run.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-paper-50 \
  --model claude-opus-5-5 --workers 4 --live

python3 apps/server/eval/bioprobench/report.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-nebius-paper-50 \
  --report docs/bioprobench-nebius-paper-50-evaluation.json
```

Preparation requires a new empty output directory. Reproduce the same sample
with the explicit exclusion list above; a wildcard that includes this new report
would produce a different sample. Once prepared, rerun only the model runner to
resume interrupted predictions. The older 24-per-task results use different
questions and must not be treated as paired baseline predictions.

## Completed results

All 200 predictions completed and were scored with the upstream
[`evaluate-protocol-outputs` skill](https://github.com/YuyangSunshine/bioprobench/blob/cf00fecd62583b98350cc48e26a29c92d3f21e5d/skills/evaluate-protocol-outputs/SKILL.md),
BioProBench profile. All 200 usage records confirm `claude-opus-5-5`; no predictions
were reused. The [machine-readable report](bioprobench-nebius-paper-50-evaluation.json)
contains selection provenance, per-question scores, source references, dense
ranks, component scores, prompt/response hashes and failure counts.

Primary scores include all 50 questions per task. Call failures and unscorable
answers receive zero; GEN uses the official core token-overlap F1, not scientific
validity or laboratory success.

| Task | All-selected score | Provider refusals |
|---|---:|---:|
| QA accuracy | **78.0% (39/50)** | 2 |
| ORD exact ordering | **48.0% (24/50)** | 7 |
| ERR accuracy | **68.0% (34/50)** | 5 |
| GEN token F1 | **0.2187**, mean over 50 | 11 |

There were 25 provider biology refusals and no other model-call errors. Two more
ORD cases (`TEST-ORD-000020`, `TEST-ORD-000111`) were rejected by the official
ordering evaluator because their reference/input step lists each contain five
entries but only four distinct strings. Both model calls succeeded; these are
dataset/evaluator compatibility failures, not transport errors. The evaluator
requires unique ordering items. They remain in the primary 50-question
denominator as zero, and the official scorer excludes them.

The official scored-only metrics expose those different denominators:

| Task | Total | Scored | Failed | Official metrics |
|---|---:|---:|---:|---|
| QA | 50 | 48 | 2 | Accuracy 81.25%; Brier 0.11674 |
| ORD | 50 | 41 | 9 | Exact match 58.54%; Kendall tau 0.8214 |
| ERR | 50 | 45 | 5 | Accuracy 75.56%; precision 0.8000; recall 0.6957; F1 0.7442 |
| GEN | 50 | 50 | 0 | Token F1 0.2187; precision 0.1463; recall 0.5431 |

ERR uses **contains an error** as the positive class. The GEN scorer accepts
empty outputs and assigns zero overlap, so its 50 scored cases include all 11
provider refusals. "Scored" does not imply a successful model response.

Subtype results, with the same all-selected failure policy:

| Task | Subtype | Count | Accuracy / mean token F1 |
|---|---|---:|---:|
| QA | Operation | 16 | 81.25% (13/16) |
| QA | Parameter | 17 | 82.35% (14/17) |
| QA | Reagent | 17 | 70.59% (12/17) |
| ORD | Child | 33 | 48.48% (16/33) |
| ORD | Top | 17 | 47.06% (8/17) |
| ERR | Correct protocol | 25 | 72.0% (18/25) |
| ERR | Operation error | 8 | 50.0% (4/8) |
| ERR | Parameter error | 9 | 100% (9/9) |
| ERR | Reagent error | 8 | 37.5% (3/8) |
| GEN | Easy | 32 | 0.1682 |
| GEN | Standard | 13 | 0.2987 |
| GEN | Difficulty | 5 | 0.3338 |

These subgroups are small. For example, the parameter-error result is nine cases,
not evidence of perfect general performance. This sample differs from the prior
24-per-task run, so score changes between those runs cannot be attributed to a
retrieval improvement. The retrieval algorithm is unchanged.

## Retrieval and resource audit

The actual manifest's retrieval configuration, document-index hashes, task
profiles and context parameters match the preceding Nebius run exactly. All 200
jobs contain the intended 5 or 3 complete chunks; each saved dense rank is within
60 and every fused score satisfies the 60/40 formula. There are no prior question
ID overlaps. A pre-retrieval selection snapshot matches the final manifest.

Of the 50 ORD questions, 13 have an exact root/section title match, including four
ambiguous matches. Considering only the nine unambiguous matches, six retrieve
the matching protocol in their final three passages. Eight of these nine are
answered correctly, so answer accuracy is not equivalent to source retrieval
success. The remaining 37 unmatched titles have unresolved source availability;
they are not proven missing. Other tasks lack dependable source IDs for the same
audit.

No document embeddings were rebuilt. The 200 new query embeddings consumed
26,233 tokens, an estimated $0.000262 at the previously documented $0.01/M rate;
this excludes generator usage and is not an invoice. Median retrieval time was
22.8 ms, excluding query embedding and index loading; median model time was
8.18 seconds. Mean serialized evidence sizes were 9,660 / 11,930 / 9,556 / 12,466
characters for QA / ORD / ERR / GEN. There were 179 jobs above 8,000 characters;
shorter contexts reflect complete short chunks, not a character cap.

The next controlled comparison should reuse these exact 200 question IDs for a
second retrieval variant. Until such a paired comparison exists, this run
establishes the larger-sample performance of the requested paper-style settings,
not their advantage over lexical-only or candidate-union retrieval. Full paper
replication still requires resolving the corpus and generator differences.
