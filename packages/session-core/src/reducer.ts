// Pure reducer from session events to a renderable transcript. The mobile app
// and (eventually) the web client both drive their UI from this so the two
// never disagree about what a stream of events means.
import type { AskUserAnswer, AskUserQuestionItem, SessionEvent, SessionMessage } from "./events";

export type ActivityItem =
  | { kind: "thinking"; text: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      inputRaw: string;
      done: boolean;
      result?: string;
      resultError?: boolean;
    }
  | { kind: "status"; text: string };

export interface TurnStats {
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface TranscriptMessage {
  id: string;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
  /** Still streaming. */
  pending: boolean;
  activity: ActivityItem[];
  stats?: TurnStats;
  error?: string;
  cancelled?: boolean;
  /** Set on the assistant message that asked; answered when `answers` is set. */
  question?: { toolUseId: string; questions: AskUserQuestionItem[]; answers?: AskUserAnswer[] };
  device?: string;
  createdAt?: string;
}

export interface TranscriptState {
  messages: TranscriptMessage[];
  streaming: boolean;
  activeTurn: string | null;
  lastSeq: number;
  /** Turn ids queued behind the running one, in order. */
  queued: string[];
  /** Most recent CLI init payload (model, session_id). */
  session: Record<string, unknown> | null;
  error: string | null;
}

export function initialState(messages: SessionMessage[] = [], lastSeq = 0): TranscriptState {
  return {
    messages: messages.map((m) => ({
      id: `m${m.idx}`,
      turnId: m.turnId,
      role: m.role,
      content: m.content,
      pending: false,
      activity: Array.isArray(m.meta?.activity) ? (m.meta!.activity as ActivityItem[]) : [],
      ...(m.meta?.stats ? { stats: m.meta.stats as TurnStats } : {}),
      ...(typeof m.meta?.error === "string" ? { error: m.meta.error as string } : {}),
      ...(m.meta?.cancelled ? { cancelled: true } : {}),
      ...(m.meta?.question
        ? { question: m.meta.question as NonNullable<TranscriptMessage["question"]> }
        : {}),
      ...(typeof m.meta?.device === "string" ? { device: m.meta.device as string } : {}),
      createdAt: m.createdAt,
    })),
    streaming: false,
    activeTurn: null,
    lastSeq,
    queued: [],
    session: null,
    error: null,
  };
}

function findAssistant(state: TranscriptState, turnId: string | null): number {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.role === "assistant" && (turnId === null || m.turnId === turnId)) return i;
  }
  return -1;
}

function mutateAssistant(
  state: TranscriptState,
  turnId: string | null,
  fn: (m: TranscriptMessage) => TranscriptMessage,
): TranscriptState {
  const i = findAssistant(state, turnId);
  if (i === -1) return state;
  const messages = state.messages.slice();
  messages[i] = fn(messages[i]!);
  return { ...state, messages };
}

function mutateActivity(
  state: TranscriptState,
  turnId: string | null,
  fn: (a: ActivityItem[]) => ActivityItem[],
): TranscriptState {
  return mutateAssistant(state, turnId, (m) => (m.pending ? { ...m, activity: fn(m.activity) } : m));
}

function updateTool(
  a: ActivityItem[],
  id: string,
  fn: (t: Extract<ActivityItem, { kind: "tool" }>) => Extract<ActivityItem, { kind: "tool" }>,
): ActivityItem[] {
  return a.map((x) => (x.kind === "tool" && x.id === id ? fn(x) : x));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Apply one event. Unknown event types are ignored (forward compatible). */
export function applyEvent(state: TranscriptState, ev: SessionEvent): TranscriptState {
  if (ev.seq > 0 && ev.seq <= state.lastSeq) return state; // replayed duplicate
  const next = ev.seq > 0 ? { ...state, lastSeq: ev.seq } : state;
  const d = ev.data ?? {};
  const t = ev.turnId;
  switch (ev.type) {
    case "turn_queued": {
      const id = String(d.queueId ?? d.turnId ?? "");
      return { ...next, queued: id && !next.queued.includes(id) ? [...next.queued, id] : next.queued };
    }
    case "turn_dequeued": {
      const id = String(d.queueId ?? d.turnId ?? "");
      return { ...next, queued: next.queued.filter((q) => q !== id) };
    }
    case "turn_started": {
      // Idempotent over seeded/persisted messages: a replay from seq 0 after
      // a reload must not duplicate turns that are already in the transcript.
      const hasUser = t !== null && next.messages.some((m) => m.role === "user" && m.turnId === t);
      const hasAssistant = t !== null && next.messages.some((m) => m.role === "assistant" && m.turnId === t);
      if (hasAssistant) {
        const a = next.messages.find((m) => m.role === "assistant" && m.turnId === t)!;
        return a.pending ? { ...next, streaming: true, activeTurn: t } : next;
      }
      const user: TranscriptMessage = {
        id: `u_${t ?? ev.seq}`,
        turnId: t,
        role: "user",
        content: String(d.text ?? ""),
        pending: false,
        activity: [],
        ...(typeof d.device === "string" ? { device: d.device } : {}),
        createdAt: ev.ts,
      };
      const assistant: TranscriptMessage = {
        id: `a_${t ?? ev.seq}`,
        turnId: t,
        role: "assistant",
        content: "",
        pending: true,
        activity: [],
        createdAt: ev.ts,
      };
      // Answering a question: the user text was already appended by question_answered.
      const alreadyHasUser = d.fromAnswer === true || hasUser;
      return {
        ...next,
        messages: alreadyHasUser
          ? [...next.messages, assistant]
          : [...next.messages, user, assistant],
        streaming: true,
        activeTurn: t,
        error: null,
      };
    }
    case "init":
      return { ...next, session: d };
    case "status":
      return mutateActivity(next, t, (a) => [
        ...a.filter((x) => x.kind !== "status"),
        { kind: "status", text: String(d.status ?? "") },
      ]);
    case "thinking_start":
      return mutateActivity(next, t, (a) => [...a, { kind: "thinking", text: "", done: false }]);
    case "thinking_delta":
      return mutateActivity(next, t, (a) => {
        const out = a.slice();
        for (let i = out.length - 1; i >= 0; i--) {
          const x = out[i]!;
          if (x.kind === "thinking" && !x.done) {
            out[i] = { ...x, text: x.text + String(d.text ?? "") };
            return out;
          }
        }
        return [...out, { kind: "thinking", text: String(d.text ?? ""), done: false }];
      });
    case "thinking_stop":
      return mutateActivity(next, t, (a) => a.map((x) => (x.kind === "thinking" ? { ...x, done: true } : x)));
    case "tool_start":
      return mutateActivity(next, t, (a) =>
        a.some((x) => x.kind === "tool" && x.id === String(d.id ?? ""))
          ? a
          : [...a, { kind: "tool", id: String(d.id ?? ""), name: String(d.name ?? ""), input: null, inputRaw: "", done: false }],
      );
    case "tool_input_delta":
      return mutateActivity(next, t, (a) =>
        updateTool(a, String(d.id ?? ""), (x) => ({ ...x, inputRaw: x.inputRaw + String(d.partial_json ?? "") })),
      );
    case "tool_input":
      return mutateActivity(next, t, (a) => updateTool(a, String(d.id ?? ""), (x) => ({ ...x, input: d.input ?? x.input })));
    case "tool_stop": {
      const id = String(d.id ?? "");
      let s = mutateActivity(next, t, (a) =>
        updateTool(a, id, (x) => ({
          ...x,
          done: true,
          input: d.input ?? x.input,
          inputRaw: typeof d.inputRaw === "string" ? d.inputRaw : x.inputRaw,
        })),
      );
      if (d.name === "AskUserQuestion") {
        const input = (d.input ?? {}) as { questions?: AskUserQuestionItem[] };
        s = mutateAssistant(s, t, (m) => ({
          ...m,
          question: { toolUseId: id, questions: Array.isArray(input.questions) ? input.questions : [] },
        }));
      }
      return s;
    }
    case "tool_result":
      return mutateActivity(next, t, (a) =>
        updateTool(a, String(d.id ?? ""), (x) => ({
          ...x,
          done: true,
          result: resultText(d.content),
          resultError: Boolean(d.is_error),
        })),
      );
    case "delta":
      return mutateAssistant(next, t, (m) => (m.pending ? { ...m, content: m.content + String(d.text ?? "") } : m));
    case "result":
      return mutateAssistant(next, t, (m) => ({
        ...m,
        stats: {
          ...(typeof d.total_cost_usd === "number" ? { costUsd: d.total_cost_usd } : {}),
          ...(typeof d.duration_ms === "number" ? { durationMs: d.duration_ms } : {}),
          ...(typeof d.num_turns === "number" ? { numTurns: d.num_turns } : {}),
        },
      }));
    case "question_asked": {
      const input = (d.input ?? {}) as { questions?: AskUserQuestionItem[] };
      const s = mutateAssistant(next, t, (m) => ({
        ...m,
        pending: false,
        question: m.question ?? {
          toolUseId: String(d.toolUseId ?? ""),
          questions: Array.isArray(input.questions) ? input.questions : [],
        },
      }));
      return { ...s, streaming: false, activeTurn: null };
    }
    case "question_answered": {
      const answers = Array.isArray(d.answers) ? (d.answers as AskUserAnswer[]) : [];
      const s = mutateAssistant(next, t, (m) =>
        m.question ? { ...m, question: { ...m.question, answers } } : m,
      );
      const nextTurn = typeof d.nextTurnId === "string" ? d.nextTurnId : null;
      if (nextTurn && s.messages.some((m) => m.role === "user" && m.turnId === nextTurn)) return s;
      const user: TranscriptMessage = {
        id: `u_ans_${ev.seq}`,
        turnId: typeof d.nextTurnId === "string" ? d.nextTurnId : null,
        role: "user",
        content: String(d.text ?? ""),
        pending: false,
        activity: [],
        ...(typeof d.device === "string" ? { device: d.device } : {}),
        createdAt: ev.ts,
      };
      return { ...s, messages: [...s.messages, user] };
    }
    case "turn_ended": {
      const s = mutateAssistant(next, t, (m) => ({
        ...m,
        pending: false,
        // Compacted replays carry the final text here; live streams already have it.
        content: typeof d.content === "string" && d.content.length >= m.content.length ? d.content : m.content,
        activity: m.activity.map((a) => (a.kind === "tool" || a.kind === "thinking" ? { ...a, done: true } : a)),
        ...(Array.isArray(d.activity) && m.activity.length === 0 ? { activity: d.activity as ActivityItem[] } : {}),
        ...(d.stats && typeof d.stats === "object" ? { stats: d.stats as TurnStats } : {}),
        ...(typeof d.error === "string" ? { error: d.error } : {}),
      }));
      return { ...s, streaming: false, activeTurn: null, ...(typeof d.error === "string" ? { error: d.error } : {}) };
    }
    case "turn_cancelled": {
      const s = mutateAssistant(next, t, (m) => ({
        ...m,
        pending: false,
        cancelled: true,
        content: m.content || "(cancelled)",
      }));
      return { ...s, streaming: false, activeTurn: null };
    }
    case "error": {
      const msg = String(d.message ?? "Error");
      const s = mutateAssistant(next, t, (m) => ({ ...m, error: msg }));
      return { ...s, error: msg };
    }
    default:
      return next;
  }
}

export function applyEvents(state: TranscriptState, events: SessionEvent[]): TranscriptState {
  return events.reduce(applyEvent, state);
}
