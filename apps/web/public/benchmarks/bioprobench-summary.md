# Labee · BioProBench experiment

200 selected questions: 50 each of question answering (QA), step ordering (ORD),
error detection (ERR), and protocol generation (GEN). All three runs used
claude-opus-5-5. These are single draws on previously analyzed development
questions, not a fresh held-out evaluation or a reproduction of the full paper.

## Same-case results

Each row uses identical cases across all three runs, excluding provider refusals
in any run. Other failures remain zero, including two malformed ORD references.

| Metric | Matched N | No RAG | Plain RAG | Patched agent |
|---|---:|---:|---:|---:|---:|
| QA accuracy | 46 | 73.91% | 80.43% | 80.43% |
| ORD accuracy | 42 | 50.00% | 57.14% | 61.90% |
| ERR accuracy | 43 | 67.44% | 74.42% | 74.42% |
| GEN token F1 | 36 | 0.1970 | 0.2741 | 0.2908 |
| Total model calls | — | 200 | 200 | 418 |

Model calls cover all 200 selected cases. Matched N counts retained questions.
GEN is core token-overlap F1, not semantic step recall or scientific correctness.

## Approaches

- No RAG: one fresh model call with the official question prompt, no retrieved
  passages, external tools, planner, reflection, or revision.
- Plain RAG: one model call with the official question and retrieved protocols.
- Patched agent: the public BioProAgent code, adapted to BioProBench with
  schema fixes, state-based plans, review, and at most two revisions. It uses
  the same frozen evidence as plain RAG and no redundant neural-planning calls.
  This is an evaluation of patched research code, not a claim that these are
  end-to-end production Labee scores.

RAG uses the available 14,361-record corpus, Qwen3-Embedding-8B, FAISS
IndexFlatL2, 60 dense candidates, and semantic/BM25 weighting of 60/40.
QA/ERR use 2,000-character chunks with 400 overlap and top 5 retrieval;
ORD/GEN use 5,000-character chunks with 1,000 overlap and top 3 retrieval.
Original question context is present in every arm. Gold answers are only used
by the evaluator. No failed or refused trials were retried or replaced.

## Findings and limitations

Retrieval's clearest benefit is GEN. In the separate no-RAG versus plain-RAG
pairwise comparison, 37 questions remain (rather than the 36 common to all three
arms). GEN F1 is 0.1943 without retrieval and 0.2698 with retrieval. The paired
bootstrap 95% interval for RAG minus no RAG is +0.0423 to +0.1120.

The accuracy differences remain uncertain at this sample size. For no RAG
versus RAG, exact McNemar p-values are 0.25 for QA and 0.453 for ORD and ERR.
Repeated model draws and a fresh holdout would be needed for stronger claims.
Provider refusal exclusions can introduce selection bias. Higher token overlap
does not establish greater scientific correctness or experimental success.

The no-RAG run had 30 provider biology refusals and no other call failures.
The plain-RAG run had 25 refusals, and the patched-agent run had 28. Seven
no-RAG evaluation-harness tests passed; these verify input isolation, preparation,
serialization, checkpoint reuse, and comparison logic, not scientific quality.

## Sources and provenance

- BioProBench dataset and evaluator:
  https://github.com/YuyangSunshine/bioprobench/tree/cf00fecd62583b98350cc48e26a29c92d3f21e5d
- Public BioProAgent source:
  https://github.com/YuyangSunshine/bioproagent/tree/e18586ab4a2a851433bedc0e6940b77470355fd6
- BioProAgent research license:
  https://github.com/YuyangSunshine/bioproagent/blob/e18586ab4a2a851433bedc0e6940b77470355fd6/Licenses.md

The displayed table is transcribed from Labee's frozen
`docs/bioprobench-no-rag-comparison.json` commonCases results. Full development
reports are retained in the repository under docs/bioprobench-no-rag.md and
docs/bioprobench-proagent-fixes.md. This summary contains no protocol text or
reference answers.
