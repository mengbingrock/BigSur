// Starter protocols shipped with the app.
//
// A protocol library with nothing in it teaches nobody what a protocol is, so
// a dozen real bench protocols ride along in the bundle and are copied into the
// shared `_public` folder the first time a server starts with an empty one.
//
// Rules that matter:
//   - only ever writes into `_public`, never into anyone's own folder;
//   - never overwrites a file that exists, so an edit survives a restart;
//   - never re-adds a file it has already seeded, so a starter protocol the
//     operator deleted stays deleted instead of returning on every boot;
//   - still picks up protocols added by a later release, because the record is
//     of what has been seeded, not merely that seeding happened;
//   - a missing seed directory is not an error — a dev checkout that has not
//     been built simply has nothing to copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userSkillsRootPath } from "./skills";

const PUBLIC_FOLDER = "_public";
/** Record of every seed file already delivered, one relative path per line.
 *  Consulted before copying, so deletions stick and later releases still top
 *  up. Lives inside _public, which is operator-owned territory. */
const STAMP = ".seeded";

/** Locate the bundled seed directory: beside dist/bin.mjs in a build, or in the
 *  source tree when running from a checkout. Mirrors resolveStaticDir(). */
function seedDir(): string | undefined {
  const override = process.env.LABEE_SEED_DIR;
  if (override && fs.existsSync(override)) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "seed/protocols"), // next to dist/bin.mjs
    path.resolve(here, "../seed/protocols"),
    path.resolve(here, "../../seed/protocols"), // src/services → apps/server/seed
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
 * Copy the bundled starter protocols into `<skills root>/_public/`, skipping
 * anything already present. Safe to call on every boot; returns how many files
 * it actually wrote.
 */
export function seedPublicProtocols(): number {
  if (process.env.LABEE_SEED_PROTOCOLS === "false") return 0;
  const from = seedDir();
  if (!from) return 0;
  try {
    const target = path.join(userSkillsRootPath(), PUBLIC_FOLDER);
    fs.mkdirSync(target, { recursive: true });
    const stamp = path.join(target, STAMP);
    const seeded = new Set(
      fs.existsSync(stamp)
        ? fs.readFileSync(stamp, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
        : [],
    );

    let copied = 0;
    for (const rel of walk(from)) {
      // Already delivered once: whatever the operator did with it since —
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
    if (copied > 0) {
      console.info(`[seed] added ${copied} starter protocol file(s) to ${PUBLIC_FOLDER}`);
    }
    return copied;
  } catch (e) {
    // Seeding is a convenience; a read-only or unusual filesystem must not stop
    // the server from booting.
    console.warn("[seed] could not seed starter protocols:", e);
    return 0;
  }
}
