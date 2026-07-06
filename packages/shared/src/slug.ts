import type { SkillSource } from "@labee/contracts";

/** Slug-safe form of an email used as a per-user directory name.
 *  `a@b.com` -> `a-at-b-com`. */
export function userSlug(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Lowercase, hyphenated base form of a name. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Qualified artifact slug, prefixed by its source so user/public/plugin
 *  artifacts of the same name don't collide. */
export function skillSlug(name: string, source: SkillSource): string {
  const base = slugifyName(name);
  if (source.kind === "plugin") {
    return `${source.marketplace.toLowerCase().replace(/[^a-z0-9]+/g, "-")}--${base}`;
  }
  return `${source.kind}--${base}`;
}
