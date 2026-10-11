// Wire shapes for server-owned chat sessions (docs/mobile-companion-design.md
// §4). Kept as plain TS types (not Effect Schema) so the mobile bundle doesn't
// pull in the contracts package's runtime.

export type SessionStatus = "idle" | "running" | "awaiting_input" | "error";

export interface SessionSummary {
  id: string;
  title: string;
  agentId: string | null;
  cwd: string | null;
  engine: string;
  provider: string;
  model: string | null;
  status: SessionStatus;
  activeTurn: string | null;
  pendingQuestion: PendingQuestion | null;
  lastSeq: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Number of turns waiting behind the running one. */
  queued: number;
  /** Set by the box mirror: which host the session lives on, and whether that
   *  host is connected right now. */
  hostId?: string;
  hostOnline?: boolean;
  /** "siri" for the account's router/log session (docs/siri-design.md §3.3). */
  kind?: "siri" | null;
  /** The protocol run this session tracks, when it does. */
  run?: SessionRunBadge | null;
}

/** Enough of a run to draw its row in a list. */
export interface SessionRunBadge {
  id: string;
  protocolName: string;
  current: number;
  total: number;
  status: "running" | "paused" | "done" | "abandoned";
  startedAt: string;
  /** A running timer's end, if any. */
  timerEndsAt?: string | null;
}

export interface PendingQuestion {
  turnId: string;
  toolUseId: string;
  input: unknown;
}

export interface SessionMessage {
  idx: number;
  turnId: string | null;
  /** `system`: a quiet line from a run or the Siri router, never a turn. */
  role: "user" | "assistant" | "system";
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** One event on the session SSE stream (event name: "session_event"). `seq`
 *  is 0 for live-only frames that were never persisted. */
export interface SessionEvent {
  seq: number;
  sessionId: string;
  turnId: string | null;
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}
export interface AskUserAnswer {
  question: string;
  answer: string | string[];
}

/** The questions of an AskUserQuestion call, whatever shape the model sent:
 *  an array, a JSON string of one (seen in the wild: the app crashed on it),
 *  or nothing. Items without a question or with malformed options are
 *  dropped; options are coerced to `{ label, description? }`. */
export function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  let list: unknown = raw;
  if (list && typeof list === "object" && !Array.isArray(list) && "questions" in (list as object)) {
    list = (list as { questions?: unknown }).questions;
  }
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const q = item as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    let opts: unknown = q.options;
    if (typeof opts === "string") {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = [];
      }
    }
    const options: AskUserQuestionOption[] = Array.isArray(opts)
      ? opts
          .map((o): AskUserQuestionOption | null => {
            if (typeof o === "string") return o.trim() ? { label: o.trim() } : null;
            if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
              const d = (o as { description?: unknown }).description;
              return { label: (o as { label: string }).label, ...(typeof d === "string" && d ? { description: d } : {}) };
            }
            return null;
          })
          .filter((o): o is AskUserQuestionOption => o !== null)
      : [];
    out.push({
      question,
      options,
      ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

/** Body of POST /api/sessions/:id/turns. */
export interface TurnRequest {
  text: string;
  skillSlugs?: string[];
  contextFiles?: string[];
  artifactNotes?: Record<string, string>;
  agentId?: string;
  runMode?: "chat" | "plan" | "build";
  fullAccess?: boolean;
  mcpServers?: string[];
  provider?: "anthropic" | "openai";
  model?: string;
  effort?: "low" | "medium" | "high";
  voice?: boolean;
  /** Free-form label of the sending device ("iPhone", "Mac"). */
  device?: string;
  /** Who asked for this turn, when it was not the person in the chat: the
   *  Siri agent delegating. The result is returned to them (siri-agent
   *  design §5): a line in the Siri session, an announced summary, unread
   *  until heard. */
  origin?: TurnOrigin;
}

export interface TurnOrigin {
  kind: "siri";
  /** The Siri exchange that delegated, so the return can name it. */
  siriTurnId: string;
  /** What the person said, for the return line. */
  said?: string;
}

/** Format AskUserQuestion answers as the follow-up user message the model
 *  sees (kept identical to the web client's wording). */
export function formatAnswers(answers: AskUserAnswer[]): string {
  const lines = answers.map((a) => {
    const ans = Array.isArray(a.answer) ? a.answer.join(", ") : a.answer;
    return `- ${a.question} → ${ans}`;
  });
  return (
    `Here are my answers to the questions you just asked:\n${lines.join("\n")}\n\n` +
    `Please continue from this.`
  );
}
