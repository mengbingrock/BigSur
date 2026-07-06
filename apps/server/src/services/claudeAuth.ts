// Anthropic/Claude account connection via the `claude` CLI's claude.ai sign-in
// — the Claude analogue of the codex/ChatGPT broker. Status comes from
// `claude auth status --json`; sign-in/out shell out to `claude auth login|logout`.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountConnection } from "@labee/contracts";

let cachedBin: string | null | undefined;
export function claudeBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      if (c !== "claude" && fs.existsSync(c)) return (cachedBin = c);
    } catch {
      /* keep looking */
    }
  }
  try {
    const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
    if (!r.error) return (cachedBin = "claude");
  } catch {
    /* not on PATH */
  }
  return (cachedBin = null);
}

export function claudeAvailable(): boolean {
  return claudeBin() !== null;
}

const SUBSCRIPTION_LABELS: Record<string, string> = {
  max: "Claude Max Subscription",
  pro: "Claude Pro Subscription",
  free: "Claude Free",
  team: "Claude Team Subscription",
  enterprise: "Claude Enterprise Subscription",
};

/** Read the Claude connection via `claude auth status --json`. */
export function readClaudeConnection(): AccountConnection {
  const bin = claudeBin();
  if (!bin) return { available: false, connected: false };
  const r = spawnSync(bin, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (r.error || !r.stdout) return { available: true, connected: false };
  let status: {
    loggedIn?: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
  };
  try {
    status = JSON.parse(r.stdout);
  } catch {
    return { available: true, connected: false };
  }
  if (!status.loggedIn) return { available: true, connected: false };

  const isApiKey = status.authMethod === "console" || status.authMethod === "apiKey";
  const email = typeof status.email === "string" ? status.email : undefined;
  if (isApiKey) {
    return { available: true, connected: true, kind: "apiKey", planLabel: "Anthropic API Key", ...(email ? { email } : {}) };
  }
  const sub = status.subscriptionType;
  return {
    available: true,
    connected: true,
    kind: "subscription",
    planLabel: (sub && SUBSCRIPTION_LABELS[sub]) || "Claude Subscription",
    ...(email ? { email } : {}),
  };
}

export interface ClaudeLoginResult {
  started: boolean;
  authUrl?: string;
  message?: string;
}

/** Start the claude.ai browser sign-in (`claude auth login --claudeai`). */
export function startClaudeLogin(): Promise<ClaudeLoginResult> {
  const bin = claudeBin();
  if (!bin) {
    return Promise.resolve({ started: false, message: "The claude CLI is not installed on this server." });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["auth", "login", "--claudeai"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      resolve({ started: false, message: e instanceof Error ? e.message : "Failed to start sign-in." });
      return;
    }
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const m = out.match(/https?:\/\/\S+/i);
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
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      resolve({ started: false, message: e.message });
    });
    setTimeout(finish, 1500);
  });
}

/** Sign out (`claude auth logout`). */
export function claudeLogout(): Promise<{ ok: boolean; message?: string }> {
  const bin = claudeBin();
  if (!bin) return Promise.resolve({ ok: false, message: "The claude CLI is not installed." });
  return new Promise((resolve) => {
    const child = spawn(bin, ["auth", "logout"], { stdio: "ignore" });
    child.on("error", (e) => resolve({ ok: false, message: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
  });
}
