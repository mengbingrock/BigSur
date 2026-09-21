#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = resolve(
  process.argv[2]
    ?? "benchmarks/protocol-agent/runs/2026-08-03-focus-feedback-reproduction/direct-codex-no-protocol-mcp",
);
await mkdir(outputDir, { recursive: true });
const isolatedCwd = await mkdtemp(join(tmpdir(), "codex-literature-react-"));
const literatureMcpPath = fileURLToPath(new URL("./direct-literature-mcp.mjs", import.meta.url));
const responsePath = join(outputDir, "response.md");

const prompt = `You are a protocol-synthesis model in a minimal, answer-blind ReAct benchmark.

Use a simple loop: reason privately about missing evidence, call only the enabled literature.search metadata tool, inspect its observation, and repeat only while another search can materially improve the answer. Use at most 10 searches.

Hard rules:
- Use only cutoff-controlled Crossref literature metadata returned by literature.search.
- Never use shell, local files, general web search, a browser, article fetch, subagents, skills, plugins, or a Plan/Build workflow.
- Do not load, invoke, or follow any protocol skill or Labee behavior. Do not use any tool named mcp__protocols__search.
- The exclusive publication cutoff is binding: publicationDate < 2026-07-01.
- You have not seen a hidden target article or answer. Do not claim otherwise.
- Do not ask questions. Make reasonable assumptions and label them.
- Distinguish retrieved metadata evidence from engineering inference.
- End with one self-contained executable protocol covering setup, calibration, live acquisition/control, validation, analysis, checkpoints, and practical timing.

Task:
Design an end-to-end protocol for long-duration three-dimensional tracking of one bright GFP-LacI-marked nuclear locus in living budding yeast.

The locus is one color and lies about 2-3 µm from the coverslip. Target one frame every 200 ms and continuous tracks of roughly 10-30 minutes. Repeated z-stacks cause too much delay and phototoxicity. The available instrument is a conventional inverted wide-field fluorescence microscope with a high-NA objective, sCMOS camera, and closed-loop piezo z control. Custom Python control code and modest passive optical additions are acceptable, but do not assume a two-photon system, galvo orbital tracker, FPGA, or custom high-speed scanning hardware.

Include microscope modifications, calibration, the live acquisition and control workflow, validation, downstream analysis, checkpoints, and practical timing. Label unsupported details as assumptions.`;

const args = [
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
  "--config", `mcp_servers.literature.command=${JSON.stringify(process.execPath)}`,
  "--config", `mcp_servers.literature.args=[${JSON.stringify(literatureMcpPath)}]`,
  "--config", 'mcp_servers.literature.env={LITERATURE_RESULT_CUTOFF="2026-07-01"}',
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
    reject(new Error("direct Codex run timed out after 12 minutes"));
  }, 12 * 60 * 1000);
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolveExit(code);
  });
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
  harness: "minimal-direct-codex-react-v1",
  model: "gpt-5.6-sol",
  exclusiveCutoff: "2026-07-01",
  labeeUsed: false,
  protocolSkillUsed: false,
  protocolSearchMcpUsed: false,
  configuredMcp: "literature",
  isolation: {
    ephemeral: true,
    userConfigIgnored: true,
    projectRulesIgnored: true,
    nativeWebSearchEnabled: false,
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
