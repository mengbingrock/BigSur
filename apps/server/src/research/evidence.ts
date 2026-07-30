// The evidence cache — the mechanical heart of chain-of-evidence. Every
// retrieval (OpenAlex HTTP call, protocols-MCP tool result) is written to
// evidence/ev_<hex12>.json and indexed in research_evidence keyed by its
// stable ref id. Downstream, "citation valid ⇔ evidence row exists for that
// ref id in this run" implements retrieval-only citations deterministically.
import path from "node:path";
import fs from "node:fs/promises";
import { evidenceId, insertEvidence } from "./runsDb";
import { emitRunEvent } from "./events";
import { safeRunPath, sha256 } from "./workspace";

export interface EvidenceCtx {
  runId: string;
  workspaceDir: string;
}

export interface CachedEvidence {
  id: string;
  relPath: string;
}

/** Cache one retrieval payload; idempotent per canonical (tool, request). */
export async function cacheEvidence(
  ctx: EvidenceCtx,
  opts: {
    sourceTool: string;
    request: unknown;
    refId?: string | null;
    payload: unknown;
  },
): Promise<CachedEvidence> {
  const id = evidenceId(opts.sourceTool, opts.request);
  const relPath = path.join("evidence", `${id}.json`);
  const body = JSON.stringify(
    {
      id,
      tool: opts.sourceTool,
      request: opts.request,
      refId: opts.refId ?? null,
      retrievedAt: new Date().toISOString(),
      payload: opts.payload,
    },
    null,
    2,
  );
  const abs = safeRunPath(ctx.workspaceDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf8");
  const fresh = await insertEvidence({
    id,
    runId: ctx.runId,
    sourceTool: opts.sourceTool,
    refId: opts.refId ?? null,
    request: opts.request,
    relPath,
    sha256: sha256(body),
  });
  if (fresh) {
    await emitRunEvent(ctx.runId, "evidence_cached", {
      evidenceId: id,
      sourceTool: opts.sourceTool,
      refId: opts.refId ?? null,
    });
  }
  return { id, relPath };
}

/** Normalise a protocols-MCP tool_result content payload into plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return JSON.stringify(content ?? null);
}

/** Intercepted from agent transcripts: cache every mcp__protocols__* result.
 *  fetch carries a stable ref id in its input; search results are cached
 *  under refId null (they ground nothing by themselves). */
export async function cacheProtocolsToolResult(
  ctx: EvidenceCtx,
  toolName: string,
  input: unknown,
  content: unknown,
): Promise<void> {
  const short = toolName.replace("mcp__protocols__", "protocols_");
  const refId =
    short === "protocols_fetch" && input && typeof (input as { id?: unknown }).id === "string"
      ? String((input as { id: string }).id)
      : null;
  await cacheEvidence(ctx, {
    sourceTool: short,
    request: input ?? {},
    refId,
    payload: { text: toolResultText(content).slice(0, 400_000) },
  });
}

/** Read a cached evidence payload back (for entailment judging / the UI). */
export async function readEvidencePayload(
  workspaceDir: string,
  relPath: string,
): Promise<{ refId: string | null; payload: unknown } | null> {
  try {
    const raw = await fs.readFile(safeRunPath(workspaceDir, relPath), "utf8");
    const parsed = JSON.parse(raw) as { refId?: string | null; payload?: unknown };
    return { refId: parsed.refId ?? null, payload: parsed.payload ?? null };
  } catch {
    return null;
  }
}
