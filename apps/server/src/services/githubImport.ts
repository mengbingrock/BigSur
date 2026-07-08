// Import a skill straight from a public (or token-authorized) GitHub repo into
// the caller's catalog. Given a URL or `owner/repo` reference we resolve the
// ref to a concrete commit SHA, pull the subtree that holds SKILL.md via the
// Git Trees API, download each file from the raw CDN, and hand the bytes to
// importSkillFromFiles — which writes them to the user's folder with an
// `origin` provenance record. No git clone, no working checkout.
import type { Skill, SkillOrigin } from "@labee/contracts";
import { importSkillFromFiles, type ImportFile } from "./skills";

export const GH_API = "https://api.github.com";
export const GH_RAW = "https://raw.githubusercontent.com";

// Skills are small; these caps just stop a mis-pointed import from pulling a
// whole monorepo into someone's skills folder.
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB per skill

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or SHA. Undefined means "the repo's default branch". */
  ref?: string | undefined;
  /** Directory within the repo that contains SKILL.md, "" for the root. */
  subpath?: string | undefined;
}

/**
 * Accept the shapes a user is likely to paste:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/<subpath>
 *   https://github.com/owner/repo/blob/<ref>/<subpath>/SKILL.md
 *   owner/repo   |   owner/repo@ref   |   owner/repo/sub/dir@ref
 */
export function parseGithubRef(input: string): GithubRef {
  const s = input.trim();

  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const owner = parts[0];
    const repo = (parts[1] ?? "").replace(/\.git$/, "");
    if (!owner || !repo) throw badRef();
    const kind = parts[2]; // "tree" | "blob" | undefined
    const ref = parts[3];
    let rest = parts.slice(4);
    if (kind === "blob" && rest.length > 0) rest = rest.slice(0, -1); // drop file name
    if ((kind === "tree" || kind === "blob") && ref) {
      return { owner, repo, ref, subpath: rest.join("/") || undefined };
    }
    return { owner, repo };
  }

  // Shorthand — split off an optional "@ref" suffix first.
  const atIdx = s.indexOf("@");
  const ref = atIdx === -1 ? undefined : s.slice(atIdx + 1).trim() || undefined;
  const pathPart = atIdx === -1 ? s : s.slice(0, atIdx);
  const segs = pathPart.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const owner = segs[0];
  const repo = (segs[1] ?? "").replace(/\.git$/, "");
  if (!owner || !repo) throw badRef();
  return { owner, repo, ref, subpath: segs.slice(2).join("/") || undefined };
}

function badRef(): Error & { code: string } {
  const e = new Error(
    "Not a GitHub reference. Paste a repo URL (github.com/owner/repo/tree/main/skill) " +
      "or owner/repo[@ref].",
  ) as Error & { code: string };
  e.code = "INVALID";
  return e;
}

function fail(message: string, code = "INVALID"): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "labee-skill-import",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

export async function ghJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) throw fail("Repository, ref, or path not found on GitHub.", "NOT_FOUND");
  if (res.status === 401 || res.status === 403) {
    throw fail(
      "GitHub denied the request (rate-limited or private). Add a personal access token and retry.",
      "FORBIDDEN",
    );
  }
  if (!res.ok) throw fail(`GitHub returned HTTP ${res.status}.`, "UPSTREAM");
  return (await res.json()) as T;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

/** Resolve a ref (or the default branch) to a commit SHA. Returns the effective
 *  ref too, so callers can store a moving branch for later update checks. */
export async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  token?: string,
): Promise<{ sha: string; ref: string }> {
  let r = ref;
  if (!r) {
    const info = await ghJson<{ default_branch?: string }>(
      `${GH_API}/repos/${owner}/${repo}`,
      token,
    );
    r = info.default_branch || "main";
  }
  const commit = await ghJson<{ sha?: string }>(
    `${GH_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(r)}`,
    token,
  );
  if (!commit.sha) throw fail(`Could not resolve "${r}" to a commit.`, "NOT_FOUND");
  return { sha: commit.sha, ref: r };
}

/** List every path in a repo at a commit (recursive). */
export async function githubTree(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const tree = await ghJson<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    token,
  );
  return { entries: tree.tree ?? [], truncated: Boolean(tree.truncated) };
}

/** Fetch a single file's text from the raw CDN at a pinned commit. */
export async function githubRawText(
  owner: string,
  repo: string,
  sha: string,
  filePath: string,
  token?: string,
): Promise<string> {
  const url = `${GH_RAW}/${owner}/${repo}/${sha}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  if (!res.ok) throw fail(`Failed to download ${filePath} (HTTP ${res.status}).`, "UPSTREAM");
  return res.text();
}

export interface GithubImportInput {
  /** URL or owner/repo shorthand. */
  input: string;
  /** Overrides the ref parsed from `input`, if given. */
  ref?: string | undefined;
  /** Overrides the subpath parsed from `input`, if given. */
  subpath?: string | undefined;
  /** Optional PAT for private repos or to lift rate limits. */
  token?: string | undefined;
}

export interface FetchedSkill {
  files: ImportFile[];
  origin: SkillOrigin;
  /** Suggested directory name (the skill folder's basename). */
  dirName: string;
}

/** Resolve + download a skill's file tree from GitHub without writing anything.
 *  Shared by the importer and the updater. */
export async function fetchGithubSkillFiles(args: GithubImportInput): Promise<FetchedSkill> {
  const parsed = parseGithubRef(args.input);
  const owner = parsed.owner;
  const repo = parsed.repo;
  const wantedRef = args.ref ?? parsed.ref;
  const subpath = (args.subpath ?? parsed.subpath ?? "").replace(/^\/+|\/+$/g, "");
  const token = args.token;

  // Resolve the ref (or default branch) to a concrete commit, so the import is
  // pinned even if the branch moves later.
  const { sha, ref } = await resolveCommitSha(owner, repo, wantedRef, token);

  // One recursive Trees call lists every path at that commit.
  const { entries, truncated } = await githubTree(owner, repo, sha, token);

  // The skill directory must contain a SKILL.md.
  const skillMdPath = subpath ? `${subpath}/SKILL.md` : "SKILL.md";
  const hasSkillMd = entries.some((e) => e.type === "blob" && e.path === skillMdPath);
  if (!hasSkillMd) {
    if (truncated) {
      throw fail(
        "The repo tree is too large to scan. Point directly at the skill folder " +
          "(…/tree/<ref>/<path-to-skill>).",
      );
    }
    throw fail(
      subpath
        ? `No SKILL.md at ${subpath}/ in ${owner}/${repo}@${ref}.`
        : `No SKILL.md at the repo root of ${owner}/${repo}. Add the subpath to the skill folder.`,
      "NOT_FOUND",
    );
  }

  const prefix = subpath ? `${subpath}/` : "";
  const blobs = entries.filter(
    (e) => e.type === "blob" && (prefix === "" ? true : e.path.startsWith(prefix)),
  );
  if (blobs.length > MAX_FILES) {
    throw fail(`Skill folder has ${blobs.length} files (limit ${MAX_FILES}).`);
  }

  const files: ImportFile[] = [];
  let total = 0;
  for (const b of blobs) {
    if (typeof b.size === "number" && b.size > MAX_FILE_BYTES) continue; // skip oversized assets
    const relPath = prefix ? b.path.slice(prefix.length) : b.path;
    if (!relPath) continue;
    const rawUrl = `${GH_RAW}/${owner}/${repo}/${sha}/${b.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const res = await fetch(
      rawUrl,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    );
    if (!res.ok) throw fail(`Failed to download ${relPath} (HTTP ${res.status}).`, "UPSTREAM");
    const bytes = new Uint8Array(await res.arrayBuffer());
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw fail("Skill exceeds the 20 MB import limit.");
    files.push({ relPath, bytes });
  }

  const origin: SkillOrigin = {
    kind: "github",
    repo: `${owner}/${repo}`,
    ref: wantedRef ?? ref,
    sha,
    subpath: subpath || undefined,
  };
  const dirName = subpath ? subpath.split("/").pop() || repo : repo;
  return { files, origin, dirName };
}

/** Fetch a skill from GitHub and write it into `email`'s catalog. */
export async function importSkillFromGithub(
  args: GithubImportInput,
  email: string,
): Promise<Skill> {
  const { files, origin, dirName } = await fetchGithubSkillFiles(args);
  return importSkillFromFiles(email, dirName, files, origin);
}
