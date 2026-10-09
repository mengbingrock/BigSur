// The Siri session and its router (docs/siri-design.md §3.3). Every phrase
// that carries text enters here; the router decides which chat continues it
// — or that a new one starts — and logs the decision in the Siri session.
// The common cases need no model; the model is one fast call over the
// last twenty chats, with a hard budget, falling through to "new".
import { completeText } from "../complete";
import { auxModel } from "../llm";
import * as rdb from "../runs/db";
import * as sdb from "../sessions/db";
import type { SessionRow } from "../sessions/db";
import { emitSystemMessage } from "../sessions/runner";

export const SIRI_SESSION_TITLE = "Siri";

export type RouteKind = "tell" | "ask" | "answer" | "start";

export interface RouteRequest {
  text: string;
  kind: RouteKind;
  /** A session the phrase named (entity), or one the client already knows. */
  sessionId?: string;
  /** For `start`: which protocol. */
  protocolSlug?: string;
  device?: string;
}

export interface RouteCandidate {
  sessionId: string;
  title: string;
}

export interface RouteResult {
  /** `continue` an existing chat, `new` one, `resume` a paused run, or `choose` among candidates. */
  action: "continue" | "new" | "resume" | "choose";
  sessionId: string | null;
  title: string | null;
  runId?: string;
  confidence: number;
  candidates: RouteCandidate[];
  /** How the decision was made, for the log and for tests. */
  via: "named" | "pending" | "run" | "model" | "new" | "resume" | "attached" | "unsure";
  siriSessionId: string;
}

export async function ensureSiriSession(email: string): Promise<SessionRow> {
  return sdb.getOrCreateSessionOfKind(email, "siri", SIRI_SESSION_TITLE);
}

/** Fast budget for the routing call; past it the message goes to a new chat. */
const MODEL_BUDGET_MS = Number(process.env.LABEE_SIRI_ROUTER_MS ?? 3000);
const CANDIDATES = 20;
const SURE = 0.6;
const UNSURE = 0.35;

const RUN_WORDS = /\b(step|timer|incubat|spin|centrifug|gel|protocol|run|done|next|pipett|aliquot|tube|sample|buffer)\w*/i;

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || "New chat";
}

async function tailOf(sessionId: string): Promise<{ user: string; assistant: string }> {
  const msgs = await sdb.listMessages(sessionId);
  const last = (role: "user" | "assistant") => [...msgs].reverse().find((m) => m.role === role)?.content.replace(/\s+/g, " ").slice(0, 160) ?? "";
  return { user: last("user"), assistant: last("assistant") };
}

export async function route(email: string, req: RouteRequest): Promise<RouteResult> {
  const siri = await ensureSiriSession(email);
  const base = { candidates: [] as RouteCandidate[], siriSessionId: siri.id };
  const done = async (r: Omit<RouteResult, "siriSessionId" | "candidates"> & Partial<Pick<RouteResult, "candidates">>): Promise<RouteResult> => {
    const full: RouteResult = { ...base, ...r };
    await log(siri.id, req, full);
    return full;
  };

  // 1. Named.
  if (req.sessionId) {
    const s = await sdb.getSession(email, req.sessionId);
    if (s && s.kind !== "siri") return done({ action: "continue", sessionId: s.id, title: s.title, confidence: 1, via: "named" });
  }

  // 2. A question waiting on the person.
  if (req.kind === "answer") {
    const [waiting] = await sdb.listSessions(email, { status: "awaiting_input", limit: 1, kind: null });
    if (waiting) return done({ action: "continue", sessionId: waiting.id, title: waiting.title, confidence: 1, via: "pending" });
    return done({ action: "new", sessionId: null, title: null, confidence: 0, via: "unsure" });
  }

  // Starting a run: resume a paused/running one of this protocol, continue a
  // chat that already has it attached, else new.
  if (req.kind === "start") {
    const slug = req.protocolSlug ?? "";
    const [open] = await rdb.listRuns(email, { status: ["running", "paused"], protocolSlug: slug, limit: 1 });
    if (open) {
      const s = await sdb.getSessionById(open.sessionId);
      return done({ action: "resume", sessionId: open.sessionId, title: s?.title ?? open.protocolName, runId: open.id, confidence: 1, via: "resume" });
    }
    const recent = await sdb.listSessions(email, { limit: CANDIDATES, kind: null });
    const attached = recent.find((s) => {
      const slugs = (s.lastBody?.skillSlugs as unknown) ?? [];
      return Array.isArray(slugs) && slugs.includes(slug) && s.status !== "running";
    });
    if (attached) {
      const existing = await rdb.getRunBySession(attached.id);
      if (!existing) return done({ action: "continue", sessionId: attached.id, title: attached.title, confidence: 0.9, via: "attached" });
    }
    return done({ action: "new", sessionId: null, title: null, confidence: 1, via: "new" });
  }

  // 3. An active run the text is about.
  const [running] = await rdb.listRuns(email, { status: ["running", "paused"], limit: 1 });
  if (running && RUN_WORDS.test(req.text)) {
    const s = await sdb.getSessionById(running.sessionId);
    if (s) return done({ action: "continue", sessionId: s.id, title: s.title, runId: running.id, confidence: 0.85, via: "run" });
  }

  // 4. The model, over recent chats.
  const recent = (await sdb.listSessions(email, { limit: CANDIDATES, kind: null })).filter((s) => s.id !== siri.id);
  if (recent.length > 0) {
    const picked = await modelPick(email, req.text, recent);
    if (picked) {
      const titleOf = (id: string) => recent.find((s) => s.id === id)?.title ?? null;
      if (picked.sessionId && picked.confidence >= SURE && titleOf(picked.sessionId)) {
        return done({ action: "continue", sessionId: picked.sessionId, title: titleOf(picked.sessionId), confidence: picked.confidence, via: "model" });
      }
      if (picked.sessionId && picked.confidence >= UNSURE) {
        // 5. Unsure: offer the top candidates and a new chat.
        const ids = [picked.sessionId, ...picked.alternatives].filter((id, i, a) => titleOf(id) && a.indexOf(id) === i).slice(0, 2);
        return done({
          action: "choose",
          sessionId: null,
          title: null,
          confidence: picked.confidence,
          via: "unsure",
          candidates: ids.map((id) => ({ sessionId: id, title: titleOf(id)! })),
        });
      }
    }
  }

  // 6. New.
  return done({ action: "new", sessionId: null, title: titleFrom(req.text), confidence: 1, via: "new" });
}

async function modelPick(
  email: string,
  text: string,
  recent: SessionRow[],
): Promise<{ sessionId: string | null; confidence: number; alternatives: string[] } | null> {
  const rows = await Promise.all(
    recent.map(async (s) => {
      const tail = await tailOf(s.id);
      return { id: s.id, title: s.title, status: s.status, updatedAt: s.updatedAt, lastUser: tail.user, lastAssistant: tail.assistant };
    }),
  );
  const system =
    "You route a spoken message from a scientist to the chat it continues. " +
    'Reply with JSON only: {"sessionId": "<id>" | "new", "confidence": 0-1, "alternatives": ["<id>", ...]}. ' +
    'Choose "new" when the message starts a different topic. Alternatives are other plausible chats, best first, at most two.';
  const user = JSON.stringify({ message: text, chats: rows });
  const model = process.env.LABEE_SIRI_ROUTER_MODEL || "haiku";
  let raw: string;
  try {
    raw = await Promise.race([
      completeText({ email, system, user, effort: "low", timeoutMs: MODEL_BUDGET_MS, anthropicModel: model, openaiModel: auxModel("openai") }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("router timeout")), MODEL_BUDGET_MS)),
    ]);
  } catch {
    return null;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { sessionId?: unknown; confidence?: unknown; alternatives?: unknown };
    const sessionId = typeof j.sessionId === "string" && j.sessionId !== "new" ? j.sessionId : null;
    const confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : sessionId ? 0.5 : 1;
    const alternatives = Array.isArray(j.alternatives) ? j.alternatives.filter((a): a is string => typeof a === "string") : [];
    return { sessionId, confidence, alternatives };
  } catch {
    return null;
  }
}

/** One quiet line per exchange in the Siri session: what was heard, where it went. */
async function log(siriSessionId: string, req: RouteRequest, r: RouteResult): Promise<void> {
  const heard = req.text.replace(/\s+/g, " ").trim();
  const short = heard.length > 120 ? `${heard.slice(0, 120)}…` : heard;
  const where =
    r.action === "continue" ? `→ ${r.title}` : r.action === "resume" ? `→ resume ${r.title}` : r.action === "choose" ? `? ${r.candidates.map((c) => c.title).join(" / ")}` : "→ new chat";
  const verb = req.kind === "ask" ? "asked" : req.kind === "answer" ? "answered" : req.kind === "start" ? "start" : "said";
  await emitSystemMessage(siriSessionId, `${where} · ${verb}: "${short}"`, {
    kind: req.kind,
    via: r.via,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(req.device ? { device: req.device } : {}),
  });
}

/** Log a quick answer so the Siri session holds the Q and the A. */
export async function logQuickAnswer(email: string, q: string, answer: string, device?: string): Promise<void> {
  const siri = await ensureSiriSession(email);
  const a = answer.replace(/\s+/g, " ").trim();
  await emitSystemMessage(siri.id, `asked: "${q.trim()}" — ${a.length > 200 ? `${a.slice(0, 200)}…` : a}`, { kind: "quick", ...(device ? { device } : {}) });
}
