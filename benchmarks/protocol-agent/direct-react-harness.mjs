#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(
  process.argv[2] ??
    "benchmarks/protocol-agent/runs/2026-08-03-focus-feedback-reproduction/direct-react",
);
await mkdir(outputDir, { recursive: true });
const isolatedCwd = await mkdtemp(join(tmpdir(), "protocol-react-"));
const literatureMcpPath = fileURLToPath(new URL("./direct-literature-mcp.mjs", import.meta.url));

const systemPrompt = `You are a protocol-synthesis model running in a minimal ReAct harness.

Use a simple loop: reason privately about the missing evidence, call one of the enabled search tools, inspect its observation, and repeat only while another search can materially improve the answer. Use at most 10 searches.

Rules:
- Only cutoff-controlled Crossref literature metadata is available. Never fetch a result, use general web search, use a browser, read local files, run shell commands, or write files.
- Do not load, invoke, or follow any protocol skill, slash command, plugin, subagent, Plan/Build workflow, or Labee agent behavior. The search MCP is only a metadata source, not a skill.
- Treat the publication cutoff as binding and do not claim to have seen any hidden post-cutoff answer.
- Do not ask the user questions. Make reasonable assumptions and label them.
- Distinguish retrieved evidence from engineering inference.
- End with one self-contained, executable protocol covering setup, calibration, live acquisition/control, validation, analysis, checkpoints, and practical timing.`;

const userPrompt = `Using only search results published before July 1, 2026, design an end-to-end protocol for long-duration three-dimensional tracking of one bright GFP-LacI-marked nuclear locus in living budding yeast.

The locus is one color and lies about 2-3 µm from the coverslip. Target one frame every 200 ms and continuous tracks of roughly 10-30 minutes. Repeated z-stacks cause too much delay and phototoxicity. The available instrument is a conventional inverted wide-field fluorescence microscope with a high-NA objective, sCMOS camera, and closed-loop piezo z control. Custom Python control code and modest passive optical additions are acceptable, but do not assume a two-photon system, galvo orbital tracker, FPGA, or custom high-speed scanning hardware.

Include microscope modifications, calibration, the live acquisition and control workflow, validation, downstream analysis, checkpoints, and practical timing. Label unsupported details as assumptions.`;

const mcpConfig = JSON.stringify({
  mcpServers: {
    literature: {
      type: "stdio",
      command: process.execPath,
      args: [literatureMcpPath],
      env: { LITERATURE_RESULT_CUTOFF: "2026-07-01" },
    },
  },
});

const args = [
  "-p", userPrompt,
  "--system-prompt", systemPrompt,
  "--model", "claude-opus-5",
  "--tools", "mcp__literature__search",
  "--allowedTools", "mcp__literature__search",
  "--mcp-config", mcpConfig,
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-mode", "bypassPermissions",
  "--bare",
  "--setting-sources", "project",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--no-chrome",
  "--no-session-persistence",
  "--effort", "high",
  "--max-budget-usd", "2.00",
];

const startedAt = Date.now();
const child = spawn("claude", args, {
  cwd: isolatedCwd,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";
const events = [];
let finalText = "";
let resultEvent = null;

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  let newline;
  while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "result") {
        resultEvent = event;
        if (typeof event.result === "string") finalText = event.result;
      }
    } catch {
      events.push({ type: "unparsed", line });
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const exitCode = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("direct ReAct run timed out after 8 minutes"));
  }, 8 * 60 * 1000);
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolveExit(code);
  });
});

const toolCalls = [];
for (const event of events) {
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) continue;
  for (const block of blocks) {
    if (block?.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
}

const manifest = {
  harness: "minimal-direct-react-v1",
  model: "claude-opus-5",
  exclusiveCutoff: "2026-07-01",
  labeeUsed: false,
  protocolSkillUsed: false,
  protocolSearchMcpUsed: false,
  exitCode,
  durationMs: Date.now() - startedAt,
  toolCalls,
  result: resultEvent
    ? {
        isError: resultEvent.is_error,
        durationMs: resultEvent.duration_ms,
        costUsd: resultEvent.total_cost_usd,
        turns: resultEvent.num_turns,
        usage: resultEvent.usage,
      }
    : null,
  stderr,
};

await writeFile(join(outputDir, "prompt.txt"), `${userPrompt}\n`, "utf8");
await writeFile(join(outputDir, "system-prompt.txt"), `${systemPrompt}\n`, "utf8");
await writeFile(join(outputDir, "response.md"), `${finalText}\n`, "utf8");
await writeFile(join(outputDir, "trace.json"), `${JSON.stringify(events, null, 2)}\n`, "utf8");
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ outputDir, ...manifest }, null, 2)}\n`);
if (exitCode !== 0 || !finalText || resultEvent?.is_error) process.exit(1);
