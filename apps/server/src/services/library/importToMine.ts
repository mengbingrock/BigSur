// Save a library protocol into the person's own library.
//
// The copy is theirs from then on — edited, recategorised, deleted like any
// other — and carries an `origin` naming the library id, source, URL and
// licence, so the original stops appearing beside it in search and the
// attribution the licence asks for travels with the file. On a desktop the
// record is fetched from the box; on the box it is read here.
import { createSkill, getAllSkills, moveSkillToCategory } from "../skills";
import type { Skill } from "@labee/contracts";
import { isDesktop, remoteLabeeSession } from "../llmSettings";
import { getLibraryProtocol, type LibraryRow } from "./store";

/** The record, from wherever the library is. */
export async function fetchLibraryProtocol(id: string): Promise<LibraryRow | null> {
  if (!isDesktop()) return getLibraryProtocol(id);
  const remote = remoteLabeeSession();
  if (!remote) return null;
  try {
    const res = await fetch(`${remote.base}/api/library/${encodeURIComponent(id)}`, { headers: { accept: "application/json", cookie: remote.cookie } });
    if (!res.ok) return null;
    return ((await res.json()) as { protocol: LibraryRow }).protocol ?? null;
  } catch {
    return null;
  }
}

/** The person's existing copy of a library protocol, if they have one. */
export function existingCopy(id: string, email: string): Skill | undefined {
  return getAllSkills(email).find((s) => s.origin?.kind === "library" && s.origin.id === id);
}

/**
 * Save `id` into `email`'s protocols, under `category` (the record's own
 * when not given). A second save of the same id returns the existing copy
 * rather than making a twin.
 */
export async function importLibraryProtocol(
  id: string,
  email: string,
  opts: { category?: string } = {},
): Promise<{ skill: Skill; already: boolean }> {
  const have = existingCopy(id, email);
  if (have) return { skill: have, already: true };
  const rec = await fetchLibraryProtocol(id);
  if (!rec) {
    const e = new Error("Library protocol not found.") as Error & { code: string };
    e.code = "NOT_FOUND";
    throw e;
  }
  const body = rec.body.replace(/\s*$/, "") + `\n\n## References\n\n- ${rec.title} — ${rec.sourceUrl || rec.source} (${rec.license})\n`;
  let skill = createSkill(
    {
      name: rec.title,
      description: rec.description,
      allowedTools: [],
      body,
      kind: "protocol",
      ...(rec.problem ? { problem: rec.problem } : {}),
      ...(rec.method ? { method: rec.method } : {}),
      ...(rec.application ? { application: rec.application } : {}),
      domains: rec.domains,
      keywords: rec.keywords,
      origin: { kind: "library", id: rec.id, source: rec.source, url: rec.sourceUrl, license: rec.license },
    },
    email,
  );
  const category = (opts.category ?? rec.category ?? "").trim();
  if (category) skill = moveSkillToCategory(skill.slug, category, email);
  return { skill, already: false };
}
