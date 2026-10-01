# Protocol search and categorisation with an embedded agent — design

Supersedes the "search" and "categories" mechanics in `protocol-home-design.md` (PR #45) and the substring search shipped in PR #46. The page, the rail, and the folder-as-category storage model stay. What changes is how a protocol is *found* and how it gets *sorted*: retrieval over embeddings rather than string matching, and a small server-side agent that proposes categories rather than a person naming folders by hand.

## 1. What "RAG" and "agent" mean here

- **Retrieval** — every protocol is split into chunks, each chunk is turned into a vector by an embedding model, and a query is answered by finding the chunks whose vectors are nearest to the query's vector. "Phenol extraction" finds the protocol that says "organic phase separation" even though the words differ.
- **Generation** — on request, the top chunks are handed to a language model that writes a short answer with citations back to the protocols it used ("Ask" mode). This is optional per query; plain retrieval never calls the language model.
- **Agent** — a server-side loop with three tools (retrieve, list categories, propose categories) that, given the current library, proposes which category each uncategorised protocol belongs in and, when the library has no useful categories yet, proposes a taxonomy. It is *embedded*: it runs inside the Labee server with the caller's own credentials, and it never moves a file itself. A person applies its proposals.

## 2. Where the model calls go

Labee already routes model traffic three ways, and this reuses that exactly (`resolveCredential` in `services/llmSettings.ts`):

| Situation | Embeddings and agent calls go to |
|---|---|
| Person has their own OpenAI key | OpenAI directly, with their key |
| Desktop on the "provided" tier | The labee.online inference proxy (`/api/llm/openai/…`), metered against their credits like any other call |
| The hosted box itself | Its own `LABEE_OPENAI_API_KEY` |
| No credential resolvable | Indexing is skipped; search falls back to the substring path and the UI says so |

Models: `text-embedding-3-small` (1536 dimensions, cheap, good enough for lab prose) for vectors; a small chat model with JSON output for the agent and for Ask. Both names are env-overridable (`LABEE_EMBED_MODEL`, `LABEE_AGENT_MODEL`), so the box can move to a newer model without a deploy.

Why OpenAI rather than the `claude` CLI already used for chat: embeddings are not something the CLI exposes, and the agent's calls are short structured-JSON exchanges where spawning a CLI per call is the wrong shape. The chat path is untouched.

## 3. Storage

Two SQLite tables next to the existing ones. No vector database.

```
artifact_index
  slug            TEXT PRIMARY KEY
  content_hash    TEXT      -- sha256 of SKILL.md body + name + description
  model           TEXT      -- embedding model the chunks were made with
  chunk_count     INTEGER
  indexed_at      TEXT

artifact_chunks
  slug            TEXT
  idx             INTEGER
  heading         TEXT      -- "Materials › Buffers", for the snippet label
  text            TEXT
  vector          BLOB      -- Float32Array, little-endian
  PRIMARY KEY (slug, idx)
```

Similarity is computed in-process: load every vector of the caller's visible protocols once into memory (a few MB at most), cosine against the query, sort. A lab library is hundreds of protocols and a few thousand chunks; that is sub-millisecond. The vectors are cached per process and invalidated by the indexer, so the disk is only read when something changed. If a library ever reaches tens of thousands of chunks the same table can be backed by `sqlite-vec` without changing the API; that is the only growth path and it is not needed now.

Visibility is enforced at query time, not index time: the index holds chunks for every protocol the server can see, and a query only scores chunks whose slug is in `getAllSkills(email)` for that caller. Shared `_public` protocols are indexed once and served to everyone.

## 4. Chunking

A protocol is a Markdown document with sections, and the section is the unit a person wants back ("the lysis step", "the buffer recipe").

1. Split on headings; carry the heading path down, so a chunk knows it is under *Materials › Buffers*.
2. Within a section, window at ~400 tokens with a 60-token overlap so a step that straddles a boundary is not lost.
3. Prefix each chunk's text, before embedding, with `Protocol: <name> — <heading path>`. This contextual header is what lets a chunk that just says "spin 5 min at 16,000 g" match "how long do I centrifuge in the miniprep": the protocol's name is part of the vector.
4. Store the chunk *without* the prefix; the prefix is for the model, the text is for the person.

Tables, code fences and lists are kept whole where they fit in a window, split at row or item boundaries when they do not.

## 5. Indexing

Incremental and never on the request path for more than one protocol.

- **Trigger points**: after `createSkill`, `saveSkill`, `saveSkillFile`, the three imports, and `moveSkillToCategory` (a move changes nothing in the text but the index row is keyed by slug and slugs survive moves, so this is a no-op; listed for completeness). Each enqueues that slug.
- **Reconcile on demand**: the search and suggest endpoints, and `GET /api/skills`, run a cheap diff — hash every visible protocol's content and compare with `artifact_index`. Anything missing or stale is enqueued. This is what picks up protocols edited on disk outside the app, which `_public` always is.
- **Queue**: a single in-process worker, one protocol at a time, embedding all of its chunks in one batched call (the API takes up to 2048 inputs per request). A protocol changed twice before the worker gets to it is embedded once.
- **First run** on a library of 300 protocols: roughly 300 batched calls, a minute or two, a few cents. `GET /api/skills/index/status` reports `{ total, indexed, pending, model }` so the page can show "Indexing 41 of 300…" instead of returning thin results silently.
- **Model change**: rows carry the model name; a different configured model makes every row stale and the worker rebuilds. Old rows keep serving until replaced.

## 6. Retrieval

`GET /api/skills/search?q=&kind=protocol&limit=`

1. Embed the query (one call; cached for 5 minutes per query string).
2. Cosine over the visible chunks; take the top 40 chunks.
3. Group by protocol. A protocol's score is its best chunk's similarity, plus a small bonus (`+0.02` per additional chunk above 0.5, capped at 3) so a protocol that matches in several places outranks one that matches once.
4. **Exact-token boost.** Embeddings are weak on identifiers: a catalogue number, a strain name, "pUC19". If the query contains a token with a digit or in ALL-CAPS and a protocol's text contains it verbatim, that protocol gets `+0.15`. This is the one place a string comparison survives, because it is the one thing dense retrieval reliably misses. It is a boost on ranking, never a filter, and never the main path.
5. Return the top `limit` (default 20) with `{ slug, score, heading, snippet }` where the snippet is the best chunk's text, trimmed to ~240 characters around the densest match. The client renders it under the card title exactly as it does today.

Latency budget: embedding call ~100–200 ms, everything else negligible. The page keeps its 200 ms debounce.

Fallback: when no credential resolves, or the index is empty and the queue is idle (meaning it could not run), the endpoint runs the existing substring search and returns `mode: "lexical"` so the page can show a quiet notice: *Semantic search needs a model key — showing text matches*.

## 7. Ask mode

`POST /api/skills/ask` `{ q, kind }` → `{ answer, citations: [{ slug, heading, quote }] }`

Retrieval as above, top 8 chunks, then one chat call with a fixed system prompt: answer only from the supplied chunks, cite by chunk number, say when the chunks do not contain the answer. The response is parsed for `[n]` markers which become links to the protocol at that heading. It is a separate button on the page ("Ask the library"), not something that fires while typing, because it costs a model call and takes a couple of seconds. Streaming is not needed at this length.

The prompt is the whole "agent" for Ask; there is no tool loop, because a fixed retrieval followed by one generation is the correct shape for a single question over a small library. Anything more elaborate would be latency without accuracy.

## 8. The categorisation agent

`POST /api/skills/categories/suggest` `{ slugs?: string[] }` → `{ proposals, newCategories }`

Runs on demand from a "Suggest categories" button in the rail, and inline on the create and import flows for the single new protocol.

The loop, in order, stopping as soon as it has an answer for every requested protocol:

1. **Nearest centroid.** For each existing category, average the vectors of every chunk of every protocol already in it. For each uncategorised protocol, average its own chunk vectors and take the cosine against each centroid. Above `0.55`, that is the proposal, with the similarity as confidence and no model call at all. This is the common case once a library has a few categories, and it is free.
2. **Ask the model for the leftovers.** Protocols with no centroid above threshold, batched into one chat call: the model gets each protocol's name, description, first 300 characters, and the list of existing category names, and returns JSON `{ slug, category, confidence, reason }` choosing from the list or `null`. Temperature 0, JSON mode.
3. **Propose a taxonomy when there is nothing to choose from.** If the library has no categories, or more than a third of protocols came back `null`, cluster the leftover protocol vectors (k-means, `k = min(8, ceil(sqrt(n / 2)))`, three restarts, cosine distance) and ask the model to name each cluster from its members' names and descriptions, with the instruction that names should read like a bench-lab folder (*Cloning*, *Cell culture*, *Imaging*), be one or two words, and not overlap the existing categories. Those become `newCategories` proposals; each member protocol gets a proposal into its cluster's name.

Nothing is written. The response is shown as a review list: protocol → proposed category, with the reason, a checkbox per row, and *Apply selected*. Applying calls the existing `POST /api/skills/categories` for any new names and `POST /api/skills/:slug/move` per row. "Move all with confidence above 0.8" is a shortcut, still behind a click. The agent never renames or deletes a category.

Why this order: it keeps model calls to a minimum (zero for most protocols once the library is organised), it makes the proposals explainable (the reason is the centroid similarity or the model's own sentence), and it keeps a person in charge of their folders, which issue #3 was explicit about.

## 9. API summary

| Endpoint | Change |
|---|---|
| `GET /api/skills/search` | Semantic retrieval; `mode` field reports `semantic` or `lexical` |
| `POST /api/skills/ask` | New. RAG answer with citations |
| `POST /api/skills/categories/suggest` | New. Agent proposals, nothing written |
| `GET /api/skills/index/status` | New. Indexing progress for the page |
| `POST /api/skills/index/rebuild` | New. Drop and re-embed everything the caller can see; admin-only on the box |
| categories create / rename / delete / move | Unchanged from PR #46; the agent's proposals are applied through them |

Page changes: an indexing progress line under the search box while the first index builds; a "Suggest categories" button in the rail that opens the review list; an "Ask the library" button next to search; the lexical-fallback notice.

## 10. Privacy and cost

Protocol text is sent to the embedding provider to be indexed, and chunks of it are sent to the chat model for Ask and for step 2 of the agent. Conversation content already goes to the same providers today, so this widens *what* leaves rather than *where it goes*: a protocol that has never been used in a chat will now be embedded when it is indexed. The privacy policy's "Who receives your data" table gets one line for this. A person who does not want that keeps no OpenAI credential configured and gets the lexical fallback; on the hosted box that is the operator's call via the env key.

Cost, `text-embedding-3-small` at $0.02 per million tokens: a 300-protocol library of ~2,000 tokens each is $0.012 to index and fractions of a cent per query. Ask mode and agent step 2 use a small chat model at cents per hundred calls. Metering on the provided tier goes through the existing proxy, so it appears in the person's usage like everything else.

## 11. Tests

The test environment gets a **fake embedding provider**: a deterministic function that hashes each word into one of 64 dimensions and normalises, so semantically identical sentences produce identical vectors and shared words produce nearby ones. It is selected by `LABEE_EMBED_PROVIDER=fake`, and the same switch selects a fake chat model that returns canned JSON. With that:

- chunking: heading paths, overlap, a table kept whole, a long section split at a list boundary
- indexing: first run indexes everything; editing one protocol re-embeds only it; a model name change marks all rows stale; visibility filtering keeps another person's protocols out of results
- search: a query with no shared words still finds the right protocol through the fake's synonym table; the exact-token boost lifts "pUC19"; the lexical fallback engages with no credential
- agent: centroid proposal above threshold makes no model call; below threshold the model is asked once for the batch; an empty library yields a taxonomy with `k` names; nothing on disk changes until apply

## 12. Phases

1. **Index and semantic search** — tables, chunker, indexer, search endpoint with fallback and status; the page swaps to it. Ships value alone.
2. **Categorisation agent** — suggest endpoint and the review list.
3. **Ask mode** — the endpoint and the button.

Each is a separate PR on top of #46.

## 13. Open questions

- **Does the hosted box have an OpenAI key?** Semantic search for provided-tier users depends on it. If not, it needs setting in `/etc/labee.env` before phase 1 is useful there.
- **Index skills too?** Everything above is written for `kind: protocol`. The same machinery indexes skills for free; the question is whether the Skills page wants semantic search, which is a product call, not a technical one.
- **Auto-apply for high confidence?** The design keeps every move behind a click. If in practice people accept nearly all proposals above 0.8, an opt-in "categorise new imports automatically" setting is a small follow-up.
