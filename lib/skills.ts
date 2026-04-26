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
