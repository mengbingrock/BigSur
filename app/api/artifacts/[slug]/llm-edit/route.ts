import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { getCurrentEmail } from "@/lib/session";
import { getSkillBySlug } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INSTRUCTION = 4000;
const REWRITE_TIMEOUT_MS = 90_000;

const SUMMARY_SENTINEL = "---END-OF-SUMMARY---";
const REWRITE_SYSTEM_PROMPT =
  "You are a markdown-rewriting engine. The user supplies a markdown document and an instruction. " +
  "Return TWO parts separated EXACTLY by the sentinel line `" +
  SUMMARY_SENTINEL +
  "` (on its own line, no leading/trailing spaces).\n" +
  "PART 1 — a plain-English summary, 1–3 short sentences, of what you changed and why. Use bullet points only if there are multiple distinct changes. No quotation marks, no markdown headings.\n" +
  "PART 2 — the full rewritten markdown body. No preamble. No quotation marks around the result. No code-fence wrappers around the whole document.\n" +
  "Preserve existing markdown structure (headings, lists, tables, code blocks, links) in PART 2 unless the instruction asks otherwise. " +
  "If the instruction is ambiguous, make a single best-effort interpretation rather than asking. " +
  "Do not invent facts the user didn't ask for. Keep the document's voice, tone, and language.";

function buildRewritePrompt(body: string, instruction: string): string {
  return [
    "INSTRUCTION:",
    instruction.trim(),
    "",
    "----- BEGIN MARKDOWN BODY -----",
    body,
    "----- END MARKDOWN BODY -----",
    "",
    "Return the rewritten markdown body below, with no other text.",
  ].join("\n");
}

interface RunResult {
  text: string;
  exitCode: number;
  stderr: string;
}

function runClaudeRewrite(
  prompt: string,
  systemPrompt: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--system-prompt",
        systemPrompt,
        "--model",
        "haiku",
        "--tools",
        "",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--effort",
        "low",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, REWRITE_TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(
          new Error(
            `LLM rewrite timed out after ${REWRITE_TIMEOUT_MS / 1000} s.`,
          ),
        );
        return;
      }
      resolve({ text: stdout, exitCode: code ?? -1, stderr });
    });
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let slug: string;
  try {
    slug = decodeURIComponent(params.slug);
  } catch {
    return Response.json({ error: "Invalid slug." }, { status: 400 });
  }

  const skill = getSkillBySlug(slug, email);
  if (!skill) {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }
  // Allow rewrite for any source kind. The endpoint only PROPOSES a new
  // body — persistence (PUT /api/skills/[slug]) is still gated to
  // user-owned artifacts. Public/plugin sources can use the proposal as a
  // session-only override (sent via /api/chat artifactNotes).

  let body: { instruction?: string };
  try {
    body = (await req.json()) as { instruction?: string };
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const instruction = (body?.instruction ?? "").trim();
  if (!instruction) {
    return Response.json({ error: "instruction is required." }, { status: 400 });
  }
  if (instruction.length > MAX_INSTRUCTION) {
    return Response.json(
      { error: `instruction must be ≤ ${MAX_INSTRUCTION} characters.` },
      { status: 400 },
    );
  }

  let result: RunResult;
  try {
    result = await runClaudeRewrite(
      buildRewritePrompt(skill.body, instruction),
      REWRITE_SYSTEM_PROMPT,
    );
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Could not run claude rewrite.";
    return Response.json({ error: msg }, { status: 500 });
  }

  if (result.exitCode !== 0) {
    return Response.json(
      {
        error: `claude exited ${result.exitCode}. ${result.stderr.trim().slice(0, 400)}`,
      },
      { status: 502 },
    );
  }

  const cleaned = result.text.replace(/^﻿/, "").replace(/\s+$/, "");
  if (!cleaned) {
    return Response.json(
      { error: "claude returned an empty rewrite." },
      { status: 502 },
    );
  }

  // Split on the summary sentinel. Tolerate optional surrounding whitespace
  // and the model occasionally including extra dashes.
  let summary = "";
  let proposed = cleaned;
  const sentinelRegex = new RegExp(
    `\\r?\\n[ \\t]*${SUMMARY_SENTINEL.replace(/-/g, "\\-")}[ \\t]*\\r?\\n`,
  );
  const m = cleaned.match(sentinelRegex);
  if (m && m.index !== undefined) {
    summary = cleaned.slice(0, m.index).trim();
    proposed = cleaned.slice(m.index + m[0].length).trim();
  }
  if (!proposed) {
    // Sentinel landed at the end with no body — treat as failure.
    return Response.json(
      { error: "claude returned a summary but no rewritten body." },
      { status: 502 },
    );
  }

  return Response.json({
    slug: skill.slug,
    current: skill.body,
    proposed,
    summary,
  });
}
