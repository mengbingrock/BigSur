import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT_BYTES = 32 * 1024;
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You are a choice-extraction engine.

INPUT: the most recent reply from a chat assistant.
TASK: identify any *user-facing* choices the assistant is asking the user to make.
OUTPUT: STRICT JSON of this exact shape — nothing else:

{ "choices": [
  { "question": "<short rephrase of what's being asked>",
    "options": ["<option label>", "<option label>", ...],
    "multiSelect": <true|false> }
] }

LEAN TOWARD CATCHING — when the assistant ends with a question mark and offers
two or more alternatives, treat that as a choice. The user benefits from a
clickable choice node much more than from a missed one. Only return empty
when you are CONFIDENT the assistant has already decided or is just listing
examples without asking.

A choice can take ANY of these forms:

  • Inline disjunction: "Coffee or tea?" → options ["Coffee", "Tea"].
  • "Would you prefer A, B, or C?" → options ["A", "B", "C"].
  • "Should I X?" / "Want me to Y?" / "Ready to Z?" → options ["Yes", "No"].
  • Numbered list after a question: "Which?\\n1. RNeasy\\n2. TRIzol" → ["RNeasy","TRIzol"].
  • Bulleted list after a question: "Pick:\\n- foo\\n- bar".
  • Question mark + listed alternatives anywhere in the reply.
  • "Do you want me to do X, or would you rather Y?" → ["X","Y"].
  • If the question is yes/no but multiple framings, still emit one choice with ["Yes","No"].

NOT a choice (return {"choices":[]} ONLY when one of these clearly applies):

  • The assistant has explicitly already decided: "We could use A, B, or C — I'm going with A."
  • Pure example listing with no question: "Some examples include X, Y, Z. Anyway, here's…"
  • Open-ended free-form ask: "What else would you like?" (no enumerated options at all).

Rules:

- A choice needs at least TWO concrete options. For yes/no questions emit ["Yes", "No"].
- multiSelect = true ONLY when the question explicitly invites picking more than one ("which of the following apply", "select all"). Default false.
- Keep each option label short (≤ 8 words). Strip leading numbers, bullets, articles, and parentheticals.
- Keep "question" under 100 chars.
- Multiple distinct choices in one reply → one entry per choice.

OUTPUT FORMAT:
- Pure JSON — no preamble, no code fences, no commentary.
- If unparseable, return { "choices": [] }.`;

function runClaude(userPrompt: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        userPrompt,
        "--system-prompt",
        SYSTEM_PROMPT,
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
    }, TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`extractor timed out after ${TIMEOUT_MS / 1000}s`));
        return;
      }
      resolve({ stdout, code: code ?? -1, stderr });
    });
  });
}

interface RawChoice {
  question?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}
interface ParsedChoice {
  question: string;
  options: string[];
  multiSelect: boolean;
}

function tryParseChoices(raw: string): ParsedChoice[] {
  const trimmed = raw
    .replace(/^﻿/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The model may have wrapped extra prose around the JSON. Try to
    // extract the first {...} block.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(arr)) return [];
  const out: ParsedChoice[] = [];
  for (const c of arr as RawChoice[]) {
    if (!c || typeof c !== "object") continue;
    const q = typeof c.question === "string" ? c.question.trim() : "";
    if (!q) continue;
    const opts = Array.isArray(c.options)
      ? (c.options as unknown[])
          .filter((o): o is string => typeof o === "string")
          .map((o) => o.trim())
          .filter((o) => o.length > 0)
      : [];
    if (opts.length < 2) continue; // a "choice" needs at least two options
    out.push({
      question: q.slice(0, 200),
      options: opts.slice(0, 12),
      multiSelect: Boolean(c.multiSelect),
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const text = (body?.text ?? "").trim();
  if (!text) {
    return Response.json({ choices: [] });
  }
  // Cap input size — we only need the assistant's last reply, not War and Peace.
  const truncated =
    Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES
      ? text.slice(0, Math.floor(MAX_TEXT_BYTES / 4))
      : text;

  let raw: string;
  try {
    const result = await runClaude(
      `Assistant's most recent reply (between BEGIN/END):\n\n` +
        `BEGIN\n${truncated}\nEND\n\n` +
        `Return the JSON now.`,
    );
    if (result.code !== 0) {
      return Response.json({ choices: [] });
    }
    raw = result.stdout;
  } catch (err) {
    return Response.json({ choices: [] });
  }

  const choices = tryParseChoices(raw);
  return Response.json({ choices });
}
