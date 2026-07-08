// Install a catalog skill into the place its runtime actually reads it. Both
// Claude Code and Codex now discover first-class skills from a native folder, so
// installing is mostly a folder-name choice keyed on the agent's engine:
//   claude → <workingDir>/.claude/skills/<name>/
//   codex  → <workingDir>/.codex/skills/<name>/
// The skill is also attached to the agent's skill group (agent.skillSlugs), so
// every chat session created from that agent inherits it.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentEngine, AgentUpdate } from "@labee/contracts";
import { getAgent, updateAgent } from "./agents";
import { getSkillBySlug } from "./skills";

export type InstallTarget = AgentEngine; // "claude" | "codex"

function codeErr(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * The folder a runtime discovers skills in, expressed RELATIVE to the agent's
 * working directory. Relative on purpose: an agent can run locally or on a
 * remote box, and while the working directory differs per machine, the skills
 * folder *inside* it (".claude/skills" / ".codex/skills") is identical. Storing
 * and reasoning about the relative path is what makes install work in both modes.
 */
export function runtimeSkillsSubdir(target: InstallTarget): string {
  return target === "codex" ? path.join(".codex", "skills") : path.join(".claude", "skills");
}

/** Absolute runtime skills dir for a working directory that lives on THIS
 *  machine (local mode). Never call this for a workingDir that isn't local. */
export function runtimeSkillsDir(target: InstallTarget, workingDir: string): string {
  return path.join(path.resolve(workingDir), runtimeSkillsSubdir(target));
}

export interface InstallResult {
  target: InstallTarget;
  agentId: string;
  skillSlug: string;
  /** Install location relative to the agent's working directory — the same on
   *  every machine (e.g. ".claude/skills/pdf"). */
  path: string;
  /** "local" copied the files now; "remote" attached to the agent group so the
   *  agent's own machine materializes them on init. */
  mode: "local" | "remote";
}

/**
 * Copy `sourcePath` (a skill directory) into `destRoot`, replacing any existing
 * copy. Returns the destination directory. Shared by explicit install and the
 * copy-on-init in agentInit.
 */
export async function copySkillInto(sourcePath: string, destRoot: string): Promise<string> {
  await fsp.mkdir(destRoot, { recursive: true });
  const dest = path.join(destRoot, path.basename(sourcePath));
  // Don't copy a skill onto itself (e.g. an agent whose workingDir already holds it).
  const rel = path.relative(path.resolve(sourcePath), dest);
  if (rel === "") return dest;
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(path.resolve(sourcePath), dest, { recursive: true, dereference: true });
  return dest;
}

/**
 * Install a catalog skill into an agent's runtime skills folder and attach it to
 * the agent's skill group. Dispatches on the agent's engine unless an explicit
 * target is given.
 */
export async function installSkillToAgent(
  email: string,
  slug: string,
  agentId: string,
  target?: InstallTarget,
): Promise<InstallResult> {
  const agent = await getAgent(email, agentId);
  if (!agent) throw codeErr("Agent not found.", "NOT_FOUND");

  const skill = getSkillBySlug(slug, email);
  if (!skill?.sourcePath) throw codeErr("Skill not found.", "NOT_FOUND");

  const engine: InstallTarget = target ?? agent.engine ?? "claude";
  const workingDir = (agent.workingDir ?? "").trim();
  if (!workingDir) throw codeErr("This agent has no working directory.", "INVALID");

  const subdir = runtimeSkillsSubdir(engine);
  const relPath = path.join(subdir, path.basename(skill.sourcePath));

  // Attach to the agent's skill group first — this is what makes the install
  // durable and machine-independent. Every session created from the agent, on
  // any machine, materializes the group into the same relative <workingDir>/<subdir>.
  if (!agent.skillSlugs.includes(slug)) {
    const patch: AgentUpdate = {
      name: agent.name,
      skillSlugs: [...agent.skillSlugs, slug],
      workingDir: agent.workingDir,
      referenceFolders: agent.referenceFolders,
      ...(agent.engine ? { engine: agent.engine } : {}),
      ...(agent.description ? { description: agent.description } : {}),
    };
    await updateAgent(email, agentId, patch);
  }

  // Materialize now only if the working directory actually exists on this
  // machine (local agent). For a remote agent — a web-created one whose folder
  // lives on another machine — we deliberately do NOT fabricate an absolute path
  // here; the agent group carries the skill, and the agent's own init writes it
  // into the identical relative path on its machine.
  const localWorkingDir = fs.existsSync(workingDir);
  if (localWorkingDir) {
    await copySkillInto(skill.sourcePath, runtimeSkillsDir(engine, workingDir));
  }

  return {
    target: engine,
    agentId,
    skillSlug: slug,
    path: relPath,
    mode: localWorkingDir ? "local" : "remote",
  };
}
