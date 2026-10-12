# BioProBench: paper retrieval configuration, 50 questions per task

> Generated JSON reports and downloaded datasets are local artifacts excluded from Git.
> References and commands below use local report paths; Markdown summaries remain in the repository.

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
  --report docs/bioprobench-nebius-paper-50-evaluation.json --exclude-provider-refusals
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
were reused. The machine-readable report (`bioprobench-nebius-paper-50-evaluation.json`, local artifact)
contains selection provenance, per-question scores, source references, dense
ranks, component scores, prompt/response hashes and failure counts.

At the user's request, primary results now exclude the 25 provider biology
refusals from both scores and denominators. This leaves **175 evaluated cases**.
Other failures remain zero. No model calls were repeated and no replacement
questions were sampled. GEN uses core token-overlap F1, not scientific validity
or laboratory success.

| Task | Updated score | Evaluated | Refusals excluded |
|---|---:|---:|---:|
| QA accuracy | **81.25% (39/48)** | 48 | 2 |
| ORD exact ordering | **55.81% (24/43)** | 43 | 7 |
| ERR accuracy | **75.56% (34/45)** | 45 | 5 |
| GEN token F1 | **0.2803**, mean over 39 | 39 | 11 |

Two ORD cases (`TEST-ORD-000020`, `TEST-ORD-000111`) contain five reference/input
steps but only four distinct strings, which the official evaluator rejects.
They are not provider refusals, so they remain in the updated 43-question
ordering denominator as zero. Excluding those two as well would give 24/41 =
58.54%, but that is a different exclusion policy from the one requested.

The machine-readable report's `primaryScorePolicy` and `primaryScores` record
this revision, including excluded IDs and subtype denominators. Original
`allQuestionScores`, official `metrics`, and all 200 case records remain available
for audit. In particular, the original official GEN metric includes empty refusal
outputs as zero; use the revised `primaryScores` value above for this exclusion
policy. ERR's positive class remains **contains an error**.

Subtype results below apply the same provider-refusal exclusion policy:

| Task | Subtype | Evaluated | Accuracy / mean token F1 |
|---|---|---:|---:|
| QA | Operation | 15 | 86.67% (13/15) |
| QA | Parameter | 17 | 82.35% (14/17) |
| QA | Reagent | 16 | 75.00% (12/16) |
| ORD | Child | 28 | 57.14% (16/28) |
| ORD | Top | 15 | 53.33% (8/15) |
| ERR | Correct protocol | 22 | 81.82% (18/22) |
| ERR | Operation error | 7 | 57.14% (4/7) |
| ERR | Parameter error | 9 | 100.00% (9/9) |
| ERR | Reagent error | 7 | 42.86% (3/7) |
| GEN | Difficulty | 3 | 0.5563 |
| GEN | Easy | 25 | 0.2153 |
| GEN | Standard | 11 | 0.3530 |

These subgroups are small. For example, the parameter-error result is nine cases,
not evidence of perfect general performance. This sample differs from the prior
24-per-task run, so score changes between those runs cannot be attributed to a
retrieval improvement. The retrieval algorithm is unchanged.

## Comparison with the original paper

The comparison target is **ProAgent with retrieval** in the published BioProBench
paper, not its standalone LLM baselines. Figures 7 and Section 6.2 report the
ProAgent results ([paper, pages 8–9](https://raw.githubusercontent.com/mlresearch/v306/main/assets/liu26cu/liu26cu.pdf#page=8)).
The authors' [project leaderboard](https://yuyangsunshine.github.io/BioPro-Project/#leaderboard)
provides more precise ERR accuracy and ORD Kendall's tau values. Differences
below are our score minus the paper score; percentage differences are percentage
points (pp).

| Metric | Original ProAgent | Our refusal-excluded run | Difference |
|---|---:|---:|---:|
| QA accuracy | 85.08% | 81.25% (39/48) | −3.83 pp |
| ORD exact match | Approximately 71% (rounded Figure 7 label) | 55.81% (24/43) | Approximately −15.19 pp |
| ERR accuracy | 81.55% (authors' leaderboard; Figure 7 rounds to 82%) | 75.56% (34/45) | −5.99 pp |
| ERR F1, error-positive | 81.90% | 74.42% (45 cases) | −7.48 pp |
| GEN semantic step recall | 62.24% (Section 6.2) | Not measured | Not comparable |
| GEN token-overlap F1 | Not reported | 0.2803 (39 cases) | Not comparable |

The paper's Figure 7 rounds GEN step recall to 63%; the table above uses the
explicit 62.24% in Section 6.2. It does not infer extra precision for ORD exact
match from the chart. ERR F1 uses incorrect/error-containing steps as the
positive class in both the original `Metrics/ERR.py` and the current evaluator.

For an additional ordering diagnostic, the official evaluator gives **0.8214
Kendall's tau over 41 scorable cases**, compared with **0.891** on the authors'
leaderboard (difference −0.0696). It uses pair-weighted aggregation, matching
the original `Metrics/ORD.py`. These 41 cases also yield **58.54% exact match**
(approximately 12.46 pp below the paper); this diagnostic excludes the two
duplicate-step reference cases as well as refusals. The requested primary ORD
result remains **55.81% over 43 cases**.

This is a descriptive comparison, not a controlled reproduction. Our retained
sample is 48 QA / 43 ORD / 45 ERR / 39 GEN, versus the paper's full test sets of
1,200 / 1,161 / 1,200 / 772. Our corpus has 14,361 indexed records versus roughly
27,000 protocols, and our generator is Opus 5.5 versus Gemini 2.5 Pro for
QA/ORD/ERR and Claude 3.7 Sonnet for GEN. We explicitly exclude 25 provider
refusals; identical refusal handling in the published experiment is not
established. These differences prevent attributing the score gaps to retrieval
alone or treating them as statistically established performance differences.

The largest observed gap is exact ordering. For generation, the next comparison
should score the existing retained outputs with the paper's keyword and semantic
step metrics; token-overlap F1 cannot establish whether we match its GEN result.

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
