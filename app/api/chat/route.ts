import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { getAllSkills } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";
import { userDeckDir } from "@/lib/deck";
import type { Skill } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  edit?: EditPayload;
}

const SYSTEM_PROMPT =
  "You are a chat assistant inside the Monterey skills catalog. " +
  "You have access to the full Claude Code toolset (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Skill). " +
  "Your current working directory IS the user's persistent file deck. Anything you write here (and in subdirectories) is saved across sessions and shows up in their Working Directory panel. " +
  "Files the user has uploaded for you live alongside your outputs in this directory — read them by name, no need to navigate into a subfolder. " +
  "Prefer top-level filenames for outputs the user will care about (the panel only surfaces top-level files); use subdirectories only for transient working state. " +
  "Skill scaffolding lives in the hidden `.claude/` folder — leave it alone. " +
  "User-level Anthropic skills (docx, xlsx, pptx, pdf, canvas-design, algorithmic-art, etc.) are available — invoke them via the Skill tool when they match the user's request. " +
  "When the user asks you to produce a file (Word doc, spreadsheet, PDF, chart), DO produce it — don't claim you can't. " +
  "You may use the AskUserQuestion tool when the user's request has a few clearly distinct interpretations and disambiguating up front would change your approach. The CLI will report a tool error, but the Monterey UI surfaces your questions as interactive cards in the chat, and the user's picks come back as a normal follow-up user message — so go ahead and ask, then continue from those answers when they arrive in the next turn. Don't ask if a single reasonable assumption gets you 90% of the way there; only ask when picking the wrong fork would mean substantial rework. " +
  "Be concise in chat responses. Use markdown when it aids clarity.";

const EDIT_SYSTEM_PROMPT =
  "You are a passage-rewriting engine. The user has selected a passage from a longer message and wants only that passage rewritten per their instruction. " +
  "Return ONLY the rewritten passage. No preamble, no explanation, no quotation marks, no markdown fences. " +
  "Preserve the original passage's markdown style (bold, lists, links, tables, code blocks). " +
  "Do not return anything outside the rewritten passage. Do not repeat the surrounding context.";

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
  if (messages.length === 1) return messages[0].content;

  const prior = messages.slice(0, -1);
  const last = messages[messages.length - 1];
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

/**
 * Wire `<deck>/.claude/skills/<name>` symlinks for the skills the user
 * selected this turn. The `.claude/skills/` directory is wiped and
 * recreated each call so a previous turn's skills don't leak in.
 */
async function linkSelectedSkills(
  cwd: string,
  selected: Skill[],
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
    while (used.has(name)) {
      name = `${baseName}-${suffix++}`;
    }
    used.add(name);

    try {
      await fs.symlink(skill.sourcePath, path.join(skillsDir, name), "dir");
      linkedNames.push(name);
    } catch {
      // symlink failed (e.g. permissions); skip this skill but keep going
    }
  }

  return linkedNames;
}

export async function POST(req: Request): Promise<Response> {
  // Middleware enforces login on /api/chat; this fetch tells us *which* user
  // so the spawned process runs in their personal deck folder.
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = body.mode ?? "chat";

  if (!Array.isArray(body.skillSlugs)) {
    return Response.json(
      { error: "`skillSlugs` must be an array of strings." },
      { status: 400 },
    );
  }

  let userPrompt: string;
  let systemPrompt: string;
  let selectedSkills: Skill[] = [];

  if (mode === "edit") {
    if (
      !body.edit ||
      typeof body.edit.fullMessage !== "string" ||
      typeof body.edit.selection !== "string" ||
      typeof body.edit.instruction !== "string" ||
      !body.edit.selection.trim() ||
      !body.edit.instruction.trim()
    ) {
      return Response.json(
        {
          error:
            "edit mode requires `edit.fullMessage`, `edit.selection`, and `edit.instruction`.",
        },
        { status: 400 },
      );
    }
    userPrompt = buildEditPrompt(body.edit);
    systemPrompt = EDIT_SYSTEM_PROMPT;
    // Skills are intentionally NOT loaded for edits — a rewrite should not trigger
    // protocol-plan / kit-finder / etc.
  } else {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json(
        { error: "`messages` must be a non-empty array." },
        { status: 400 },
      );
    }
    userPrompt = buildUserPrompt(body.messages);
    systemPrompt = SYSTEM_PROMPT;

    const allSkills = getAllSkills(email);
    const bySlug = new Map(allSkills.map((s) => [s.slug, s]));
    for (const slug of body.skillSlugs) {
      const skill = bySlug.get(slug);
      if (skill) selectedSkills.push(skill);
    }
  }

  // Working directory = user's persistent deck. Anything written here lives
  // on across chat sessions and surfaces in the Working Directory panel.
  const cwd = userDeckDir(email);
  await fs.mkdir(cwd, { recursive: true });
  const linkedSkillNames = await linkSelectedSkills(cwd, selectedSkills);

  const args = [
    "-p",
    userPrompt,
    "--system-prompt",
    systemPrompt,
    "--model",
    "opus",
    "--tools",
    mode === "edit" ? "" : "default",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--setting-sources",
    mode === "edit" ? "project" : "project,user",
    "--exclude-dynamic-system-prompt-sections",
    "--effort",
    mode === "edit" ? "low" : "high",
  ];

  let proc: ChildProcessByStdio<null, Readable, Readable>;
  try {
    proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to spawn claude.";
    return Response.json({ error: message }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let stderrBuf = "";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
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
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Announce the skills we linked so the UI can display them.
      send("skills_loaded", {
        linkedNames: linkedSkillNames,
        cwd,
      });

      const blockTypeByIndex = new Map<number, string>();
      const blockIdByIndex = new Map<number, string>();
      const blockNameByIndex = new Map<number, string>();
      const blockInputJsonByIndex = new Map<number, string>();

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
          handleEvent(
            evt,
            send,
            blockTypeByIndex,
            blockIdByIndex,
            blockNameByIndex,
            blockInputJsonByIndex,
          );
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 8192) {
          stderrBuf = stderrBuf.slice(-8192);
        }
      });

      proc.on("error", (err) => {
        send("error", { message: err.message });
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

      req.signal.addEventListener("abort", () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // process already exited
        }
      });
    },
    cancel() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
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
      } else if (
        dt === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
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
      const stopReason = (inner.delta as Record<string, unknown> | undefined)
        ?.stop_reason;
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
    // Tool results sent back to the assistant. The CLI wraps these in a
    // synthetic user message; surface them so the UI can render expandable
    // tool-result blocks under their initiating tool_use.
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
