// Server-owned session runner (design §4.2). Owns the engine child for a
// running turn, persists every event with a per-session seq, fans them out
// to subscribers, and never lets a client disconnect touch the child. Turns
// sent while one is running are queued and started when it ends.
import { SseParser, frameJson, formatAnswers, type AskUserAnswer, type TurnRequest } from "@labee/session-core";
import { prepareTurn, type ChatRequest } from "../turnBuilder";
import * as db from "./db";
import type { SessionRow } from "./db";

export interface SessionEventEnvelope {
  seq: number;
  sessionId: string;
  turnId: string | null;
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

type Listener = (evt: SessionEventEnvelope) => void;

interface Handle {
  sessionId: string;
  turnId: string;
  cancel: () => void;
  listeners: Set<Listener>;
}

const live = new Map<string, Handle>();
/** Subscribers for sessions that have no running turn yet. */
const idleListeners = new Map<string, Set<Listener>>();
/** Global tap used by the Device Link mirror. */
const globalListeners = new Set<(evt: SessionEventEnvelope, session: SessionRow | null) => void>();

/** Live-only event types (never persisted; too chatty). Persisted deltas are
 *  compacted at turn end instead, so the live turn can be replayed mid-way. */
const LIVE_ONLY = new Set<string>(["status", "message_delta", "message_start", "message_stop", "text_start", "text_stop"]);

export function getHandle(sessionId: string): Handle | undefined {
  return live.get(sessionId);
}

export function subscribe(sessionId: string, listener: Listener): () => void {
  const h = live.get(sessionId);
  if (h) {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  }
  let set = idleListeners.get(sessionId);
  if (!set) {
    set = new Set();
    idleListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) idleListeners.delete(sessionId);
  };
}

export function subscribeAll(listener: (evt: SessionEventEnvelope, session: SessionRow | null) => void): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

function publish(evt: SessionEventEnvelope, session: SessionRow | null = null): void {
  const targets = new Set<Listener>();
  live.get(evt.sessionId)?.listeners.forEach((l) => targets.add(l));
  idleListeners.get(evt.sessionId)?.forEach((l) => targets.add(l));
  for (const l of targets) {
    try {
      l(evt);
    } catch {
      // a broken subscriber must not take down the turn
    }
  }
  for (const g of globalListeners) {
    try {
      g(evt, session);
    } catch {
      // ignore
    }
  }
}

async function emit(
  sessionId: string,
  turnId: string | null,
  type: string,
  data: Record<string, unknown>,
  opts: { persist?: boolean } = {},
): Promise<SessionEventEnvelope> {
  const persist = opts.persist ?? !LIVE_ONLY.has(type);
  let seq = 0;
  let ts = new Date().toISOString();
  if (persist) {
    const r = await db.appendEvent(sessionId, turnId, type, data);
    seq = r.seq;
    ts = r.ts;
  }
  const envelope = { seq, sessionId, turnId, type, ts, data };
  publish(envelope);
  return envelope;
}

/** Same wording as the web client: AskUserQuestion answers become the next
 *  user message so the model never sees a tool error. */
export { formatAnswers };

export type StartResult =
  | { ok: true; turnId: string; queued: false }
  | { ok: true; queueId: string; queued: true }
  | { ok: false; status: number; message: string };

/** Start a turn now, or queue it if one is running. */
export async function startTurn(
  email: string,
  sessionId: string,
  req: TurnRequest,
): Promise<StartResult> {
  const session = await db.getSession(email, sessionId);
  if (!session) return { ok: false, status: 404, message: "Session not found." };
  const text = typeof req.text === "string" ? req.text.trim() : "";
  if (!text) return { ok: false, status: 400, message: "`text` is required." };

  if (live.has(sessionId)) {
    const q = await db.enqueueTurn(sessionId, req as unknown as Record<string, unknown>);
    await emit(sessionId, null, "turn_queued", {
      queueId: q.id,
      text,
      ...(req.device ? { device: req.device } : {}),
    });
    return { ok: true, queued: true, queueId: q.id };
  }
  const turnId = db.newId("turn");
  await runTurn(session, turnId, req, { fromAnswer: false });
  return { ok: true, turnId, queued: false };
}

async function runTurn(
  session: SessionRow,
  turnId: string,
  req: TurnRequest,
  opts: { fromAnswer: boolean },
): Promise<void> {
  const sessionId = session.id;
  const text = req.text.trim();
  const history = await db.listMessages(sessionId);
  const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: text }];

  // Persist the user message first so a crash still leaves the transcript coherent.
  await db.appendMessage(sessionId, turnId, "user", text, req.device ? { device: req.device } : null);
  if (history.length === 0 && session.title === "New chat") {
    const title = text.replace(/\s+/g, " ").slice(0, 48) + (text.length > 48 ? "…" : "");
    await db.updateSession(sessionId, { title });
    await emit(sessionId, turnId, "session_renamed", { title });
  }
  await db.updateSession(sessionId, {
    status: "running",
    activeTurn: turnId,
    pendingQuestion: null,
    lastBody: req as unknown as Record<string, unknown>,
    ...(req.model ? { model: req.model } : {}),
    ...(req.provider ? { provider: req.provider } : {}),
  });

  // Register the handle BEFORE the first event so subscribers attached to an
  // idle session move over and nothing is dropped.
  const handle: Handle = { sessionId, turnId, cancel: () => {}, listeners: new Set() };
  const idle = idleListeners.get(sessionId);
  if (idle) {
    idle.forEach((l) => handle.listeners.add(l));
    idleListeners.delete(sessionId);
  }
  live.set(sessionId, handle);

  await emit(sessionId, turnId, "turn_started", {
    turnId,
    text,
    fromAnswer: opts.fromAnswer,
    ...(req.device ? { device: req.device } : {}),
    ...(req.voice ? { voice: true } : {}),
  });

  const body: ChatRequest = {
    mode: "chat",
    messages,
    skillSlugs: Array.isArray(req.skillSlugs) ? req.skillSlugs : [],
    ...(req.contextFiles ? { contextFiles: req.contextFiles } : {}),
    ...(req.artifactNotes ? { artifactNotes: req.artifactNotes } : {}),
    ...(req.agentId ?? session.agentId ? { agentId: (req.agentId ?? session.agentId) as string } : {}),
    ...(req.runMode ? { runMode: req.runMode } : {}),
    ...(req.fullAccess !== undefined ? { fullAccess: req.fullAccess } : {}),
    ...(req.mcpServers ? { mcpServers: req.mcpServers } : {}),
    ...(req.provider ? { provider: req.provider } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
    ...(req.voice ? { voice: true } : {}),
  };

  // Turn-local accumulation for the durable assistant message.
  let content = "";
  const activity: Record<string, unknown>[] = [];
  const toolIndex = new Map<string, number>();
  let stats: Record<string, unknown> | null = null;
  let error: string | null = null;
  let cancelled = false;
  let question: { toolUseId: string; input: unknown } | null = null;
  let finished = false;

  const finish = async () => {
    if (finished) return;
    finished = true;
    live.delete(sessionId);
    // Keep the listeners for the idle period (and the next turn).
    if (handle.listeners.size > 0) idleListeners.set(sessionId, new Set(handle.listeners));

    const meta: Record<string, unknown> = { activity };
    if (stats) meta.stats = stats;
    if (error) meta.error = error;
    if (cancelled) meta.cancelled = true;
    if (question) meta.question = { toolUseId: question.toolUseId, questions: (question.input as { questions?: unknown })?.questions ?? [] };
    if (req.device) meta.device = req.device;
    await db.appendMessage(sessionId, turnId, "assistant", content, meta);
    const cost = typeof stats?.costUsd === "number" ? stats.costUsd : 0;
    await db.updateSession(sessionId, {
      status: question ? "awaiting_input" : error ? "error" : "idle",
      activeTurn: null,
      pendingQuestion: question ? { turnId, toolUseId: question.toolUseId, input: question.input } : null,
      ...(cost ? { addCostUsd: cost } : {}),
    });
    if (cancelled) {
      await emit(sessionId, turnId, "turn_cancelled", { turnId, content });
    } else if (question) {
      await emit(sessionId, turnId, "question_asked", { turnId, toolUseId: question.toolUseId, input: question.input });
    }
    await emit(sessionId, turnId, "turn_ended", {
      turnId,
      content,
      activity,
      ...(stats ? { stats } : {}),
      ...(error ? { error } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      ...(question ? { question: true } : {}),
    });
    await db.compactTurn(sessionId, turnId);

    // A question blocks the queue: the user must answer first.
    if (!question) void drainQueue(sessionId);
  };

  const prepared = await prepareTurn(session.email, body).catch((e: unknown) => ({
    ok: false as const,
    kind: "unavailable" as const,
    message: e instanceof Error ? e.message : String(e),
  }));
  if (!prepared.ok) {
    error = prepared.message;
    await emit(sessionId, turnId, "error", { message: prepared.message });
    await finish();
    return;
  }
  if (session.cwd !== prepared.cwd || session.engine !== prepared.engine) {
    await db.updateSession(sessionId, { cwd: prepared.cwd, engine: prepared.engine, provider: prepared.provider });
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  handle.cancel = () => {
    cancelled = true;
    try {
      void reader?.cancel();
    } catch {
      // already done
    }
  };

  const onFrame = async (event: string, data: Record<string, unknown>) => {
    switch (event) {
      case "delta":
        if (typeof data.text === "string") content += data.text;
        break;
      case "tool_start": {
        const id = String(data.id ?? "");
        toolIndex.set(id, activity.length);
        activity.push({ kind: "tool", id, name: String(data.name ?? ""), input: null, inputRaw: "", done: false });
        break;
      }
      case "tool_input":
      case "tool_stop": {
        const i = toolIndex.get(String(data.id ?? ""));
        if (i !== undefined) {
          const a = activity[i]!;
          a.input = data.input ?? a.input;
          if (event === "tool_stop") {
            a.done = true;
            if (data.name === "AskUserQuestion") {
              question = { toolUseId: String(data.id ?? ""), input: data.input ?? null };
            }
          }
        } else if (data.name === "AskUserQuestion" && event === "tool_stop") {
          question = { toolUseId: String(data.id ?? ""), input: data.input ?? null };
        }
        break;
      }
      case "tool_result": {
        const i = toolIndex.get(String(data.id ?? ""));
        if (i !== undefined) {
          const a = activity[i]!;
          a.done = true;
          const c = data.content;
          const txt = typeof c === "string" ? c : JSON.stringify(c ?? "");
          a.result = txt.length > 8192 ? `${txt.slice(0, 8192)}…` : txt;
          a.resultError = Boolean(data.is_error);
        }
        break;
      }
      case "result":
        stats = {
          ...(typeof data.total_cost_usd === "number" ? { costUsd: data.total_cost_usd } : {}),
          ...(typeof data.duration_ms === "number" ? { durationMs: data.duration_ms } : {}),
          ...(typeof data.num_turns === "number" ? { numTurns: data.num_turns } : {}),
        };
        break;
      case "error":
        error = String(data.message ?? "Error");
        break;
      default:
        break;
    }
    await emit(sessionId, turnId, event, data);
  };

  // Consume the engine stream in the background; the caller returns as soon
  // as the turn is registered.
  void (async () => {
    try {
      const stream = prepared.makeStream();
      reader = stream.getReader();
      const parser = new SseParser();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.feed(value)) {
          if (frame.event === "end") continue;
          await onFrame(frame.event, frameJson(frame));
          if (question) {
            // The claude path already kills the CLI on AskUserQuestion; make
            // the other engines stop too.
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            break;
          }
        }
        if (question) break;
      }
      for (const frame of parser.end()) {
        if (frame.event !== "end") await onFrame(frame.event, frameJson(frame));
      }
    } catch (e) {
      if (!cancelled) {
        error = e instanceof Error ? e.message : String(e);
        await emit(sessionId, turnId, "error", { message: error });
      }
    } finally {
      await finish();
    }
  })();
}

async function drainQueue(sessionId: string): Promise<void> {
  if (live.has(sessionId)) return;
  const next = await db.dequeueTurn(sessionId);
  if (!next) return;
  const session = await db.getSessionById(sessionId);
  if (!session) return;
  await emit(sessionId, null, "turn_dequeued", { queueId: next.id });
  const turnId = db.newId("turn");
  await runTurn(session, turnId, next.body as unknown as TurnRequest, { fromAnswer: false });
}

export async function cancelTurn(email: string, sessionId: string): Promise<{ ok: boolean; message?: string }> {
  const session = await db.getSession(email, sessionId);
  if (!session) return { ok: false, message: "Session not found." };
  const h = live.get(sessionId);
  if (!h) return { ok: false, message: "No turn is running." };
  h.cancel();
  return { ok: true };
}

export async function removeQueued(email: string, sessionId: string, queueId: string): Promise<boolean> {
  const session = await db.getSession(email, sessionId);
  if (!session) return false;
  const removed = await db.removeQueued(sessionId, queueId);
  if (removed) await emit(sessionId, null, "turn_dequeued", { queueId, removed: true });
  return removed;
}

export async function answerQuestion(
  email: string,
  sessionId: string,
  answers: AskUserAnswer[],
  extra: { device?: string; voice?: boolean } = {},
): Promise<StartResult> {
  const session = await db.getSession(email, sessionId);
  if (!session) return { ok: false, status: 404, message: "Session not found." };
  if (!session.pendingQuestion) return { ok: false, status: 409, message: "No question is pending." };
  if (live.has(sessionId)) return { ok: false, status: 409, message: "A turn is already running." };
  const text = formatAnswers(answers);
  const nextTurnId = db.newId("turn");
  await db.updateSession(sessionId, { pendingQuestion: null });
  await emit(sessionId, session.pendingQuestion.turnId, "question_answered", {
    toolUseId: session.pendingQuestion.toolUseId,
    answers,
    text,
    nextTurnId,
    ...(extra.device ? { device: extra.device } : {}),
  });
  const last = (session.lastBody ?? {}) as Partial<TurnRequest>;
  const req: TurnRequest = {
    ...last,
    text,
    ...(extra.device ? { device: extra.device } : {}),
    ...(extra.voice !== undefined ? { voice: extra.voice } : {}),
  };
  await runTurn({ ...session, pendingQuestion: null }, nextTurnId, req, { fromAnswer: true });
  return { ok: true, turnId: nextTurnId, queued: false };
}

/** On boot, any session left `running`/`awaiting` by a crash is put back to
 *  idle with an `error` event so clients don't wait on a turn that died. */
export async function recoverInterrupted(): Promise<number> {
  const rows = await db.listRunningSessions();
  let n = 0;
  for (const s of rows) {
    if (live.has(s.id)) continue;
    await db.updateSession(s.id, { status: "idle", activeTurn: null });
    await emit(s.id, s.activeTurn, "turn_ended", {
      turnId: s.activeTurn,
      content: "",
      error: "The server restarted while this turn was running.",
    });
    n++;
  }
  return n;
}

// Runs once when the server loads its routes.
void recoverInterrupted().catch(() => {});
