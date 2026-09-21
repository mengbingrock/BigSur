import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents, initialState } from "../src/reducer";
import type { SessionEvent } from "../src/events";

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, turnId = "t1", live = false): SessionEvent => ({
  seq: live ? 0 : ++seq,
  sessionId: "s1",
  turnId,
  type,
  ts: "2026-09-19T00:00:00Z",
  data,
});

describe("session reducer", () => {
  it("builds a streamed assistant reply with tools and stats", () => {
    let s = initialState();
    s = applyEvents(s, [
      ev("turn_started", { text: "hello", device: "iPhone" }),
      ev("init", { model: "opus" }),
      ev("thinking_start"),
      ev("thinking_delta", { text: "hmm" }),
      ev("thinking_stop"),
      ev("tool_start", { id: "tu1", name: "Read" }),
      ev("tool_input_delta", { id: "tu1", partial_json: '{"a":' }),
      ev("tool_input_delta", { id: "tu1", partial_json: "1}" }),
      ev("tool_stop", { id: "tu1", name: "Read", input: { a: 1 }, inputRaw: '{"a":1}' }),
      ev("tool_result", { id: "tu1", content: "ok", is_error: false }),
      ev("delta", { text: "Hel" }),
      ev("delta", { text: "lo" }),
      ev("result", { total_cost_usd: 0.5, duration_ms: 10 }),
      ev("turn_ended", { content: "Hello", stats: { costUsd: 0.5 } }),
    ]);
    expect(s.streaming).toBe(false);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "hello", device: "iPhone" });
    const a = s.messages[1]!;
    expect(a.content).toBe("Hello");
    expect(a.pending).toBe(false);
    expect(a.stats).toEqual({ costUsd: 0.5 });
    expect(a.activity.map((x) => x.kind)).toEqual(["thinking", "tool"]);
    const tool = a.activity[1] as Extract<(typeof a.activity)[number], { kind: "tool" }>;
    expect(tool).toMatchObject({ name: "Read", input: { a: 1 }, done: true, result: "ok" });
    expect(s.session).toEqual({ model: "opus" });
    expect(s.lastSeq).toBe(seq);
  });

  it("rebuilds from compacted events (no deltas) using turn_ended content", () => {
    let s = initialState();
    s = applyEvents(s, [
      ev("turn_started", { text: "q" }, "t2"),
      ev("turn_ended", { content: "final answer", activity: [{ kind: "tool", id: "x", name: "Bash", input: {}, inputRaw: "", done: true }] }, "t2"),
    ]);
    expect(s.messages[1]!.content).toBe("final answer");
    expect(s.messages[1]!.activity).toHaveLength(1);
  });

  it("ignores duplicate replayed seqs but applies live seq-0 frames", () => {
    let s = initialState();
    const start = ev("turn_started", { text: "x" }, "t3");
    s = applyEvent(s, start);
    s = applyEvent(s, start);
    expect(s.messages).toHaveLength(2);
    s = applyEvent(s, ev("delta", { text: "a" }, "t3", true));
    s = applyEvent(s, ev("delta", { text: "b" }, "t3", true));
    expect(s.messages[1]!.content).toBe("ab");
  });

  it("tracks questions, answers, queue and cancel", () => {
    let s = initialState();
    s = applyEvents(s, [
      ev("turn_started", { text: "do it" }, "t4"),
      ev("tool_start", { id: "q1", name: "AskUserQuestion" }, "t4"),
      ev("tool_stop", { id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] } }, "t4"),
      ev("question_asked", { toolUseId: "q1", input: { questions: [] } }, "t4"),
    ]);
    expect(s.streaming).toBe(false);
    expect(s.messages[1]!.question?.questions[0]?.question).toBe("Which?");
    s = applyEvents(s, [
      ev("turn_queued", { queueId: "qq1" }, null as unknown as string),
      ev("question_answered", { answers: [{ question: "Which?", answer: "A" }], text: "answered", nextTurnId: "t5" }, "t4"),
      ev("turn_started", { text: "answered", fromAnswer: true }, "t5"),
      ev("turn_dequeued", { queueId: "qq1" }, null as unknown as string),
      ev("turn_cancelled", {}, "t5"),
    ]);
    expect(s.messages[1]!.question?.answers).toEqual([{ question: "Which?", answer: "A" }]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(s.messages[3]).toMatchObject({ cancelled: true, content: "(cancelled)", pending: false });
    expect(s.queued).toEqual([]);
  });

  it("replaying from seq 0 over seeded messages does not duplicate turns", () => {
    let s = initialState(
      [
        { idx: 0, turnId: "t9", role: "user", content: "old", meta: null, createdAt: "x" },
        { idx: 1, turnId: "t9", role: "assistant", content: "old reply", meta: { activity: [{ kind: "tool", id: "tt", name: "Read", input: null, inputRaw: "", done: true }] }, createdAt: "x" },
        { idx: 2, turnId: "t10", role: "user", content: "live", meta: null, createdAt: "x" },
      ],
      0,
    );
    s = applyEvents(s, [
      ev("turn_started", { text: "old" }, "t9"),
      ev("tool_start", { id: "tt", name: "Read" }, "t9"),
      ev("delta", { text: "SHOULD NOT APPEND" }, "t9"),
      ev("turn_ended", { content: "old reply" }, "t9"),
      ev("turn_started", { text: "live" }, "t10"),
      ev("delta", { text: "streaming" }, "t10"),
    ]);
    expect(s.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:old", "assistant:old reply", "user:live", "assistant:streaming"]);
    expect(s.messages[1]!.activity).toHaveLength(1);
    expect(s.streaming).toBe(true);
  });

  it("seeds from persisted messages", () => {
    const s = initialState(
      [
        { idx: 0, turnId: "t", role: "user", content: "hi", meta: null, createdAt: "x" },
        { idx: 1, turnId: "t", role: "assistant", content: "yo", meta: { stats: { costUsd: 1 } }, createdAt: "x" },
      ],
      9,
    );
    expect(s.messages[1]).toMatchObject({ content: "yo", stats: { costUsd: 1 } });
    expect(s.lastSeq).toBe(9);
  });
});
