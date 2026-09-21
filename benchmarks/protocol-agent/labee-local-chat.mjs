import { readFile } from "node:fs/promises";
import { sealData } from "iron-session";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("usage: bun labee-local-chat.mjs <request.json>");

const password = Bun.env.SESSION_PASSWORD;
if (!password) throw new Error("SESSION_PASSWORD is not loaded");

const email = Bun.env.BENCHMARK_LABEE_EMAIL ?? "menbinwan@gmail.com";
const token = await sealData(
  { email, isAdmin: true },
  { password, ttl: 60 * 60 },
);
const body = JSON.parse(await readFile(requestPath, "utf8"));

const response = await fetch("http://127.0.0.1:3000/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `monterey_session=${encodeURIComponent(token)}`,
  },
  body: JSON.stringify(body),
});

if (!response.ok || !response.body) {
  throw new Error(`Labee HTTP ${response.status}: ${await response.text()}`);
}

const output = { content: "", tools: [], session: null, stats: null, errors: [] };
const toolById = new Map();
let buffer = "";
const decoder = new TextDecoder();

function consume(block) {
  let event = "";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!event || data.length === 0) return;
  let payload;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return;
  }

  if (event === "delta") output.content += String(payload.text ?? "");
  else if (event === "init") output.session = payload;
  else if (event === "result") {
    output.stats = {
      isError: Boolean(payload.is_error),
      costUsd: payload.total_cost_usd,
      durationMs: payload.duration_ms,
      numTurns: payload.num_turns,
      usage: payload.usage,
      modelUsage: payload.model_usage,
    };
  }
  else if (event === "error") output.errors.push(String(payload.message ?? "Stream error"));
  else if (event === "tool_start") {
    const tool = { id: String(payload.id ?? ""), name: String(payload.name ?? ""), inputRaw: "" };
    output.tools.push(tool);
    toolById.set(tool.id, tool);
  } else if (event === "tool_input_delta") {
    const tool = toolById.get(String(payload.id ?? ""));
    if (tool) tool.inputRaw += String(payload.partial_json ?? "");
  } else if (event === "tool_input") {
    const id = String(payload.id ?? "");
    let tool = toolById.get(id);
    if (!tool) {
      tool = { id, name: String(payload.name ?? ""), inputRaw: "" };
      output.tools.push(tool);
      toolById.set(id, tool);
    }
    tool.input = payload.input;
  } else if (event === "tool_stop") {
    const tool = toolById.get(String(payload.id ?? ""));
    if (tool && payload.input && Object.keys(payload.input).length > 0) tool.input = payload.input;
  } else if (event === "tool_result") {
    const tool = toolById.get(String(payload.id ?? ""));
    if (tool) {
      tool.isError = Boolean(payload.is_error);
      const rendered = typeof payload.content === "string"
        ? payload.content
        : JSON.stringify(payload.content);
      tool.resultPreview = rendered.slice(0, 500);
    }
  }
}

for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let split;
  while ((split = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    if (block.trim()) consume(block);
  }
}
if (buffer.trim()) consume(buffer);

for (const tool of output.tools) {
  if (tool.input === undefined && tool.inputRaw) {
    try { tool.input = JSON.parse(tool.inputRaw); } catch { /* keep raw input */ }
  }
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
