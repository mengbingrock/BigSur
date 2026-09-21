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
}

export interface PendingQuestion {
  turnId: string;
  toolUseId: string;
  input: unknown;
}

export interface SessionMessage {
  idx: number;
  turnId: string | null;
  role: "user" | "assistant";
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
