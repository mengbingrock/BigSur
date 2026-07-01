// Pull the user's saved agents from a central Labee server (labee.online) into
// the local `agents` table — the local-first desktop counterpart to
// services/remoteSkills.ts. Lets a locally-running instance bring the user's
// hosted agents onto their machine so they run locally against local folders.
import fs from "node:fs";
import type { Agent } from "@labee/contracts";
import { upsertAgentFromRemote } from "./agents";

function serverBase(): string {
  return (process.env.LABEE_SKILLS_SERVER || "https://labee.online").replace(/\/+$/, "");
}

// Must match services/session.ts COOKIE_NAME.
const SESSION_COOKIE = "monterey_session";

function invalid(message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = "INVALID";
  return e;
}

/** Cookie header authenticating to the box: a box session the desktop persisted
 *  at "Connect to Labee" (LABEE_REMOTE_SESSION_FILE), else an optional
 *  email/password login (dev / headless). */
async function remoteCookie(base: string): Promise<string | null> {
  const file = process.env.LABEE_REMOTE_SESSION_FILE;
  if (file) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      if (value) return `${SESSION_COOKIE}=${value}`;
    } catch {
      /* not connected yet */
    }
  }
  const email = process.env.LABEE_SKILLS_SERVER_EMAIL;
  const password = process.env.LABEE_SKILLS_SERVER_PASSWORD;
  if (email && password) {
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const sc = res.headers.get("set-cookie");
        if (sc) return sc.split(";")[0] ?? null;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

export interface RemoteAgentSyncResult {
  server: string;
  synced: number;
  agents: string[];
  /** Names of synced agents whose workingDir doesn't exist on this machine
   *  (usually web-created agents) — the UI prompts the user to re-pick a folder. */
  needsFolder: string[];
}

/** Mirror the box's saved agents into the local `agents` table for `email`. */
export async function syncAgentsFromServer(email: string): Promise<RemoteAgentSyncResult> {
  const base = serverBase();
  const cookie = await remoteCookie(base);
  if (!cookie) throw invalid("Not connected to Labee — connect your Labee account first.");

  const res = await fetch(`${base}/api/agents`, {
    headers: { accept: "application/json", cookie },
  });
  if (res.status === 401)
    throw invalid("Your Labee connection expired — reconnect your account.");
  if (!res.ok) throw invalid(`${base} returned HTTP ${res.status} for /api/agents`);

  const { agents } = (await res.json()) as { agents: Agent[] };
  const names: string[] = [];
  const needsFolder: string[] = [];
  for (const agent of agents ?? []) {
    if (!agent?.id) continue;
    await upsertAgentFromRemote(email, agent);
    names.push(agent.name);
    const wd = (agent.workingDir ?? "").trim();
    if (!wd || !fs.existsSync(wd)) needsFolder.push(agent.name);
  }
  return { server: base, synced: names.length, agents: names, needsFolder };
}
