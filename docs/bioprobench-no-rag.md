# Plain LLM without retrieval: BioProBench baseline

This run uses one fresh `claude-opus-5-5` call for each of the same 200 frozen
BioProBench cases: 50 each of PQA, ORD, ERR, and GEN. It supplies the official
question prompt alone. There is no retrieval, embedding, agent planner,
reflection, revision, persistent session memory, or external tool use.

Context contained in the official question remains present—for example, the
neighboring steps supplied by an ERR question. No corpus passages or empty
retrieved-evidence header are appended. Reference answers remain with the
scorer. The CLI system prompt, model, task formatting, and scorer are unchanged
from the [plain-RAG run](bioprobench-nebius-paper-50.md); the experimental change
is removal of retrieved evidence. The CLI uses its default sampling settings.

Eight concurrent workers execute exactly one call per case. Completed failures
are checkpointed and never retried or replaced. Reports exclude provider biology
refusals from primary scores; matched comparisons exclude a case if either arm
refused it. Other failures, including the two known malformed ORD references,
remain zero. All-selected scores and excluded IDs are retained for audit.

These are previously analyzed development questions, not a new holdout. A
single draw per question does not establish general superiority of an approach.
GEN uses the existing core token-overlap F1 metric, not the original paper's
semantic step-recall measure.

## Results

All **200 calls completed**, with **30 provider biology refusals and no other
call failures**. The no-RAG run used exactly 200 model calls, the same as plain
RAG and fewer than the patched agent's 418. No embeddings, index queries, or
retrieval calls occurred. Median model latency was 11.04 seconds, versus 8.18
seconds for the stored RAG run and 22.21 seconds for the patched agent; these
were separate runs with different load conditions (RAG used four workers,
no-RAG and patched agent eight), so latency is descriptive rather than a
controlled speed comparison.

### Same-case comparison across all three runs

Every column below uses exactly the same question IDs. A case is excluded if
**any** of the three runs refused it; other failures remain zero. This changes
the denominators from earlier reports that compared fewer arms.

| Task / metric | Matched N | Plain LLM, no RAG | Plain RAG | Patched ProAgent |
|---|---:|---:|---:|---:|
| QA accuracy | 46 | **73.91%** | 80.43% | 80.43% |
| ORD accuracy | 42 | **50.00%** | 57.14% | 61.90% |
| ERR accuracy | 43 | **67.44%** | 74.42% | 74.42% |
| GEN core token F1 | 36 | **0.1970** | 0.2741 | 0.2908 |
| Model calls, all 200 selected cases | — | **200** | 200 | 418 |

The standalone no-RAG scores, excluding only its own refusals, are:

| Task | Refusals / 50 | Evaluated | Score | Other unscorable cases |
|---|---:|---:|---:|---:|
| QA | 3 | 47 | 74.47% | 0 |
| ORD | 8 | 42 | 50.00% | 2 known malformed references |
| ERR | 6 | 44 | 68.18% | 0 |
| GEN | 13 | 37 | 0.1943 token F1 | 0 |

### What retrieval contributed in this comparison

Compare no-RAG directly with the stored plain-RAG run, excluding a case only
when either of those two runs refused it. GEN then includes 37 cases instead
of the 36 common to all three arms.

| Task | Paired N | No RAG | RAG | RAG minus no RAG | Paired bootstrap 95% interval |
|---|---:|---:|---:|---:|---:|
| QA accuracy | 46 | 73.91% | 80.43% | +6.52 pp | 0.00 to +15.22 pp |
| ORD accuracy | 42 | 50.00% | 57.14% | +7.14 pp | −4.76 to +19.05 pp |
| ERR accuracy | 43 | 67.44% | 74.42% | +6.98 pp | −4.65 to +18.60 pp |
| GEN token F1 | 37 | 0.1943 | 0.2698 | +0.0755 | +0.0423 to +0.1120 |

Retrieval has the clearest measured benefit for **GEN token overlap**: RAG
improved 28 of 37 paired cases and worsened nine; the paired interval excludes
zero. The accuracy differences remain uncertain: exact paired McNemar p-values
are 0.25 for QA and 0.453 for both ORD and ERR. Bootstrap intervals are based on
10,000 resamples of these questions, not repeated model generations; they do
not account for development-set reuse or provider refusal selection.

This supports retaining retrieval for the next experiment. The
[agent experiment](bioprobench-proagent-fixes.md) found a much smaller and
uncertain added benefit from review/revision over plain RAG. A fresh held-out
comparison should therefore retain **plain LLM, plain RAG, and RAG plus agent**
as separate arms. A more informative GEN quality measure is needed before
claiming that higher token overlap means better scientific quality.

## Artifacts and validation

- [Per-case evaluation](bioprobench-no-rag-evaluation.json), including own-arm
  scores, exclusions, all-selected scores, and paired RAG comparison.
- [Three-arm comparison](bioprobench-no-rag-comparison.json), including paired
  confidence intervals and common-case IDs.
- Seven targeted tests passed: no-RAG input isolation and preparation, unchanged
  RAG serialization, checkpoint reuse, and paired/common-case reporting.
- All 200 response prompt hashes match the exact official question formatter;
  all responses record zero passages, retrieved characters/bytes, and retrieval
  time. Report source-reference lists and index usage are empty/zero.
- All 200 IDs are unique, 50 per task, and their input samples equal the frozen
  baseline. Runner and renderer hashes match the manifest; all reported model
  usage is for `claude-opus-5-5`.

## Reproduce

```sh
python3 apps/server/eval/bioprobench/prepareNoRag.py \
  --base /private/tmp/labee-bioprobench-nebius-paper-50 \
  --out /private/tmp/labee-bioprobench-no-rag-50

CLAUDE_BIN=/Users/martin/.local/bin/claude \
  python3 apps/server/eval/bioprobench/run.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-no-rag-50 \
  --model claude-opus-5-5 --workers 8 --live

python3 apps/server/eval/bioprobench/report.py \
  --source /private/tmp/labee-bioprobench-research \
  --out /private/tmp/labee-bioprobench-no-rag-50 \
  --report docs/bioprobench-no-rag-evaluation.json \
  --baseline-report docs/bioprobench-nebius-paper-50-evaluation.json \
  --exclude-provider-refusals

python3 apps/server/eval/bioprobench/compareBaselines.py \
  --report docs/bioprobench-no-rag-evaluation.json \
  --baseline rag=docs/bioprobench-nebius-paper-50-evaluation.json \
  --baseline agent=docs/bioprobench-proagent-fixes-evaluation.json \
  --out docs/bioprobench-no-rag-comparison.json
```

Preparation requires an empty output directory; rerun only `run.py` to resume.
The manifest records the baseline manifest, runner, and prompt renderer hashes.
It deliberately omits the RAG arm's embedding configuration and index files.
The inherited reference-corpus audit and source aliases support paired reporting
only; neither is supplied to the model. Recorded retrieval time, index usage,
passage count, and retrieved-context size are all zero.

Full local responses remain in `/private/tmp/labee-bioprobench-no-rag-50`.
Shareable reports contain scores, exclusions, model usage, and hashes rather
than protocol text or answers.
