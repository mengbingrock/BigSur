import { beforeAll, it, expect } from "vitest";
import { applyTestEnv } from "./helpers/env";
applyTestEnv("context-embeddings");
process.env.LABEE_EMBED_PROVIDER = "fake";
let sdb: typeof import("../src/services/sessions/db");
let index: typeof import("../src/services/context/embeddings");
let context: typeof import("../src/services/context/service");
let db: import("../src/services/db").SqlDb;
const email = "embedding@example.com";
let sid: string;
let messageIdx: number;
beforeAll(async () => {
  sdb = await import("../src/services/sessions/db");
  index = await import("../src/services/context/embeddings");
  context = await import("../src/services/context/service");
  db = await (await import("../src/services/db")).getDb();
  const s = await sdb.createSession({ email, title: "History" });
  sid = s.id;
  messageIdx = (
    await sdb.appendMessage(sid, null, "user", "Keep tubes in an ice bucket.")
  ).idx;
  await sdb.appendMessage(
    sid,
    null,
    "assistant",
    "x".repeat(9000) + " final details",
  );
});
it("builds a resumable index through the authenticated agent tool, including all long-message chunks", async () => {
  const first = await context.retrieveContext(email, {
    tool: "index.build",
    limit: 1,
  });
  expect(first.embedding?.embedded).toBe(1);
  expect(first.embedding?.pending).toBe(2);
  const resumed = await index.buildContextEmbeddings(email, 20);
  expect(resumed.ready).toBe(true);
  expect(resumed.embedded).toBe(3);
  expect((await index.buildContextEmbeddings(email)).built).toBe(0);
  const chunks = db
    .prepare(
      "SELECT start_offset,end_offset FROM context_vectors WHERE document_id=(SELECT id FROM context_documents WHERE email=? AND entity_id=? AND ordinal=1 AND kind='message') ORDER BY chunk_idx",
    )
    .all(email, sid);
  expect(chunks[0]?.start_offset).toBe(0);
  expect(chunks.at(-1)?.end_offset).toBe(9014);
});
it("retrieves a vector-only match with zero lexical overlap and exact source references", async () => {
  const { embedBatch, vectorToBlob } =
    await import("../src/services/artifactIndex/embed");
  // Simulate a known semantic match; the fake provider proves plumbing,
  // not language-model recall quality.
  const query = "cool specimen";
  const [v] = await embedBatch([query], { apiKey: "fake", baseUrl: "fake" });
  db.prepare(
    "UPDATE context_vectors SET vector=? WHERE document_id=(SELECT id FROM context_documents WHERE email=? AND entity_id=? AND ordinal=? AND kind='message')",
  ).run(vectorToBlob(v!), email, sid, messageIdx);
  expect(
    (
      await context.retrieveContext(email, {
        tool: "sessions.search",
        query,
        mode: "lexical",
      })
    ).items,
  ).toEqual([]);
  const semantic = await context.retrieveContext(email, {
    tool: "sessions.search",
    query,
    mode: "hybrid",
    limit: 1,
  });
  expect(semantic.mode).toBe("hybrid");
  expect(semantic.items[0]).toMatchObject({ sessionId: sid, messageIdx });
  const read = await context.retrieveContext(email, {
    tool: "messages.read",
    sessionId: sid,
    messageIdx,
  });
  expect(read.items[0]?.content).toContain("ice bucket");
  const another = await context.retrieveContext("stranger@example.com", {
    tool: "sessions.search",
    query,
    mode: "hybrid",
  });
  expect(another.items).toEqual([]);
});
it("invalidates vectors on edits and removes them on deletion", async () => {
  const id = db
    .prepare(
      "SELECT id FROM context_documents WHERE email=? AND entity_id=? AND kind='message' AND ordinal=?",
    )
    .get(email, sid, messageIdx)!.id;
  db.prepare(
    "UPDATE chat_session_messages SET content='Revised handling instruction' WHERE session_id=? AND idx=?",
  ).run(sid, messageIdx);
  expect(
    db.prepare("SELECT 1 FROM context_vectors WHERE document_id=?").get(id),
  ).toBeUndefined();
  expect((await index.contextEmbeddingStatus(email)).pending).toBe(1);
  expect((await index.buildContextEmbeddings(email)).built).toBe(1);
  await sdb.deleteSession(sid);
  expect((await index.contextEmbeddingStatus(email)).total).toBe(0);
  expect(db.prepare("SELECT COUNT(*) n FROM context_vectors").get()!.n).toBe(0);
});
it("reports unavailable embedding credentials instead of pretending an index was built", async () => {
  delete process.env.LABEE_EMBED_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LABEE_OPENAI_API_KEY;
  const result = await index.buildContextEmbeddings(
    "unconfigured@example.invalid",
  );
  expect(result.available).toBe(false);
  expect(result.built).toBe(0);
  await expect(
    context.retrieveContext("unconfigured@example.invalid", {
      tool: "sessions.search",
      query: "anything",
      mode: "semantic",
    }),
  ).rejects.toThrow(/unavailable/);
});
