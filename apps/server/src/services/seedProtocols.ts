// Starter protocols shipped with the app.
//
// A protocol library with nothing in it teaches nobody what a protocol is, so
// a dozen real bench protocols ride along in the bundle. They are copied into
// each person's OWN protocols folder the first time that folder is read —
// from then on they are that person's, to edit, recategorise or delete like
// anything else there. There is no shared copy.
//
// Rules that matter:
//   - never overwrites a file that exists, so an edit survives;
//   - never re-delivers a file it has already delivered, so a starter protocol
//     the person deleted stays deleted instead of returning on every boot;
//   - still delivers protocols added by a later release, because the record
//     is of what has been delivered, not merely that delivery happened;
//   - a missing seed directory is not an error — a dev checkout that has not
//     been built simply has nothing to copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Record of every seed file already delivered to a folder, one relative path
 *  per line. Lives inside the person's protocols folder, beside their files. */
const STAMP = ".starter-protocols";
/** The same record for the person's skills folder. */
const SKILLS_STAMP = ".starter-skills";

/** Folders already checked this process, so the per-request scan that calls
 *  this pays for one Set lookup after the first time. */
const done = new Set<string>();

/** Locate a bundled seed directory (`protocols` or `skills`): beside
 *  dist/bin.mjs in a build, or in the source tree when running from a
 *  checkout. Mirrors resolveStaticDir(). */
function seedDir(sub: "protocols" | "skills"): string | undefined {
  const override = sub === "protocols" ? process.env.LABEE_SEED_DIR : process.env.LABEE_SEED_SKILLS_DIR;
  if (override && fs.existsSync(override)) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, `seed/${sub}`), // next to dist/bin.mjs
    path.resolve(here, `../seed/${sub}`),
    path.resolve(here, `../../seed/${sub}`), // src/services → apps/server/seed
  ];
  return candidates.find((d) => fs.existsSync(d));
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Copy the bundled starter protocols into `target` (a person's protocols
 * folder), skipping anything already delivered there. Safe to call on every
 * read; returns how many files it actually wrote.
 */
export function seedStarterProtocols(target: string): number {
  return deliver("protocols", target, STAMP);
}

/**
 * Copy the bundled starter skills — today the Protocol Agent's skill — into
 * `target` (a person's skills folder). Same rules as the protocols: delivered
 * once, never overwritten, never resurrected after the person deletes one.
 */
export function seedStarterSkills(target: string): number {
  return deliver("skills", target, SKILLS_STAMP);
}

/**
 * The skill the old protocol agent ran on lived in the shared `_public`
 * folder that the two-folder layout retired; nothing reads it any more. Once
 * the replacement skill has been delivered, that one folder goes, so a
 * person browsing their files does not find a dead copy beside the live one.
 * Only that folder: anything else under `_public` is left alone.
 */
export function retireLegacyProtocolPlan(rootPath: string): boolean {
  const legacy = path.join(rootPath, "_public", "protocol-plan");
  if (!fs.existsSync(legacy)) return false;
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
    console.info(`[seed] removed retired skill folder ${legacy}`);
    return true;
  } catch (e) {
    console.warn("[seed] could not remove retired skill folder:", e);
    return false;
  }
}

function deliver(sub: "protocols" | "skills", target: string, stampName: string): number {
  if (process.env.LABEE_SEED_PROTOCOLS === "false") return 0;
  if (done.has(target)) return 0;
  const from = seedDir(sub);
  if (!from) return 0;
  try {
    fs.mkdirSync(target, { recursive: true });
    const stamp = path.join(target, stampName);
    const seeded = new Set(
      fs.existsSync(stamp)
        ? fs.readFileSync(stamp, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
        : [],
    );

    let copied = 0;
    for (const rel of walk(from)) {
      // Already delivered once: whatever the person did with it since —
      // edited, moved, deleted — is their decision, not ours to undo.
      if (seeded.has(rel)) continue;
      const dst = path.join(target, rel);
      seeded.add(rel);
      if (fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(from, rel), dst);
      copied += 1;
    }
    fs.writeFileSync(stamp, [...seeded].sort().join("\n") + "\n");
    done.add(target);
    if (copied > 0) {
      console.info(`[seed] delivered ${copied} starter ${sub} file(s) to ${target}`);
    }
    return copied;
  } catch (e) {
    // Seeding is a convenience; a read-only or unusual filesystem must not
    // stop the library from loading.
    console.warn(`[seed] could not deliver starter ${sub}:`, e);
    return 0;
  }
}

/** For tests: forget which folders were seeded this process. */
export function resetSeedMemory(): void {
  done.clear();
}
