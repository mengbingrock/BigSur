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

/**
 * Convert an email to a stable, readable folder name. Each user gets one
 * directory under the user-source skills root that holds only their skills.
 *   menbinwan@gmail.com → menbinwan-at-gmail-com
 */
export function userSlug(email: string): string {
  const lowered = email.toLowerCase();
  return lowered
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Absolute path to the directory holding `email`'s personal skills inside a
 * user-source root. Plugin roots return their own path unchanged.
 */
function scopedRootPath(root: Root, email: string | undefined): string {
  if (root.kind !== "user") return root.path;
  if (!email) return ""; // signals "do not scan" for user roots without a user
  return path.join(root.path, userSlug(email));
}

function findSkillFiles(root: string): string[] {
  if (!root || !fs.existsSync(root)) return [];
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

/** Folder name (under each user root) holding skills visible to everyone. */
const PUBLIC_FOLDER = "_public";

function slugify(name: string, source: SkillSource): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (source.kind === "plugin") {
    return `${source.marketplace.toLowerCase().replace(/[^a-z0-9]+/g, "-")}--${base}`;
  }
  if (source.kind === "public") {
    return `public--${base}`;
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

function parseSkillFile(
  file: string,
  source: SkillSource,
  sourceLabel: string,
): Omit<Skill, "slug"> | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    const raw = fs.readFileSync(file, "utf8");
    parsed = matter(raw);
  } catch {
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  const name = typeof data.name === "string" && data.name.trim()
    ? data.name.trim()
    : path.basename(path.dirname(file));
  return {
    name,
    description: normalizeDescription(data.description),
    allowedTools: normalizeAllowedTools(data["allowed-tools"]),
    license: typeof data.license === "string" ? data.license : undefined,
    body: parsed.content.trim(),
    source,
    sourceLabel,
    sourcePath: path.dirname(file),
  };
}

/**
 * List skills visible to `email`:
 *   - user: caller's own folder (`<root>/<emailSlug>/`)
 *   - public: shared, read-only folder (`<root>/_public/`) seen by everyone
 *   - plugin: all marketplace skills (read-only)
 *
 * Without `email`, user skills are skipped. Public + plugin still load.
 */
export function getAllSkills(email?: string): Skill[] {
  const roots = getRoots();
  const collected: Array<Omit<Skill, "slug">> = [];

  for (const root of roots) {
    if (root.kind === "plugins") {
      const files = findSkillFiles(root.path);
      for (const file of files) {
        const mp = marketplaceFromPath(file, root.path) ?? "plugin";
        const parsed = parseSkillFile(
          file,
          { kind: "plugin", marketplace: mp },
          mp,
        );
        if (parsed) collected.push(parsed);
      }
      continue;
    }

    // user-kind root: scan public subfolder + caller's own subfolder
    const publicDir = path.join(root.path, PUBLIC_FOLDER);
    if (fs.existsSync(publicDir)) {
      for (const file of findSkillFiles(publicDir)) {
        const parsed = parseSkillFile(file, { kind: "public" }, "public");
        if (parsed) collected.push(parsed);
      }
    }
    if (email) {
      const ownDir = path.join(root.path, userSlug(email));
      if (fs.existsSync(ownDir)) {
        for (const file of findSkillFiles(ownDir)) {
          const parsed = parseSkillFile(file, { kind: "user" }, "user");
          if (parsed) collected.push(parsed);
        }
      }
    }
  }

  // Assign unique slugs (collisions get a numeric suffix).
  const seenSlugs = new Set<string>();
  const skills: Skill[] = collected.map((s) => {
    let slug = slugify(s.name, s.source);
    let suffix = 2;
    while (seenSlugs.has(slug)) {
      slug = `${slugify(s.name, s.source)}-${suffix++}`;
    }
    seenSlugs.add(slug);
    return { ...s, slug };
  });

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function getSkillBySlug(slug: string, email?: string): Skill | undefined {
  return getAllSkills(email).find((s) => s.slug === slug);
}

export interface SkillFile {
  /** Path relative to the skill's root directory, using "/" separators. */
  relPath: string;
  size: number;
  /** Decoded text content, present only for small text files. */
  text?: string;
  /** True when the file looked binary or exceeded MAX_TEXT_BYTES. */
  binary: boolean;
  /** True when the file was elided because it exceeded MAX_TEXT_BYTES. */
  truncated: boolean;
}

const MAX_TEXT_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonl", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".html", ".htm", ".xml", ".css", ".scss",
  ".csv", ".tsv", ".env",
]);

function looksTextual(buf: Buffer): boolean {
  // Check the first 8KB for NUL bytes — a strong heuristic for binary content.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}

/**
 * Walk the skill's directory and return every regular file under it (other
 * than SKILL.md, which the page renders separately). Text files small enough
 * to inline are returned with their decoded content; everything else gets
 * size + a binary/truncated flag so the UI can show metadata only.
 */
export function listSkillFiles(skill: Skill): SkillFile[] {
  const root = skill.sourcePath;
  if (!fs.existsSync(root)) return [];
  const out: SkillFile[] = [];
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
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");

      const ext = path.extname(entry.name).toLowerCase();
      const probablyText = TEXT_EXTENSIONS.has(ext);

      if (stat.size > MAX_TEXT_BYTES) {
        out.push({ relPath: rel, size: stat.size, binary: !probablyText, truncated: true });
        continue;
      }

      let buf: Buffer;
      try {
        buf = fs.readFileSync(full);
      } catch {
        out.push({ relPath: rel, size: stat.size, binary: true, truncated: false });
        continue;
      }

      const isText = probablyText || looksTextual(buf);
      if (isText) {
        out.push({
          relPath: rel,
          size: stat.size,
          text: buf.toString("utf8"),
          binary: false,
          truncated: false,
        });
      } else {
        out.push({ relPath: rel, size: stat.size, binary: true, truncated: false });
      }
    }
  };

  walk(root);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
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
    const reason =
      skill.source.kind === "public"
        ? "shared and read-only via the UI (edit it on disk under <root>/_public/)"
        : "from a plugin marketplace (edit it in the source repository)";
    const err = new Error(
      `This skill is ${reason}. Only your own skills can be edited here.`,
    );
    (err as Error & { code: string }).code = "READ_ONLY";
    throw err;
  }
}

/**
 * Confirm `absPath` lives inside `email`'s personal folder of any user root.
 * Prevents PUT/DELETE from touching another user's directory even if a slug
 * collides.
 */
function isInsideOwnFolder(absPath: string, email: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return false;
  }
  return getRoots()
    .filter((r) => r.kind === "user")
    .some((r) => {
      const owned = scopedRootPath(r, email);
      if (!owned) return false;
      try {
        if (!fs.existsSync(owned)) return false;
        const realOwned = fs.realpathSync(owned);
        return real === realOwned || real.startsWith(realOwned + path.sep);
      } catch {
        return false;
      }
    });
}

export function saveSkill(
  slug: string,
  update: SkillUpdate,
  email: string,
): Skill {
  const existing = getSkillBySlug(slug, email);
  if (!existing) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(existing);

  const file = path.join(existing.sourcePath, "SKILL.md");
  if (!isInsideOwnFolder(file, email)) {
    const err = new Error(
      "Refusing to write outside your own skills folder.",
    );
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

  const refreshed = getSkillBySlug(slug, email);
  if (!refreshed) {
    // Slug derives from name; if the user renamed the skill, the slug shifted.
    const recomputed = getAllSkills(email).find(
      (s) => s.sourcePath === existing.sourcePath,
    );
    if (!recomputed) throw new Error("Failed to re-read skill after save.");
    return recomputed;
  }
  return refreshed;
}

function dirSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function createSkill(input: SkillUpdate, email: string): Skill {
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

  const ownFolder = scopedRootPath(userRoot, email);
  fs.mkdirSync(ownFolder, { recursive: true });
  const targetDir = path.join(ownFolder, dirName);
  if (fs.existsSync(targetDir)) {
    const err = new Error(
      `You already have a skill named "${trimmedName}". ` +
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
    getAllSkills(email).find((s) => s.sourcePath === realDir) ??
    getAllSkills(email).find((s) => s.sourcePath === targetDir);
  if (!created) throw new Error("Failed to read newly created skill.");
  return created;
}

/**
 * Copy a non-user skill (public or plugin) into the caller's own folder so
 * they can edit it. The whole source directory is duplicated, preserving
 * helper files (scripts, README, assets). On a name collision in the
 * caller's folder, the target dir is auto-suffixed with `-copy`,
 * `-copy-2`, etc.
 */
export function importSkill(slug: string, email: string): Skill {
  const source = getAllSkills(email).find((s) => s.slug === slug);
  if (!source) {
    const err = new Error("Source skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  if (source.source.kind === "user") {
    const err = new Error(
      "This skill is already in your own folder; nothing to import.",
    );
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const userRoot = getRoots().find((r) => r.kind === "user");
  if (!userRoot) {
    const err = new Error("No user-source skills root is configured.");
    (err as Error & { code: string }).code = "NO_ROOT";
    throw err;
  }

  const ownFolder = scopedRootPath(userRoot, email);
  fs.mkdirSync(ownFolder, { recursive: true });

  const baseName = path.basename(source.sourcePath);
  let targetName = baseName;
  for (let attempt = 1; attempt <= 50; attempt++) {
    if (!fs.existsSync(path.join(ownFolder, targetName))) break;
    targetName = attempt === 1 ? `${baseName}-copy` : `${baseName}-copy-${attempt}`;
    if (attempt === 50) {
      const err = new Error(
        `You already have 50+ copies of "${source.name}". Delete one first.`,
      );
      (err as Error & { code: string }).code = "CONFLICT";
      throw err;
    }
  }

  const targetDir = path.join(ownFolder, targetName);
  fs.cpSync(source.sourcePath, targetDir, { recursive: true });

  const realDir = fs.realpathSync(targetDir);
  const created =
    getAllSkills(email).find((s) => s.sourcePath === realDir) ??
    getAllSkills(email).find((s) => s.sourcePath === targetDir);
  if (!created) throw new Error("Failed to read imported skill.");
  return created;
}

/**
 * Write `content` to a single file inside a user-owned skill directory.
 * Path is resolved against the skill's root and verified to stay inside it
 * (no `../` escapes, no symlinks pointing out). Used by the in-page Files
 * editor to update SKILL.md or any reference file.
 */
export function saveSkillFile(
  slug: string,
  relPath: string,
  content: string,
  email: string,
): void {
  const skill = getSkillBySlug(slug, email);
  if (!skill) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(skill);

  const cleanRel = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!cleanRel || cleanRel.split("/").some((seg) => seg === ".." || seg === "")) {
    const err = new Error("Invalid file path.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const target = path.join(skill.sourcePath, ...cleanRel.split("/"));

  // The file must already exist (this endpoint only updates, doesn't create).
  if (!fs.existsSync(target)) {
    const err = new Error("File not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }

  if (!isInsideOwnFolder(target, email)) {
    const err = new Error("Refusing to write outside your own skills folder.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }

  // Containment check against the skill's own dir as well, in case the user
  // somehow targets a sibling skill via a symlink chain.
  const realTarget = fs.realpathSync(target);
  const realRoot = fs.realpathSync(skill.sourcePath);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    const err = new Error("Path escapes the skill directory.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }

  fs.writeFileSync(target, content, "utf8");
}

export function deleteSkill(slug: string, email: string): void {
  const existing = getSkillBySlug(slug, email);
  if (!existing) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(existing);
  if (!isInsideOwnFolder(existing.sourcePath, email)) {
    const err = new Error("Refusing to delete outside your own skills folder.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  fs.rmSync(existing.sourcePath, { recursive: true, force: true });
}
