// A warm planner process (docs/siri-agent-design.md §3): on a Mac the only
// sanctioned way to the model is the Claude CLI, and spawning it per phrase
// costs 2–5 s before the first token, which is most of Siri's patience. So
// one CLI process per account stays alive between phrases, fed user
// messages over stdin (`--input-format stream-json`): the first answer pays
// the start-up, the rest take about a second. It also carries the
// conversation itself, though the exchange context in each message is what
// the planner relies on, so a restart loses nothing that matters.
//
// No tools, one model, a system prompt fixed at spawn. Idle processes are
// closed after ten minutes; a long conversation is restarted to keep the
// context small. Anything that goes wrong falls back to the one-shot path.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { CLAUDE_BIN, childEnv } from "../claudeRunner";

const IDLE_MS = 10 * 60 * 1000;
const MAX_TURNS = 40;
/** A single answer never waits longer than this; the process is restarted. */
const HARD_MS = 90_000;

interface Waiter {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

class WarmProcess {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private buf = "";
  private queue: Array<{ text: string; waiter: Waiter }> = [];
  private current: Waiter | null = null;
  private turns = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private hard: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly key: string,
    private readonly systemPrompt: string,
    private readonly model: string,
  ) {}

  get alive(): boolean {
    return this.proc !== null;
  }

  private start(): void {
    const cwd = path.join(process.env.LABEE_DATA_DIR || path.join(process.cwd(), "data"), "siri");
    fs.mkdirSync(cwd, { recursive: true });
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt", this.systemPrompt,
      "--model", this.model,
      "--tools", "",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--effort", "low",
    ];
    const proc = spawn(CLAUDE_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    this.proc = proc;
    this.buf = "";
    this.turns = 0;
    proc.stdout.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8").trim();
      if (s) console.warn(`[siri-warm ${this.key}] ${s.slice(0, 300)}`);
    });
    proc.on("error", (e) => this.fail(new Error(`planner process error: ${e.message}`)));
    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = null;
      this.fail(new Error(`planner process exited (${code ?? "signal"})`));
    });
    console.log(`[siri-warm ${this.key}] started`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m: { type?: string; result?: unknown; is_error?: boolean; subtype?: string };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        continue;
      }
      if (m.type !== "result") continue;
      const text = typeof m.result === "string" ? m.result : "";
      const w = this.current;
      this.current = null;
      if (this.hard) clearTimeout(this.hard);
      this.hard = null;
      if (w) {
        if (m.is_error) w.reject(new Error(`planner: ${text || m.subtype || "error"}`));
        else w.resolve(text);
      }
      this.pump();
    }
  }

  /** Reject whatever is waiting; the next ask starts a fresh process. */
  private fail(e: Error): void {
    const w = this.current;
    this.current = null;
    if (this.hard) clearTimeout(this.hard);
    this.hard = null;
    w?.reject(e);
    for (const q of this.queue.splice(0)) q.waiter.reject(e);
    this.proc = null;
  }

  private pump(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) {
      this.touch();
      return;
    }
    if (!this.proc || this.turns >= MAX_TURNS) {
      this.kill();
      this.start();
    }
    this.current = next.waiter;
    this.turns++;
    this.hard = setTimeout(() => {
      this.kill();
      this.fail(new Error("planner answer took too long"));
    }, HARD_MS);
    const msg = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: next.text }] } });
    this.proc!.stdin.write(`${msg}\n`);
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(), IDLE_MS);
  }

  kill(): void {
    const p = this.proc;
    this.proc = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (p) {
      try {
        p.stdin.end();
        p.kill("SIGTERM");
      } catch {
        // gone already
      }
    }
  }

  /** One message in, one answer out, in order. */
  ask(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ text, waiter: { resolve, reject } });
      this.pump();
    });
  }
}

const processes = new Map<string, WarmProcess>();

/** The warm process for this account and prompt (a new prompt means a new
 *  process, since the system prompt is fixed at spawn). */
export function warmPlanner(email: string, systemPrompt: string, model: string): WarmProcess {
  const key = `${email}:${hash(systemPrompt)}:${model}`;
  let p = processes.get(key);
  if (!p) {
    for (const [k, old] of processes) if (k.startsWith(`${email}:`)) { old.kill(); processes.delete(k); }
    p = new WarmProcess(email, systemPrompt, model);
    processes.set(key, p);
  }
  return p;
}

export function stopWarmPlanners(): void {
  for (const p of processes.values()) p.kill();
  processes.clear();
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
