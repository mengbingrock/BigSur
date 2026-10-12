import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyTestEnv } from "./helpers/env";
import {
  bioProHierarchy,
  hierarchyNode,
  markdownHierarchy,
  snapshotHierarchy,
} from "../src/services/protocolHierarchy";
import {
  chunkProtocol,
  protocolEmbeddingFragments,
} from "../src/services/artifactIndex/chunk";
import { parseTree, renderTree, stepAt } from "../src/services/protocolTree";
applyTestEnv("protocol-hierarchy");
process.env.LABEE_EMBED_PROVIDER = "fake";
const source = {
  "2": {
    title: "Preparation",
    "2.4": {
      title: "Buffer",
      "2.4.8": {
        title: "Mix",
        "2.4.8.3": "Mix carefully.\nKeep this qualifying note with the step.",
      },
    },
  },
  "2.4.8.3.2": "Check the label.",
  "9.7.2": "Final separate step.",
};
const nodes = bioProHierarchy(source, "Materials list");

describe("source protocol hierarchy", () => {
  it("preserves deep dotted addresses, original text, order and inferred missing parents", () => {
    const read = hierarchyNode(nodes, "step:2.4.8.3")!;
    expect(read.node?.text).toBe(
      "Mix carefully.\nKeep this qualifying note with the step.",
    );
    expect(read.ancestors.map((n) => n.id)).toEqual([
      "section:2",
      "section:2.4",
      "section:2.4.8",
    ]);
    expect(read.children.map((n) => n.id)).toEqual(["step:2.4.8.3.2"]);
    expect(
      hierarchyNode(nodes, "step:9.7.2")?.ancestors.map((n) => n.path),
    ).toEqual(["9", "9.7"]);
    expect(hierarchyNode(nodes)?.children.map((n) => n.path)).toEqual([
      "materials",
      "2",
      "9",
    ]);
  });
  it("keeps a long normal step intact and links only oversized provider fragments to its source", () => {
    const long = "Complete instruction. ".repeat(160);
    const hierarchy = bioProHierarchy({ "1": { title: "Phase" }, "1.1": long });
    const chunks = chunkProtocol({
      name: "Example",
      description: "",
      body: "",
      hierarchy,
    });
    expect(chunks.filter((c) => c.path === "1.1").map((c) => c.text)).toEqual([
      long,
    ]);
    const oversized = "⚗️ 中文 note\n".repeat(3000);
    const pieces = protocolEmbeddingFragments(oversized);
    expect(pieces.join("")).toBe(oversized);
    expect(pieces.every((p) => Buffer.byteLength(p) <= 6000)).toBe(true);
    const oversizedChunks = chunkProtocol({
      name: "Large",
      description: "",
      body: "",
      hierarchy: bioProHierarchy({ "1": oversized }),
    });
    expect(
      new Set(
        oversizedChunks.filter((c) => c.grain === "step").map((c) => c.path),
      ),
    ).toEqual(new Set(["1"]));
  });
  it("preserves deep Markdown substeps and headings through rendering", () => {
    const body =
      "## Phase\n\n### Group\n\n#### Part\n\n##### Detail\n\n1. A\n   1. B\n      1. C\n         1. D\n";
    const tree = parseTree(body);
    expect(parseTree(renderTree(tree))).toEqual(tree);
    expect(stepAt(tree, "1.1.1.1.1.1.1.1")?.text).toBe("D");
    const hierarchy = markdownHierarchy(body);
    expect(hierarchy.filter((n) => n.grain === "step")).toHaveLength(4);
    expect(
      hierarchyNode(hierarchy, "step:1.1.1.1.1.1.1.1")?.ancestors,
    ).toHaveLength(7);
    expect(
      markdownHierarchy("1. First\n   1. Child\n2. Second").filter(
        (n) => n.grain === "step",
      ),
    ).toHaveLength(3);
  });
  it("reconstructs only recorded nodes for legacy run snapshots", () => {
    const legacy = snapshotHierarchy({ steps: [{ n: 3, text: "Saved step" }] });
    expect(hierarchyNode(legacy, "step:steps.3")?.node?.text).toBe(
      "Saved step",
    );
  });
});

let store: typeof import("../src/services/library/store");
let context: typeof import("../src/services/context/service");
let db: import("../src/services/db").SqlDb;
beforeAll(async () => {
  store = await import("../src/services/library/store");
  context = await import("../src/services/context/service");
  db = await (await import("../src/services/db")).getDb();
});
it("persists the original hierarchy and lets the router search, navigate, page, and detect edits", async () => {
  const record = {
    id: "test:hierarchy",
    source: "synthetic",
    sourceUrl: "",
    license: "CC0",
    title: "Nested buffer preparation",
    description: "A nested protocol",
    domains: [],
    keywords: [],
    body: "## Display\n1. Original body",
    hierarchy: nodes,
  };
  await store.upsertLibraryProtocol(record);
  expect((await store.getLibraryProtocol(record.id))?.hierarchy).toEqual(nodes);
  const result = await context.retrieveLocal("test@example.invalid", {
    tool: "protocols.search",
    query: "qualifying note",
  });
  expect(result.items[0]).toMatchObject({
    protocolSlug: "library:test:hierarchy",
    nodeId: "step:2.4.8.3",
  });
  const read = await context.retrieveLocal("test@example.invalid", {
    tool: "protocols.read",
    protocolSlug: "library:test:hierarchy",
    nodeId: "step:2.4.8.3",
  });
  expect(read.items[0]?.content).toContain("qualifying note");
  expect(read.items[0]?.children).toEqual([
    expect.objectContaining({ nodeId: "step:2.4.8.3.2" }),
  ]);
  const rootCall = {
    tool: "protocols.read" as const,
    protocolSlug: "library:test:hierarchy",
    part: "tree" as const,
    limit: 1,
  };
  const first = await context.retrieveLocal("test@example.invalid", rootCall);
  expect(first.hasMore).toBe(true);
  const second = await context.retrieveLocal("test@example.invalid", {
    ...rootCall,
    cursor: first.nextCursor,
  });
  expect(second.items[0]?.children).toEqual([
    expect.objectContaining({ nodeId: "section:2" }),
  ]);
  await store.upsertLibraryProtocol({
    ...record,
    description: "Changed revision",
  });
  await expect(
    context.retrieveLocal("test@example.invalid", {
      ...rootCall,
      revision: String(read.items[0]?.revision),
    }),
  ).rejects.toThrow(/revision changed/);
  await expect(
    context.retrieveLocal("test@example.invalid", {
      ...rootCall,
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow(/revision changed/);
});
it("rebuilds old derived chunks without claiming to recover missing source hierarchy", async () => {
  const record = {
    id: "test:legacy",
    source: "synthetic",
    sourceUrl: "",
    license: "CC0",
    title: "Old source",
    description: "",
    domains: [],
    keywords: [],
    body: "## Phase\n1. Original\n   1. Nested",
  };
  await store.upsertLibraryProtocol(record);
  db.prepare(
    "UPDATE library_protocols SET index_version='',content_hash='old',model='old-model' WHERE id=?",
  ).run(record.id);
  await store.ensureLibraryHierarchy();
  expect((await store.getLibraryProtocol(record.id))?.model).toBe("");
  expect(
    db
      .prepare(
        "SELECT path FROM library_chunks WHERE protocol_id=? AND grain='step' ORDER BY idx",
      )
      .all(record.id)
      .map((r) => r.path),
  ).toEqual(["1.1", "1.1.1"]);
});
it("embeds frozen runs by protocol node and reads the complete original revision", async () => {
  const sdb = await import("../src/services/sessions/db");
  const runs = await import("../src/services/runs/service");
  const { parseProtocol } = await import("../src/services/runs/parse");
  const embedding = await import("../src/services/context/embeddings");
  const email = "run-hierarchy@example.invalid";
  const session = await sdb.createSession({ email, title: "Frozen hierarchy" });
  const body =
    "## First phase\n1. Initial action.\n   1. Nested action.\n\n## Later phase\n1. Preserve the later-phase instruction.";
  const run = await runs.createRun({
    email,
    sessionId: session.id,
    hostId: null,
    protocolSlug: "frozen",
    protocolName: "Frozen hierarchy",
    snapshot: parseProtocol(body),
  });
  await embedding.buildContextEmbeddings(email);
  const ids = db
    .prepare(
      "SELECT v.node_id FROM context_vectors v JOIN context_documents d ON d.id=v.document_id WHERE d.kind='run' AND d.entity_id=? ORDER BY v.chunk_idx",
    )
    .all(run.id)
    .map((r) => r.node_id);
  expect(ids).toContain("step:1.1.1");
  expect(ids).toContain("step:2.1");
  const read = await context.retrieveLocal(email, {
    tool: "runs.read",
    runId: run.id,
    nodeId: "step:2.1",
    part: "tree",
  });
  expect(read.items[0]).toMatchObject({
    sourceComplete: true,
    content: "Preserve the later-phase instruction.",
  });
  await expect(
    context.retrieveLocal("stranger@example.invalid", {
      tool: "runs.read",
      runId: run.id,
      part: "tree",
    }),
  ).rejects.toThrow(/not found/);
});
it("batches a large hierarchy into bounded real-provider requests", async () => {
  const old = process.env.LABEE_EMBED_PROVIDER;
  delete process.env.LABEE_EMBED_PROVIDER;
  const sizes: number[] = [];
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      sizes.push(input.length);
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
        { status: 200 },
      );
    });
  try {
    const { embedBatch } = await import("../src/services/artifactIndex/embed");
    const vectors = await embedBatch(
      Array.from({ length: 65 }, (_, i) => `Node ${i}`),
      { apiKey: "test", baseUrl: "https://embedding.invalid" },
    );
    expect(sizes).toEqual([32, 32, 1]);
    expect(vectors).toHaveLength(65);
  } finally {
    mock.mockRestore();
    if (old === undefined) delete process.env.LABEE_EMBED_PROVIDER;
    else process.env.LABEE_EMBED_PROVIDER = old;
  }
});
it("does not overwrite a changed hierarchy with embeddings from an older revision", async () => {
  const record = {
    id: "test:revision-race",
    source: "synthetic",
    sourceUrl: "",
    license: "CC0",
    title: "Revision race",
    description: "",
    domains: [],
    keywords: [],
    body: "## Phase\n1. Old",
    hierarchy: bioProHierarchy({ "1": "Old instruction" }),
  };
  await store.upsertLibraryProtocol(record);
  // Other records are already embedded so the pending batch targets this one.
  db.prepare(
    "UPDATE library_protocols SET model='text-embedding-3-small' WHERE id!=?",
  ).run(record.id);
  const old = process.env.LABEE_EMBED_PROVIDER;
  delete process.env.LABEE_EMBED_PROVIDER;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      await store.upsertLibraryProtocol({
        ...record,
        hierarchy: bioProHierarchy({ "1": "New instruction" }),
      });
      const input = JSON.parse(String(init?.body)).input as string[];
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
        { status: 200 },
      );
    });
  try {
    expect(
      await store.embedLibraryPending({
        apiKey: "test",
        baseUrl: "https://embedding.invalid",
      }),
    ).toBe(0);
    const saved = await store.getLibraryProtocol(record.id);
    expect(saved?.hierarchy?.[0]?.text).toBe("New instruction");
    expect(saved?.model).toBe("");
    expect(
      db
        .prepare(
          "SELECT text FROM library_chunks WHERE protocol_id=? AND grain='step'",
        )
        .get(record.id)?.text,
    ).toBe("New instruction");
  } finally {
    mock.mockRestore();
    if (old === undefined) delete process.env.LABEE_EMBED_PROVIDER;
    else process.env.LABEE_EMBED_PROVIDER = old;
  }
});
