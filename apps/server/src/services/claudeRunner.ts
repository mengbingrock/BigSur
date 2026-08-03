// The single claude-CLI spawn path, shared by the chat route (streaming SSE),
// the auxiliary one-shot completions (complete.ts), and the research run
// engine (research/). Callers describe an invocation with ClaudeArgsOpts and
// consume either the raw stream-json event feed (spawnClaudeStream) or a
// one-shot result (runClaudeText / runClaudeJson).
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

export const CLAUDE_NOT_FOUND =
  "Claude Code isn't installed (or wasn't found on your PATH). Install it with " +
  "`npm i -g @anthropic-ai/claude-code`, then restart the app. To use OpenAI " +
  "Codex instead, set the agent's engine to Codex.";

/** True when a spawn failure means the claude binary couldn't be found. */
export function isMissingClaude(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export interface ClaudeArgsOpts {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** `""` disables all tools (pure-LLM call); `"default"` is the full set. */
  tools: string;
  outputFormat: "stream-json" | "text";
  permissionMode: "bypassPermissions" | "default";
  /** e.g. "project" or "project,user". Omitted → CLI default. */
  settingSources?: string;
  excludeDynamicSystemPromptSections?: boolean;
  disallowedTools?: readonly string[];
  /** Pass-through extra args, e.g. protocolsMcpArgs(). */
  mcpArgs?: readonly string[];
  chrome?: boolean;
  effort: "low" | "medium" | "high";
}

/** Assemble the claude CLI argv for an invocation. Flag set (not order) is the
 *  contract; stream-json implies --verbose --include-partial-messages. */
export function buildClaudeArgs(o: ClaudeArgsOpts): string[] {
  const args = [
    "-p", o.prompt,
    "--system-prompt", o.systemPrompt,
    "--model", o.model,
    "--tools", o.tools,
    "--output-format", o.outputFormat,
  ];
  if (o.outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }
  args.push("--permission-mode", o.permissionMode, "--no-session-persistence");
  if (o.settingSources) args.push("--setting-sources", o.settingSources);
  if (o.excludeDynamicSystemPromptSections) args.push("--exclude-dynamic-system-prompt-sections");
  if (o.disallowedTools && o.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...o.disallowedTools);
  }
  if (o.mcpArgs && o.mcpArgs.length > 0) args.push(...o.mcpArgs);
  if (o.chrome) args.push("--chrome");
  args.push("--effort", o.effort);
  return args;
}

export interface ClaudeSpawnOpts {
  cwd: string;
  args: readonly string[];
  extraEnv?: NodeJS.ProcessEnv;
  /** SIGKILL the child after this long. The onClose handler still fires. */
  timeoutMs?: number;
}

export interface ClaudeSpawnHandlers {
  /** One parsed stream-json event per CLI stdout line. */
  onEvent: (evt: Record<string, unknown>) => void;
  /** Async spawn failure (e.g. binary vanished mid-flight). */
  onError: (message: string) => void;
  /** Process exited. `stderrTail` is the (capped) raw stderr buffer;
   *  `timedOut` is set when the runner killed the child at timeoutMs. */
  onClose: (code: number | null, stderrTail: string, timedOut: boolean) => void;
}

export interface ClaudeChild {
  kill: () => void;
}

const STDERR_CAP = 8192;

/** Spawn the claude CLI and feed parsed stream-json events to the handlers.
 *  Throws synchronously if the process cannot be started at all — callers
 *  translate that with isMissingClaude/CLAUDE_NOT_FOUND. */
export function spawnClaudeStream(
  opts: ClaudeSpawnOpts,
  handlers: ClaudeSpawnHandlers,
): ClaudeChild {
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    CLAUDE_BIN,
    opts.args as string[],
    {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.extraEnv },
    },
  );

  let stderrBuf = "";
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, opts.timeoutMs)
    : null;

  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      handlers.onEvent(evt);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(-STDERR_CAP);
  });

  proc.on("error", (err) => {
    if (timer) clearTimeout(timer);
    handlers.onError(isMissingClaude(err) ? CLAUDE_NOT_FOUND : err.message);
  });

  proc.on("close", (code) => {
    if (timer) clearTimeout(timer);
    handlers.onClose(code, stderrBuf, timedOut);
  });

  return {
    kill: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}

export interface ClaudeTextOpts {
  prompt: string;
  systemPrompt: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  cwd?: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Defaults to "" (no tools) — one-shot completions are pure LLM calls. */
  tools?: string;
  disallowedTools?: readonly string[];
  mcpArgs?: readonly string[];
  settingSources?: string;
}

/** One-shot completion: spawn `claude -p … --output-format text`, resolve stdout. */
export function runClaudeText(opts: ClaudeTextOpts): Promise<string> {
  const args = buildClaudeArgs({
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    model: opts.model,
    tools: opts.tools ?? "",
    outputFormat: "text",
    permissionMode: "bypassPermissions",
    effort: opts.effort,
    ...(opts.settingSources ? { settingSources: opts.settingSources } : {}),
    ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
    ...(opts.mcpArgs ? { mcpArgs: opts.mcpArgs } : {}),
  });
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`claude timed out after ${opts.timeoutMs / 1000}s`));
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        return reject(new Error(`claude exited ${code}${tail ? `: ${tail}` : ""}`));
      }
      resolve(stdout);
    });
  });
}

/** Pull the last fenced ```json block out of a completion; falls back to
 *  treating the whole trimmed text as JSON. Returns null if nothing parses. */
export function extractLastJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = [];
  if (fences.length > 0) candidates.push(fences[fences.length - 1]![1]!);
  candidates.push(text.trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** One-shot structured completion. `validate` throws (with a useful message)
 *  on shape mismatch; on parse/validation failure the call is retried with the
 *  error appended to the prompt, up to maxAttempts total. `_runText` is
 *  injectable for tests. */
export async function runClaudeJson<A>(
  opts: ClaudeTextOpts,
  validate: (u: unknown) => A,
  maxAttempts = 2,
  _runText: (o: ClaudeTextOpts) => Promise<string> = runClaudeText,
): Promise<A> {
  let prompt = opts.prompt;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const text = await _runText({ ...opts, prompt });
    const parsed = extractLastJson(text);
    if (parsed === null) {
      lastError = "Output contained no parseable JSON.";
    } else {
      try {
        return validate(parsed);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    prompt =
      opts.prompt +
      `\n\nYour previous output failed validation: ${lastError}\n` +
      "Respond again with ONLY a single fenced ```json block matching the required shape.";
  }
  throw new Error(`Structured output failed after ${maxAttempts} attempts: ${lastError}`);
}
