import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Skill } from "@labee/contracts";
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { bodyJson, error, sessionUser } from "../httpKit";
import { getAllSkills } from "../services/skills";
import { readDeckFile, userDeckDir } from "../services/deck";
import { getSettings, resolveCredential } from "../services/llmSettings";
import { getAgent } from "../services/agents";
import { claudeEnvForCredential, validModel } from "../services/llm";
import { openAIChatStream, type OpenAIChatMessage } from "../services/openai";
import { codexExecStream } from "../services/codex";
import { protocolsMcpArgs } from "../services/protocolsMcp";
import type { Provider } from "@labee/contracts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
interface EditPayload {
  fullMessage: string;
  selection: string;
  instruction: string;
}
interface ChatRequest {
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
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

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
  "A protocol-search tool named exactly `mcp__protocols__search_protocols` is also available (load it via ToolSearch with `select:mcp__protocols__search_protocols` if it isn't already loaded): it searches laboratory-protocol journals and reagent vendors " +
  "(STAR Protocols, Nature Protocols, JoVE, Bio-protocol, Current Protocols, protocols.io, Thermo Fisher, QIAGEN, NEB, Bio-Rad, Sigma-Aldrich, EMD Millipore, Takara Bio, Promega, IDT) and returns ranked links per source. " +
  "Prefer it over WebFetch/WebSearch for those sources — they bot-block direct fetches. " +
  "Your current working directory IS the user's persistent file deck. Anything you write here (and in subdirectories) is saved across sessions and shows up in their Working Directory panel. " +
  "Files the user has uploaded for you live alongside your outputs in this directory — read them by name, no need to navigate into a subfolder. " +
  "Prefer top-level filenames for outputs the user will care about (the panel only surfaces top-level files); use subdirectories only for transient working state. " +
  "Skill scaffolding lives in the hidden `.claude/` folder — leave it alone. " +
  "User-level Anthropic skills (docx, xlsx, pptx, pdf, canvas-design, algorithmic-art, etc.) are available — invoke them via the Skill tool when they match the user's request. " +
  "When the user asks you to produce a file (Word doc, spreadsheet, PDF, chart), DO produce it — don't claim you can't. " +
  "You may use the AskUserQuestion tool when the user's request has a few clearly distinct interpretations and disambiguating up front would change your approach. The CLI will report a tool error, but the Labee UI surfaces your questions as interactive cards in the chat, and the user's picks come back as a normal follow-up user message — so go ahead and ask, then continue from those answers when they arrive in the next turn. Don't ask if a single reasonable assumption gets you 90% of the way there; only ask when picking the wrong fork would mean substantial rework. " +
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

const CLAUDE_NOT_FOUND =
  "Claude Code isn't installed (or wasn't found on your PATH). Install it with " +
  "`npm i -g @anthropic-ai/claude-code`, then restart the app. To use OpenAI " +
  "Codex instead, set the agent's engine to Codex.";

/** True when a spawn failure means the claude binary couldn't be found. */
function isMissingClaude(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Build the SSE ReadableStream that spawns the claude CLI and forwards events. */
function buildChatStream(
  cwd: string,
  args: string[],
  linkedSkillNames: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReadableStream<Uint8Array> {
  let proc: ChildProcessByStdio<null, Readable, Readable>;
  const encoder = new TextEncoder();
  let stderrBuf = "";
  // Hoisted so cancel() (client abort) can stop further enqueues; otherwise
  // buffered stdout keeps calling send() after the controller is closed.
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        proc = spawn(CLAUDE_BIN, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...extraEnv },
        });
      } catch (err) {
        const message = isMissingClaude(err)
          ? CLAUDE_NOT_FOUND
          : err instanceof Error
            ? err.message
            : "Failed to spawn claude.";
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`),
        );
        controller.close();
        return;
      }

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

      send("skills_loaded", { linkedNames: linkedSkillNames, cwd });

      const blockType = new Map<number, string>();
      const blockId = new Map<number, string>();
      const blockName = new Map<number, string>();
      const blockInputJson = new Map<number, string>();
      let buffer = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(evt, send, blockType, blockId, blockName, blockInputJson);
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      });

      proc.on("error", (err) => {
        send("error", { message: isMissingClaude(err) ? CLAUDE_NOT_FOUND : err.message });
        close();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          const tail = stderrBuf.trim().split("\n").slice(-5).join(" | ");
          send("error", {
            message: `claude CLI exited with code ${code}${tail ? `: ${tail}` : ""}`,
          });
        } else {
          send("end", {});
        }
        close();
      });
    },
    cancel() {
      closed = true;
      try {
        proc?.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
  });
}

export const chatRoute = HttpRouter.add(
  "POST",
  "/api/chat",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const email = user.email;

    const body = yield* bodyJson<ChatRequest>().pipe(
      Effect.catch(() => Effect.succeed(null as ChatRequest | null)),
    );
    if (!body) return yield* error("Invalid JSON body.", 400);
    if (!Array.isArray(body.skillSlugs)) {
      return yield* error("`skillSlugs` must be an array of strings.", 400);
    }

    const mode = body.mode ?? "chat";
    // Operating mode from the composer (Plan / Build / Chat). Edit is a tightly
    // scoped rewrite and always builds. Plan and Chat are read-only (no file
    // edits or commands); Plan also asks for a step-by-step plan. The user
    // switches to Build to execute.
    const runMode: "chat" | "plan" | "build" =
      mode === "edit"
        ? "build"
        : body.runMode === "build"
          ? "build"
          : body.runMode === "chat"
            ? "chat"
            : "plan"; // default to Plan for normal chat turns
    const readOnly = runMode === "plan" || runMode === "chat";
    const fullAccess = body.fullAccess !== false; // default: full access
    let userPrompt: string;
    let systemPrompt = SYSTEM_PROMPT;
    const selectedSkills: Skill[] = [];
    const selectedProtocols: Skill[] = [];

    // When an agent is active, run inside its working directory, expose its
    // reference folders, and source skills from its `.skill` folder too.
    const agent =
      typeof body.agentId === "string" && body.agentId
        ? yield* Effect.promise(() => getAgent(email, body.agentId!))
        : null;
    const extraSkillDirs = agent?.workingDir ? [path.join(agent.workingDir, ".skill")] : [];
    // The agent preset can pin a local engine. "codex" runs the user's codex CLI
    // (its own auth, agentic + workspace-write); otherwise we use the claude path.
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
        return yield* error(
          "edit mode requires `edit.fullMessage`, `edit.selection`, and `edit.instruction`.",
          400,
        );
      }
      userPrompt = buildEditPrompt(edit);
      systemPrompt = EDIT_SYSTEM_PROMPT;
    } else {
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return yield* error("`messages` must be a non-empty array.", 400);
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

    const built = yield* Effect.promise(async () => {
      await fs.mkdir(cwd, { recursive: true });
      const names = await linkSelectedSkills(cwd, selectedSkills, artifactNotes);
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
      return { names, protocolAddendum, contextAddendum };
    });
    const linkedSkillNames = built.names;

    // Resolve which provider/model + credential to run this turn with: an
    // explicit per-request override wins, else the user's saved settings.
    const { provider, model, cred } = yield* Effect.promise(async () => {
      const settings = await getSettings(email);
      const prov: Provider = body.provider ?? settings.provider;
      const mdl = validModel(prov, body.model ?? settings.model);
      const credential = await resolveCredential(email, prov);
      return { provider: prov, model: mdl, cred: credential };
    });

    // Provider-specific system prompt. The agentic runtimes (claude, and the
    // codex CLI — whether a pinned codex agent or a ChatGPT subscription) get the
    // full tool-aware prompt incl. the protocol-search MCP. Only the plain OpenAI
    // HTTP chat (own API key, no codex) gets the non-agentic "no tools" prompt,
    // still receiving inlined context-file content.
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
            "materially change the plan before finalizing it. Then present a clear, numbered step-by-step " +
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
              "and run shell commands to complete the task.\n";
      systemPrompt =
        (provider === "openai" && !codexEngine && !cred.useCodex
          ? OPENAI_SYSTEM_PROMPT + built.contextAddendum + referenceAddendum + agentMemoryHint
          : SYSTEM_PROMPT +
            built.protocolAddendum +
            built.contextAddendum +
            referenceAddendum +
            agentMemoryHint) + modeAddendum;
    }

    // The codex engine uses codex's own local auth, so it doesn't need an
    // Anthropic/OpenAI credential configured.
    if (!codexEngine && cred.unavailable) {
      return HttpServerResponse.stream(
        Stream.fromReadableStream({
          evaluate: () => singleErrorStream(cred.reason ?? "No usable LLM credential."),
          onError: (cause) => cause,
        }),
        { contentType: "text/event-stream; charset=utf-8" },
      );
    }

    // Plan mode is a SOFT read-only: we keep tools un-gated (bypassPermissions)
    // so the agent can still load Skills, call AskUserQuestion, and research —
    // and instead block only the mutating tools via --disallowedTools below.
    // Claude's hard `--permission-mode plan` would gate Skill + AskUserQuestion,
    // which is exactly what we don't want during protocol planning.
    const claudePermissionMode =
      mode === "edit" || readOnly || fullAccess ? "bypassPermissions" : "default";
    const codexSandbox: "read-only" | "workspace-write" | "danger-full-access" = readOnly
      ? "read-only"
      : fullAccess
        ? "danger-full-access"
        : "workspace-write";

    let makeStream: () => ReadableStream<Uint8Array>;
    if (codexEngine) {
      // Local codex agent: sandbox per the composer's plan / full-access toggles.
      makeStream = () =>
        codexExecStream({
          prompt: `${systemPrompt}\n\n----\n\n${userPrompt}`,
          cwd,
          mode: codexSandbox,
        });
    } else if (provider === "openai" && cred.useCodex) {
      // ChatGPT subscription → run through the codex CLI (agentic, read-only).
      makeStream = () =>
        codexExecStream({
          prompt: `${systemPrompt}\n\n----\n\n${userPrompt}`,
          cwd,
          ...(cred.planLabel ? { planLabel: cred.planLabel } : {}),
        });
    } else if (provider === "openai") {
      const oaMessages: OpenAIChatMessage[] =
        mode === "edit"
          ? [{ role: "user", content: userPrompt }]
          : (body.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
      makeStream = () =>
        openAIChatStream({ apiKey: cred.apiKey!, model, system: systemPrompt, messages: oaMessages });
    } else {
      const args = [
        "-p", userPrompt,
        "--system-prompt", systemPrompt,
        "--model", model,
        "--tools", mode === "edit" ? "" : "default",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode", claudePermissionMode,
        "--no-session-persistence",
        "--setting-sources", mode === "edit" ? "project" : "project,user",
        "--exclude-dynamic-system-prompt-sections",
        // Plan / Chat are read-only: keep Skill / AskUserQuestion / Read /
        // WebSearch available, but remove tools that change things or run commands.
        ...(readOnly
          ? ["--disallowedTools", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]
          : []),
        // Register the protocol-search MCP server (no-op when it isn't built).
        // Skipped for edit mode, which runs with no tools.
        ...(mode === "edit" ? [] : protocolsMcpArgs()),
        "--effort", mode === "edit" ? "low" : "high",
      ];
      const extraEnv = claudeEnvForCredential(cred);
      makeStream = () => buildChatStream(cwd, args, linkedSkillNames, extraEnv);
    }

    const sse = Stream.fromReadableStream({
      evaluate: makeStream,
      onError: (cause) => cause,
    });

    return HttpServerResponse.stream(sse, {
      contentType: "text/event-stream; charset=utf-8",
      headers: {
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }),
);

/** A one-shot SSE stream that emits a single `error` event then ends. */
function singleErrorStream(message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
      controller.close();
    },
  });
}

function handleEvent(
  evt: Record<string, unknown>,
  send: (event: string, data: unknown) => void,
  blockType: Map<number, string>,
  blockId: Map<number, string>,
  blockName: Map<number, string>,
  blockInputJson: Map<number, string>,
) {
  const type = evt.type;

  if (type === "system") {
    const sub = evt.subtype;
    if (sub === "init") {
      send("init", {
        model: evt.model,
        session_id: evt.session_id,
        cwd: evt.cwd,
        permission_mode: evt.permissionMode,
        api_key_source: evt.apiKeySource,
        claude_code_version: evt.claude_code_version,
        tools: evt.tools,
        skills: evt.skills,
        slash_commands: evt.slash_commands,
      });
    } else if (sub === "status") {
      send("status", { status: evt.status });
    }
    return;
  }

  if (type === "stream_event") {
    const inner = (evt as { event?: Record<string, unknown> }).event;
    if (!inner || typeof inner !== "object") return;
    const innerType = inner.type;

    if (innerType === "message_start") {
      const msg = inner.message as { id?: string } | undefined;
      send("message_start", { id: msg?.id });
      return;
    }
    if (innerType === "content_block_start") {
      const index = inner.index as number;
      const block = inner.content_block as Record<string, unknown> | undefined;
      if (!block) return;
      const bt = block.type as string;
      blockType.set(index, bt);
      if (bt === "thinking") {
        send("thinking_start", { index });
      } else if (bt === "tool_use") {
        const id = block.id as string;
        const name = block.name as string;
        blockId.set(index, id);
        blockName.set(index, name);
        blockInputJson.set(index, "");
        send("tool_start", { index, id, name });
      } else if (bt === "text") {
        send("text_start", { index });
      }
      return;
    }
    if (innerType === "content_block_delta") {
      const index = inner.index as number;
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      const dt = delta.type;
      if (dt === "text_delta" && typeof delta.text === "string") {
        send("delta", { index, text: delta.text });
      } else if (dt === "thinking_delta" && typeof delta.thinking === "string") {
        send("thinking_delta", { index, text: delta.thinking });
      } else if (dt === "input_json_delta" && typeof delta.partial_json === "string") {
        const prev = blockInputJson.get(index) ?? "";
        blockInputJson.set(index, prev + delta.partial_json);
        send("tool_input_delta", { index, partial_json: delta.partial_json });
      }
      return;
    }
    if (innerType === "content_block_stop") {
      const index = inner.index as number;
      const bt = blockType.get(index);
      if (bt === "thinking") {
        send("thinking_stop", { index });
      } else if (bt === "tool_use") {
        const id = blockId.get(index);
        const name = blockName.get(index);
        const inputRaw = blockInputJson.get(index) ?? "";
        let parsedInput: unknown = null;
        try {
          parsedInput = inputRaw ? JSON.parse(inputRaw) : {};
        } catch {
          parsedInput = inputRaw;
        }
        send("tool_stop", { index, id, name, input: parsedInput, inputRaw });
      } else if (bt === "text") {
        send("text_stop", { index });
      }
      return;
    }
    if (innerType === "message_delta") {
      const usage = (inner as { usage?: unknown }).usage;
      const stopReason = (inner.delta as Record<string, unknown> | undefined)?.stop_reason;
      send("message_delta", { stop_reason: stopReason, usage });
      return;
    }
    if (innerType === "message_stop") {
      send("message_stop", {});
      return;
    }
    return;
  }

  if (type === "user") {
    const message = evt.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const item of content as Record<string, unknown>[]) {
      if (item.type !== "tool_result") continue;
      send("tool_result", {
        id: item.tool_use_id,
        is_error: Boolean(item.is_error),
        content: item.content,
      });
    }
    return;
  }

  if (type === "result") {
    send("result", {
      subtype: evt.subtype,
      duration_ms: evt.duration_ms,
      duration_api_ms: evt.duration_api_ms,
      total_cost_usd: evt.total_cost_usd,
      num_turns: evt.num_turns,
      usage: evt.usage,
      permission_denials: evt.permission_denials,
      is_error: evt.is_error,
      result: evt.result,
    });
    return;
  }
}
