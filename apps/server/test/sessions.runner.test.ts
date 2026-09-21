import { beforeAll, describe, expect, it } from "vitest";
import { applyTestEnv, sleep, waitFor } from "./helpers/env";

const EMAIL = "alice@example.com";

beforeAll(() => {
  applyTestEnv("runner");
});

const load = async () => ({
  db: await import("../src/services/sessions/db"),
  runner: await import("../src/services/sessions/runner"),
});

async function collect(runner: Awaited<ReturnType<typeof load>>["runner"], sessionId: string) {
  const events: { type: string; seq: number; data: Record<string, unknown> }[] = [];
  const off = runner.subscribe(sessionId, (e) => events.push(e));
  return { events, off };
}

describe("session runner", () => {
  it("persists a turn's events and final message; deltas are compacted", async () => {
    const { db, runner } = await load();
    const s = await db.createSession({ email: EMAIL });
    const { events, off } = await collect(runner, s.id);
    const r = await runner.startTurn(EMAIL, s.id, { text: "hi there", device: "test" });
    expect(r.ok && !r.queued).toBe(true);
    await waitFor(() => events.some((e) => e.type === "turn_ended"));
    off();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session_renamed");
    expect(types).toContain("turn_started");
    expect(types).toContain("init");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_result");
    expect(types).toContain("delta");
    expect(types).toContain("result");
    expect(types[types.length - 1]).toBe("turn_ended");
    // seqs strictly increasing for persisted events
    const seqs = events.filter((e) => e.seq > 0).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const after = await db.getSessionById(s.id);
    expect(after?.status).toBe("idle");
    expect(after?.title).toBe("hi there");
    expect(after?.costUsd).toBeCloseTo(0.001);
    const msgs = await db.listMessages(s.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toBe("Hello from fake claude. The README is short.");
    expect((msgs[1]!.meta?.activity as unknown[]).length).toBe(1);
    // compaction dropped deltas but kept durable rows
    const rows = await db.listEventsAfter(s.id, 0);
    expect(rows.some((e) => e.type === "delta")).toBe(false);
    expect(rows.some((e) => e.type === "tool_result")).toBe(true);
    const ended = rows.find((e) => e.type === "turn_ended");
    expect(ended?.data).toMatchObject({ content: "Hello from fake claude. The README is short." });
  });

  it("queues a second turn while one is running and runs it afterwards", async () => {
    process.env.FAKE_CLAUDE_SCRIPT = "slow";
    process.env.FAKE_CLAUDE_DELAY_MS = "60";
    try {
      const { db, runner } = await load();
      const s = await db.createSession({ email: EMAIL });
      const { events, off } = await collect(runner, s.id);
      const a = await runner.startTurn(EMAIL, s.id, { text: "first" });
      expect(a.ok && !a.queued).toBe(true);
      const b = await runner.startTurn(EMAIL, s.id, { text: "second" });
      expect(b.ok && b.queued).toBe(true);
      expect((await db.listQueue(s.id)).length).toBe(1);
      await waitFor(() => events.filter((e) => e.type === "turn_ended").length === 2, 15000);
      off();
      const starts = events.filter((e) => e.type === "turn_started").map((e) => e.data.text);
      expect(starts).toEqual(["first", "second"]);
      expect(events.map((e) => e.type)).toContain("turn_queued");
      expect(events.map((e) => e.type)).toContain("turn_dequeued");
      expect((await db.listQueue(s.id)).length).toBe(0);
      const msgs = await db.listMessages(s.id);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("cancel kills the child and records a cancelled turn; subscribers leaving never kills it", async () => {
    process.env.FAKE_CLAUDE_SCRIPT = "slow";
    process.env.FAKE_CLAUDE_DELAY_MS = "200";
    try {
      const { db, runner } = await load();
      const s = await db.createSession({ email: EMAIL });
      const { events, off } = await collect(runner, s.id);
      await runner.startTurn(EMAIL, s.id, { text: "long" });
      await waitFor(() => events.some((e) => e.type === "delta"));
      // A subscriber disconnecting must not affect the turn.
      off();
      await sleep(100);
      expect(runner.getHandle(s.id)).toBeDefined();
      const { events: events2, off: off2 } = await collect(runner, s.id);
      const c = await runner.cancelTurn(EMAIL, s.id);
      expect(c.ok).toBe(true);
      await waitFor(() => events2.some((e) => e.type === "turn_ended"), 5000);
      off2();
      expect(events2.map((e) => e.type)).toContain("turn_cancelled");
      const msgs = await db.listMessages(s.id);
      expect(msgs[1]!.meta?.cancelled).toBe(true);
      expect((await db.getSessionById(s.id))?.status).toBe("idle");
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("AskUserQuestion pauses the session; answering starts the next turn", async () => {
    process.env.FAKE_CLAUDE_SCRIPT = "question";
    try {
      const { db, runner } = await load();
      const s = await db.createSession({ email: EMAIL });
      const { events, off } = await collect(runner, s.id);
      await runner.startTurn(EMAIL, s.id, { text: "decide" });
      await waitFor(() => events.some((e) => e.type === "turn_ended"), 5000);
      const q = events.find((e) => e.type === "question_asked");
      expect(q).toBeDefined();
      expect(q!.data.toolUseId).toBe("toolu_q1");
      const mid = await db.getSessionById(s.id);
      expect(mid?.status).toBe("awaiting_input");
      expect(mid?.pendingQuestion?.toolUseId).toBe("toolu_q1");
      // A fresh turn (not an answer) is allowed and clears the pending question.
      process.env.FAKE_CLAUDE_SCRIPT = "echo";
      const fresh = await runner.startTurn(EMAIL, s.id, { text: "meanwhile" });
      expect(fresh.ok && !fresh.queued).toBe(true);
      await waitFor(() => events.filter((e) => e.type === "turn_ended").length === 2, 5000);
      expect((await db.getSessionById(s.id))?.pendingQuestion).toBeNull();
      const bad = await runner.answerQuestion(EMAIL, s.id, [{ question: "Which evaluator?", answer: "Command" }]);
      // pendingQuestion was cleared by the fresh turn: answering now is a 409
      expect(bad.ok).toBe(false);
      off();
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
    }
  });

  it("answerQuestion formats the answers as the next user message", async () => {
    process.env.FAKE_CLAUDE_SCRIPT = "question";
    try {
      const { db, runner } = await load();
      const s = await db.createSession({ email: EMAIL });
      const { events, off } = await collect(runner, s.id);
      await runner.startTurn(EMAIL, s.id, { text: "decide", runMode: "build" });
      await waitFor(() => events.some((e) => e.type === "question_asked"), 5000);
      await waitFor(() => events.some((e) => e.type === "turn_ended"), 5000);
      process.env.FAKE_CLAUDE_SCRIPT = "echo";
      const r = await runner.answerQuestion(EMAIL, s.id, [{ question: "Which evaluator?", answer: "Command" }], { device: "iPhone" });
      expect(r.ok).toBe(true);
      await waitFor(() => events.filter((e) => e.type === "turn_ended").length === 2, 5000);
      off();
      const answered = events.find((e) => e.type === "question_answered");
      expect(answered?.data.text).toContain("Which evaluator? → Command");
      const msgs = await db.listMessages(s.id);
      expect(msgs[2]).toMatchObject({ role: "user", meta: { device: "iPhone" } });
      // lastBody options (runMode) carried over to the answer turn
      expect((await db.getSessionById(s.id))?.lastBody?.runMode).toBe("build");
      expect(msgs[3]!.content).toContain("You said:");
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
    }
  });

  it("a failing engine records an error and leaves the session usable", async () => {
    process.env.FAKE_CLAUDE_SCRIPT = "fail";
    try {
      const { db, runner } = await load();
      const s = await db.createSession({ email: EMAIL });
      const { events, off } = await collect(runner, s.id);
      await runner.startTurn(EMAIL, s.id, { text: "boom" });
      await waitFor(() => events.some((e) => e.type === "turn_ended"), 5000);
      off();
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect((await db.getSessionById(s.id))?.status).toBe("error");
      expect(runner.getHandle(s.id)).toBeUndefined();
    } finally {
      delete process.env.FAKE_CLAUDE_SCRIPT;
    }
  });
});
