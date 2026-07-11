import { describe, it, expect } from "vitest";
import { handleEvent } from "../src/services/claudeStream";

// A real AskUserQuestion tool_use input captured from `claude ... stream-json`.
// Note `questions` is a double-encoded JSON *string*, which is how the CLI emits
// it — the client unwraps it. What matters here is that the server forwards it.
const AUQ_INPUT = {
  questions:
    '[{"question": "What should the new module be named?", "header": "Module name", "multiSelect": false, "options": [{"label": "core", "description": "central logic"}, {"label": "kernel", "description": "low-level runtime"}]}]',
};

/** Drive handleEvent over a list of raw CLI events with fresh block maps, and
 *  return the flat list of SSE `[event, payload]` pairs it emitted. */
function run(events: Record<string, unknown>[]): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  const send = (event: string, data: unknown) => out.push([event, data]);
  const blockType = new Map<number, string>();
  const blockId = new Map<number, string>();
  const blockName = new Map<number, string>();
  const blockInputJson = new Map<number, string>();
  for (const evt of events) {
    handleEvent(evt, send, blockType, blockId, blockName, blockInputJson);
  }
  return out;
}

describe("handleEvent — tool input", () => {
  it("emits authoritative tool_input from the complete assistant message", () => {
    const emitted = run([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: AUQ_INPUT },
          ],
        },
      },
    ]);
    const toolInputs = emitted.filter(([e]) => e === "tool_input");
    expect(toolInputs).toHaveLength(1);
    expect(toolInputs[0][1]).toEqual({
      id: "toolu_1",
      name: "AskUserQuestion",
      input: AUQ_INPUT,
    });
  });

  it("regression: AskUserQuestion torn down before its input deltas still yields real input", () => {
    // Repro of the bug: content_block_start fires (client shows the question
    // card), but NO input_json_delta arrives before the block is torn down.
    // The full input only exists in the complete assistant message. Without the
    // assistant handler the client was left with empty input → "(still
    // streaming…)". Now the assistant message carries it.
    const emitted = run([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_9", name: "AskUserQuestion", input: {} },
        },
      },
      // no content_block_delta for index 0 — the gap that caused the bug
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_9", name: "AskUserQuestion", input: AUQ_INPUT },
          ],
        },
      },
    ]);

    // tool_start opened the card...
    expect(emitted.find(([e, p]) => e === "tool_start" && p.id === "toolu_9")).toBeTruthy();
    // ...and tool_input supplies the real, non-empty input keyed by the same id.
    const ti = emitted.find(([e, p]) => e === "tool_input" && p.id === "toolu_9");
    expect(ti).toBeTruthy();
    expect(ti![1].input).toEqual(AUQ_INPUT);
    // And the input is actually parseable back into a question with options.
    const parsed = JSON.parse((ti![1].input as { questions: string }).questions);
    expect(parsed[0].question).toContain("named");
    expect(parsed[0].options).toHaveLength(2);
  });

  it("still streams a normal tool via partial deltas (start → delta → stop)", () => {
    const emitted = run([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file":"a.ts"}' },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
    ]);
    expect(emitted.map(([e]) => e)).toEqual(["tool_start", "tool_input_delta", "tool_stop"]);
    const stop = emitted.find(([e]) => e === "tool_stop")!;
    expect(stop[1].input).toEqual({ file: "a.ts" });
    expect(stop[1].inputRaw).toBe('{"file":"a.ts"}');
  });

  it("content_block_stop with no deltas reports an empty object (client keeps prior input)", () => {
    // The empty {} here is exactly what must NOT clobber a good input on the
    // client; this asserts the server's side of that contract.
    const emitted = run([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_3", name: "AskUserQuestion", input: {} },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    ]);
    const stop = emitted.find(([e]) => e === "tool_stop")!;
    expect(stop[1].input).toEqual({});
  });
});
