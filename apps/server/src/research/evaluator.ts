// Golden-evaluator runner. `command` evaluators run in the node's workspace;
// the contract is: last non-empty stdout line is `{"score": <number>, ...}`.
// With `kind:"none"` the caller falls back to LLM-rubric scoring (pruning
// only — those scores are never treated as verified results).
import { spawn } from "node:child_process";
import type { EvaluatorSpec } from "@labee/contracts";

export interface EvalResult {
  score: number;
  scoreKind: "golden" | "llm_rubric";
  details: unknown;
  raw?: string;
}

/** Parse the evaluator stdout contract: last non-empty line is JSON. */
export function parseEvaluatorOutput(stdout: string): { score: number; details: unknown } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("Evaluator produced no output.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new Error(`Evaluator's last stdout line is not JSON: ${last.slice(0, 200)}`);
  }
  const score = (parsed as { score?: unknown }).score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`Evaluator JSON lacks a numeric "score": ${last.slice(0, 200)}`);
  }
  return { score, details: parsed };
}

/** Run a command evaluator in `cwd`. Rejects on non-zero exit or timeout. */
export function runCommandEvaluator(
  spec: Extract<EvaluatorSpec, { kind: "command" }>,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<EvalResult> {
  const timeoutMs = spec.timeoutMs ?? 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const proc = spawn(spec.command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`Evaluator timed out after ${timeoutMs / 1000}s.`));
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        return reject(new Error(`Evaluator exited ${code}${tail ? `: ${tail}` : ""}`));
      }
      try {
        const { score, details } = parseEvaluatorOutput(stdout);
        resolve({ score, scoreKind: "golden", details, raw: stdout.slice(-4000) });
      } catch (err) {
        reject(err);
      }
    });
  });
}
