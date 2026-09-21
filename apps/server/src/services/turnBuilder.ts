// Shared turn builder: turns a ChatRequest into a ready-to-run SSE byte stream
// for whichever engine applies (claude CLI, codex CLI, or plain OpenAI chat).
// Used by the legacy one-shot `/api/chat` route and by the server-owned
// session runner (services/sessions), so both build prompts, link skills, and
// pick credentials the same way. Extracted verbatim from routes/chat.ts.
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Skill } from "@labee/contracts";
import { getAllSkills } from "./skills";
import { readDeckFile, userDeckDir } from "./deck";
import { getSettings, resolveCredential } from "./llmSettings";
import { getAgent } from "./agents";
import { claudeEnvForCredential, validModel } from "./llm";
import { openAIChatStream, type OpenAIChatMessage } from "./openai";
import { codexExecStream } from "./codex";
import { ensureProtocolsMcpToken, protocolsMcpArgs } from "./protocolsMcp";
import { handleEvent } from "./claudeStream";
import {
  CLAUDE_NOT_FOUND,
  buildClaudeArgs,
  isMissingClaude,
  spawnClaudeStream,
  type ClaudeChild,
} from "./claudeRunner";
import type { Provider } from "@labee/contracts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface EditPayload {
  fullMessage: string;
  selection: string;
  instruction: string;
}
export interface ChatRequest {
  mode?: "chat" | "edit";
  messages?: ChatMessage[];
  skillSlugs: string[];
  contextFiles?: string[];
  artifactNotes?: Record<string, string>;
  edit?: EditPayload;
  provider?: Provider;
  model?: string;
  agentId?: string;
  runMode?: "chat" | "plan" | "build";
  fullAccess?: boolean;
  /** Enabled MCP server ids for this turn. Omitted → all available (back-compat). */
  mcpServers?: string[];
  /** The user is on a phone speaking/listening: ask for a spoken-summary-first reply. */
  voice?: boolean;
  /** Per-turn reasoning effort override (claude engine). */
  effort?: "low" | "medium" | "high";
}

const CONTEXT_FILE_MAX_BYTES = 200 * 1024;
const CONTEXT_TOTAL_MAX_BYTES = 1_000_000;
const TEXT_CONTEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml",
  ".xml", ".html", ".htm", ".log", ".toml", ".ini", ".conf", ".sh", ".bash",
  ".zsh", ".py", ".js", ".jsx", ".ts", ".tsx", ".sql", ".r", ".go", ".rs",
  ".rb", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp", ".css",
]);

interface LoadedContextFile {
  name: string;
  text: string;
}
interface ContextLoadReport {
  loaded: LoadedContextFile[];
  skipped: { name: string; reason: string }[];
}

async function loadContextFiles(email: string, paths: string[]): Promise<ContextLoadReport> {
  const loaded: LoadedContextFile[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let total = 0;
  for (const raw of paths) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    const ext = path.extname(name).toLowerCase();
    if (!TEXT_CONTEXT_EXTENSIONS.has(ext)) {
      skipped.push({
        name,
        reason: `${ext || "(no extension)"} is not a recognised text format for context injection.`,
      });
      continue;
    }
    try {
      const { data, size } = await readDeckFile(email, name);
      if (size > CONTEXT_FILE_MAX_BYTES) {
        skipped.push({
          name,
          reason: `File is ${(size / 1024).toFixed(1)} KB — exceeds per-file ${CONTEXT_FILE_MAX_BYTES / 1024} KB limit.`,
        });
        continue;
      }
      if (total + size > CONTEXT_TOTAL_MAX_BYTES) {
        skipped.push({
          name,
          reason: `Adding this file would exceed the ${CONTEXT_TOTAL_MAX_BYTES / 1024} KB total context budget.`,
        });
        continue;
      }
      total += size;
      loaded.push({ name, text: data.toString("utf8") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Read failed.";
      skipped.push({ name, reason: msg });
    }
  }
  return { loaded, skipped };
}

function buildContextAddendum(report: ContextLoadReport): string {
  if (report.loaded.length === 0 && report.skipped.length === 0) return "";
  const blocks = report.loaded.map(
    (f) =>
      `===CONTEXT FILE: ${f.name}===\n${f.text.replace(/\s+$/, "")}\n===END CONTEXT FILE: ${f.name}===`,
  );
  let intro = "";
  if (report.loaded.length > 0) {
    intro =
      "\n\nThe user attached the following file" +
      (report.loaded.length === 1 ? "" : "s") +
      " from their working directory as additional context for this turn. " +
      "Treat them as authoritative reference for the user's data — read them carefully when they bear on the question. " +
      "Each file is delimited by ===CONTEXT FILE=== markers.\n\n";
  }
  let trail = "";
  if (report.skipped.length > 0) {
    const lines = report.skipped.map((s) => `- ${s.name}: ${s.reason}`);
    trail =
      "\n\nThe following selected files could not be loaded as context — surface this to the user if it matters:\n" +
      lines.join("\n");
  }
  return intro + blocks.join("\n\n") + trail;
}

const SYSTEM_PROMPT =
  "You are a chat assistant inside the Labee skills catalog. " +
  "You have access to the full Claude Code toolset (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Skill, AskUserQuestion). " +
  "A protocol-search tool `mcp__protocols__search` (from the `protocols` MCP server) is also available: it searches laboratory-protocol journals and reagent vendors " +
  "(STAR Protocols, Nature Protocols, JoVE, Bio-protocol, Current Protocols, protocols.io, Thermo Fisher, QIAGEN, NEB, Bio-Rad, Sigma-Aldrich, EMD Millipore, Takara Bio, Promega, IDT) plus the REBASE restriction-enzyme database, and returns ranked results each with a stable `id` and a `fetchable` flag. " +
  "Use it for any protocol/reagent/enzyme lookup — prefer it over WebFetch/WebSearch for those sources, which bot-block direct fetches. " +
  "Then call `mcp__protocols__fetch` with a result's `id` to read its content: `rebase:<enzyme>` returns restriction-enzyme facts (recognition site, cut, methylation, isoschizomers, whether NEB supplies it) from REBASE — use it for NEB enzyme questions rather than fetching neb.com; `doi:`/`pmid:`/`pmcid:` returns the open-access full text of a protocol/methods article; a `url:` vendor page is bot-blocked, so open its link instead. `mcp__protocols__list_sources` lists everything searchable. " +
  "Your current working directory IS the user's persistent file deck. Anything you write here (and in subdirectories) is saved across sessions and shows up in their Working Directory panel. " +
  "Files the user has uploaded for you live alongside your outputs in this directory — read them by name, no need to navigate into a subfolder. " +
  "Prefer top-level filenames for outputs the user will care about (the panel only surfaces top-level files); use subdirectories only for transient working state. " +
  "Skill scaffolding lives in the hidden `.claude/` folder — leave it alone. " +
  "User-level Anthropic skills (docx, xlsx, pptx, pdf, canvas-design, algorithmic-art, etc.) are available — invoke them via the Skill tool when they match the user's request. " +
  "When the user asks you to produce a file (Word doc, spreadsheet, PDF, chart), DO produce it — don't claim you can't. " +
  "Whenever you need the user to choose, confirm, or decide between options, you MUST ask via the AskUserQuestion tool — NEVER in prose. If you catch yourself about to write a question with options, a numbered/bulleted list of choices, or phrases like 'a few options', 'let me know which', 'which would you prefer', 'should I X or Y', or 'confirm at build time', STOP and emit an AskUserQuestion call with those options instead. Plain-text questions are dead ends in this UI: they have no buttons and the user can't answer them cleanly. The CLI reports a tool error for AskUserQuestion — that error is EXPECTED and BENIGN: the Labee UI surfaces your questions as interactive cards in the chat, and the user's picks come back as a normal follow-up user message. So after you emit an AskUserQuestion call, STOP and end your turn immediately: do NOT answer your own questions, do NOT say the interactive card 'wasn't available', and do NOT proceed with assumed defaults. Just ask and wait — the user's answers arrive next turn, and you continue from there. Don't ask when a single reasonable assumption gets you 90% of the way there; only ask when picking the wrong fork would mean substantial rework — but when you do ask, always use the tool. " +
  "Be concise in chat responses. Use markdown when it aids clarity.";

const OPENAI_SYSTEM_PROMPT =
  "You are a helpful chat assistant inside the Labee skills catalog. " +
  "You are running as a plain chat model: you do NOT have Bash, file, web, or skill tools in this mode, so do not claim to run commands, read/write files, or produce downloadable documents — answer directly with text and markdown instead. " +
  "If the user attached files as context this turn, their contents are inlined below between ===CONTEXT FILE=== markers; treat them as authoritative reference. " +
  "Be concise. Use markdown when it aids clarity.";

const EDIT_SYSTEM_PROMPT =
  "You are a passage-rewriting engine. The user has selected a passage from a longer message and wants only that passage rewritten per their instruction. " +
  "Return ONLY the rewritten passage. No preamble, no explanation, no quotation marks, no markdown fences. " +
  "Preserve the original passage's markdown style (bold, lists, links, tables, code blocks). " +
  "Do not return anything outside the rewritten passage. Do not repeat the surrounding context.";

interface LinkedProtocol {
  protocol: Skill;
  relPath: string;
}

function buildProtocolAddendum(linked: LinkedProtocol[]): string {
  if (linked.length === 0) return "";
  const lines = linked.map(({ protocol, relPath }, i) => {
    const idx = i + 1;
    const desc = protocol.description ? ` — ${protocol.description}` : "";
    return `${idx}. **${protocol.name}**${desc}\n   File: \`${relPath}\``;
  });
  return (
    "\n\nThe user has activated the following laboratory protocol" +
    (linked.length === 1 ? "" : "s") +
    " for this session:\n\n" +
    lines.join("\n") +
    "\n\n" +
    "These are reference documents the user expects you to follow as authoritative procedure. " +
    "Their bodies are NOT inlined into this prompt — read each file with the Read tool when its content is relevant to the user's question, " +
    "or when the question depends on its specific steps, reagents, quantities, or quality checkpoints. " +
    "Cite sections by header when helpful. Flag any deviation between what the user is doing and the protocol they have active. " +
    "Do NOT treat protocols as callable Claude Code skills — they are passive reference text accessed via Read.\n"
  );
}

/** Tell the agent about reference-protocol folders it can read from disk. */
function buildReferenceFoldersAddendum(folders: readonly string[]): string {
  if (folders.length === 0) return "";
  const lines = folders.map((f, i) => `${i + 1}. \`${f}\``);
  return (
    "\n\nThe user has attached the following folder" +
    (folders.length === 1 ? "" : "s") +
    " of reference protocols for this agent. Treat their contents as authoritative reference procedure. " +
    "Use the Read/Glob/Grep tools on these absolute paths to consult the relevant files when the task depends on them:\n\n" +
    lines.join("\n") +
    "\n"
  );
}

function buildEditPrompt(edit: EditPayload): string {
  return [
    "FULL MESSAGE (for context only — do NOT rewrite this, only the selected passage below):",
    "----- BEGIN FULL MESSAGE -----",
    edit.fullMessage,
    "----- END FULL MESSAGE -----",
    "",
    "SELECTED PASSAGE (this is what you must rewrite):",
    "----- BEGIN SELECTION -----",
    edit.selection,
    "----- END SELECTION -----",
    "",
    `INSTRUCTION: ${edit.instruction}`,
    "",
    "Output the rewritten passage below, with no other text.",
  ].join("\n");
}

function buildUserPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0]!.content;
  const prior = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const transcript = prior
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");
  return (
    `Prior conversation so far:\n\n${transcript}\n\n` +
    `---\n\nNew user turn — respond to this:\n\n${last.content}`
  );
}

function sanitizeSkillDirName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "skill";
}

async function materializeArtifactWithOverride(
  dst: string,
  skill: Skill,
  customBody: string,
): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const sourceSkillMd = path.join(skill.sourcePath, "SKILL.md");
  let raw = "";
  try {
    raw = await fs.readFile(sourceSkillMd, "utf8");
  } catch {
    // bare body fallback
  }
  const parsed = raw ? matter(raw) : { data: {}, content: "" };
  const written = matter.stringify(
    customBody.replace(/\s+$/, "") + "\n",
    parsed.data as Record<string, unknown>,
  );
  await fs.writeFile(path.join(dst, "SKILL.md"), written, "utf8");
  try {
    const entries = await fs.readdir(skill.sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "SKILL.md") continue;
      const src = path.join(skill.sourcePath, entry.name);
      const target = path.join(dst, entry.name);
      try {
        await fs.symlink(src, target, entry.isDirectory() ? "dir" : "file");
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

async function linkSelectedSkills(
  cwd: string,
  selected: Skill[],
  notes: Record<string, string> = {},
): Promise<string[]> {
  const skillsDir = path.join(cwd, ".claude", "skills");
  await fs.rm(skillsDir, { recursive: true, force: true });
  await fs.mkdir(skillsDir, { recursive: true });
  const linkedNames: string[] = [];
  const used = new Set<string>();
  for (const skill of selected) {
    const baseName = sanitizeSkillDirName(skill.name);
    let name = baseName;
    let suffix = 2;
    while (used.has(name)) name = `${baseName}-${suffix++}`;
    used.add(name);
    const dst = path.join(skillsDir, name);
    const override = notes[skill.slug];
    try {
      if (typeof override === "string" && override.trim().length > 0) {
        await materializeArtifactWithOverride(dst, skill, override);
      } else {
        await fs.symlink(skill.sourcePath, dst, "dir");
      }
      linkedNames.push(name);
    } catch {
      // skip
    }
  }
  return linkedNames;
}

async function linkSelectedProtocols(
  cwd: string,
  selected: Skill[],
  notes: Record<string, string> = {},
): Promise<LinkedProtocol[]> {
  const protocolsDir = path.join(cwd, ".claude", "protocols");
  await fs.rm(protocolsDir, { recursive: true, force: true });
  await fs.mkdir(protocolsDir, { recursive: true });
  const linked: LinkedProtocol[] = [];
  const used = new Set<string>();
  for (const protocol of selected) {
    const baseName = sanitizeSkillDirName(protocol.name);
    let name = baseName;
    let suffix = 2;
    while (used.has(name)) name = `${baseName}-${suffix++}`;
    used.add(name);
    const dst = path.join(protocolsDir, name);
    const override = notes[protocol.slug];
    try {
      if (typeof override === "string" && override.trim().length > 0) {
        await materializeArtifactWithOverride(dst, protocol, override);
      } else {
        await fs.symlink(protocol.sourcePath, dst, "dir");
      }
      linked.push({ protocol, relPath: `.claude/protocols/${name}/SKILL.md` });
    } catch {
      // skip
    }
  }
  return linked;
}

/** Build the SSE ReadableStream that spawns the claude CLI and forwards events. */
function buildChatStream(
  cwd: string,
  args: string[],
  linkedSkillNames: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReadableStream<Uint8Array> {
  let child: ClaudeChild | undefined;
  const encoder = new TextEncoder();
  // Hoisted so cancel() (client abort) can stop further enqueues; otherwise
  // buffered stdout keeps calling send() after the controller is closed.
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller already closed (e.g. the client aborted) — stop sending.
          closed = true;
        }
      };

      // End the turn cleanly when the model asks the user a question: emit `end`,
      // then kill the CLI so it can't proceed past the (unsupported) tool call.
      const stopForQuestion = () => {
        if (closed) return;
        send("end", {});
        child?.kill();
        close();
      };

      const blockType = new Map<number, string>();
      const blockId = new Map<number, string>();
      const blockName = new Map<number, string>();
      const blockInputJson = new Map<number, string>();

      try {
        child = spawnClaudeStream(
          { cwd, args, extraEnv },
          {
            onEvent: (evt) =>
              handleEvent(evt, send, blockType, blockId, blockName, blockInputJson, stopForQuestion),
            onError: (message) => {
              send("error", { message });
              close();
            },
            onClose: (code, stderrBuf) => {
              if (code !== 0) {
                const tail = stderrBuf.trim().split("\n").slice(-5).join(" | ");
                send("error", {
                  message: `claude CLI exited with code ${code}${tail ? `: ${tail}` : ""}`,
                });
              } else {
                send("end", {});
              }
              close();
            },
          },
        );
      } catch (err) {
        const message = isMissingClaude(err)
          ? CLAUDE_NOT_FOUND
          : err instanceof Error
            ? err.message
            : "Failed to spawn claude.";
        send("error", { message });
        close();
        return;
      }

      send("skills_loaded", { linkedNames: linkedSkillNames, cwd });
    },
    cancel() {
      closed = true;
      child?.kill();
    },
  });
}


export type PreparedTurn =
  | {
      ok: true;
      makeStream: () => ReadableStream<Uint8Array>;
      cwd: string;
      linkedSkillNames: string[];
      provider: Provider;
      model: string;
      engine: "claude" | "codex" | "openai";
    }
  | {
      /** `invalid` → HTTP 400 for the caller; `unavailable` → a normal-looking
       *  stream that emits one `error` event (the UI shows it in the chat). */
      ok: false;
      kind: "invalid" | "unavailable";
      message: string;
    };

/** Resolve everything a turn needs (cwd, prompt, skills, credential, engine)
 *  and return a lazy stream factory. Never throws for user-facing problems. */
export async function prepareTurn(email: string, body: ChatRequest): Promise<PreparedTurn> {
  if (!Array.isArray(body.skillSlugs)) {
    return { ok: false, kind: "invalid", message: "`skillSlugs` must be an array of strings." };
  }

  const mode = body.mode ?? "chat";
  const runMode: "chat" | "plan" | "build" =
    mode === "edit"
      ? "build"
      : body.runMode === "build"
        ? "build"
        : body.runMode === "chat"
          ? "chat"
          : "plan";
  const readOnly = runMode === "plan" || runMode === "chat";
  const fullAccess = body.fullAccess !== false;
  const protocolsMcpOn = !Array.isArray(body.mcpServers) || body.mcpServers.includes("protocols");
  const chromeMcpOn = !Array.isArray(body.mcpServers) || body.mcpServers.includes("chrome");
  if (protocolsMcpOn) await ensureProtocolsMcpToken();

  let userPrompt: string;
  let systemPrompt = SYSTEM_PROMPT;
  const selectedSkills: Skill[] = [];
  const selectedProtocols: Skill[] = [];

  const agent =
    typeof body.agentId === "string" && body.agentId ? await getAgent(email, body.agentId) : null;
  const extraSkillDirs = agent?.workingDir ? [path.join(agent.workingDir, ".skill")] : [];
  const codexEngine = mode !== "edit" && agent?.engine === "codex";

  if (mode === "edit") {
    const edit = body.edit;
    if (
      !edit ||
      typeof edit.fullMessage !== "string" ||
      typeof edit.selection !== "string" ||
      typeof edit.instruction !== "string" ||
      !edit.selection.trim() ||
      !edit.instruction.trim()
    ) {
      return {
        ok: false,
        kind: "invalid",
        message: "edit mode requires `edit.fullMessage`, `edit.selection`, and `edit.instruction`.",
      };
    }
    userPrompt = buildEditPrompt(edit);
    systemPrompt = EDIT_SYSTEM_PROMPT;
  } else {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return { ok: false, kind: "invalid", message: "`messages` must be a non-empty array." };
    }
    userPrompt = buildUserPrompt(body.messages);
    const allSkills = getAllSkills(email, { extraSkillDirs });
    const bySlug = new Map(allSkills.map((s) => [s.slug, s]));
    for (const slug of body.skillSlugs) {
      const artifact = bySlug.get(slug);
      if (!artifact) continue;
      if (artifact.artifactKind === "protocol") selectedProtocols.push(artifact);
      else selectedSkills.push(artifact);
    }
  }

  const cwd = agent?.workingDir ? agent.workingDir : userDeckDir(email);
  const referenceFolders = agent?.referenceFolders ?? [];
  const artifactNotes = mode === "edit" || !body.artifactNotes ? {} : body.artifactNotes;

  if (agent?.workingDir) {
    const dirExists = await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false);
    if (!dirExists) {
      return {
        ok: false,
        kind: "unavailable",
        message:
          `This agent's working directory "${cwd}" doesn't exist on this machine. ` +
          `Open Agents, edit "${agent.name}", and pick a local folder — this happens after ` +
          `syncing an agent that was created elsewhere.`,
      };
    }
  }

  await fs.mkdir(cwd, { recursive: true });
  const linkedSkillNames = await linkSelectedSkills(cwd, selectedSkills, artifactNotes);
  let protocolAddendum = "";
  let contextAddendum = "";
  if (mode !== "edit") {
    const linkedProtocols = await linkSelectedProtocols(cwd, selectedProtocols, artifactNotes);
    const contextReport = await loadContextFiles(
      email,
      Array.isArray(body.contextFiles) ? body.contextFiles : [],
    );
    protocolAddendum = buildProtocolAddendum(linkedProtocols);
    contextAddendum = buildContextAddendum(contextReport);
  }

  const settings = await getSettings(email);
  const provider: Provider = body.provider ?? settings.provider;
  const model = validModel(provider, body.model ?? settings.model);
  const cred = await resolveCredential(email, provider);

  if (mode !== "edit") {
    const referenceAddendum = buildReferenceFoldersAddendum(referenceFolders);
    const agentMemoryHint = agent
      ? "\n\nThis is the working directory for the saved agent \"" +
        agent.name +
        "\". It contains `AGENTS.md` and `agent-memory.md` — an auto-generated digest of the reference protocols. " +
        "Consult `agent-memory.md` first to answer quickly; open the original reference files only when you need detail beyond the digest.\n"
      : "";
    const modeAddendum =
      runMode === "plan"
        ? "\n\n## PLAN MODE (read-only)\n" +
          "You are in plan mode. You MAY read files, search the web, and load any relevant Skill for " +
          "methodology, and you SHOULD use the AskUserQuestion tool to confirm any decisions that " +
          "materially change the plan before finalizing it. When you ask, STOP and wait for the user's " +
          "reply — never finalize a plan on assumed answers or claim the question tool was unavailable. " +
          "Then present a clear, numbered step-by-step " +
          "plan as your final message. You may NOT edit files or run shell commands — Write/Edit/Bash " +
          "are disabled. Do not claim you have built, created, or changed anything; you are only " +
          "proposing a plan. The user will switch to Build to execute it.\n"
        : runMode === "chat"
          ? "\n\n## CHAT MODE (read-only)\n" +
            "You are in chat mode: answer conversationally and help the user think. You MAY read files " +
            "and search the web, but you may NOT edit files or run shell commands (Write/Edit/Bash are " +
            "disabled). Do not claim you have changed anything. The user will switch to Build to make changes.\n"
          : "\n\n## BUILD MODE\n" +
            "You are in build mode: implement the work directly. You may read, create, and edit files " +
            "and run shell commands to complete the task. If you hit a fork that needs the user to " +
            "confirm or choose before you proceed, you MUST ask via the AskUserQuestion tool (never in " +
            "prose), then stop and wait for their pick.\n";
    const voiceAddendum = body.voice
      ? "\n\n## VOICE\n" +
        "The user is speaking and listening by voice on a phone. Begin with a one- or two-sentence " +
        "spoken summary of your answer, then give details. Keep sentences short.\n"
      : "";
    systemPrompt =
      (provider === "openai" && !codexEngine && !cred.useCodex
        ? OPENAI_SYSTEM_PROMPT + contextAddendum + referenceAddendum + agentMemoryHint
        : SYSTEM_PROMPT + protocolAddendum + contextAddendum + referenceAddendum + agentMemoryHint) +
      modeAddendum +
      voiceAddendum;
  }

  if (!codexEngine && cred.unavailable) {
    return { ok: false, kind: "unavailable", message: cred.reason ?? "No usable LLM credential." };
  }

  if (process.env.LABEE_MODE === "desktop" && !codexEngine && cred.mode === "own_api_key") {
    return {
      ok: false,
      kind: "unavailable",
      message:
        `Chatting with your own API key isn't available in the desktop app yet. Open Labee at ` +
        `labee.online in your browser, or switch this provider to "Your subscription" or ` +
        `"Labee Provided" in Settings to run it here.`,
    };
  }

  const claudePermissionMode =
    mode === "edit" || readOnly || fullAccess ? "bypassPermissions" : "default";
  const codexSandbox: "read-only" | "workspace-write" | "danger-full-access" = readOnly
    ? "read-only"
    : fullAccess
      ? "danger-full-access"
      : "workspace-write";

  const base = { cwd, linkedSkillNames, provider, model } as const;
  if (codexEngine) {
    return {
      ok: true,
      ...base,
      engine: "codex",
      makeStream: () =>
        codexExecStream({
          prompt: `${systemPrompt}\n\n----\n\n${userPrompt}`,
          cwd,
          mode: codexSandbox,
          protocolsMcp: protocolsMcpOn,
        }),
    };
  }
  if (provider === "openai" && cred.useCodex) {
    return {
      ok: true,
      ...base,
      engine: "codex",
      makeStream: () =>
        codexExecStream({
          prompt: `${systemPrompt}\n\n----\n\n${userPrompt}`,
          cwd,
          protocolsMcp: protocolsMcpOn,
          ...(cred.planLabel ? { planLabel: cred.planLabel } : {}),
        }),
    };
  }
  if (provider === "openai") {
    const oaMessages: OpenAIChatMessage[] =
      mode === "edit"
        ? [{ role: "user", content: userPrompt }]
        : (body.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
    return {
      ok: true,
      ...base,
      engine: "openai",
      makeStream: () =>
        openAIChatStream({
          apiKey: cred.apiKey!,
          model,
          system: systemPrompt,
          messages: oaMessages,
          ...(cred.proxyBaseUrl ? { baseUrl: cred.proxyBaseUrl } : {}),
        }),
    };
  }
  const args = buildClaudeArgs({
    prompt: userPrompt,
    systemPrompt,
    model,
    tools: mode === "edit" ? "" : "default",
    outputFormat: "stream-json",
    permissionMode: claudePermissionMode,
    settingSources: mode === "edit" ? "project" : "project,user",
    excludeDynamicSystemPromptSections: true,
    ...(readOnly ? { disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] } : {}),
    ...(mode === "edit" || !protocolsMcpOn ? {} : { mcpArgs: protocolsMcpArgs() }),
    chrome: mode !== "edit" && chromeMcpOn,
    effort: body.effort ?? (mode === "edit" ? "low" : "high"),
  });
  const extraEnv = claudeEnvForCredential(cred);
  return {
    ok: true,
    ...base,
    engine: "claude",
    makeStream: () => buildChatStream(cwd, args, linkedSkillNames, extraEnv),
  };
}

/** A one-shot SSE stream that emits a single `error` event then ends. */
export function singleErrorStream(message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
      controller.close();
    },
  });
}
