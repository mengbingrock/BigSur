# Siri context router: implementation and validation

> Generated JSON reports and downloaded datasets are local artifacts excluded from Git.
> References and commands below use local report paths; Markdown summaries remain in the repository.

Branch: `feat/siri-context-retrieval` (isolated `.claude/worktrees/siri-context`).

The default `/api/siri/say` path now runs an application-owned retrieval loop. `LABEE_SIRI_CONTEXT=0` selects the legacy planner and pauses the new worker without deleting its persisted tasks. No production deployment is part of this change.

## Search and exact reads

SQLite FTS5 indexes local and mirrored session titles, messages, durable session events, run names/snapshots, and run events. Triggers maintain derived rows in the source transaction. Existing databases backfill in resumable batches and report incomplete coverage until finished. Searches filter account/host/status/archive/date before paging. Exact reads validate the source's account ownership each time.

A bounded page is not a history horizon. The model can repeatedly search, follow cursors, read around an anchor, and continue long messages/tool results by character offset. Search cursors reject changed indexes rather than silently skip results. Working evidence compacts by payload size, keeping durable task-event references for reopening it.

Named online hosts answer authoritative reads through Device Link. A desktop can query the box and other Macs through the box. Offline mirrors expose receipt timestamps and observed sequence watermarks, always marked incomplete. Reconnect replication now enumerates all sessions, including archives, and copies messages in pages; it does not prune against a truncated session list. Historical event replication remains incomplete and is represented as such.

## Buildable embedding index

The context index is separate from the existing protocol/artifact and shared-library indexes:

1. Canonical context documents arrive through the source triggers/backfill.
2. Session transcript text splits into 1,800-character chunks with 200-character overlap. Protocol/run source text now uses the BioProBench hierarchy described in `bioprobench-hierarchy-implementation.md`; run vectors carry exact node references.
3. The existing embedding provider embeds batches of up to 32 chunks. Its default real model is `text-embedding-3-small`; `LABEE_EMBED_MODEL` selects another model. `LABEE_EMBED_PROVIDER=fake` is test-only.
4. Unit-normalized Float32 vectors are stored as SQLite BLOBs, with model and dimension metadata. A per-document completion record makes builds resumable. Changed/deleted sources invalidate their vectors; a changed model leaves old vectors ineligible until rebuilt.
5. The agent can call `index.status` and `index.build`. Missing credentials are reported, never treated as a successful semantic build.
6. `sessions.search` and `runs.search` accept `mode: lexical | semantic | hybrid`. Dense retrieval embeds the query and scores all authorized vectors in batches using cosine similarity. It has no keyword candidate gate. Hybrid retrieval merges independent lexical and dense rankings with reciprocal-rank fusion. Returned references reopen original records; retrieval can continue across pages.

An administrator can also finish a build explicitly against the intended data directory:

```sh
LABEE_DATA_DIR=/path/to/labee-data bun run apps/server/scripts/indexContext.ts --email scientist@example.com
```

This requires the account's configured embedding credential, the provided-tier proxy, or the configured server key. It does not use Claude's chat subscription as an embedding credential. It resumes pending work and exits only when the backfill/index is ready; provider failures fail the command. Source history was not uploaded or indexed against a real provider during this implementation.

Example authenticated context API bodies:

```json
{"tool":"index.status"}
{"tool":"index.build","limit":20}
{"tool":"sessions.search","query":"keeping specimens cold","mode":"hybrid"}
{"tool":"messages.read","sessionId":"ses_...","messageIdx":42}
```

The first implementation uses exact vector scans, not FAISS or an ANN service. This preserves recall and simple account isolation; query CPU grows with the account's indexed corpus. Protocol files continue to use the existing artifact-index build/search services; the new context vectors cover conversational and run evidence.

## Task and action durability

Requests deduplicate by account and client request ID. Model/tool decisions and checkpoints persist across scheduling slices and process restarts. Independent tasks have leases; cancellation prevents an outstanding model response from authorizing a later action. Multiple confirmations require an explicit target or clarification.

Confirmations retain exact action arguments and target-state fingerprints. Execution rechecks the authoritative target. Receipts live on the mutation owner, including tunneled actions, and duplicate operations return the stored outcome. A process crash between starting a side effect and recording its outcome leaves an **uncertain** receipt: the router reports uncertainty and does not repeat the action. Existing run/chat services are not converted into one cross-service atomic transaction.

Each child operation has a delegation ID and turn/queue reference, so two children in one chat can settle independently. Durable turn-ended events recover missing return messages after restart. Late confirmations retain their confirmation ID and question type. Unread results are durable; push delivery remains best effort, as in the existing notification service.

Legacy exchanges migrate once; transcripts retain their original IDs. A legacy confirmation must be proposed again because its original representation had no target-state fingerprint.

## Validation and remaining release checks

All 327 server tests pass across 45 files. Server and mobile TypeScript checks, the server build, Swift syntax parsing for the changed Siri request file, and `git diff --check` also pass. The build retains its existing `gray-matter` direct-eval warning.

Automated coverage includes long/old histories, archives, correction reads, continuation of long messages and tool output, cross-account isolation, offline mirrors, authoritative host reads, repeated tool calls, request/action retries, stale and ambiguous confirmations, interrupted leases, cancellation during model work, multiple children, late confirmation delivery, resumable embedding builds, vector-only candidate recall, and edit/delete invalidation.

The embedding tests use the deterministic fake provider and an explicitly simulated synonymous vector pair. They validate indexing/retrieval mechanics, not real-model semantic quality. The live Claude evaluator (`apps/server/eval/siriContext.ts`) passed both synthetic cases: finding a correction within a 1,000-message current session (21.3 seconds) and finding an archived session behind 210 newer sessions (17.8 seconds). Each answer required both the correct fact and an original source read. See `siri-context-live-evaluation.json`. An earlier run answered one case from a search excerpt; `siri-context-live-evaluation.before-source-read.json` preserves that finding. The router now enforces a supporting read before accepting an answer from search evidence, with a regression test.

These two live cases are a smoke test, not a broad quality benchmark. Real embedding-provider semantic recall/latency and physical Siri/AirPods tests remain release checks. No production history was sent to an embedding provider.

## BioProAgent comparison

Reviewed public repository: https://github.com/YuyangSunshine/bioproagent

Its public `src/capabilities/retrieval/knowledge_sources.py` explicitly omits the private embedding index, chunks, and production connectors. `CustomFaissRetriever` is a compatibility stub; `get_retriever(k=3)` does not implement nearest-neighbor retrieval. Consequently its exact ingestion, chunking, embedding model, FAISS metric/index type, and index build process cannot be established from this release.

The visible `retrieve_knowledge` tool runs five lookups concurrently: Mem0 memory, the local retriever, PubMed, protocol search, and web search. It joins their results into labeled text for draft generation. The local and external connectors in the public retrieval module return placeholders. Memory is a separate Mem0 integration; it uses `session_id` as `user_id`, and initialization can fall back to a no-op backend. That code alone does not implement account-wide searching of arbitrary earlier sessions.

Sources:
- https://github.com/YuyangSunshine/bioproagent/blob/main/src/capabilities/retrieval/knowledge_sources.py
- https://github.com/YuyangSunshine/bioproagent/blob/main/src/tools/tool_definitions.py
- https://github.com/YuyangSunshine/bioproagent/blob/main/config/settings.py
- https://github.com/YuyangSunshine/bioproagent/blob/main/src/core/llms.py
