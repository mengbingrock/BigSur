import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT_BYTES = 32 * 1024;
// Medium effort on longer structured replies (multi-option protocols,
// multi-phase pipelines) can take 30-45 s. Cap at 60 s.
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are a structure-extraction engine that turns an
assistant's reply into a graph the user can interact with. You always
output STRICT JSON of this shape:

{
  "phases": [
    {
      "id": "p1",
      "label": "...",
      "summary": "...",
      "subPhases": [
        { "id": "p1.1", "label": "...", "summary": "..." }
      ]
    }
  ],
  "edges":  [ { "from": "p1", "to": "p2" } ],
  "choices":[ { "question": "...", "options": ["...", "..."], "multiSelect": false } ]
}

Phases are HIERARCHICAL. A top-level phase may contain 'subPhases' —
finer-grained sub-steps the user can drill into. Use sub-phases when
the assistant's reply naturally has two layers (a high-level
"Extraction -> RT -> qPCR" plus key steps inside each), but ONLY include
sub-phases when there is real structural detail; don't pad them.

Cap: top-level phases ≤ 8; subPhases per top-level ≤ 8; recursion
depth ≤ 2 (no sub-sub-phases). Each sub-phase id should nest under its
parent ("p1.1", "p1.2", etc.).

All three arrays are independent and any can be empty. Output pure JSON
— no code fences, no prose. If the reply has no structure at all, output
{"phases":[],"edges":[],"choices":[]}.

The two things you extract are FLEXIBLE concepts, not pattern-matches.
Lean toward catching when the signal is reasonable. False positives cost
the user one click to dismiss; false negatives leave them without an
affordance and feel broken.

========================================================================
PIPELINE (phases + edges)
========================================================================

A *phase* is a distinct stage of a procedure / workflow / plan the user
is expected to perform or follow. The signal that a pipeline is present
is *any* of these (any one is sufficient — don't insist on a particular
form):

  • An ordered series of stages connected by arrows, "then", "next",
    "followed by", "after that", numbering ("step 1 / step 2 / step 3"),
    or section headings ("Phase 1: …", "Stage A: …").
  • A title or intro line that names stages with separators —
    "X → Y → Z", "X / Y / Z", "X, then Y, then Z".
  • A description that lays out a clear front-to-back procedure.
  • A reply that compares several procedures that *share* the same
    high-level pipeline: extract the SHARED pipeline once.

Edges encode order. Sequential A→B emits { from:"p1", to:"p2" }. If two
phases run in parallel from the same predecessor, emit two edges from
that predecessor. If the reply names only the phases without specifying
order, emit phases but no edges.

DO emit phases when the assistant is comparing or offering several
*variants* of the same pipeline: extract the shared high-level phases
once (e.g. if four protocols all do "Extraction → RT → qPCR", emit
those three phases, then surface the four protocols as a single
multi-option choice).

Skip phases when:
  • There is no procedure — only conversation, opinions, or a single
    short instruction.
  • The only "steps" are *parameters* of one operation (e.g. "set
    temperature, set volume, press start" might still qualify as a
    pipeline — use judgement).

Cap: ≤ 8 phases. Label ≤ 30 chars (the short name of the stage).
Summary ≤ 90 chars (one sentence on what the stage does).

========================================================================
CHOICES
========================================================================

A *choice* is anywhere the assistant has made the user the decision-
maker among ≥ 2 enumerated alternatives. The signal can be:

  • A direct question: "Which X?", "Should I Y?", "Do you prefer A or B?"
  • A request phrased as an instruction: "Pick one and I'll …", "Reply
    with the option number", "Let me know which one to use", "Tell me
    which …", "Choose one to proceed".
  • A list of numbered or bulleted options ("Option 1: …", "Option 2: …")
    when the surrounding context invites the user to pick among them.
  • An offer to take an action: "Want me to run X?" → ["Yes","No"].

When the assistant LISTS options AND recommends one ("here are four
choices … I'd recommend option 2"), that is STILL a choice — the
recommendation is the assistant's hint, not its final decision. The user
is being asked to confirm or override. Emit the choice with all listed
options; do NOT skip it just because a recommendation appears.

Skip a choice only when:
  • The assistant has *unambiguously* declared a single course of action
    and is not asking the user to pick ("I've decided to use X; here's
    the protocol").
  • The mentioned options are illustrative examples in prose that the
    assistant is not asking the user to choose between.
  • The "question" is open-ended free-form with no enumerated options
    ("What else would you like?").

For options labeled "Option 1: TRIzol → …", "Option 2: RNeasy → …", the
option *label* should be a short tag readers can scan — typically the
distinguishing name or the headline of the option, not the full
description. For "Option 1: TRIzol → DNase → High-Capacity cDNA RT →
TaqMan qPCR (Gold-standard, tissue)" the label is "TRIzol + TaqMan" or
"Option 1: TRIzol + TaqMan". Keep ≤ 8 words.

multiSelect = true only when the question explicitly says "pick all
that apply", "select any combination", "which of the following apply",
etc. Default false.

A choice needs ≥ 2 options. Cap options at 12. Question ≤ 100 chars.

========================================================================
COEXISTENCE
========================================================================

Phases and choices can coexist in a single reply. A protocol-comparison
reply typically has:
  • A shared pipeline (3–5 phases) → emit those.
  • A multi-option choice for the user to pick a variant → emit that.

Output ONLY JSON.`;

function runClaude(userPrompt: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        userPrompt,
        "--system-prompt",
        SYSTEM_PROMPT,
        // Sonnet handles the hierarchical nesting better than Haiku for
        // complex protocol replies. Costs a bit more per call but pays off
        // when the reply has 3+ phases or 4+ option variants.
        "--model",
        "sonnet",
        "--tools",
        "",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--effort",
        "medium",
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

interface ParsedChoice {
  question: string;
  options: string[];
  multiSelect: boolean;
}
interface ParsedPhase {
  id: string;
  label: string;
  summary: string;
  subPhases?: ParsedPhase[];
}
interface ParsedEdge {
  from: string;
  to: string;
}
interface ParsedStructure {
  phases: ParsedPhase[];
  edges: ParsedEdge[];
  choices: ParsedChoice[];
}

function tryParseStructure(raw: string): ParsedStructure {
  const empty: ParsedStructure = { phases: [], edges: [], choices: [] };
  const trimmed = raw
    .replace(/^﻿/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!trimmed) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return empty;
      }
    } else {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const root = parsed as Record<string, unknown>;

  // --- Phases --- (recursive, capped to depth 2)
  function parsePhase(node: unknown, depth: number): ParsedPhase | null {
    if (!node || typeof node !== "object") return null;
    const r = node as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!id || !label) return null;
    const summary =
      typeof r.summary === "string" ? r.summary.trim().slice(0, 200) : "";
    const out: ParsedPhase = {
      id: id.slice(0, 64),
      label: label.slice(0, 60),
      summary,
    };
    if (depth < 2 && Array.isArray(r.subPhases)) {
      const subs: ParsedPhase[] = [];
      for (const sp of r.subPhases as unknown[]) {
        const child = parsePhase(sp, depth + 1);
        if (child) subs.push(child);
        if (subs.length >= 8) break;
      }
      if (subs.length > 0) out.subPhases = subs;
    }
    return out;
  }
  const phases: ParsedPhase[] = [];
  if (Array.isArray(root.phases)) {
    for (const p of root.phases as unknown[]) {
      const parsed = parsePhase(p, 1);
      if (parsed) phases.push(parsed);
      if (phases.length >= 8) break;
    }
  }

  // --- Edges --- (only between known phase ids)
  const phaseIds = new Set(phases.map((p) => p.id));
  const edges: ParsedEdge[] = [];
  if (Array.isArray(root.edges)) {
    for (const e of root.edges as unknown[]) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const from = typeof r.from === "string" ? r.from.trim() : "";
      const to = typeof r.to === "string" ? r.to.trim() : "";
      if (!from || !to || !phaseIds.has(from) || !phaseIds.has(to)) continue;
      if (from === to) continue;
      edges.push({ from, to });
      if (edges.length >= 16) break;
    }
  }

  // --- Choices ---
  const choices: ParsedChoice[] = [];
  if (Array.isArray(root.choices)) {
    for (const c of root.choices as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const r = c as Record<string, unknown>;
      const q = typeof r.question === "string" ? r.question.trim() : "";
      if (!q) continue;
      const opts = Array.isArray(r.options)
        ? (r.options as unknown[])
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
        : [];
      if (opts.length < 2) continue;
      choices.push({
        question: q.slice(0, 200),
        options: opts.slice(0, 12),
        multiSelect: Boolean(r.multiSelect),
      });
    }
  }

  return { phases, edges, choices };
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
  const empty = { phases: [], edges: [], choices: [] };
  if (!text) {
    return Response.json(empty);
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
      return Response.json(empty);
    }
    raw = result.stdout;
  } catch (err) {
    return Response.json(empty);
  }

  const structure = tryParseStructure(raw);
  console.log(
    `[extract-choices] in=${truncated.length}ch phases=${structure.phases.length} ` +
      `edges=${structure.edges.length} choices=${structure.choices.length} ` +
      `raw="${raw.replace(/\s+/g, " ").slice(0, 280)}"`,
  );
  return Response.json(structure);
}
