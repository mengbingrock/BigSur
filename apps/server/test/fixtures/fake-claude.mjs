#!/usr/bin/env node
// A stand-in for the `claude` CLI that emits a deterministic stream-json
// transcript, so the session runner and routes can be tested without a model.
// Behaviour is picked by FAKE_CLAUDE_SCRIPT:
//   default  — init, thinking, a tool call + result, streamed text, result
//   question — init, an AskUserQuestion tool call (then keeps running until killed)
//   slow     — like default but sleeps between text deltas (FAKE_CLAUDE_DELAY_MS)
//   fail     — init then exit 1 with stderr
//   echo     — streams the prompt text back (for transcript assertions)
const args = process.argv.slice(2);
const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] ?? "" : "";
// The prompt can pick the behaviour too (one long-lived server, many cases):
// "[[question]]", "[[slow]]", "[[fail]]", "[[echo]]" anywhere in the text.
const markers = [...prompt.matchAll(/\[\[(question|slow|fail|echo|default)\]\]/g)].map((m) => m[1]);
const marker = markers[markers.length - 1];
const script = marker || process.env.FAKE_CLAUDE_SCRIPT || "default";
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || (marker === "slow" ? 150 : 0));
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : "fake";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = "fake-session-" + process.pid;

async function main() {
  out({ type: "system", subtype: "init", model, session_id: sid, cwd: process.cwd(), permissionMode: "bypassPermissions", tools: ["Read"] });
  if (script === "fail") {
    process.stderr.write("fake failure\n");
    process.exit(1);
  }
  out({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
  if (script === "question") {
    const input = { questions: [{ question: "Which evaluator?", header: "Evaluator", options: [{ label: "Command" }, { label: "Rubric" }], multiSelect: false }] };
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_q1", name: "AskUserQuestion" } } });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input }] } });
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    // The real CLI would now block on the tool; stay alive until killed.
    await sleep(60_000);
    return;
  }
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } } });
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  out({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"README.md"}' } } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }] } });
  out({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# README" }] } });
  out({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "text" } } });
  const text = script === "echo" ? `You said: ${prompt.slice(-200)}` : "Hello from fake claude. The README is short.";
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: (i ? " " : "") + words[i] } } });
    if (script === "slow" && delay) await sleep(delay);
  }
  out({ type: "stream_event", event: { type: "content_block_stop", index: 2 } });
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } } });
  out({ type: "stream_event", event: { type: "message_stop" } });
  out({ type: "result", subtype: "success", duration_ms: 42, total_cost_usd: 0.001, num_turns: 1, is_error: false, result: text });
}
main();
