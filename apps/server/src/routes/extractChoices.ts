import { spawn } from "node:child_process";
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MAX_TEXT_BYTES = 32 * 1024;
const TIMEOUT_MS = 150_000;

const SYSTEM_PROMPT = `You are a structure-extraction engine that turns an
assistant's reply into a graph the user can interact with. You always
output STRICT JSON of this shape:

{
  "phases": [
    { "id": "p1", "label": "...", "summary": "...", "subPhases": [ { "id": "p1.1", "label": "...", "summary": "..." } ] }
  ],
  "edges":  [ { "from": "p1", "to": "p2" } ],
  "choices":[ { "question": "...", "options": ["...", "..."], "multiSelect": false } ],
  "materials":[ { "name": "...", "alternatives": ["...", "..."], "appliesTo": ["...", "..."] } ]
}

Phases are HIERARCHICAL (subPhases, depth <= 2, <= 8 each). All arrays are
independent and any can be empty. Output pure JSON — no code fences, no prose.
A choice needs >= 2 options. Materials lead with the assistant's pick and list
2-6 interchangeable alternatives; appliesTo lists the EXACT choice-option labels
the reagent is used in (verbatim), or is empty when it applies regardless.
Output ONLY JSON.`;

function runClaude(
  userPrompt: string,
): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CLAUDE_BIN,
      [
        "-p", userPrompt,
        "--system-prompt", SYSTEM_PROMPT,
        "--model", "sonnet",
        "--tools", "",
        "--output-format", "text",
        "--no-session-persistence",
        "--permission-mode", "bypassPermissions",
        "--effort", "medium",
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
interface ParsedMaterial {
  name: string;
  alternatives: string[];
  appliesTo?: string[];
}
interface ParsedStructure {
  phases: ParsedPhase[];
  edges: ParsedEdge[];
  choices: ParsedChoice[];
  materials: ParsedMaterial[];
}

function tryParseStructure(raw: string): ParsedStructure {
  const empty: ParsedStructure = { phases: [], edges: [], choices: [], materials: [] };
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

  function parsePhase(node: unknown, depth: number): ParsedPhase | null {
    if (!node || typeof node !== "object") return null;
    const r = node as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!id || !label) return null;
    const summary = typeof r.summary === "string" ? r.summary.trim().slice(0, 200) : "";
    const out: ParsedPhase = { id: id.slice(0, 64), label: label.slice(0, 60), summary };
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
      const parsedPhase = parsePhase(p, 1);
      if (parsedPhase) phases.push(parsedPhase);
      if (phases.length >= 8) break;
    }
  }

  const phaseIds = new Set(phases.map((p) => p.id));
  const edges: ParsedEdge[] = [];
  if (Array.isArray(root.edges)) {
    for (const e of root.edges as unknown[]) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const from = typeof r.from === "string" ? r.from.trim() : "";
      const to = typeof r.to === "string" ? r.to.trim() : "";
      if (!from || !to || !phaseIds.has(from) || !phaseIds.has(to) || from === to) continue;
      edges.push({ from, to });
      if (edges.length >= 16) break;
    }
  }

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

  const materials: ParsedMaterial[] = [];
  if (Array.isArray(root.materials)) {
    for (const m of root.materials as unknown[]) {
      if (!m || typeof m !== "object") continue;
      const r = m as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name) continue;
      const rawAlts = Array.isArray(r.alternatives)
        ? (r.alternatives as unknown[])
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const seen = new Set<string>();
      const alternatives: string[] = [];
      for (const opt of [name, ...rawAlts]) {
        const key = opt.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        alternatives.push(opt.slice(0, 80));
        if (alternatives.length >= 6) break;
      }
      if (alternatives.length < 2) continue;
      let appliesTo: string[] | undefined;
      if (Array.isArray(r.appliesTo)) {
        const collected = (r.appliesTo as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => s.slice(0, 120));
        if (collected.length > 0) appliesTo = collected.slice(0, 12);
      } else if (typeof r.option === "string" && r.option.trim()) {
        appliesTo = [r.option.trim().slice(0, 120)];
      }
      materials.push({ name: name.slice(0, 60), alternatives, ...(appliesTo ? { appliesTo } : {}) });
      if (materials.length >= 8) break;
    }
  }

  return { phases, edges, choices, materials };
}

/** POST /api/extract-choices — Sonnet turns an assistant reply into a
 *  canvas graph (phases/edges/choices/materials). Always 200; failures
 *  degrade to an empty structure. */
export const extractChoicesRoute = HttpRouter.add(
  "POST",
  "/api/extract-choices",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* bodyJson<{ text?: string }>().pipe(
      Effect.catch(() => Effect.succeed({} as { text?: string })),
    );
    const text = (body?.text ?? "").trim();
    const empty: ParsedStructure = { phases: [], edges: [], choices: [], materials: [] };
    if (!text) return yield* json(empty);
    const truncated =
      Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES
        ? text.slice(0, Math.floor(MAX_TEXT_BYTES / 4))
        : text;

    const structure = yield* Effect.promise(async () => {
      try {
        const result = await runClaude(
          `Assistant's most recent reply (between BEGIN/END):\n\n` +
            `BEGIN\n${truncated}\nEND\n\n` +
            `Return the JSON now.`,
        );
        if (result.code !== 0) return empty;
        return tryParseStructure(result.stdout);
      } catch {
        return empty;
      }
    });
    return yield* json(structure);
  }),
);
