// ChatGPT (OpenAI) subscription connection via the codex CLI — the same broker
// AgentScience uses. Connection STATUS is read straight from ~/.codex/auth.json
// (no binary/PATH dependency); sign-in, sign-out, and subscription inference
// shell out to the codex binary.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountConnection } from "@labee/contracts";

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
function authPath(): string {
  return path.join(codexHome(), "auth.json");
}

/** Resolve the codex binary across common install locations (the server's PATH
 *  may not include ~/.local/bin). */
let cachedBin: string | null | undefined;
export function codexBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = [
    process.env.CODEX_BIN,
    path.join(os.homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return (cachedBin = c);
    } catch {
      /* keep looking */
    }
  }
  // Fall back to a PATH lookup.
  try {
    const r = spawnSync("codex", ["--version"], { stdio: "ignore" });
    if (!r.error) return (cachedBin = "codex");
  } catch {
    /* not on PATH */
  }
  return (cachedBin = null);
}

export function codexAvailable(): boolean {
  return codexBin() !== null;
}

const PLAN_LABELS: Record<string, string> = {
  free: "ChatGPT Free Subscription",
  go: "ChatGPT Go Subscription",
  plus: "ChatGPT Plus Subscription",
  pro: "ChatGPT Pro Subscription",
  team: "ChatGPT Team Subscription",
  business: "ChatGPT Business Subscription",
  enterprise: "ChatGPT Enterprise Subscription",
  edu: "ChatGPT Edu Subscription",
};

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read the current codex/ChatGPT connection from ~/.codex/auth.json. */
export function readCodexConnection(): AccountConnection {
  const available = codexAvailable();
  let raw: string;
  try {
    raw = fs.readFileSync(authPath(), "utf8");
  } catch {
    return { available, connected: false };
  }
  let auth: {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: { id_token?: string };
  };
  try {
    auth = JSON.parse(raw);
  } catch {
    return { available, connected: false };
  }

  const idToken = auth.tokens?.id_token;
  if (idToken) {
    const claims = decodeJwtPayload(idToken) ?? {};
    const authClaim = (claims["https://api.openai.com/auth"] ?? {}) as {
      chatgpt_plan_type?: string;
    };
    const plan = authClaim.chatgpt_plan_type;
    const email = typeof claims.email === "string" ? claims.email : undefined;
    return {
      available,
      connected: true,
      kind: "subscription",
      planLabel: (plan && PLAN_LABELS[plan]) || "ChatGPT Subscription",
      ...(email ? { email } : {}),
    };
  }

  if (auth.auth_mode === "apikey" || auth.OPENAI_API_KEY) {
    return { available, connected: true, kind: "apiKey", planLabel: "OpenAI API Key" };
  }
  return { available, connected: false };
}

export interface CodexLoginResult {
  started: boolean;
  authUrl?: string;
  message?: string;
}

/** Start the ChatGPT browser sign-in. `codex login` opens the browser and runs
 *  a local callback server; we spawn it detached and let the client poll status. */
export function startCodexLogin(): Promise<CodexLoginResult> {
  const bin = codexBin();
  if (!bin) {
    return Promise.resolve({ started: false, message: "The codex CLI is not installed on this server." });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["login"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ started: false, message: e instanceof Error ? e.message : "Failed to start sign-in." });
      return;
    }
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const m = out.match(/https?:\/\/\S*auth\S*/i) || out.match(/https?:\/\/\S+/i);
      child.unref();
      resolve({ started: true, ...(m ? { authUrl: m[0] } : {}) });
    };
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (/https?:\/\//.test(out)) finish();
    });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
      if (/https?:\/\//.test(out)) finish();
    });
    child.on("error", (e) =>
      settled ? undefined : (resolve({ started: false, message: e.message }), (settled = true)),
    );
    // Resolve shortly even if no URL is printed (browser may auto-open).
    setTimeout(finish, 1500);
  });
}

/** Clear stored codex credentials. */
export function codexLogout(): Promise<{ ok: boolean; message?: string }> {
  const bin = codexBin();
  if (!bin) return Promise.resolve({ ok: false, message: "The codex CLI is not installed." });
  return new Promise((resolve) => {
    const child = spawn(bin, ["logout"], { stdio: "ignore" });
    child.on("error", (e) => resolve({ ok: false, message: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
  });
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Run a non-interactive `codex exec` turn (using the ChatGPT subscription) and
 *  surface the final message on Labee's SSE event protocol. */
export function codexExecStream(opts: {
  prompt: string;
  cwd: string;
  planLabel?: string;
}): ReadableStream<Uint8Array> {
  const { prompt, cwd, planLabel } = opts;
  const bin = codexBin();
  const aborted = { v: false };
  let proc: ReturnType<typeof spawn> | null = null;
  const outFile = path.join(os.tmpdir(), `labee-codex-${process.pid}-${Date.now()}.txt`);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      const enqueue = (event: string, data: unknown) => {
        if (aborted.v) return;
        controller.enqueue(sse(event, data));
      };
      enqueue("init", { model: planLabel ?? "ChatGPT", api_key_source: "chatgpt", permission_mode: "read-only" });
      if (!bin) {
        enqueue("error", { message: "The codex CLI is not installed on this server." });
        controller.close();
        return;
      }
      enqueue("status", { status: "thinking" });

      try {
        proc = spawn(
          bin,
          [
            "exec",
            "--skip-git-repo-check",
            "-s", "read-only",
            "-C", cwd,
            "-o", outFile,
            prompt,
          ],
          { stdio: ["ignore", "ignore", "pipe"], cwd },
        );
      } catch (e) {
        enqueue("error", { message: e instanceof Error ? e.message : "Failed to run codex." });
        controller.close();
        return;
      }

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      proc.on("error", (e) => {
        enqueue("error", { message: e.message });
        controller.close();
      });
      proc.on("close", (code) => {
        let finalText = "";
        try {
          finalText = fs.readFileSync(outFile, "utf8").trim();
        } catch {
          /* no output file */
        }
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        if (code !== 0 && !finalText) {
          const tail = stderr.trim().split("\n").slice(-4).join(" | ");
          enqueue("error", { message: `codex exited ${code}${tail ? `: ${tail}` : ""}` });
        } else {
          if (finalText) enqueue("delta", { index: 0, text: finalText });
          enqueue("result", { duration_ms: Date.now() - started, num_turns: 1 });
          enqueue("end", {});
        }
        controller.close();
      });
    },
    cancel() {
      aborted.v = true;
      try {
        proc?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  });
}
