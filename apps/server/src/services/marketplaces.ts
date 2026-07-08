// Curated first-party skill marketplaces. Claude and Codex each ship a vetted
// collection of ready-made skills in a public GitHub repo; browsing means
// listing every SKILL.md folder in that repo, and importing reuses the GitHub
// adapter pointed at the chosen subpath. A Codex "plugin" can bundle more than a
// skill, but its skill surface is still a SKILL.md folder, so the same scan
// finds it.
import matter from "gray-matter";
import type { Skill } from "@labee/contracts";
import {
  githubRawText,
  githubTree,
  importSkillFromGithub,
  resolveCommitSha,
} from "./githubImport";

export interface MarketplaceDescriptor {
  id: string;
  label: string;
  /** "owner/repo". */
  repo: string;
  ref?: string;
  about: string;
}

export const MARKETPLACES: Record<string, MarketplaceDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude Skills",
    repo: "anthropics/skills",
    about: "Anthropic's curated skills collection.",
  },
  codex: {
    id: "codex",
    label: "Codex Plugins",
    repo: "openai/plugins",
    about: "OpenAI's curated Codex plugin marketplace.",
  },
};

export interface MarketplaceEntry {
  name: string;
  description: string;
  /** Folder inside the repo that holds SKILL.md. */
  subpath: string;
}

export interface MarketplaceListing {
  id: string;
  label: string;
  repo: string;
  entries: MarketplaceEntry[];
}

const MAX_ENTRIES = 200;

function codeErr(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

/** Browse a marketplace: every SKILL.md folder, with name + description. */
export async function listMarketplace(id: string, token?: string): Promise<MarketplaceListing> {
  const mp = MARKETPLACES[id];
  if (!mp) throw codeErr(`Unknown marketplace "${id}".`, "NOT_FOUND");
  const { owner, name } = splitRepo(mp.repo);
  const { sha } = await resolveCommitSha(owner, name, mp.ref, token);
  const { entries } = await githubTree(owner, name, sha, token);

  const subpaths = entries
    .filter((e) => e.type === "blob" && (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md")))
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -"/SKILL.md".length)))
    .slice(0, MAX_ENTRIES);

  // Pull each SKILL.md front-matter from the raw CDN (no API rate limit).
  const listing = await Promise.all(
    subpaths.map(async (subpath): Promise<MarketplaceEntry> => {
      const filePath = subpath ? `${subpath}/SKILL.md` : "SKILL.md";
      const fallbackName = subpath.split("/").pop() || name;
      try {
        const data = matter(await githubRawText(owner, name, sha, filePath, token)).data as Record<
          string,
          unknown
        >;
        const nm =
          typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallbackName;
        const description =
          typeof data.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "";
        return { name: nm, description, subpath };
      } catch {
        return { name: fallbackName, description: "", subpath };
      }
    }),
  );

  listing.sort((a, b) => a.name.localeCompare(b.name));
  return { id: mp.id, label: mp.label, repo: mp.repo, entries: listing };
}

/** Import one entry from a marketplace into the caller's catalog. */
export async function importFromMarketplace(
  id: string,
  subpath: string,
  email: string,
  token?: string,
): Promise<Skill> {
  const mp = MARKETPLACES[id];
  if (!mp) throw codeErr(`Unknown marketplace "${id}".`, "NOT_FOUND");
  return importSkillFromGithub({ input: mp.repo, ref: mp.ref, subpath, token }, email);
}
