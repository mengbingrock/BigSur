# Opus 5.5 and protocol context expansion

Work is isolated on `feat/siri-context-retrieval`, following the hierarchy implementation in `a6fb940`. The exact model `claude-opus-5-5` was accepted by the authenticated CLI and confirmed in its `modelUsage` metadata. The model release is documented by [Anthropic](https://www.anthropic.com/claude-opus-5-5).

## Implementation

- **Protocol identity before node ranking.** An explicit unique title or library ID scopes shared-library search. Ambiguous names keep the global fallback. Personal-library identity resolution uses only the account's visible protocols.
- **Expand context from source nodes.** For an identified protocol or explicit expansion request, three ranked seeds grow through ancestors, adjacent siblings and descendants, then matching standalone materials/notes. Whole original node text is selected under a serialized evidence budget and restored to source order. This changes context assembly, not the embedded node representation or source content.
- **Dynamic router reads.** `protocols.read` now accepts `part:context` with an optional `nodeId` and query. Responses include exact node references, revision, omitted-node count and instructions to continue with tree navigation or text offsets. An 8,000-character response budget is not a searchable-history limit. Existing arbitrary-depth tree reads, pagination and revision-conflict checks remain available.
- **Source-linked answers.** Identified personal and shared Ask passages expand the same way and carry node IDs and content revision through citations.
- **Reproducible evaluation.** Four official task types, fresh ID exclusions, pinned model, checkpoint validation, source hashes, separate development audit, official metrics and paired intervals. Failed/refused calls remain in all-selected denominators.

The shared-library semantic path still reranks a lexical shortlist. This work does not introduce a dense candidate index or claim it finds zero-overlap semantic matches. No `OPENAI_API_KEY` or `LABEE_OPENAI_API_KEY` was available for a real embedding evaluation. The existing resumable embedding builder and deterministic plumbing tests remain available; fake embeddings are not used as evidence of semantic retrieval quality.

## Validation

The full server suite passed 339 tests across 47 files. Focused tests cover title ambiguity/ID boundaries, original node order, complete text under budgets, distractor exclusion, revision conflicts, and citation node/revision references. Server and mobile typechecks and the server build passed; the build retains the existing gray-matter direct-eval warning.

The real router passed 5/5 synthetic cases using Opus 5.5, including a correction buried in 1,000 messages and an archived session behind 210 recent sessions. All five checks required reading the expected source. The three protocol cases checked parameter, conditional context and step order; the final case used tree navigation and revision-bound context expansion. See [router report](siri-context-opus-evaluation.json).

## Benchmark design

The holdout contains 24 questions each for PQA, ORD, ERR and GEN, selected before model calls and excluding all previously analyzed pilot IDs. Three variants produce 288 predictions. The separate development audit reuses all 35 source-covered ordering cases with hierarchy and expanded retrieval, producing 70 more predictions. Both used the same 10,359 accepted source records, before the duplicate and corpus repair documented in [the follow-up](bioprobench-corpus-repair.md). Corpus/reference text and predictions stay in `/private/tmp`; only aggregate scores, IDs, hashes and source references are committed.

The official [evaluate-protocol-outputs skill](https://github.com/YuyangSunshine/bioprobench/blob/main/skills/evaluate-protocol-outputs/SKILL.md) supplies scoring. GEN uses core token-overlap metrics, which do not establish scientific correctness. These are sampled, single-run retrieval comparisons; they are not the complete leaderboard. Protocols are not held out from the source index: this evaluates retrieval from a corpus, with fresh test questions rather than unseen protocols.

Results and interpretation follow. All preselected runs completed.

### Source-covered ordering development audit

| Variant | Correct / all 35 | Official scored accuracy | Kendall tau | Target protocol included |
|---|---:|---:|---:|---:|
| Prior hierarchy, Opus 5.5 | 23/35 (65.7%) | 23/32 (71.9%) | 0.894 | 20/35 |
| Identity + expansion, Opus 5.5 | 27/35 (77.1%) | 27/32 (84.4%) | 0.964 | 26/35 |

Each variant had two provider biology refusals and one duplicate-step reference rejected by the official ordering scorer. All three count as incorrect in the all-selected column. The paired result was four wins, zero losses and 31 ties: +11.4 percentage points. The percentile bootstrap interval is +2.9 to +22.9 points, but exact McNemar p=0.125; with only four discordant pairs this is encouraging development evidence, not a reliable generalization claim. These cases were already used to diagnose the earlier retrieval failures.

Unique identity routing activated on 24/35 questions. Of the 11 unresolved titles, eight have multiple exact-title source records, and three also match other full protocol names in the query. The conservative resolver declines to choose among them. Expanded evidence included the intended title in 26/35 cases overall, and used 6,752 serialized characters on average versus 3,914 for the prior hierarchy. This supports both identified failure modes: source selection and context underfilling.

See [development evaluation](bioprobench-opus-development-evaluation.json). The earlier Haiku hierarchy run also scored 23/35, but single stochastic runs with different refusal patterns do not establish model equivalence. No Opus flat-window predictions were run on this development set; do not compare the old Haiku flat result as though the model were held constant.

### Fresh four-task experiment

Each row uses 24 questions. Failures count as zero. The expansion column is the **always-expand experimental candidate**, not a measurement of the final conditional default.

| Task / metric | Flat windows | Prior hierarchy | Identity + expansion candidate |
|---|---:|---:|---:|
| PQA accuracy | 75.0% (18/24) | 66.7% (16/24) | 70.8% (17/24) |
| ORD exact order | 41.7% (10/24) | 41.7% (10/24) | 41.7% (10/24) |
| ERR accuracy | 54.2% (13/24) | 66.7% (16/24) | 54.2% (13/24) |
| GEN token-overlap F1 | 0.209 | 0.202 | 0.202 |

No fresh-task comparison demonstrates a reliable improvement. Expansion versus hierarchy was +4.2 points for PQA, 0 for ORD, -12.5 for ERR (95% paired bootstrap interval -29.2 to +4.2), and +0.0003 token F1 for GEN. The original audit found 0/24 matches against whole-protocol titles. A subsequent section-aware audit corrected this to 1/24 matches in the original corpus: many ORD questions name subsections, not whole protocols. The split still mostly measures fallback behavior. See `bioprobench-corpus-coverage.json` for the source expansion and corrected audit; the historical model scores here are unchanged.

There were 45 provider biology safeguard refusals across the 288 calls and no other call failures. PQA/ORD/ERR failures are excluded by official scored metrics but included as incorrect above. The official GEN core scorer accepts an empty prediction and assigns token F1 zero, so it reports 24 scored even when calls were refused; the separate failure breakdown preserves that distinction. On the 17 GEN questions with usable responses across all variants, token F1 was 0.287 flat, 0.285 hierarchy and 0.277 expansion. Generated text overlap is not a scientific correctness score.

See [original fresh evaluation](bioprobench-opus-evaluation.json). Expanded accounting includes source-reference metadata that is omitted from the model's displayed evidence, so budgets are nominally comparable rather than exactly token-matched. The evaluation uses the production identity/expansion helpers but omits production grain bonuses, embedding reranking and agent navigation.

## Decision after evaluation

Automatic context expansion is enabled only when a protocol identity resolves confidently. Unnamed/ambiguous queries retain the previous ranked-chunk path. Callers may explicitly request expansion, and the router can use `protocols.read` with `part:context` after choosing a source. This decision follows the mixed fresh results: broad expansion is not promoted as a universal improvement. The experiments above informed that decision; they are not an untouched evaluation of the final policy.

Final review also found that an explicitly named missing protocol could resolve to an incidental protocol name inside the steps. Explicit `titled`, `named`, or `called` targets now take precedence; missing and duplicate targets fall back globally. Tests cover both missing targets and conflicting incidental names. Five changed-evidence cases were reevaluated separately; all unchanged model/prompt checkpoints, including refusals, were reused. Original reports remain intact. These corrective follow-ups are post-hoc development measurements.

## Next evaluation priorities

1. Add source IDs/URLs and protocol versions to test cases, and expand the source corpus. Exact-title duplicates and missing source coverage currently dominate the retrieval diagnosis. Use a new untouched, source-linked split after these development experiments.
2. Evaluate real dense candidate retrieval plus lexical fusion once an embedding credential is configured. The shared-library lexical shortlist remains a recall bottleneck; no real embedding quality result is claimed here.
3. Evaluate generation with parameter/condition fidelity, citation support and expert review or validated semantic step metrics. Token overlap alone is insufficient. Increase sample sizes and repeat stochastic model calls on a prespecified evaluation design, preserving refusal rates rather than selectively retrying them.

No production corpus was ingested, and no changes were pushed or deployed.

The title-precedence correction made two fresh and three development calls (five new calls total, 353 unchanged checkpoints reused across the follow-up reports). Aggregate answer scores did not change. On the development set, target-title inclusion improved again from 26/35 to **27/35**, with 27 identities now resolved. The corrected reports are [four-task follow-up](bioprobench-opus-title-fix-evaluation.json) and [source-covered follow-up](bioprobench-opus-development-title-fix-evaluation.json). Total benchmark model calls for this work: **363** (288 + 70 + 5), plus 21 calls for the five synthetic router checks and one model-availability probe. These totals exclude the earlier Haiku work.
