import { beforeAll, describe, it, expect } from "vitest";
import { applyTestEnv } from "./helpers/env";
applyTestEnv("context");
let sdb: typeof import("../src/services/sessions/db");
let context: typeof import("../src/services/context/service");
let db: import("../src/services/db").SqlDb;
const email = "context@example.com";
let sessionId: string;
beforeAll(async () => {
  sdb = await import("../src/services/sessions/db");
  context = await import("../src/services/context/service");
  db = await (await import("../src/services/db")).getDb();
  const session = await sdb.createSession({
    email,
    title: "Older centrifuge experiment",
  });
  sessionId = session.id;
  for (let i = 0; i < 1000; i++)
    await sdb.appendMessage(
      sessionId,
      null,
      i % 2 ? "assistant" : "user",
      i === 3
        ? "Original cobalt temperature is 37 degrees."
        : i === 9
          ? "Correction: cobalt temperature is 42 degrees."
          : `Message ${i}`,
    );
  for (let i = 0; i < 205; i++)
    await sdb.createSession({ email, title: `Newer session ${i}` });
});
describe("full-history retrieval", () => {
  it("finds an old message beyond 200 sessions and reads its correction", async () => {
    const found = await context.retrieveContext(email, {
      tool: "sessions.search",
      query: "cobalt",
    });
    expect(found.items).toHaveLength(2);
    expect(found.items[0]).toMatchObject({ sessionId, messageIdx: 3 });
    const read = await context.retrieveContext(email, {
      tool: "sessions.read",
      sessionId,
      messageIdx: 3,
      limit: 10,
    });
    expect(
      read.items.some((i) => String(i.content).includes("42 degrees")),
    ).toBe(true);
  });
  it("paginates all messages in both directions without dropping old records", async () => {
    for (const direction of ["before", "after"] as const) {
      let cursor: string | undefined;
      const indexes: number[] = [];
      do {
        const r = await context.retrieveContext(email, {
          tool: "sessions.read",
          sessionId,
          direction,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        indexes.push(...r.items.map((i) => Number(i.messageIdx)));
        cursor = r.nextCursor;
      } while (cursor);
      expect(indexes).toHaveLength(1000);
      expect(new Set(indexes).size).toBe(1000);
      expect(indexes[0]).toBe(direction === "before" ? 999 : 0);
    }
  });
  it("returns complete long messages and tool output through explicit continuations", async () => {
    const content = "x".repeat(15000) + " important ending";
    const m = await sdb.appendMessage(sessionId, null, "assistant", content);
    let offset = 0;
    let rebuilt = "";
    do {
      const r = await context.retrieveContext(email, {
        tool: "messages.read",
        sessionId,
        messageIdx: m.idx,
        offset,
      });
      rebuilt += r.items[0]!.content;
      offset = Number(r.items[0]!.nextOffset ?? 0);
    } while (offset);
    expect(rebuilt).toBe(content);
    const ev = await sdb.appendEvent(sessionId, null, "tool_result", {
      content,
    });
    const found = await context.retrieveContext(email, {
      tool: "sessions.search",
      query: "important ending",
      includeEvents: true,
    });
    expect(found.items.some((i) => i.eventSeq === ev.seq)).toBe(true);
    const last = await context.retrieveContext(email, {
      tool: "sessions.events",
      sessionId,
      eventSeq: ev.seq,
      offset: 12000,
    });
    expect(last.items[0]!.content).toContain("important ending");
  });
  it("authorizes exact reads and binds cursors to the account/query", async () => {
    await expect(
      context.retrieveContext("other@example.com", {
        tool: "messages.read",
        sessionId,
        messageIdx: 3,
      }),
    ).rejects.toThrow(/not found/);
    expect(
      (
        await context.retrieveContext("other@example.com", {
          tool: "sessions.search",
          query: "cobalt",
        })
      ).items,
    ).toEqual([]);
    const first = await context.retrieveContext(email, {
      tool: "sessions.search",
      query: "Newer",
      limit: 1,
    });
    await expect(
      context.retrieveContext("other@example.com", {
        tool: "sessions.search",
        query: "Newer",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/);
    await sdb.createSession({ email, title: "Newer addition" });
    await expect(
      context.retrieveContext(email, {
        tool: "sessions.search",
        query: "Newer",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/History changed/);
  });
  it("indexes archived sessions, edits and deletes in the source transaction", async () => {
    await sdb.updateSession(sessionId, { archived: true });
    expect(
      (
        await context.retrieveContext(email, {
          tool: "sessions.search",
          query: "cobalt",
          archived: true,
        })
      ).items,
    ).toHaveLength(2);
    expect(
      (
        await context.retrieveContext(email, {
          tool: "sessions.search",
          query: "cobalt",
          archived: false,
        })
      ).items,
    ).toHaveLength(0);
    db.prepare(
      "UPDATE chat_session_messages SET content=? WHERE session_id=? AND idx=3",
    ).run("Changed to zirconium", sessionId);
    expect(
      (
        await context.retrieveContext(email, {
          tool: "sessions.search",
          query: "zirconium",
        })
      ).items,
    ).toHaveLength(1);
    db.prepare(
      "DELETE FROM chat_session_messages WHERE session_id=? AND idx=3",
    ).run(sessionId);
    expect(
      (
        await context.retrieveContext(email, {
          tool: "sessions.search",
          query: "zirconium",
        })
      ).items,
    ).toHaveLength(0);
    await expect(
      context.retrieveContext(email, {
        tool: "messages.read",
        sessionId,
        messageIdx: 3,
      }),
    ).rejects.toThrow(/missing/);
  });
  it("marks offline mirrored evidence incomplete and checks mirror account ownership", async () => {
    const mirror = await import("../src/services/deviceLink/mirror");
    await mirror.upsertMirrorSession(email, "mac-offline", {
      id: "remote",
      title: "Remote history",
      lastSeq: 4,
    });
    await mirror.upsertMirrorMessages(email, "mac-offline", "remote", [
      { idx: 0, role: "user", content: "offline unique reagent" },
    ]);
    const found = await context.retrieveContext(email, {
      tool: "sessions.search",
      query: "unique reagent",
    });
    expect(found.items[0]).toMatchObject({
      hostId: "mac-offline",
      sessionId: "remote",
    });
    expect(found.coverage.complete).toBe(false);
    const read = await context.retrieveContext(email, {
      tool: "messages.read",
      hostId: "mac-offline",
      sessionId: "remote",
      messageIdx: 0,
    });
    expect(read.coverage.unavailableHosts).toContain("mac-offline");
    expect(read.coverage.sources[0]?.messageThrough).toBe(0);
    await expect(
      context.retrieveContext("other@example.com", {
        tool: "messages.read",
        hostId: "mac-offline",
        sessionId: "remote",
        messageIdx: 0,
      }),
    ).rejects.toThrow(/not found/);
    await mirror.deleteMirrorSession(email, "mac-offline", "remote");
    expect(
      (
        await context.retrieveContext(email, {
          tool: "sessions.search",
          query: "unique reagent",
        })
      ).items,
    ).toEqual([]);
  });
});
