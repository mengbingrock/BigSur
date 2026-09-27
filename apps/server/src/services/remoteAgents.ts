// Keep this machine's agents and the account's agents on labee.online in step.
//
// Two-way: we send everything we hold (tombstones included), the box merges it
// with what every other device has sent, and we store the reconciled set it
// returns. Last write wins per agent on `updatedAt`, so an edit made anywhere
// reaches everywhere, and a deletion stays deleted instead of being re-created
// by the next device to sync.
//
// A synced agent keeps the `workingDir` it was created with, which may not
// exist on this machine — that is reported as `needsFolder` rather than
// treated as an error, so the person can re-pick a folder here.
import fs from "node:fs";
import { listAgentsForSync, mergeAgents, type SyncAgent } from "./agents";

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

/** Reconcile this machine's agents with the account's, in both directions. */
export async function syncAgentsFromServer(email: string): Promise<RemoteAgentSyncResult> {
  const base = serverBase();
  const cookie = await remoteCookie(base);
  if (!cookie) throw invalid("Not connected to Labee — connect your Labee account first.");

  const mine = await listAgentsForSync(email);
  const res = await fetch(`${base}/api/agents/merge`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie },
    body: JSON.stringify({ agents: mine }),
  });
  if (res.status === 401)
    throw invalid("Your Labee connection expired — reconnect your account.");
  if (!res.ok) throw invalid(`${base} returned HTTP ${res.status} for /api/agents/merge`);

  const { agents } = (await res.json()) as { agents: SyncAgent[] };
  // Apply the reconciled set locally. Same merge, same rule, so this device
  // ends up byte-identical to the box without trusting it blindly: a local row
  // that is genuinely newer still wins.
  const merged = await mergeAgents(email, agents ?? []);

  const live = merged.filter((a) => !a.deletedAt);
  const needsFolder: string[] = [];
  for (const agent of live) {
    const wd = (agent.workingDir ?? "").trim();
    if (!wd || !fs.existsSync(wd)) needsFolder.push(agent.name);
  }
  return {
    server: base,
    synced: live.length,
    agents: live.map((a) => a.name),
    needsFolder,
  };
}
