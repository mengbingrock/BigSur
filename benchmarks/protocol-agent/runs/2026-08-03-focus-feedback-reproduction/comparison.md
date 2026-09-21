# Labee versus direct Codex ReAct comparison

The direct condition used an isolated Codex CLI process with ignored user
config and project rules, ephemeral session storage, a fresh temporary working
directory, read-only sandboxing, and no native web search. Its only retrieval
tool was the benchmark-owned `mcp__literature__search`, which queries Crossref
metadata and fail-closed filters to `publicationDate < 2026-07-01`.

It did not use Labee, a protocol skill, `mcp__protocols__search`, article fetch,
Chrome, general web search, plugins, or prior transcripts.

| Metric | Labee Plan → Build | Direct Codex ReAct | Delta (Codex − Labee) |
|---|---:|---:|---:|
| Formula score | 0.839 | 0.879 | +0.040 |
| Hard pass | yes | yes | — |
| Case pass at 0.85 | no | yes | — |
| Fidelity | 0.946 | 0.946 | 0.000 |
| Procedure structure | 0.800 | 1.000 | +0.200 |
| Provenance | 0.667 | 0.667 | 0.000 |
| Usefulness | 0.833 | 0.833 | 0.000 |

## Direct-run audit

| Audit | Result |
|---|---:|
| Model | GPT-5.6-sol |
| Search tool | `mcp__literature__search` only |
| Search calls | 10 |
| `mcp__protocols__search` calls | 0 |
| Protocol skills / Labee | 0 / no |
| Unique returned DOIs | 94 |
| DOIs strictly before 2026-07-01 | 94 |
| Post-cutoff violations | 0 |
| Unresolved dates | 0 |
| Hidden DOI/title/software-name matches | 0 |
| Article fetch / native web / Chrome | 0 / 0 / 0 |
| Strict audit | pass |

## Formula and conservative deductions

```text
0.40*(26.5/28) + 0.20*(5/5) + 0.20*(4/6) + 0.20*(5/6)
= 0.878571 → 0.879
```

The direct response receives half credit for analysis deliverables because it
does not include an explicit kymograph, and half credit for timing because it
does not explicitly frame the complete configured workflow as a one-day task
after setup. It receives no source-text or claim-level verification credit
because retrieval was intentionally limited to metadata and abstracts.

The direct run took 330.8 seconds, made 10 searches, and emitted 12,418 output
tokens including 8,482 reasoning tokens. The local Codex event stream did not
report dollar cost.

This comparison changes both orchestration and model: Labee used Claude Opus 5,
while the direct run used GPT-5.6-sol. Therefore the +0.040 is a case-level
system comparison, not evidence that one orchestration method or model is
generally better. Paired repeated runs are required for that conclusion.

The historical direct-Claude score of 0.879 is excluded from this comparison
because that run called `mcp__protocols__search`, which the current condition
prohibits.

## Built-in web-search-only rerun

| Metric | Direct Codex + independent literature MCP | Direct Codex + built-in web only |
|---|---:|---:|
| Raw quality | 0.879 | 0.829 |
| Hard pass | yes | no |
| Benchmark score after gate | 0.879 | 0.000 |
| Search queries | 10 | 10 |
| MCP calls | 10 | 0 |
| Built-in web-search actions | 0 | 3 |
| Complete result payload auditable | yes | no |

The built-in-web condition obeyed the tool restriction: all 10 observable
queries included `before:2026-07-01`, no MCP or other tool ran, and all eight
final citations were published before the cutoff. However, native web-search
events expose the queries but not the complete returned result payloads.
Consequently, the audit cannot prove that Codex was never shown a post-cutoff
or hidden-answer result. The run therefore fails the strict answer-blind gate;
its 0.829 is diagnostic response quality, not a valid benchmark score.
