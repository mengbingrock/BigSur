import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import type { Skill, SkillSource } from "./types";

interface Root {
  path: string;
  kind: "user" | "plugins";
}

function getRoots(): Root[] {
  const override = process.env.SKILLS_ROOTS;
  if (override) {
    return override.split(":").filter(Boolean).map((p) => ({
      path: p,
      kind: inferKind(p),
    }));
  }
  const home = os.homedir();
  return [
    {
      path: path.join(home, "WorkSync/Git/protocol-agent/.claude/skills"),
      kind: "user",
    },
  ];
}

function inferKind(p: string): "user" | "plugins" {
  return p.includes("marketplaces") || p.includes("plugins") ? "plugins" : "user";
}

function findSkillFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth = 0) => {
    if (depth > 6) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (stat.isFile() && entry.name === "SKILL.md") {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function marketplaceFromPath(filePath: string, rootPath: string): string | null {
  const rel = path.relative(rootPath, filePath);
  const parts = rel.split(path.sep);
  return parts[0] || null;
}

function slugify(name: string, source: SkillSource): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (source.kind === "plugin") {
    return `${source.marketplace.toLowerCase().replace(/[^a-z0-9]+/g, "-")}--${base}`;
  }
  return `user--${base}`;
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeAllowedTools(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") {
    return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function getAllSkills(): Skill[] {
  const roots = getRoots();
  const skills: Skill[] = [];
  const seenSlugs = new Set<string>();

  for (const root of roots) {
    const files = findSkillFiles(root.path);
    for (const file of files) {
      let parsed: matter.GrayMatterFile<string>;
      try {
        const raw = fs.readFileSync(file, "utf8");
        parsed = matter(raw);
      } catch {
        continue;
      }
      const data = parsed.data as Record<string, unknown>;
      const name = typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : path.basename(path.dirname(file));
      const description = normalizeDescription(data.description);
      const allowedTools = normalizeAllowedTools(data["allowed-tools"]);
      const license = typeof data.license === "string" ? data.license : undefined;

      let source: SkillSource;
      let sourceLabel: string;
      if (root.kind === "user") {
        source = { kind: "user" };
        sourceLabel = "user";
      } else {
        const mp = marketplaceFromPath(file, root.path) ?? "plugin";
        source = { kind: "plugin", marketplace: mp };
        sourceLabel = mp;
      }

      let slug = slugify(name, source);
      let suffix = 2;
      while (seenSlugs.has(slug)) {
        slug = `${slugify(name, source)}-${suffix++}`;
      }
      seenSlugs.add(slug);

      skills.push({
        slug,
        name,
        description,
        allowedTools,
        license,
        body: parsed.content.trim(),
        source,
        sourceLabel,
        sourcePath: path.dirname(file),
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function getSkillBySlug(slug: string): Skill | undefined {
  return getAllSkills().find((s) => s.slug === slug);
}

export function getAllSources(skills: Skill[]): string[] {
  const set = new Set<string>();
  for (const s of skills) set.add(s.sourceLabel);
  return Array.from(set).sort();
}

export interface SkillUpdate {
  name: string;
  description: string;
  allowedTools: string[];
  license?: string;
  body: string;
}

function assertEditable(skill: Skill) {
  if (skill.source.kind !== "user") {
    const err = new Error(
      "This skill comes from a plugin marketplace and is read-only. " +
        "Only user-source skills can be edited.",
    );
    (err as Error & { code: string }).code = "READ_ONLY";
    throw err;
  }
}

function isInsideUserRoot(absPath: string): boolean {
  const real = fs.realpathSync(absPath);
  return getRoots()
    .filter((r) => r.kind === "user")
    .some((r) => {
      try {
        const rRoot = fs.realpathSync(r.path);
        return real === rRoot || real.startsWith(rRoot + path.sep);
      } catch {
        return false;
      }
    });
}

export function saveSkill(slug: string, update: SkillUpdate): Skill {
  const existing = getSkillBySlug(slug);
  if (!existing) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(existing);

  const file = path.join(existing.sourcePath, "SKILL.md");
  if (!isInsideUserRoot(file)) {
    const err = new Error("Refusing to write outside the user skills root.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }

  const trimmedName = update.name.trim();
  if (!trimmedName) {
    const err = new Error("name is required.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const data: Record<string, unknown> = {
    name: trimmedName,
    description: update.description.trim(),
  };
  if (update.allowedTools.length > 0) data["allowed-tools"] = update.allowedTools;
  if (update.license) data.license = update.license;

  const content = matter.stringify(update.body.replace(/\s*$/, "") + "\n", data);
  fs.writeFileSync(file, content, "utf8");

  const refreshed = getSkillBySlug(slug);
  if (!refreshed) {
    // Slug derives from name; if the user renamed the skill, the slug shifted.
    const recomputed = getAllSkills().find((s) => s.sourcePath === existing.sourcePath);
    if (!recomputed) throw new Error("Failed to re-read skill after save.");
    return recomputed;
  }
  return refreshed;
}

function dirSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function createSkill(input: SkillUpdate): Skill {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    const err = new Error("name is required.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }
  const dirName = dirSlug(trimmedName);
  if (!dirName) {
    const err = new Error("name must contain at least one alphanumeric character.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const userRoot = getRoots().find((r) => r.kind === "user");
  if (!userRoot) {
    const err = new Error(
      "No user-source skills root is configured. Set SKILLS_ROOTS to include " +
        "at least one path without 'plugins'/'marketplaces' in the name.",
    );
    (err as Error & { code: string }).code = "NO_ROOT";
    throw err;
  }

  fs.mkdirSync(userRoot.path, { recursive: true });
  const targetDir = path.join(userRoot.path, dirName);
  if (fs.existsSync(targetDir)) {
    const err = new Error(
      `A skill directory already exists at ${targetDir}. ` +
        "Pick a different name or edit the existing skill.",
    );
    (err as Error & { code: string }).code = "CONFLICT";
    throw err;
  }

  fs.mkdirSync(targetDir);
  const file = path.join(targetDir, "SKILL.md");

  const data: Record<string, unknown> = {
    name: trimmedName,
    description: input.description.trim(),
  };
  if (input.allowedTools.length > 0) data["allowed-tools"] = input.allowedTools;
  if (input.license) data.license = input.license;

  const content = matter.stringify(input.body.replace(/\s*$/, "") + "\n", data);
  fs.writeFileSync(file, content, "utf8");

  const realDir = fs.realpathSync(targetDir);
  const created =
    getAllSkills().find((s) => s.sourcePath === realDir) ??
    getAllSkills().find((s) => s.sourcePath === targetDir);
  if (!created) throw new Error("Failed to read newly created skill.");
  return created;
}

export function deleteSkill(slug: string): void {
  const existing = getSkillBySlug(slug);
  if (!existing) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(existing);
  if (!isInsideUserRoot(existing.sourcePath)) {
    const err = new Error("Refusing to delete outside the user skills root.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  fs.rmSync(existing.sourcePath, { recursive: true, force: true });
}
