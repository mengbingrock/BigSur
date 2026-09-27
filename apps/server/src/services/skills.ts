import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import type { Skill, SkillOrigin, SkillSource } from "@labee/contracts";
import { seedStarterProtocols } from "./seedProtocols";
import { grantedFilePathsSync, grantedFolderPathsSync } from "./userFolders";

interface Root {
  path: string;
  kind: "user" | "plugins";
}

/** The app's internal data directory (matches services/db.ts). App-managed state
 *  — skills, the SQLite DB, etc. — lives here. On desktop this is under the OS
 *  app-data folder (LABEE_DATA_DIR); in dev it's ./data. */
function appDataDir(): string {
  return (
    process.env.LABEE_DATA_DIR ||
    process.env.MONTEREY_DATA_DIR ||
    path.join(process.cwd(), "data")
  );
}

/** Default skills root — an app-internal folder, not an ad-hoc external path. */
function defaultSkillsRoot(): string {
  return path.join(appDataDir(), "skills");
}

function getRoots(): Root[] {
  const override = process.env.SKILLS_ROOTS;
  if (override) {
    return override.split(":").filter(Boolean).map((p) => ({
      path: p,
      kind: inferKind(p),
    }));
  }
  return [{ path: defaultSkillsRoot(), kind: "user" }];
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

/** Deck (workspace) root — kept in sync with services/deck.ts without importing
 *  it (deck.ts imports userSlug from here, so a back-import would cycle). */
function deckRoot(): string {
  return process.env.DECK_ROOT || path.join(os.homedir(), "monterey-decks");
}

/** A user's workspace skills live in a `.skill` folder at their deck root. */
export function userWorkspaceSkillDir(email: string): string {
  return path.join(deckRoot(), userSlug(email), ".skill");
}

/** The first user-source skills root (where synced/created skills are written). */
export function userSkillsRootPath(): string {
  const root = getRoots().find((r) => r.kind === "user");
  return root ? root.path : defaultSkillsRoot();
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

/** Documents that stand alone as a protocol. A skill needs a folder because it
 *  can carry scripts and references; a protocol is just prose, so it is a file. */
const PROTOCOL_EXTENSIONS = new Set([".md", ".markdown"]);

/** Markdown files that are project furniture rather than protocols. Granting a
 *  working folder should not fill the library with its README. These are
 *  conventional filenames, not a guess at content — anything else in a granted
 *  folder is taken at face value. */
const NOT_PROTOCOL_NAMES = new Set([
  "readme",
  "agents",
  "claude",
  "changelog",
  "contributing",
  "license",
  "licence",
  "code_of_conduct",
  "security",
  "notice",
  "authors",
]);

function isConventionalDoc(file: string): boolean {
  return NOT_PROTOCOL_NAMES.has(path.basename(file, path.extname(file)).toLowerCase());
}

/** True for a manifest file (`SKILL.md`), false for a standalone document. */
export function isManifestFile(file: string): boolean {
  return /^skill\.md$/i.test(path.basename(file));
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
      } else if (stat.isFile()) {
        // A folder's manifest, or a standalone protocol document. Both are
        // artifacts; which one it is decides how it is stored and edited.
        if (entry.name === "SKILL.md") {
          out.push(full);
        } else if (
          PROTOCOL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
          !isConventionalDoc(entry.name)
        ) {
          out.push(full);
        }
      }
    }
  };
  walk(root);
  const manifestDirs = new Set(out.filter(isManifestFile).map((f) => path.dirname(f)));
  return out.filter((f) => isManifestFile(f) || !manifestDirs.has(path.dirname(f)));
}

function marketplaceFromPath(filePath: string, rootPath: string): string | null {
  const rel = path.relative(rootPath, filePath);
  const parts = rel.split(path.sep);
  return parts[0] || null;
}

/** Folder name (under each user root) holding skills visible to everyone. */
/** Left over from when protocols had a shared folder. Old installs still have
 *  the directory on disk; it is never read, and must not become a category. */
const LEGACY_SHARED_FOLDER = "_public";

/**
 * Layout of a person's own artifact folder. Two kinds, two subfolders, and the
 * folder decides the kind:
 *
 *   <base>/protocols/<Category>/<slug>.md   a protocol is a document; its
 *                                            category is the subfolder it is in
 *   <base>/skills/<slug>/SKILL.md            a skill is a folder, because it can
 *                                            carry scripts beside its manifest
 *
 * `base` is the user root (`<root>/<emailSlug>/`) or the deck workspace's
 * `.skill/`. Older installs kept both kinds side by side at the top of the
 * base and told them apart by "is it a SKILL.md"; migrateLayout() moves that
 * into the two subfolders once. Granted folders are the person's own choice
 * of place and are read as they are.
 */
const PROTOCOLS_DIR = "protocols";
const SKILLS_DIR = "skills";

/** Where this person's protocols live. Created on demand by the writers. */
export function ownProtocolsDir(email: string): string {
  return path.join(ownRootDir(email), PROTOCOLS_DIR);
}

/** Where this person's skills live. */
export function ownSkillsDir(email: string): string {
  return path.join(ownRootDir(email), SKILLS_DIR);
}

/** Is `base` one of the folders that carries the protocols/skills layout, as
 *  opposed to a granted folder, which is read as the person arranged it? */
function hasLayout(base: string, email: string): boolean {
  // Compare real paths: callers hand us both resolved and unresolved forms,
  // and on macOS /var and /tmp are symlinks, so string equality would call
  // the same folder two different things.
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const r = real(base);
  return r === real(ownRootDir(email)) || r === real(userWorkspaceSkillDir(email));
}

/** The folder categories live in for a given base. */
function protocolsDirOf(base: string, email: string): string {
  return hasLayout(base, email) ? path.join(base, PROTOCOLS_DIR) : base;
}

/** Move a base's old flat layout into protocols/ and skills/. Idempotent, and
 *  never overwrites: an entry that already exists at the destination is left
 *  where it is and shows up as a duplicate to be sorted out by hand rather
 *  than silently clobbered. */
function migrateLayout(base: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === PROTOCOLS_DIR || e.name === SKILLS_DIR) continue;
    if (e.name === LEGACY_SHARED_FOLDER) continue;
    const from = path.join(base, e.name);
    let to: string;
    if (e.isDirectory()) {
      // A folder with a manifest is a skill — unless the manifest says it is a
      // protocol, which is how protocols were written before they became
      // documents. Honour that: the file knows what it is better than the
      // shape it was stored in.
      const manifest = path.join(from, "SKILL.md");
      const isSkill = fs.existsSync(manifest) && declaredKind(manifest) !== "protocol";
      to = path.join(base, isSkill ? SKILLS_DIR : PROTOCOLS_DIR, e.name);
    } else if (e.isFile() && PROTOCOL_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      to = path.join(base, PROTOCOLS_DIR, e.name);
    } else {
      continue;
    }
    if (!fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      continue;
    }
    // Destination taken. A file stays where it is rather than clobber
    // anything; a folder is merged child by child, so a category that
    // exists on both sides ends up with everything and nothing is lost.
    if (e.isDirectory() && fs.statSync(to).isDirectory()) {
      mergeInto(from, to);
      try {
        fs.rmdirSync(from); // only succeeds once empty
      } catch {
        // something could not be moved; it stays visible at the top level
      }
    }
  }
}

/** Move every entry of `from` into `to` that does not already exist there. */
function mergeInto(from: string, to: string): void {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    } else if (e.isDirectory() && fs.statSync(dst).isDirectory()) {
      mergeInto(src, dst);
      try {
        fs.rmdirSync(src);
      } catch {
        // not empty; leave it
      }
    }
  }
}

/** The `kind:` a manifest declares for itself, if any. Only used to place
 *  legacy folders during migration; afterwards the folder is the authority. */
function declaredKind(manifest: string): "skill" | "protocol" | undefined {
  try {
    const k = matter(fs.readFileSync(manifest, "utf8")).data?.kind;
    return k === "protocol" || k === "skill" ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Read one base in the two-folder layout, after migrating it if needed. */
function scanOwnBase(base: string, label: string, into: Array<Omit<Skill, "slug">>): void {
  if (!fs.existsSync(base)) return;
  migrateLayout(base);
  const pdir = path.join(base, PROTOCOLS_DIR);
  if (fs.existsSync(pdir)) {
    for (const file of findSkillFiles(pdir)) {
      const parsed = parseSkillFile(file, { kind: "user" }, label, pdir, "protocol");
      if (parsed) into.push(parsed);
    }
  }
  const sdir = path.join(base, SKILLS_DIR);
  if (fs.existsSync(sdir)) {
    for (const file of findSkillFiles(sdir)) {
      const parsed = parseSkillFile(file, { kind: "user" }, label, sdir, "skill");
      if (parsed) into.push(parsed);
    }
  }
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

/** Read an `origin:` provenance block from SKILL.md front-matter, tolerating
 *  hand-edited or missing fields. Unknown/invalid shapes yield `undefined`. */
function parseOrigin(raw: unknown): SkillOrigin | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (o.kind === "github") {
    const repo = str(o.repo);
    if (!repo) return undefined;
    return {
      kind: "github",
      repo,
      ref: str(o.ref) ?? "",
      sha: str(o.sha) ?? "",
      subpath: str(o.subpath),
    };
  }
  if (o.kind === "registry") {
    const registry = str(o.registry);
    const pkg = str(o.pkg);
    if (!registry || !pkg) return undefined;
    return {
      kind: "registry",
      registry,
      pkg,
      version: str(o.version) ?? "",
      digest: str(o.digest),
    };
  }
  return undefined;
}

/** The folder an artifact sits in, relative to the root it was scanned from.
 *  `<base>/Cloning/miniprep/SKILL.md` → "Cloning"; `<base>/miniprep/SKILL.md`
 *  → undefined (flat, shown as "Uncategorised"). Only the first level counts,
 *  so deeper nesting collapses onto its top folder. */
function categoryOf(
  file: string,
  baseDir: string | undefined,
  loose: boolean,
): string | undefined {
  if (!baseDir) return undefined;
  const rel = path.relative(baseDir, path.dirname(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep).filter(Boolean);
  // A manifest sits one level deeper than a document: <base>/<cat>/<slug>/SKILL.md
  // versus <base>/<cat>/<slug>.md, so they need different depths.
  const depth = loose ? 0 : 1;
  return parts.length > depth ? parts[0] : undefined;
}

/** Sibling files in the artifact directory, excluding SKILL.md. One shallow
 *  readdir; any failure just means the count is omitted. */
function siblingFileCount(dir: string): number | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.toLowerCase() !== "skill.md").length;
  } catch {
    return undefined;
  }
}

function parseSkillFile(
  file: string,
  source: SkillSource,
  sourceLabel: string,
  baseDir?: string,
  /** Set when the folder the file sits in already says what it is. */
  forcedKind?: "skill" | "protocol",
): Omit<Skill, "slug"> | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    const raw = fs.readFileSync(file, "utf8");
    parsed = matter(raw);
  } catch {
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  const loose = !isManifestFile(file);
  // Without a `name:` in frontmatter, fall back to the filename for a loose
  // document and to the folder name for a SKILL.md, which is the folder's
  // manifest rather than a document in its own right.
  const fallbackName = loose
    ? path.basename(file, path.extname(file))
    : path.basename(path.dirname(file));
  const name = typeof data.name === "string" && data.name.trim()
    ? data.name.trim()
    : fallbackName;
  // Frontmatter wins. Without it, a standalone document is a protocol and a
  // folder manifest is a skill — which is what each shape is for.
  const rawKind = typeof data.kind === "string" ? data.kind.toLowerCase() : "";
  const artifactKind: "skill" | "protocol" =
    forcedKind ?? (rawKind === "protocol" ? "protocol" : rawKind === "skill" ? "skill" : loose ? "protocol" : "skill");
  // A `category` in frontmatter overrides the folder name for display only;
  // it never moves files.
  const declaredCategory =
    typeof data.category === "string" && data.category.trim()
      ? data.category.trim()
      : undefined;
  let updatedAt: string | undefined;
  try {
    updatedAt = fs.statSync(file).mtime.toISOString();
  } catch {
    updatedAt = undefined;
  }
  const dir = path.dirname(file);
  return {
    category: declaredCategory ?? categoryOf(file, baseDir, loose),
    updatedAt,
    fileCount: loose ? 0 : siblingFileCount(dir),
    name,
    description: normalizeDescription(data.description),
    allowedTools: normalizeAllowedTools(data["allowed-tools"]),
    license: typeof data.license === "string" ? data.license : undefined,
    body: parsed.content.trim(),
    source,
    sourceLabel,
    origin: parseOrigin(data.origin),
    sourcePath: path.dirname(file),
    // A single-file grant has no manifest directory; the file is the artifact.
    ...(loose ? { artifactFile: file } : {}),
    artifactKind,
  };
}

/**
 * List skills visible to `email`:
 *   - user: caller's own folder (`<root>/<emailSlug>/`), starter protocols included
 *   - plugin: all marketplace skills (read-only)
 *
 * Without `email`, user skills are skipped; plugins still load.
 */
export function getAllSkills(
  email?: string,
  opts?: { extraSkillDirs?: readonly string[] },
): Skill[] {
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
          root.path,
        );
        if (parsed) collected.push(parsed);
      }
      continue;
    }

    // user-kind root: the caller's own subfolder. Every protocol belongs to a
    // person; the starter library is copied into this folder on first use
    // (see seedProtocols), so there is nothing shared to scan.
    if (email) {
      const ownDir = path.join(root.path, userSlug(email));
      // Migrate first, seed second. The seeder creates the category folders
      // the starters live in; if it ran first, a person's own folder of the
      // same name would find its destination taken and be left behind,
      // unread. Migrated first, their files are in place and the seeder
      // simply skips the ones they already have.
      migrateLayout(ownDir);
      seedStarterProtocols(path.join(ownDir, PROTOCOLS_DIR));
      scanOwnBase(ownDir, "user", collected);
    }
  }

  // Workspace `.skill` folders: the user's deck workspace + any extra dirs
  // (e.g. the active agent's working directory). These are user-owned.
  if (email) scanOwnBase(userWorkspaceSkillDir(email), "workspace", collected);
  const workspaceDirs: string[] = [];
  // Folders the person granted Labee access to: their protocols are part of
  // the library, which is what makes them searchable and editable. They are
  // read as the person arranged them — no layout is imposed on their folders.
  for (const d of grantedFolderPathsSync(email)) workspaceDirs.push(d);
  for (const d of opts?.extraSkillDirs ?? []) workspaceDirs.push(d);
  const seenWs = new Set<string>();
  for (const dir of workspaceDirs) {
    if (!dir || seenWs.has(dir) || !fs.existsSync(dir)) continue;
    seenWs.add(dir);
    for (const file of findSkillFiles(dir)) {
      const parsed = parseSkillFile(file, { kind: "user" }, "workspace", dir);
      if (parsed) collected.push(parsed);
    }
  }

  // Single granted documents: the file itself is the artifact, so it is parsed
  // directly rather than walked for a SKILL.md.
  for (const file of grantedFilePathsSync(email)) {
    const parsed = parseSkillFile(file, { kind: "user" }, "workspace");
    if (parsed) collected.push(parsed);
  }

  // Drop workspace skills that merely duplicate a catalog skill by name (e.g.
  // an agent's `.skill` folder holding synced copies of selected skills), so
  // they don't appear twice. Unique workspace skills are kept.
  const catalogNames = new Set(
    collected.filter((s) => s.sourceLabel !== "workspace").map((s) => s.name.toLowerCase()),
  );
  const deduped = collected.filter(
    (s) => s.sourceLabel !== "workspace" || !catalogNames.has(s.name.toLowerCase()),
  );

  // Assign unique slugs (collisions get a numeric suffix).
  const seenSlugs = new Set<string>();
  const skills: Skill[] = deduped.map((s) => {
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
  // A standalone document has no folder of its own, so no siblings to list;
  // its neighbours belong to whoever owns the directory.
  if (skill.artifactFile) return [];
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
  /** Optional artifact kind. When omitted on save, the existing kind is preserved. */
  kind?: "skill" | "protocol";
}

function assertEditable(skill: Skill) {
  if (skill.source.kind !== "user") {
    const err = new Error(
      "This skill is from a plugin marketplace (edit it in the source repository). Only your own skills can be edited here.",
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
/** Every directory that holds `email`'s own artifacts: their folder in each
 *  user root, plus their deck workspace `.skill` folder — which is where
 *  anything created in the app is written, so it is just as much theirs. */
function ownBases(email: string): string[] {
  const bases = getRoots()
    .filter((r) => r.kind === "user")
    .map((r) => scopedRootPath(r, email))
    .filter(Boolean);
  bases.push(userWorkspaceSkillDir(email));
  // A granted folder is writable by design: it is where new protocols go.
  for (const d of grantedFolderPathsSync(email)) bases.push(d);
  // A granted document is writable too, but only that one file.
  for (const f of grantedFilePathsSync(email)) bases.push(f);
  return bases;
}

function containedIn(real: string, base: string): boolean {
  try {
    if (!fs.existsSync(base)) return false;
    const realBase = fs.realpathSync(base);
    return real === realBase || real.startsWith(realBase + path.sep);
  } catch {
    return false;
  }
}

function isInsideOwnFolder(absPath: string, email: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return false;
  }
  return ownBases(email).some((b) => containedIn(real, b));
}

/** Which of `email`'s own bases holds `absPath`, or null when none does. */
function baseHolding(absPath: string, email: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return null;
  }
  for (const b of ownBases(email)) {
    if (containedIn(real, b)) return fs.realpathSync(b);
  }
  return null;
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

  // A single granted document is edited in place; a folder artifact has its
  // SKILL.md rewritten.
  const file = existing.artifactFile ?? path.join(existing.sourcePath, "SKILL.md");

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
  // Preserve / set artifact kind. Default to existing kind when not provided.
  const nextKind = update.kind ?? existing.artifactKind;
  if (nextKind === "protocol") data.kind = "protocol";
  // Keep import provenance across edits — the user editing the body doesn't
  // change where it came from.
  if (existing.origin) data.origin = existing.origin;

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

  // A protocol is a document, so it is written as one file. A skill needs a
  // folder because it can carry scripts and references beside its manifest.
  // Each goes to its own folder in the person's root — the one place their
  // artifacts live, on their own machine.
  const asDocument = input.kind === "protocol";
  const ownFolder = asDocument ? ownProtocolsDir(email) : ownSkillsDir(email);
  fs.mkdirSync(ownFolder, { recursive: true });
  const targetDir = path.join(ownFolder, dirName);
  const file = asDocument
    ? path.join(ownFolder, `${dirName}.md`)
    : path.join(targetDir, "SKILL.md");
  const collision = asDocument ? file : targetDir;
  if (fs.existsSync(collision)) {
    const err = new Error(
      `You already have ${asDocument ? "a protocol" : "a skill"} named "${trimmedName}". ` +
        "Pick a different name, or edit the existing one.",
    );
    (err as Error & { code: string }).code = "CONFLICT";
    throw err;
  }
  if (!asDocument) fs.mkdirSync(targetDir);

  const data: Record<string, unknown> = {
    name: trimmedName,
    description: input.description.trim(),
  };
  if (input.allowedTools.length > 0) data["allowed-tools"] = input.allowedTools;
  if (input.license) data.license = input.license;
  if (input.kind === "protocol") data.kind = "protocol";

  const content = matter.stringify(input.body.replace(/\s*$/, "") + "\n", data);
  fs.writeFileSync(file, content, "utf8");

  const all = getAllSkills(email);
  const created = asDocument
    ? all.find((s) => s.artifactFile === file) ??
      all.find((s) => s.artifactFile && fs.realpathSync(s.artifactFile) === fs.realpathSync(file))
    : (() => {
        const realDir = fs.realpathSync(targetDir);
        return (
          all.find((s) => s.sourcePath === realDir) ??
          all.find((s) => s.sourcePath === targetDir)
        );
      })();
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

  const ownFolder = path.join(scopedRootPath(userRoot, email), SKILLS_DIR);
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

export interface ImportFile {
  /** Path relative to the skill root, using "/" separators. */
  relPath: string;
  bytes: Uint8Array;
}

/** Inject (or replace) the `origin:` provenance block inside a SKILL.md buffer. */
function withOrigin(bytes: Uint8Array, origin: SkillOrigin): Uint8Array {
  const text = Buffer.from(bytes).toString("utf8");
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(text);
  } catch {
    return bytes;
  }
  const data = { ...(parsed.data as Record<string, unknown>), origin };
  return Buffer.from(
    matter.stringify(parsed.content.replace(/\s*$/, "") + "\n", data),
    "utf8",
  );
}

/**
 * Write an externally-fetched skill (SKILL.md + reference files) into the
 * caller's own folder and return the resulting catalog entry. The skill's
 * `source` stays `user` — so it's editable and deletable — while `origin`
 * records where it was pulled from. Shared by every import adapter (GitHub
 * today; registry/marketplace next). Directory-name collisions are
 * auto-suffixed like importSkill.
 */
export function importSkillFromFiles(
  email: string,
  preferredDirName: string,
  files: ImportFile[],
  origin?: SkillOrigin,
): Skill {
  if (!files.some((f) => f.relPath === "SKILL.md")) {
    const err = new Error("No SKILL.md found in the imported skill.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const userRoot = getRoots().find((r) => r.kind === "user");
  if (!userRoot) {
    const err = new Error("No user-source skills root is configured.");
    (err as Error & { code: string }).code = "NO_ROOT";
    throw err;
  }
  const ownFolder = path.join(scopedRootPath(userRoot, email), SKILLS_DIR);
  if (!ownFolder) {
    const err = new Error("Authentication required.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }
  fs.mkdirSync(ownFolder, { recursive: true });

  const baseName = dirSlug(preferredDirName) || "skill";
  let targetName = baseName;
  for (let attempt = 1; attempt <= 50; attempt++) {
    if (!fs.existsSync(path.join(ownFolder, targetName))) break;
    targetName = attempt === 1 ? `${baseName}-copy` : `${baseName}-copy-${attempt}`;
    if (attempt === 50) {
      const err = new Error(`Too many copies of "${preferredDirName}". Delete one first.`);
      (err as Error & { code: string }).code = "CONFLICT";
      throw err;
    }
  }
  const targetDir = path.join(ownFolder, targetName);
  writeFilesInto(targetDir, files, origin);

  const realDir = fs.realpathSync(targetDir);
  const created =
    getAllSkills(email).find((s) => s.sourcePath === realDir) ??
    getAllSkills(email).find((s) => s.sourcePath === targetDir);
  if (!created) throw new Error("Failed to read imported skill.");
  return created;
}

/** Write a set of files into `targetDir`, injecting `origin` into SKILL.md.
 *  Rejects path traversal. Creates parent dirs as needed. */
function writeFilesInto(targetDir: string, files: ImportFile[], origin?: SkillOrigin): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of files) {
    const cleanRel = f.relPath.replace(/^\/+/, "").replace(/\\/g, "/");
    // Skip anything that would escape the target directory.
    if (!cleanRel || cleanRel.split("/").some((seg) => seg === ".." || seg === "")) continue;
    const dest = path.join(targetDir, ...cleanRel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const bytes = cleanRel === "SKILL.md" && origin ? withOrigin(f.bytes, origin) : f.bytes;
    fs.writeFileSync(dest, bytes);
  }
}

/**
 * Re-fetch an imported skill in place: clear its directory and rewrite it from
 * fresh files, updating the `origin` (e.g. a new pinned SHA). The slug and
 * folder stay put. Owner-only, path-guarded like the other write paths.
 */
export function overwriteSkillFiles(
  email: string,
  slug: string,
  files: ImportFile[],
  origin?: SkillOrigin,
): Skill {
  const skill = getSkillBySlug(slug, email);
  if (!skill) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(skill);
  if (!isInsideOwnFolder(skill.sourcePath, email)) {
    const err = new Error("Refusing to write outside your own skills folder.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  if (!files.some((f) => f.relPath === "SKILL.md")) {
    const err = new Error("Refusing to overwrite: the new files have no SKILL.md.");
    (err as Error & { code: string }).code = "INVALID";
    throw err;
  }

  const dir = skill.sourcePath;
  fs.rmSync(dir, { recursive: true, force: true });
  writeFilesInto(dir, files, origin);

  const refreshed =
    getAllSkills(email).find((s) => s.sourcePath === dir) ??
    getAllSkills(email).find((s) => path.basename(s.sourcePath) === path.basename(dir));
  if (!refreshed) throw new Error("Failed to read skill after update.");
  return refreshed;
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

// ---------- categories ------------------------------------------------------
//
// A category is one level of subfolder inside the caller's own artifact folder
// (`<root>/<emailSlug>/<category>/<slug>/SKILL.md`). Nothing else is stored:
// the folder IS the category, so the files stay readable without the app and a
// flat layout keeps working. All of this refuses to touch anything outside the
// caller's folder, the same guard the write paths use.

/** Folder-name rules: one path segment, no separators, dots or control
 *  characters, and never a dotfile or the legacy `_public` folder. */
function assertCategoryName(name: string): string {
  const clean = name.trim();
  if (!clean) throw invalidCategory("A category needs a name.");
  if (clean.length > 64) throw invalidCategory("Category names are limited to 64 characters.");
  if (clean === LEGACY_SHARED_FOLDER) throw invalidCategory(`"${LEGACY_SHARED_FOLDER}" is reserved.`);
  if (clean.startsWith(".")) throw invalidCategory("A category name cannot start with a dot.");
  // eslint-disable-next-line no-control-regex
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(clean)) {
    throw invalidCategory("A category name cannot contain / \\ : * ? \" < > | .");
  }
  if (clean === "." || clean === "..") throw invalidCategory("Invalid category name.");
  return clean;
}

function invalidCategory(message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = "INVALID";
  return err;
}

function notFound(message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = "NOT_FOUND";
  return err;
}

/** The caller's own artifact folder in the first user root, created on demand. */
function ownRootDir(email: string): string {
  const dir = path.join(userSkillsRootPath(), userSlug(email));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Categories the caller owns: every direct subfolder of any of their own
 *  bases that is not itself an artifact (i.e. holds no SKILL.md). The same
 *  name in two bases is one category. */
export function listCategories(email: string): string[] {
  const names = new Set<string>();
  for (const dir of ownBases(email).map((b) => protocolsDirOf(b, email))) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === LEGACY_SHARED_FOLDER) continue;
      if (fs.existsSync(path.join(dir, e.name, "SKILL.md"))) continue;
      names.add(e.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function createCategory(name: string, email: string): string {
  const clean = assertCategoryName(name);
  const target = path.join(ownProtocolsDir(email), clean);
  if (fs.existsSync(target)) throw invalidCategory(`"${clean}" already exists.`);
  fs.mkdirSync(target, { recursive: true });
  return clean;
}

export function renameCategory(from: string, to: string, email: string): string {
  const fromClean = assertCategoryName(from);
  const clean = assertCategoryName(to);
  let renamed = 0;
  for (const base of ownBases(email).map((b) => protocolsDirOf(b, email))) {
    const src = path.join(base, fromClean);
    const dst = path.join(base, clean);
    if (!fs.existsSync(src)) continue;
    if (!isInsideOwnFolder(src, email)) {
      throw invalidCategory("Refusing to rename outside your own folder.");
    }
    if (fs.existsSync(dst) && path.resolve(src) !== path.resolve(dst)) {
      throw invalidCategory(`"${clean}" already exists.`);
    }
    fs.renameSync(src, dst);
    renamed += 1;
  }
  if (renamed === 0) throw notFound(`No category named "${from}".`);
  return clean;
}

/** Delete a category. Refuses while it still holds anything, so no artifact is
 *  ever removed as a side effect of tidying the rail. */
export function deleteCategory(name: string, email: string): void {
  const clean = assertCategoryName(name);
  const dirs = ownBases(email)
    .map((b) => path.join(protocolsDirOf(b, email), clean))
    .filter((d) => fs.existsSync(d));
  if (dirs.length === 0) throw notFound(`No category named "${name}".`);
  let held = 0;
  for (const dir of dirs) {
    if (!isInsideOwnFolder(dir, email)) {
      throw invalidCategory("Refusing to delete outside your own folder.");
    }
    held += fs.readdirSync(dir).filter((n) => !n.startsWith(".")).length;
  }
  if (held > 0) {
    throw invalidCategory(
      `"${name}" still holds ${held} item${held === 1 ? "" : "s"}. Move them out first.`,
    );
  }
  for (const dir of dirs) fs.rmdirSync(dir);
}

/** Move an artifact into a category, or to the top level when `category` is
 *  null/empty. Returns the artifact as it reads back from its new home — the
 *  slug is unchanged because slugs come from the name, not the path. */
export function moveSkillToCategory(
  slug: string,
  category: string | null,
  email: string,
): Skill {
  const existing = getSkillBySlug(slug, email);
  if (!existing) throw notFound("Artifact not found.");
  assertEditable(existing);
  if (existing.artifactKind !== "protocol") {
    throw invalidCategory("Only protocols have categories.");
  }
  if (!isInsideOwnFolder(existing.artifactFile ?? existing.sourcePath, email)) {
    throw invalidCategory("Refusing to move outside your own folder.");
  }
  // Categorise inside whichever of the caller's bases already holds this
  // artifact, so a protocol is not relocated across roots just to be filed.
  const held = baseHolding(existing.artifactFile ?? existing.sourcePath, email) ?? ownRootDir(email);
  const root = protocolsDirOf(held, email);
  const clean = category == null || category === "" ? null : assertCategoryName(category);
  const targetDir = clean ? path.join(root, clean) : root;
  if (clean && !fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  // A document moves as a file, a skill as its folder.
  const from = existing.artifactFile ?? existing.sourcePath;
  const dest = path.join(targetDir, path.basename(from));
  if (path.resolve(dest) === path.resolve(from)) return existing;
  if (fs.existsSync(dest)) {
    throw invalidCategory(
      `"${path.basename(from)}" already exists in ${clean ?? "the top level"}.`,
    );
  }
  fs.renameSync(from, dest);
  const moved = getSkillBySlug(slug, email);
  if (!moved) throw notFound("Artifact moved but could not be read back.");
  return moved;
}

// ---------- body search -----------------------------------------------------

export interface SkillSearchHit {
  slug: string;
  /** Lower is better: the offset of the first match, plus a field bonus. */
  score: number;
  /** ~160 characters of body around the first body match, if it matched there. */
  snippet?: string;
  /** Which field matched first: name, description or body. */
  field: "name" | "description" | "body";
}

/** Case-insensitive substring search across name, description and body of the
 *  artifacts visible to `email`. Deliberately plain: it is predictable, needs
 *  no index, and a lab catalog is small. Bodies stay on the server — only a
 *  snippet travels. */
export function searchSkills(
  query: string,
  email?: string,
  opts?: { kind?: "skill" | "protocol"; limit?: number },
): SkillSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const hits: SkillSearchHit[] = [];
  for (const s of getAllSkills(email)) {
    if (opts?.kind && s.artifactKind !== opts.kind) continue;
    const inName = s.name.toLowerCase().indexOf(q);
    if (inName >= 0) {
      hits.push({ slug: s.slug, score: inName, field: "name" });
      continue;
    }
    const inDesc = s.description.toLowerCase().indexOf(q);
    if (inDesc >= 0) {
      hits.push({ slug: s.slug, score: 1000 + inDesc, field: "description" });
      continue;
    }
    const inBody = s.body.toLowerCase().indexOf(q);
    if (inBody >= 0) {
      const start = Math.max(0, inBody - 70);
      const raw = s.body.slice(start, start + 160).replace(/\s+/g, " ").trim();
      hits.push({
        slug: s.slug,
        score: 2000 + inBody,
        field: "body",
        snippet: `${start > 0 ? "…" : ""}${raw}…`,
      });
    }
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}

export function deleteSkill(slug: string, email: string): void {
  const existing = getSkillBySlug(slug, email);
  if (!existing) {
    const err = new Error("Skill not found.");
    (err as Error & { code: string }).code = "NOT_FOUND";
    throw err;
  }
  assertEditable(existing);
  const victim = existing.artifactFile ?? existing.sourcePath;
  if (!isInsideOwnFolder(victim, email)) {
    const err = new Error("Refusing to delete outside your own skills folder.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  // A document is one file; a skill is its whole folder.
  fs.rmSync(victim, { recursive: !existing.artifactFile, force: true });
}
