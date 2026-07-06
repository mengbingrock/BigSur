// Pull skills from a central Labee server (e.g. labee.online) into the local
// skills catalog, mirroring SKILL.md + reference files over HTTP. After a sync
// the skills appear in Artifacts and get copied into an agent's `.skill` folder
// on init. Configure with:
//   LABEE_SKILLS_SERVER           default https://labee.online
//   LABEE_SKILLS_SERVER_EMAIL     (optional) to also pull your own user skills
//   LABEE_SKILLS_SERVER_PASSWORD
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Skill, SkillFile } from "@labee/contracts";
import { userSkillsRootPath, userSlug } from "./skills";

function serverBase(): string {
  return (process.env.LABEE_SKILLS_SERVER || "http://labee.online").replace(/\/+$/, "");
}

/** Log into the remote server (if creds configured) and return the session cookie. */
async function remoteLogin(base: string): Promise<string | null> {
  const email = process.env.LABEE_SKILLS_SERVER_EMAIL;
  const password = process.env.LABEE_SKILLS_SERVER_PASSWORD;
  if (!email || !password) return null;
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const sc = res.headers.get("set-cookie");
    return sc ? (sc.split(";")[0] ?? null) : null;
  } catch {
    return null;
  }
}

function reconstructSkillMd(skill: Skill): string {
  const data: Record<string, unknown> = { name: skill.name };
  if (skill.description) data.description = skill.description;
  if (skill.allowedTools && skill.allowedTools.length) data["allowed-tools"] = skill.allowedTools;
  if (skill.artifactKind === "protocol") data.kind = "protocol";
  return matter.stringify((skill.body ?? "").replace(/\s*$/, "") + "\n", data);
}

export interface RemoteSyncResult {
  server: string;
  synced: number;
  skills: string[];
}

/** Mirror the remote server's skills into the local catalog (default root). */
export async function syncSkillsFromServer(email: string): Promise<RemoteSyncResult> {
  const base = serverBase();
  const cookie = await remoteLogin(base);
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  if (cookie) headers.cookie = cookie;

  const listRes = await fetch(`${base}/api/skills`, { headers });
  if (!listRes.ok) {
    const e = new Error(`${base} returned HTTP ${listRes.status} for /api/skills`) as Error & {
      code: string;
    };
    e.code = "INVALID";
    throw e;
  }
  const { skills } = (await listRes.json()) as { skills: Skill[] };
  const root = userSkillsRootPath();
  const names: string[] = [];

  for (const skill of skills) {
    const dirName = path.basename(skill.sourcePath || skill.slug) || skill.slug;
    const isPublic = skill.source?.kind === "public" || skill.sourceLabel === "public";
    const target = path.join(root, isPublic ? "_public" : userSlug(email), dirName);
    await fsp.mkdir(target, { recursive: true });

    // Pull the full file tree (SKILL.md + references) — text files carry content.
    let files: SkillFile[] = [];
    try {
      const detRes = await fetch(`${base}/api/skills/${encodeURIComponent(skill.slug)}`, { headers });
      if (detRes.ok) files = ((await detRes.json()) as { files?: SkillFile[] }).files ?? [];
    } catch {
      /* fall back to body only */
    }
    const textFiles = files.filter((f) => !f.binary && typeof f.text === "string");
    if (textFiles.length === 0) {
      await fsp.writeFile(path.join(target, "SKILL.md"), reconstructSkillMd(skill), "utf8");
    } else {
      for (const f of textFiles) {
        const dest = path.join(target, f.relPath);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.text ?? "", "utf8");
      }
    }
    names.push(skill.name);
  }

  return { server: base, synced: names.length, skills: names };
}
