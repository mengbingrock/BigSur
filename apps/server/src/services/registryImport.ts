// Import a skill from a package registry (ClawHub by default). ClawHub packages
// ARE SKILL.md directories — npm-safe slugs (@scope/name), semver versions, and
// string tags like `latest` (per docs.openclaw.ai/clawhub). The registry's exact
// HTTP surface isn't pinned in this codebase yet, so this adapter targets a
// small, conventional, files-based contract (mirroring the Labee skills API, so
// there's no tarball extraction) and keeps the base URL configurable. Swapping
// registries is swapping a base URL; changing the wire contract is confined here.
//
// Assumed contract:
//   GET {base}/api/packages/{pkg}            -> { distTags?:{latest}, versions: string[] | {..} }
//   GET {base}/api/packages/{pkg}/{version}  -> { version, digest?, files:[{path, text?|base64?}] }
import type { Skill, SkillOrigin } from "@labee/contracts";
import { importSkillFromFiles, type ImportFile } from "./skills";

export const DEFAULT_REGISTRY_ID = "clawhub";

function codeErr(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** Base URL for a registry id. ClawHub has a default; others come from env. */
export function registryBase(id: string): string {
  if (id === "clawhub") {
    return (process.env.CLAWHUB_REGISTRY || "https://clawhub.ai").replace(/\/+$/, "");
  }
  const key = `REGISTRY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const base = process.env[key];
  if (!base) throw codeErr(`Unknown registry "${id}". Set ${key} to its base URL.`, "INVALID");
  return base.replace(/\/+$/, "");
}

// --- tiny semver (major.minor.patch; caret / tilde / x-ranges / exact) --------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseVer(v: string): SemVer | null {
  // Accept partials — "1", "1.2", "1.2.3" — defaulting missing parts to 0, so
  // caret/tilde ranges like "^1.1" resolve. Published versions are always full.
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

function cmp(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function satisfies(v: SemVer, range: string): boolean {
  const r = range.trim().replace(/^v/, "");
  if (r === "" || r === "*" || r === "latest") return true;
  if (r.startsWith("^")) {
    const b = parseVer(r.slice(1));
    return !!b && v.major === b.major && cmp(v, b) >= 0;
  }
  if (r.startsWith("~")) {
    const b = parseVer(r.slice(1));
    return !!b && v.major === b.major && v.minor === b.minor && cmp(v, b) >= 0;
  }
  // Partial / x-ranges: "1", "1.2", "1.x", "1.2.x", or an exact "1.2.3".
  const [maj, min, pat] = r.split(".");
  if (maj && maj !== "x" && Number(maj) !== v.major) return false;
  if (min && min !== "x" && Number(min) !== v.minor) return false;
  if (pat && pat !== "x" && Number(pat) !== v.patch) return false;
  return true;
}

/** Pick the highest available version matching `range` (undefined/"latest" →
 *  the dist-tag or the highest published). */
export function resolveVersion(
  range: string | undefined,
  versions: string[],
  latestTag?: string,
): string {
  const parsed = versions
    .map((raw) => ({ raw, sv: parseVer(raw) }))
    .filter((x): x is { raw: string; sv: SemVer } => x.sv !== null);
  const r = (range ?? "").trim();

  if (!r || r === "latest") {
    if (latestTag && versions.includes(latestTag)) return latestTag;
    const sorted = [...parsed].sort((a, b) => cmp(b.sv, a.sv));
    if (!sorted[0]) throw codeErr("Registry has no published versions.", "NOT_FOUND");
    return sorted[0].raw;
  }
  if (versions.includes(r)) return r; // exact hit
  const matches = parsed.filter((x) => satisfies(x.sv, r)).sort((a, b) => cmp(b.sv, a.sv));
  if (!matches[0]) throw codeErr(`No published version matches "${r}".`, "NOT_FOUND");
  return matches[0].raw;
}

// --- wire ---------------------------------------------------------------------

async function regJson<T>(url: string, registryId: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw codeErr(`Could not reach the ${registryId} registry.`, "UPSTREAM");
  }
  if (res.status === 404) throw codeErr("Package or version not found on the registry.", "NOT_FOUND");
  if (!res.ok) throw codeErr(`Registry returned HTTP ${res.status}.`, "UPSTREAM");
  return (await res.json()) as T;
}

interface Packument {
  distTags?: { latest?: string };
  "dist-tags"?: { latest?: string };
  versions?: string[] | Record<string, unknown>;
}

interface Manifest {
  version?: string;
  digest?: string;
  files?: Array<{ path?: string; text?: string; base64?: string; content?: string; encoding?: string }>;
}

function versionList(p: Packument): string[] {
  const v = p.versions;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

function toImportFiles(files: Manifest["files"]): ImportFile[] {
  if (!Array.isArray(files)) return [];
  const out: ImportFile[] = [];
  for (const f of files) {
    const p = typeof f?.path === "string" ? f.path : undefined;
    if (!p) continue;
    let bytes: Uint8Array | null = null;
    if (typeof f.text === "string") bytes = new TextEncoder().encode(f.text);
    else if (typeof f.base64 === "string") bytes = new Uint8Array(Buffer.from(f.base64, "base64"));
    else if (typeof f.content === "string") {
      bytes =
        f.encoding === "base64"
          ? new Uint8Array(Buffer.from(f.content, "base64"))
          : new TextEncoder().encode(f.content);
    }
    if (bytes) out.push({ relPath: p, bytes });
  }
  return out;
}

export interface RegistryImportInput {
  registry?: string | undefined;
  pkg: string;
  version?: string | undefined;
}

/** Resolve + fetch a package's files and origin without writing (shared with the updater). */
export async function fetchRegistrySkill(
  args: RegistryImportInput,
): Promise<{ files: ImportFile[]; origin: SkillOrigin; dirName: string }> {
  const id = (args.registry || DEFAULT_REGISTRY_ID).trim();
  const base = registryBase(id);
  const pkg = args.pkg.trim();
  if (!pkg) throw codeErr("A package name is required.", "INVALID");
  const encPkg = pkg.split("/").map(encodeURIComponent).join("/");

  const packument = await regJson<Packument>(`${base}/api/packages/${encPkg}`, id);
  const latestTag = packument.distTags?.latest ?? packument["dist-tags"]?.latest;
  const version = resolveVersion(args.version, versionList(packument), latestTag);

  const manifest = await regJson<Manifest>(
    `${base}/api/packages/${encPkg}/${encodeURIComponent(version)}`,
    id,
  );
  const files = toImportFiles(manifest.files);
  if (!files.some((f) => f.relPath === "SKILL.md")) {
    throw codeErr("Registry package has no SKILL.md.", "UPSTREAM");
  }

  const origin: SkillOrigin = manifest.digest
    ? { kind: "registry", registry: id, pkg, version, digest: manifest.digest }
    : { kind: "registry", registry: id, pkg, version };
  const dirName = pkg.split("/").pop() || pkg;
  return { files, origin, dirName };
}

/** The latest published version of a package (for update checks). */
export async function latestVersion(registry: string, pkg: string): Promise<string> {
  const base = registryBase(registry);
  const encPkg = pkg.split("/").map(encodeURIComponent).join("/");
  const packument = await regJson<Packument>(`${base}/api/packages/${encPkg}`, registry);
  const latestTag = packument.distTags?.latest ?? packument["dist-tags"]?.latest;
  return resolveVersion(undefined, versionList(packument), latestTag);
}

/** Import a skill from a registry into `email`'s catalog. */
export async function importSkillFromRegistry(
  args: RegistryImportInput,
  email: string,
): Promise<Skill> {
  const { files, origin, dirName } = await fetchRegistrySkill(args);
  return importSkillFromFiles(email, dirName, files, origin);
}
