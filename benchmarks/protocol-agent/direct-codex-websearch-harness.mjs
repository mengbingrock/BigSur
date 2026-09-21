#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const outputDir = resolve(
  process.argv[2]
    ?? "benchmarks/protocol-agent/runs/2026-08-03-focus-feedback-reproduction/direct-codex-websearch",
);
await mkdir(outputDir, { recursive: true });
const isolatedCwd = await mkdtemp(join(tmpdir(), "codex-native-web-react-"));
const responsePath = join(outputDir, "response.md");

const prompt = `You are a protocol-synthesis model in a minimal, answer-blind ReAct benchmark.

Use a simple loop: reason privately about missing evidence, use only the built-in web_search tool, inspect its observation, and repeat only while another search can materially improve the answer. Use at most 10 searches.

Hard rules:
- The exclusive publication cutoff is publicationDate < 2026-07-01.
- Add before:2026-07-01 to every web-search query. Do not use, cite, open, or rely on a result unless its displayed publication date is strictly before July 1, 2026. If the date is missing or ambiguous, reject it.
- Never use MCP, shell, local files, a browser UI, article-fetch tools outside built-in web_search, subagents, skills, plugins, or a Plan/Build workflow.
- Do not load, invoke, or follow any protocol skill or Labee behavior.
- Do not seek a hidden target article or post-cutoff answer. You have not seen one and must not claim otherwise.
- Do not ask questions. Make reasonable assumptions and label them.
- Distinguish retrieved evidence from engineering inference.
- End with one self-contained executable protocol covering setup, calibration, live acquisition/control, validation, analysis, checkpoints, and practical timing.

Task:
Design an end-to-end protocol for long-duration three-dimensional tracking of one bright GFP-LacI-marked nuclear locus in living budding yeast.

The locus is one color and lies about 2-3 µm from the coverslip. Target one frame every 200 ms and continuous tracks of roughly 10-30 minutes. Repeated z-stacks cause too much delay and phototoxicity. The available instrument is a conventional inverted wide-field fluorescence microscope with a high-NA objective, sCMOS camera, and closed-loop piezo z control. Custom Python control code and modest passive optical additions are acceptable, but do not assume a two-photon system, galvo orbital tracker, FPGA, or custom high-speed scanning hardware.

Include microscope modifications, calibration, the live acquisition and control workflow, validation, downstream analysis, checkpoints, and practical timing. Label unsupported details as assumptions.`;

const args = [
  "--search",
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--sandbox", "read-only",
  "--cd", isolatedCwd,
  "--model", "gpt-5.6-sol",
  "--config", 'model_reasoning_effort="high"',
  "--config", 'approval_policy="never"',
  "--output-last-message", responsePath,
  prompt,
];

const startedAt = Date.now();
const child = spawn("codex", args, {
  cwd: isolatedCwd,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

const exitCode = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("direct Codex web-search run timed out after 12 minutes"));
  }, 12 * 60 * 1000);
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => { clearTimeout(timer); resolveExit(code); });
});

const events = stdout
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => {
    try { return JSON.parse(line); } catch { return { type: "unparsed", line }; }
  });
let response = "";
try { response = await readFile(responsePath, "utf8"); } catch { /* recorded below */ }

const manifest = {
  harness: "minimal-direct-codex-native-web-v1",
  model: "gpt-5.6-sol",
  exclusiveCutoff: "2026-07-01",
  labeeUsed: false,
  protocolSkillUsed: false,
  protocolSearchMcpUsed: false,
  anyMcpConfigured: false,
  nativeWebSearchEnabled: true,
  isolation: {
    ephemeral: true,
    userConfigIgnored: true,
    projectRulesIgnored: true,
    sandbox: "read-only",
    isolatedWorkingDirectory: true,
  },
  exitCode,
  durationMs: Date.now() - startedAt,
  stderr,
};

await writeFile(join(outputDir, "prompt.txt"), `${prompt}\n`, "utf8");
await writeFile(join(outputDir, "trace.json"), `${JSON.stringify(events, null, 2)}\n`, "utf8");
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputDir, responseBytes: response.length, ...manifest }, null, 2)}\n`);
if (exitCode !== 0 || !response.trim()) process.exit(1);
