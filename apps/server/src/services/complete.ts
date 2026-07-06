// Provider-aware, non-streaming text completion for the auxiliary calls
// (canvas extraction, passage rewrite). Mirrors the chat route's provider
// dispatch but returns a single string.
import { spawn } from "node:child_process";
import { getSettings, resolveCredential } from "./llmSettings";
import { openAIComplete } from "./openai";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

function runClaudeText(opts: {
  system: string;
  user: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  apiKey: string | null;
}): Promise<string> {
  const { system, user, model, effort, timeoutMs, apiKey } = opts;
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CLAUDE_BIN,
      [
        "-p", user,
        "--system-prompt", system,
        "--model", model,
        "--tools", "",
        "--output-format", "text",
        "--no-session-persistence",
        "--permission-mode", "bypassPermissions",
        "--effort", effort,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : { ...process.env },
      },
    );
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
      if (killed) return reject(new Error(`claude timed out after ${timeoutMs / 1000}s`));
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        return reject(new Error(`claude exited ${code}${tail ? `: ${tail}` : ""}`));
      }
      resolve(stdout);
    });
  });
}

/** Complete a prompt with the user's active provider/credential. */
export async function completeText(opts: {
  email: string;
  system: string;
  user: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  anthropicModel: string;
  openaiModel: string;
}): Promise<string> {
  const settings = await getSettings(opts.email);
  const provider = settings.provider;
  const cred = await resolveCredential(opts.email, provider);
  if (cred.unavailable) throw new Error(cred.reason ?? "No usable LLM credential.");

  if (provider === "openai") {
    return openAIComplete({
      apiKey: cred.apiKey!,
      model: opts.openaiModel,
      system: opts.system,
      user: opts.user,
    });
  }
  return runClaudeText({
    system: opts.system,
    user: opts.user,
    model: opts.anthropicModel,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    apiKey: cred.apiKey,
  });
}
