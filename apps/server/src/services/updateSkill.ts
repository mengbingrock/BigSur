// Update & audit for imported skills. Because every import stamps an `origin`
// (a pinned GitHub SHA or a registry version), we can re-resolve the same ref
// later to see whether it moved, and re-fetch in place when it has.
import type { Skill } from "@labee/contracts";
import { getSkillBySlug, overwriteSkillFiles } from "./skills";
import { fetchGithubSkillFiles, resolveCommitSha } from "./githubImport";
import { fetchRegistrySkill, latestVersion } from "./registryImport";

function codeErr(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export interface UpdateStatus {
  /** Whether this skill has an origin we can re-fetch. */
  updatable: boolean;
  updateAvailable: boolean;
  origin?: "github" | "registry";
  /** SHA (github) or version (registry) currently installed. */
  current?: string;
  /** Latest SHA/version upstream. */
  latest?: string;
  detail?: string;
}

/** Compare the pinned origin against upstream without changing anything. */
export async function checkForUpdate(email: string, slug: string): Promise<UpdateStatus> {
  const skill = getSkillBySlug(slug, email);
  if (!skill) throw codeErr("Skill not found.", "NOT_FOUND");
  const o = skill.origin;
  if (!o) return { updatable: false, updateAvailable: false };

  if (o.kind === "github") {
    const [owner = "", repo = ""] = o.repo.split("/");
    const { sha } = await resolveCommitSha(owner, repo, o.ref || undefined);
    return {
      updatable: true,
      updateAvailable: sha !== o.sha,
      origin: "github",
      current: o.sha,
      latest: sha,
      detail: `${o.repo}@${o.ref || "default"}`,
    };
  }

  const latest = await latestVersion(o.registry, o.pkg);
  return {
    updatable: true,
    updateAvailable: latest !== o.version,
    origin: "registry",
    current: o.version,
    latest,
    detail: `${o.registry}:${o.pkg}`,
  };
}

/** Re-fetch the skill from its origin and overwrite it in place. */
export async function updateSkill(email: string, slug: string): Promise<Skill> {
  const skill = getSkillBySlug(slug, email);
  if (!skill) throw codeErr("Skill not found.", "NOT_FOUND");
  const o = skill.origin;
  if (!o) throw codeErr("This skill has no import origin to update from.", "INVALID");

  if (o.kind === "github") {
    const { files, origin } = await fetchGithubSkillFiles({
      input: o.repo,
      ref: o.ref || undefined,
      subpath: o.subpath,
    });
    return overwriteSkillFiles(email, slug, files, origin);
  }

  // Registry: pull the latest matching version.
  const { files, origin } = await fetchRegistrySkill({ registry: o.registry, pkg: o.pkg });
  return overwriteSkillFiles(email, slug, files, origin);
}
