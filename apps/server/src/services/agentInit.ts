// Agent initialization: scaffold the working directory with init files and a
// summarized "memory" of the reference-protocol folders. Run on agent create
// (background) and on demand (rebuild). The memory digest lets a chat consult a
// compact summary instead of re-reading every reference file each turn.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@labee/contracts";
import { completeText } from "./complete";
import { getAllSkills } from "./skills";
import { syncSkillsFromServer } from "./remoteSkills";

export const AGENT_MEMORY_FILE = "agent-memory.md";
const AGENTS_FILE = "AGENTS.md";
const PROFILE_FILE = "agent.md";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml",
  ".xml", ".html", ".htm", ".rst", ".org", ".tex", ".log", ".toml", ".ini",
  ".sh", ".py", ".js", ".ts", ".r", ".sql", ".m", ".do",
]);

const MAX_FILES = 40;
const MAX_DEPTH = 4;
const PER_FILE_BYTES = 40 * 1024;
const TOTAL_BYTES = 220 * 1024;

interface RefFile {
  /** Absolute path. */
  path: string;
  /** Display path: "<folder name>/<rel>". */
  display: string;
  text: string;
}

async function walkFolder(
  root: string,
  acc: RefFile[],
  budget: { bytes: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES || budget.bytes <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const rootName = path.basename(root);
  for (const entry of entries) {
    if (acc.length >= MAX_FILES || budget.bytes <= 0) break;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFolder(full, acc, budget, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = await fsp.stat(full);
      if (stat.size === 0 || stat.size > 4 * 1024 * 1024) continue;
      const buf = await fsp.readFile(full);
      const slice = buf.subarray(0, Math.min(PER_FILE_BYTES, budget.bytes));
      const text = slice.toString("utf8");
      budget.bytes -= slice.byteLength;
      acc.push({ path: full, display: path.join(rootName, path.relative(root, full)), text });
    } catch {
      continue;
    }
  }
}

/** Collect text files across all of the agent's reference folders (capped). */
async function collectReferenceFiles(folders: readonly string[]): Promise<RefFile[]> {
  const acc: RefFile[] = [];
  const budget = { bytes: TOTAL_BYTES };
  for (const folder of folders) {
    if (acc.length >= MAX_FILES || budget.bytes <= 0) break;
    await walkFolder(path.resolve(folder), acc, budget, 0);
  }
  return acc;
}

const SUMMARY_SYSTEM =
  "You are building a reference index for an AI lab agent. You are given the contents of reference " +
  "protocol/document files. Produce a concise, well-structured Markdown digest the agent can consult " +
  "quickly instead of re-reading every file. For EACH file, write a `### <path>` heading followed by a " +
  "2–4 sentence summary and a short bullet list of the key steps, reagents, parameters, or sections it " +
  "contains. Start with a one-paragraph overview of what this reference set covers. Be factual and terse; " +
  "do not invent content. Output only the Markdown digest.";

function buildSummaryPrompt(files: RefFile[]): string {
  const blocks = files.map(
    (f) => `===FILE: ${f.display}===\n${f.text.replace(/\s+$/, "")}\n===END FILE: ${f.display}===`,
  );
  return (
    `There are ${files.length} reference file(s). Build the Markdown digest now.\n\n` +
    blocks.join("\n\n")
  );
}

/** Build (or rebuild) the reference-protocol memory digest for an agent. */
async function buildMemory(email: string, agent: Agent): Promise<string> {
  const files = await collectReferenceFiles(agent.referenceFolders);
  const header =
    `# Agent memory — ${agent.name}\n\n` +
    `_Auto-generated digest of the reference protocol folders. ` +
    `Consult this first; read the source files only when you need detail._\n\n` +
    (agent.referenceFolders.length
      ? `Reference folders:\n${agent.referenceFolders.map((f) => `- \`${f}\``).join("\n")}\n\n`
      : "") +
    `---\n\n`;
  if (files.length === 0) {
    return header + "_No readable reference files were found in the configured folders._\n";
  }
  try {
    const digest = await completeText({
      email,
      system: SUMMARY_SYSTEM,
      user: buildSummaryPrompt(files),
      effort: "low",
      timeoutMs: 150_000,
      anthropicModel: "sonnet",
      openaiModel: "gpt-5.4-mini",
    });
    return header + (digest.trim() || "_(summary was empty)_") + "\n";
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown error";
    const index = files.map((f) => `- \`${f.display}\``).join("\n");
    return (
      header +
      `_Automatic summarization was unavailable (${reason}). Files found:_\n\n${index}\n`
    );
  }
}

function profileMarkdown(agent: Agent): string {
  return (
    `# ${agent.name}\n\n` +
    (agent.description ? `${agent.description}\n\n` : "") +
    `## Working directory\n\`${agent.workingDir}\`\n\n` +
    `## Active skills\n` +
    (agent.skillSlugs.length ? agent.skillSlugs.map((s) => `- ${s}`).join("\n") : "_none_") +
    `\n\n## Reference protocol folders\n` +
    (agent.referenceFolders.length
      ? agent.referenceFolders.map((f) => `- \`${f}\``).join("\n")
      : "_none_") +
    "\n"
  );
}

function agentsMarkdown(agent: Agent): string {
  return (
    `# Agent: ${agent.name}\n\n` +
    (agent.description ? `${agent.description}\n\n` : "") +
    `You are operating as this saved agent. Your current working directory is this folder; write all outputs here.\n\n` +
    `## Memory\n` +
    `A summarized digest of the reference protocols is in \`${AGENT_MEMORY_FILE}\`. ` +
    `Read it first to answer questions quickly. Open the original reference files only when you need detail beyond the digest.\n\n` +
    (agent.referenceFolders.length
      ? `## Reference protocol folders\n${agent.referenceFolders
          .map((f) => `- \`${f}\``)
          .join("\n")}\n`
      : "")
  );
}

/** Copy the agent's selected skills into its working-dir `.skill` folder so the
 *  workspace carries its own skills. Returns the names synced. */
async function syncAgentSkills(email: string, agent: Agent, dir: string): Promise<string[]> {
  const skillDir = path.join(dir, ".skill");
  await fsp.mkdir(skillDir, { recursive: true });
  if (agent.skillSlugs.length === 0) return [];
  const bySlug = new Map(getAllSkills(email).map((s) => [s.slug, s]));
  const synced: string[] = [];
  for (const slug of agent.skillSlugs) {
    const skill = bySlug.get(slug);
    if (!skill?.sourcePath) continue;
    const src = path.resolve(skill.sourcePath);
    // Skip a skill that already lives inside this agent's .skill folder.
    const rel = path.relative(skillDir, src);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) continue;
    const dest = path.join(skillDir, path.basename(src));
    try {
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(src, dest, { recursive: true, dereference: true });
      synced.push(skill.name);
    } catch {
      /* skip unreadable skill */
    }
  }
  return synced;
}

export interface InitResult {
  workingDir: string;
  written: string[];
  syncedSkills: string[];
  /** True when the memory digest was deferred and is still building in the background. */
  memoryPending: boolean;
}

export interface InitOptions {
  /** When false, skip the slow LLM memory digest — the caller rebuilds it
   *  separately (e.g. in the background) so the HTTP response returns fast. */
  buildMemory?: boolean;
}

/** Ensure the working dir exists, scaffold init files, and (optionally) build memory. */
export async function initializeAgent(
  email: string,
  agent: Agent,
  opts: InitOptions = {},
): Promise<InitResult> {
  const dir = path.resolve(agent.workingDir);
  await fsp.mkdir(dir, { recursive: true });
  // Refresh the local catalog from the central Labee server first (best effort),
  // then copy the agent's selected skills into its workspace `.skill` folder.
  await syncSkillsFromServer(email).catch(() => {});
  const syncedSkills = await syncAgentSkills(email, agent, dir);

  const written: string[] = [];
  const write = async (name: string, content: string) => {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
    written.push(name);
  };

  // Fast scaffolding first so the files appear immediately.
  await write(PROFILE_FILE, profileMarkdown(agent));
  await write(AGENTS_FILE, agentsMarkdown(agent));

  // The memory digest is an LLM call and can take far longer than a proxy/client
  // idle timeout. When deferred, the caller rebuilds it in the background.
  if (opts.buildMemory === false) {
    return { workingDir: dir, written, syncedSkills, memoryPending: true };
  }
  const memory = await buildMemory(email, agent);
  await write(AGENT_MEMORY_FILE, memory);
  return { workingDir: dir, written, syncedSkills, memoryPending: false };
}

/** Rebuild just the reference-protocol memory digest (slow; LLM, best-effort). */
export async function rebuildAgentMemory(email: string, agent: Agent): Promise<void> {
  const dir = path.resolve(agent.workingDir);
  await fsp.mkdir(dir, { recursive: true });
  const memory = await buildMemory(email, agent);
  await fsp.writeFile(path.join(dir, AGENT_MEMORY_FILE), memory, "utf8");
}
