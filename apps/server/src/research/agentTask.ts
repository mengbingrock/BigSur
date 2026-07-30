// One sub-agent invocation = one research_tasks row = one claude CLI child.
// Wraps the shared runner with: global + per-run concurrency, cancellation,
// transcript capture, live delta events, evidence interception for protocols
// MCP retrievals, cost accounting with the fail-closed cost cap, and a
// structured-output retry loop.
import path from "node:path";
import type { ResearchRole, ResearchStage } from "@labee/contracts";
import { buildClaudeArgs, extractLastJson, spawnClaudeStream } from "../services/claudeRunner";
import { ensureProtocolsMcpToken, protocolsMcpArgs } from "../services/protocolsMcp";
import { ROLES, roleModel } from "./roles";
import { addRunCost, finishTask, insertTask } from "./runsDb";
import { emitRunEvent } from "./events";
import { cacheProtocolsToolResult } from "./evidence";
import { appendTranscript } from "./workspace";
import { RunCancelled, RunFailed, type RunSpec } from "./types";
import type { RunHandle } from "./registry";

/** Minimal counting semaphore. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private held = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.held < this.limit) {
      this.held++;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.held++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

/** Process-wide cap on concurrent research CLI children (all runs). */
const GLOBAL_MAX = (() => {
  const n = parseInt(process.env.RESEARCH_MAX_AGENTS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();
export const globalAgentSemaphore = new Semaphore(GLOBAL_MAX);

export interface RunCtx {
  runId: string;
  email: string;
  workspaceDir: string;
  spec: RunSpec;
  /** Credential env from claudeEnvForCredential(). */
  extraEnv: NodeJS.ProcessEnv;
  handle: RunHandle;
  /** Per-run concurrency gate (spec.budget.maxConcurrentAgents). */
  runSemaphore: Semaphore;
}

export interface AgentTaskOpts {
  stage: ResearchStage;
  role: ResearchRole;
  /** The task input, appended to the role's system prompt as the user turn. */
  prompt: string;
  /** Absolute cwd; defaults to the run workspace. */
  cwd?: string;
  branch?: string | null;
  parentTaskId?: string | null;
  attempt?: number;
  timeoutMs?: number;
}

export interface AgentTaskResult {
  taskId: string;
  text: string;
  costUsd: number;
}

function throwIfAborted(ctx: RunCtx): void {
  if (ctx.handle.abort.signal.aborted) throw new RunCancelled();
}

/** Run one sub-agent to completion and return its final text. */
export async function runAgentTask(ctx: RunCtx, opts: AgentTaskOpts): Promise<AgentTaskResult> {
  throwIfAborted(ctx);
  const releaseRun = await ctx.runSemaphore.acquire();
  const releaseGlobal = await globalAgentSemaphore.acquire();
  const started = Date.now();
  try {
    throwIfAborted(ctx);
    const role = ROLES[opts.role];
    const model = roleModel(opts.role, ctx.spec.modelTiers);
    if (role.protocolsMcp) await ensureProtocolsMcpToken();
    const mcpArgs = role.protocolsMcp ? protocolsMcpArgs() : [];

    const taskId = await insertTask({
      runId: ctx.runId,
      stage: opts.stage,
      role: opts.role,
      branch: opts.branch ?? null,
      parentTaskId: opts.parentTaskId ?? null,
      attempt: opts.attempt ?? 1,
      model,
      input: { promptBytes: Buffer.byteLength(opts.prompt, "utf8") },
    });
    const meta = {
      taskId,
      stage: opts.stage,
      role: opts.role,
      branch: opts.branch ?? null,
    };
    await emitRunEvent(ctx.runId, "task_started", { model, attempt: opts.attempt ?? 1 }, meta);

    const args = buildClaudeArgs({
      prompt: opts.prompt,
      systemPrompt: role.systemPrompt,
      model,
      tools: role.tools,
      outputFormat: "stream-json",
      permissionMode: "bypassPermissions",
      settingSources: "project",
      excludeDynamicSystemPromptSections: true,
      ...(role.tools === "default" && role.disallowedTools.length > 0
        ? { disallowedTools: role.disallowedTools }
        : {}),
      ...(mcpArgs.length > 0 ? { mcpArgs } : {}),
      effort: role.effort,
    });

    const cwd = opts.cwd ?? ctx.workspaceDir;
    const result = await new Promise<{ text: string; costUsd: number; error?: string }>(
      (resolve) => {
        let finalText = "";
        let costUsd = 0;
        let errored: string | undefined;
        // tool_use id → {name, input}, for pairing tool_results to requests.
        const toolUses = new Map<string, { name: string; input: unknown }>();

        // Assigned once the child registers with the run handle; onClose can
        // fire only after spawn returns, so the placeholder is never the one
        // that runs.
        let cleanup = () => {};
        try {
        const child = spawnClaudeStream(
          {
            cwd,
            args,
            extraEnv: ctx.extraEnv,
            timeoutMs: opts.timeoutMs ?? role.timeoutMs,
          },
          {
            onEvent: (evt) => {
              void appendTranscript(ctx.workspaceDir, taskId, evt).catch(() => {});
              const type = evt.type;
              if (type === "stream_event") {
                const inner = (evt as { event?: Record<string, unknown> }).event;
                const innerType = inner?.type;
                if (innerType === "content_block_delta") {
                  const delta = (inner as { delta?: Record<string, unknown> }).delta;
                  if (delta?.type === "text_delta" && typeof delta.text === "string") {
                    void emitRunEvent(ctx.runId, "agent_delta", { text: delta.text }, meta);
                  }
                }
                return;
              }
              if (type === "assistant") {
                const content = (evt as { message?: { content?: unknown } }).message?.content;
                if (!Array.isArray(content)) return;
                for (const item of content as Record<string, unknown>[]) {
                  if (item.type !== "tool_use") continue;
                  toolUses.set(String(item.id), {
                    name: String(item.name),
                    input: item.input ?? null,
                  });
                  void emitRunEvent(ctx.runId, "agent_tool", { name: item.name }, meta);
                }
                return;
              }
              if (type === "user") {
                const content = (evt as { message?: { content?: unknown } }).message?.content;
                if (!Array.isArray(content)) return;
                for (const item of content as Record<string, unknown>[]) {
                  if (item.type !== "tool_result") continue;
                  const use = toolUses.get(String(item.tool_use_id));
                  if (use && use.name.startsWith("mcp__protocols__") && !item.is_error) {
                    void cacheProtocolsToolResult(ctx, use.name, use.input, item.content).catch(
                      () => {},
                    );
                  }
                }
                return;
              }
              if (type === "result") {
                if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
                if (typeof evt.result === "string") finalText = evt.result;
                if (evt.is_error) errored = String(evt.result ?? "agent returned an error result");
              }
            },
            onError: (message) => {
              errored = message;
            },
            onClose: (code, stderrTail, timedOut) => {
              cleanup();
              if (timedOut) {
                errored = `agent timed out after ${(opts.timeoutMs ?? role.timeoutMs) / 60000} min`;
              } else if (code !== 0 && !errored) {
                const tail = stderrTail.trim().split("\n").slice(-5).join(" | ");
                errored = `claude CLI exited with code ${code}${tail ? `: ${tail}` : ""}`;
              }
              resolve(
                errored ? { text: finalText, costUsd, error: errored } : { text: finalText, costUsd },
              );
            },
          },
        );

        ctx.handle.kills.add(child.kill);
        const onAbort = () => child.kill();
        ctx.handle.abort.signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => {
          ctx.handle.kills.delete(child.kill);
          ctx.handle.abort.signal.removeEventListener("abort", onAbort);
        };
        } catch (err) {
          resolve({
            text: "",
            costUsd: 0,
            error: err instanceof Error ? err.message : "Failed to spawn claude.",
          });
        }
      },
    );

    const durationMs = Date.now() - started;
    const total = await addRunCost(ctx.runId, result.costUsd);

    if (ctx.handle.abort.signal.aborted) {
      await finishTask(taskId, { status: "cancelled", costUsd: result.costUsd, durationMs });
      throw new RunCancelled();
    }
    if (result.error) {
      await finishTask(taskId, {
        status: "failed",
        costUsd: result.costUsd,
        durationMs,
        error: result.error,
      });
      await emitRunEvent(ctx.runId, "task_finished", { ok: false, error: result.error }, meta);
      throw new Error(`[${opts.role}] ${result.error}`);
    }
    await finishTask(taskId, {
      status: "succeeded",
      costUsd: result.costUsd,
      durationMs,
      outputPath: path.join("tasks", `${taskId}.jsonl`),
    });
    await emitRunEvent(
      ctx.runId,
      "task_finished",
      { ok: true, costUsd: result.costUsd, durationMs },
      meta,
    );

    const cap = ctx.spec.budget.maxCostUsd;
    if (cap != null && total > cap) {
      throw new RunFailed("COST_CAP", `Run cost $${total.toFixed(2)} exceeded the $${cap} cap.`);
    }
    return { taskId, text: result.text, costUsd: result.costUsd };
  } finally {
    releaseGlobal();
    releaseRun();
  }
}

/** Run a structured-output role: parse the last fenced JSON block of the
 *  final text, validate, and retry once with the validation error appended. */
export async function runStructuredTask<A>(
  ctx: RunCtx,
  opts: AgentTaskOpts,
  validate: (u: unknown) => A,
  maxAttempts = 2,
): Promise<A & { __taskId: string }> {
  let lastError = "";
  let parentTaskId: string | null = opts.parentTaskId ?? null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1
        ? opts.prompt
        : opts.prompt +
          `\n\nYour previous output failed validation: ${lastError}\n` +
          "Respond again, ending with ONE fenced ```json block matching the required shape exactly.";
    const result = await runAgentTask(ctx, { ...opts, prompt, attempt, parentTaskId });
    parentTaskId = result.taskId;
    const parsed = extractLastJson(result.text);
    if (parsed === null) {
      lastError = "Output contained no parseable JSON block.";
      continue;
    }
    try {
      const value = validate(parsed);
      return Object.assign(value as A & { __taskId: string }, { __taskId: result.taskId });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `[${opts.role}] structured output failed after ${maxAttempts} attempts: ${lastError}`,
  );
}

/** Map over items with bounded concurrency, failing fast on the first error. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown = null;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failed === null) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = err ?? new Error("task failed");
      }
    }
  });
  await Promise.all(workers);
  if (failed !== null) throw failed;
  return results;
}
