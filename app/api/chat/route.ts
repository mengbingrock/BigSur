import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getAllSkills } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";
import { userDeckDir } from "@/lib/deck";
import type { Skill } from "@/lib/types";
import {
  createWorkspace,
  touchWorkspace,
  scanProducedFiles,
  deleteWorkspace,
} from "@/lib/workspaces";

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
  "A clean temporary directory is your working directory — use it freely to run scripts, write output files (.docx, .xlsx, .pdf, images, etc.), and install packages if a skill asks you to. " +
  "Any file you write to the current working directory (or its subdirectories, excluding .claude and ./deck) will be collected after your turn and offered to the user as a download. " +
  "There is also a `./deck/` subdirectory that is the user's PERSISTENT file deck — files the user has uploaded for you to read and any output you write there shows up in their /deck page after this turn. " +
  "Read from ./deck/ when the user references files they uploaded; write outputs there if the user asks for something to be saved permanently or if a skill needs durable storage. " +
  "User-level Anthropic skills (docx, xlsx, pptx, pdf, canvas-design, algorithmic-art, etc.) are available — invoke them via the Skill tool when they match the user's request. " +
  "When the user asks you to produce a file (Word doc, spreadsheet, PDF, chart), DO produce it — don't claim you can't. " +
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
 * Mount the user's persistent file deck into the chat workspace at ./deck/.
 * The deck directory is created if missing so the symlink target always
 * exists and the model can `cd deck && ls` even on first session.
 */
async function linkDeck(workspaceDir: string, email: string): Promise<string | null> {
  const deck = userDeckDir(email);
  try {
    await fs.mkdir(deck, { recursive: true });
    const linkPath = path.join(workspaceDir, "deck");
    // realpathSync — resolve any symlink target so the model writes through to
    // the actual deck dir.
    const real = fsSync.realpathSync(deck);
    await fs.symlink(real, linkPath, "dir");
    return real;
  } catch {
    return null;
  }
}

async function linkSelectedSkills(
  workspaceDir: string,
  selected: Skill[],
): Promise<string[]> {
  const skillsDir = path.join(workspaceDir, ".claude", "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  const linkedNames: string[] = [];
  const used = new Set<string>();

  for (const skill of selected) {
    let baseName = sanitizeSkillDirName(skill.name);
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
  // so we only expose their personal skills to the spawned subprocess.
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

  const workspace = await createWorkspace();
  const linkedSkillNames = await linkSelectedSkills(workspace.dir, selectedSkills);
  // Mount the user's persistent deck at <workspace>/deck so skills can read
  // their uploads and write outputs that survive the session.
  await linkDeck(workspace.dir, email);
  const streamStartedAt = Date.now();

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
      cwd: workspace.dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    await deleteWorkspace(workspace.id);
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
        workspaceId: workspace.id,
        cwd: workspace.dir,
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

      proc.on("error", async (err) => {
        send("error", { message: err.message });
        await deleteWorkspace(workspace.id);
        close();
      });

      proc.on("close", async (code) => {
        if (code !== 0) {
          const tail = stderrBuf.trim().split("\n").slice(-5).join(" | ");
          send("error", {
            message: `claude CLI exited with code ${code}${tail ? `: ${tail}` : ""}`,
          });
          // Don't retain workspace on failure — nothing to download.
          await deleteWorkspace(workspace.id);
        } else {
          // Successful turn — scan for produced files and keep the workspace
          // alive so the user can download them.
          try {
            const files = await scanProducedFiles(workspace.dir, streamStartedAt);
            if (files.length > 0) {
              send("files_produced", {
                workspaceId: workspace.id,
                files,
              });
              touchWorkspace(workspace.id, workspace.dir);
            } else {
              await deleteWorkspace(workspace.id);
            }
          } catch {
            await deleteWorkspace(workspace.id);
          }
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
      void deleteWorkspace(workspace.id);
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
        send("delta", { text: delta.text });
      } else if (dt === "thinking_delta" && typeof delta.thinking === "string") {
        send("thinking_delta", { text: delta.thinking });
      } else if (
        dt === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const prev = blockInputJson.get(index) ?? "";
        blockInputJson.set(index, prev + delta.partial_json);
        send("tool_input_delta", {
          id: blockId.get(index),
          partial_json: delta.partial_json,
        });
      }
      return;
    }

    if (innerType === "content_block_stop") {
      const index = inner.index as number;
      const bt = blockType.get(index);
      if (bt === "thinking") {
        send("thinking_stop", { index });
      } else if (bt === "tool_use") {
        const raw = blockInputJson.get(index) ?? "";
        let input: unknown = null;
        try {
          input = raw ? JSON.parse(raw) : null;
        } catch {
          input = { _raw: raw };
        }
        send("tool_stop", {
          index,
          id: blockId.get(index),
          name: blockName.get(index),
          input,
        });
      } else if (bt === "text") {
        send("text_stop", { index });
      }
      return;
    }

    if (innerType === "message_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      const usage = inner.usage;
      send("message_delta", {
        stop_reason: delta?.stop_reason,
        usage,
      });
      return;
    }

    if (innerType === "message_stop") {
      send("message_stop", {});
      return;
    }
    return;
  }

  if (type === "user") {
    const message = (evt as { message?: { content?: unknown[] } }).message;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "tool_result"
      ) {
        const b = block as Record<string, unknown>;
        send("tool_result", {
          tool_use_id: b.tool_use_id,
          is_error: b.is_error ?? false,
          content: b.content,
        });
      }
    }
    return;
  }

  if (type === "rate_limit_event") {
    send("rate_limit", evt.rate_limit_info);
    return;
  }

  if (type === "result") {
    send("result", {
      is_error: evt.is_error,
      duration_ms: evt.duration_ms,
      duration_api_ms: evt.duration_api_ms,
      num_turns: evt.num_turns,
      total_cost_usd: evt.total_cost_usd,
      usage: evt.usage,
      model_usage: evt.modelUsage,
      stop_reason: evt.stop_reason,
      permission_denials: evt.permission_denials,
    });
    if (evt.is_error) {
      const msg =
        typeof evt.result === "string"
          ? evt.result
          : "Claude CLI returned an error.";
      send("error", { message: msg });
    }
    return;
  }
}
