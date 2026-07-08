
/**
 * Module-scoped chat session store.
 *
 * The streaming fetch lives here, not inside any React component, so
 * navigating between pages (e.g. /chat → /skills → /chat) doesn't kill
 * an in-progress turn. The Chat component subscribes via
 * useSyncExternalStore and re-renders as deltas arrive.
 *
 * Page reloads still reset live streams (the JS context is gone) but the
 * static history is rehydrated from localStorage so the user sees their
 * prior conversation. Activity (thinking + tool blocks) is dropped on
 * persist — its volume blows the storage quota and it isn't useful after
 * the turn ends.
 */

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

export interface Stats {
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
  model_usage?: Record<string, Record<string, unknown>>;
}

export interface SkillSnapshot {
  slug: string;
  name: string;
  description: string;
  sourceLabel: string;
  allowedTools: string[];
  bodyChars: number;
}

export interface EditSnapshot {
  start: number;
  end: number;
  originalText: string;
  newText: string;
  instruction: string;
}

/** One answered question from an AskUserQuestion tool call. */
export interface AskUserAnswer {
  question: string;
  /** string for single-select, string[] for multiSelect. */
  answer: string | string[];
}

/**
 * A choice that a Haiku post-stream extractor inferred from the assistant's
 * plain-text reply when the model offered options without invoking the
 * AskUserQuestion tool. Surfaced as canvas question nodes so users have
 * a clickable way to respond.
 */
export interface ExtractedChoice {
  /** Synthetic id; deterministic from message id + index. */
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  /** "material" choices are reagent/kit swaps that depend on a
   *  higher-level variant pick; on the canvas they stay hidden until a
   *  non-material choice from the same round is acted on, so the user
   *  isn't reagent-shopping for a protocol they haven't agreed to yet.
   *  Undefined / "choice" = regular, always visible. */
  kind?: "material" | "choice";
  /** For "material" entries: the list of EXACT option labels this
   *  reagent applies to (each one of the regular sibling choice's
   *  options). A reagent can belong to multiple variants — list every
   *  one. The canvas reveals the material when the user's draft/
   *  answer on a sibling matches ANY entry. Empty/undefined = applies
   *  regardless of pick. */
  parentOptions?: string[];
}

/**
 * A workflow step the extractor inferred from a plain-text assistant
 * reply. Surfaced on the canvas as a step-style node. Phases can be
 * hierarchical: `subPhases` carries finer-grained children that
 * expand on click in the UI.
 */
export interface ExtractedPhase {
  /** Canvas-unique id; deterministic from message id + local id. */
  id: string;
  label: string;
  summary: string;
  subPhases?: ExtractedPhase[];
}
export interface ExtractedPipelineEdge {
  /** Canvas-unique ids matching ExtractedPhase.id. */
  source: string;
  target: string;
}

/**
 * Local regex fallback for choice patterns Haiku sometimes misses. Runs
 * only when the server-side extractor returns an empty result. Conservative
 * — only catches very simple, high-confidence patterns to avoid false
 * positives. Returns the same shape Haiku does so the rest of the pipeline
 * is unchanged.
 */
function heuristicExtractChoices(
  text: string,
): { question: string; options: string[]; multiSelect: boolean }[] {
  const out: { question: string; options: string[]; multiSelect: boolean }[] = [];

  // Pattern 0: an enumerated / bulleted list of options — the most common way a
  // prose reply offers a choice ("Two quick options for you to confirm:\n1. …\n2. …").
  // Requires a pick-like cue so we don't turn every bulleted list into a question.
  {
    const lines = text.split("\n").map((l) => l.trim());
    const items: string[] = [];
    let question = "";
    for (let i = 0; i < lines.length; i++) {
      const bullet = lines[i].match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (!bullet) continue;
      // Clean the label: strip markdown bold, keep the text before the first
      // dash/colon/period break so long items become short option labels.
      let label = bullet[1].replace(/\*\*/g, "").trim();
      label = label.split(/\s+[—–-]\s+|:\s|\.\s/)[0].trim().slice(0, 60).trim();
      if (!label) continue;
      items.push(label);
      if (!question) {
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j];
          if (!prev || /^(?:[-*•]|\d+[.)])\s+/.test(prev)) continue;
          question = prev.replace(/\*\*/g, "").replace(/:$/, "").trim();
          break;
        }
      }
    }
    const looksLikeAsk =
      /\b(option|confirm|choose|choice|prefer|which|pick|proceed)\b/i.test(text) ||
      /\?/.test(question);
    if (items.length >= 2 && items.length <= 6 && looksLikeAsk) {
      const q = question && question.length <= 140 ? question : "Which option?";
      out.push({ question: q.slice(0, 140), options: items, multiSelect: false });
    }
  }

  // Pattern 1: "X or Y?" with short alternatives. Captures the trailing
  // sentence ending in "?" and looks for a single " or " inside it.
  // Example: "Coffee or tea?" -> ["Coffee", "Tea"]
  // Example: "Would you like to use TRIzol or RNeasy?" -> ["TRIzol", "RNeasy"]
  if (out.length === 0) {
    const sentences = text.match(/[^.!?\n][^.!?\n]*\?/g) ?? [];
    for (const sRaw of sentences) {
      const s = sRaw.trim();
      if (s.length < 4 || s.length > 200) continue;
      const beforeQ = s.replace(/\?+$/, "").trim();
      // Split on " or " (case-insensitive). Skip if more than one occurrence
      // (likely a complex compound — let the server extractor handle it later).
      const parts = beforeQ.split(/\s+or\s+/i);
      if (parts.length !== 2) continue;
      // Take last 1–4 words from the first segment as the option label
      // (drops the lead-in like "Would you like to use").
      const left = parts[0]
        .replace(/[,;:]+$/, "")
        .trim()
        .split(/\s+/)
        .slice(-4)
        .join(" ");
      const right = parts[1].replace(/[,.;:]+$/, "").trim();
      if (
        left.length < 1 ||
        right.length < 1 ||
        left.length > 40 ||
        right.length > 40
      ) {
        continue;
      }
      // Capitalise option labels for nicer display.
      const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
      out.push({
        question: s.slice(0, 100),
        options: [cap(left), cap(right)],
        multiSelect: false,
      });
      break; // One choice per reply is enough for fallback.
    }
  }

  // Pattern 2: yes/no question. Emit only if pattern 1 didn't catch one.
  // Example: "Should I proceed?" -> ["Yes", "No"]
  if (out.length === 0) {
    const m = text.match(
      /\b(Should|Would|Could|Shall|Will|Do|Does|Did|Want|Are|Is|Can|Ready|May)\b[^?!\n]{2,120}\?/i,
    );
    if (m) {
      out.push({
        question: m[0].trim().slice(0, 100),
        options: ["Yes", "No"],
        multiSelect: false,
      });
    }
  }

  return out;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  errored?: boolean;
  activity?: ActivityItem[];
  stats?: Stats;
  loadedSkills?: SkillSnapshot[];
  edits?: EditSnapshot[];
  /**
   * Per-tool-use-id record of the user's picks for AskUserQuestion calls
   * inside this assistant message. Keyed by tool_use_id so we know which
   * card has already been answered when the message is re-rendered after
   * navigation/reload.
   */
  askUserAnswers?: Record<string, AskUserAnswer[]>;
  /** True once the post-stream choice extractor has been called. Prevents
   *  repeating the LLM call on every re-render. */
  extractionAttempted?: boolean;
  /** True while the post-stream extractor sub-agent is in flight for
   *  this message. UI surfaces a spinner / status text so the user
   *  knows why the canvas is still blank. Cleared in `finally`. */
  extracting?: boolean;
  /** Choices the extractor inferred from this message's plain text. */
  extractedChoices?: ExtractedChoice[];
  /** Per-choice-id record of how the user answered an extracted choice
   *  (single → string, multi → string[]). Dismissal isn't supported here
   *  yet — to not see the question, just don't submit. */
  extractedChoicesAnswered?: Record<string, string | string[]>;
  /** Workflow phases Haiku extracted — rendered as a pipeline of step
   *  nodes on the canvas. */
  extractedPhases?: ExtractedPhase[];
  /** Edges between extracted phases (sequence / branching). */
  extractedPipelineEdges?: ExtractedPipelineEdge[];
}

export interface SessionInfo {
  model?: string;
  session_id?: string;
  api_key_source?: string;
  claude_code_version?: string;
  permission_mode?: string;
}

/** Lightweight metadata for one chat session, shown in the sidebar list. */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** The agent this chat is bound to (chats are always agent-scoped). */
  agentId?: string;
}

export interface ChatState {
  messages: ChatMsg[];
  streaming: boolean;
  error: string | null;
  session: SessionInfo | null;
  /** Recent chat sessions, most-recent first (for the sidebar). */
  sessions: SessionMeta[];
  /** Id of the currently-open session. */
  currentSessionId: string;
}

export interface SendOptions {
  text: string;
  skillSlugs: string[];
  /** Qualified paths of files to inject into the system prompt. */
  contextFiles?: string[];
  /** Per-session body overrides keyed by artifact slug. Used when the user
   *  has tweaked an artifact's body for this turn (e.g. for a public
   *  artifact they can't persist). */
  artifactNotes?: Record<string, string>;
  snapshot: SkillSnapshot[];
  /** When set, run the turn inside this saved agent's working directory. */
  agentId?: string;
  /** Operating mode: "build" (execute), "plan" (read-only plan), "chat" (read-only answer). */
  runMode?: "chat" | "plan" | "build";
  /** Full machine + internet access (vs. limited to the working directory). */
  fullAccess?: boolean;
}

export interface EditOptions {
  messageId: string;
  selectionStart: number;
  selectionEnd: number;
  selectionText: string;
  fullMessage: string;
  instruction: string;
}

const HISTORY_KEY = "monterey.chatHistory.v1";
const SESSIONS_KEY = "monterey.sessions.v1";
/** Stable empty snapshot for SSR (must be referentially stable). */
const EMPTY_STATE: ChatState = {
  messages: [],
  streaming: false,
  error: null,
  session: null,
  sessions: [],
  currentSessionId: "",
};
const CURRENT_SESSION_KEY = "monterey.currentSession.v1";

/** Per-session message storage key. */
function sessionMsgKey(id: string): string {
  return `${HISTORY_KEY}:${id}`;
}

function newSessionId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}`;
}

/** Title for a session: first user message, trimmed. */
function deriveTitle(messages: ChatMsg[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function readSessionsIndex(): SessionMeta[] {
  if (typeof window === "undefined") return [];
  try {
    const arr = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
      .map((s) => ({
        id: String(s.id ?? ""),
        title: typeof s.title === "string" ? s.title : "New chat",
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        ...(typeof s.agentId === "string" ? { agentId: s.agentId } : {}),
      }))
      .filter((s) => s.id);
  } catch {
    return [];
  }
}

function writeSessionsIndex(list: SessionMeta[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  } catch {
    /* quota — drop persistence */
  }
}

export function makeId(): string {
  return `m_${Math.random().toString(36).slice(2, 10)}`;
}

export function formatResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
          return String((c as Record<string, unknown>).text);
        }
        try {
          return JSON.stringify(c);
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function readPersistedMessages(key: string): ChatMsg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
      .map((m): ChatMsg => ({
        id: typeof m.id === "string" ? m.id : makeId(),
        role: m.role === "user" ? "user" : "assistant",
        content: typeof m.content === "string" ? m.content : "",
        pending: false, // never re-hydrate as pending
        errored: Boolean(m.errored),
        stats: (m.stats as Stats | undefined) ?? undefined,
        loadedSkills: Array.isArray(m.loadedSkills)
          ? (m.loadedSkills as SkillSnapshot[])
          : undefined,
        edits: Array.isArray(m.edits) ? (m.edits as EditSnapshot[]) : undefined,
        askUserAnswers:
          m.askUserAnswers && typeof m.askUserAnswers === "object"
            ? (m.askUserAnswers as Record<string, AskUserAnswer[]>)
            : undefined,
        extractionAttempted: Boolean(m.extractionAttempted),
        extractedChoices: Array.isArray(m.extractedChoices)
          ? (m.extractedChoices as ExtractedChoice[])
          : undefined,
        extractedChoicesAnswered:
          m.extractedChoicesAnswered &&
          typeof m.extractedChoicesAnswered === "object"
            ? (m.extractedChoicesAnswered as Record<string, string | string[]>)
            : undefined,
        extractedPhases: Array.isArray(m.extractedPhases)
          ? (m.extractedPhases as ExtractedPhase[])
          : undefined,
        extractedPipelineEdges: Array.isArray(m.extractedPipelineEdges)
          ? (m.extractedPipelineEdges as ExtractedPipelineEdge[])
          : undefined,
        // activity intentionally dropped on persist
      }));
  } catch {
    return [];
  }
}

function persistMessages(messages: ChatMsg[], key: string): void {
  if (typeof window === "undefined") return;
  try {
    const slim = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      errored: m.errored,
      stats: m.stats,
      loadedSkills: m.loadedSkills,
      edits: m.edits,
      askUserAnswers: m.askUserAnswers,
      extractionAttempted: m.extractionAttempted,
      extractedChoices: m.extractedChoices,
      extractedChoicesAnswered: m.extractedChoicesAnswered,
      extractedPhases: m.extractedPhases,
      extractedPipelineEdges: m.extractedPipelineEdges,
    }));
    window.localStorage.setItem(key, JSON.stringify(slim));
  } catch {
    // quota / mode / etc. — silently lose persistence rather than crash
  }
}

class ChatStore {
  private state: ChatState = {
    messages: [],
    streaming: false,
    error: null,
    session: null,
    sessions: [],
    currentSessionId: "",
  };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private hydrated = false;
  // Remember the last operating mode / access the user sent with, so follow-up
  // turns (AskUserQuestion answers, extracted choices) reuse the same mode.
  private lastRunMode: "chat" | "plan" | "build" = "plan";
  private lastFullAccess = true;
  // The agent bound to the current session (persisted into the sessions index).
  private lastAgentId: string | undefined;
  /**
   * Set to true when the browser is about to unload (refresh, navigation
   * to a different origin, tab close). Used in the fetch catch block to
   * distinguish a browser-killed request (TypeError: Failed to fetch) from
   * a genuine network failure so we don't surface a red error banner that
   * survives across the reload via localStorage.
   */
  private isUnloading = false;

  constructor() {
    if (typeof window === "undefined") return;
    const onUnload = () => {
      this.isUnloading = true;
      // Abort proactively so the in-flight fetch's catch sees AbortError
      // synchronously (otherwise the browser kills the network call and the
      // promise rejects with TypeError after we've already lost control).
      this.abort?.abort();
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
  }

  /**
   * Hydrate from localStorage on first read in the browser. Lazy so the
   * server snapshot stays empty (no SSR/CSR mismatch).
   */
  private ensureHydrated() {
    if (this.hydrated) return;
    this.hydrated = true;
    if (typeof window === "undefined") return;

    let sessions = readSessionsIndex();
    let currentId = window.localStorage.getItem(CURRENT_SESSION_KEY) ?? "";

    // First run on this device: migrate the legacy single conversation into a
    // session so existing history isn't lost.
    if (sessions.length === 0 && !currentId) {
      const legacy = readPersistedMessages(HISTORY_KEY);
      currentId = newSessionId();
      if (legacy.length > 0) {
        persistMessages(legacy, sessionMsgKey(currentId));
        sessions = [{ id: currentId, title: deriveTitle(legacy), updatedAt: Date.now() }];
        writeSessionsIndex(sessions);
      }
      window.localStorage.setItem(CURRENT_SESSION_KEY, currentId);
    }
    if (!currentId) {
      currentId = sessions[0]?.id ?? newSessionId();
      window.localStorage.setItem(CURRENT_SESSION_KEY, currentId);
    }

    const messages = readPersistedMessages(sessionMsgKey(currentId));
    this.state = { ...this.state, messages, sessions, currentSessionId: currentId };
  }

  getState = (): ChatState => {
    this.ensureHydrated();
    return this.state;
  };

  /** Stable empty snapshot for SSR. */
  getServerSnapshot = (): ChatState => EMPTY_STATE;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
    if (!this.state.streaming) this.persist();
  }

  /** Save the current session's messages and refresh the sessions index so the
   *  sidebar reflects the latest title/order. Empty sessions are not indexed. */
  private persist() {
    if (typeof window === "undefined") return;
    const id = this.state.currentSessionId;
    if (!id) return;
    persistMessages(this.state.messages, sessionMsgKey(id));
    const list = readSessionsIndex().filter((s) => s.id !== id);
    if (this.state.messages.length > 0) {
      list.unshift({
        id,
        title: deriveTitle(this.state.messages),
        updatedAt: Date.now(),
        ...(this.lastAgentId ? { agentId: this.lastAgentId } : {}),
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    writeSessionsIndex(list);
    this.state = { ...this.state, sessions: list };
    this.notify();
  }

  /** Start a fresh chat session bound to an agent (previous one is saved). */
  newSession = (agentId?: string) => {
    this.ensureHydrated();
    this.cancel();
    const id = newSessionId();
    this.lastAgentId = agentId;
    if (typeof window !== "undefined") window.localStorage.setItem(CURRENT_SESSION_KEY, id);
    this.state = {
      ...this.state,
      messages: [],
      error: null,
      session: null,
      currentSessionId: id,
    };
    this.notify();
  };

  /** Open an existing session by id (loads its messages + agent binding). */
  switchSession = (id: string) => {
    this.ensureHydrated();
    if (id === this.state.currentSessionId) return;
    this.cancel();
    this.lastAgentId = this.state.sessions.find((s) => s.id === id)?.agentId;
    if (typeof window !== "undefined") window.localStorage.setItem(CURRENT_SESSION_KEY, id);
    this.state = {
      ...this.state,
      messages: readPersistedMessages(sessionMsgKey(id)),
      error: null,
      session: null,
      currentSessionId: id,
    };
    this.notify();
  };

  /** Delete a session; if it was open, fall back to the next most recent. */
  deleteSession = (id: string) => {
    this.ensureHydrated();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(sessionMsgKey(id));
      } catch {
        /* ignore */
      }
    }
    const list = readSessionsIndex().filter((s) => s.id !== id);
    writeSessionsIndex(list);
    if (id === this.state.currentSessionId) {
      this.cancel();
      const nextId = list[0]?.id ?? newSessionId();
      if (typeof window !== "undefined") window.localStorage.setItem(CURRENT_SESSION_KEY, nextId);
      this.state = {
        ...this.state,
        sessions: list,
        currentSessionId: nextId,
        messages: list[0] ? readPersistedMessages(sessionMsgKey(nextId)) : [],
        error: null,
        session: null,
      };
    } else {
      this.state = { ...this.state, sessions: list };
    }
    this.notify();
  };

  private mutateMessage(id: string, mutator: (m: ChatMsg) => ChatMsg) {
    this.state = {
      ...this.state,
      messages: this.state.messages.map((m) => (m.id === id ? mutator(m) : m)),
    };
    this.notify();
  }

  private appendMessages(...msgs: ChatMsg[]) {
    this.state = {
      ...this.state,
      messages: [...this.state.messages, ...msgs],
    };
    this.notify();
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  setError(error: string | null) {
    this.setState({ error });
  }

  /**
   * True if a fetch failure is a cancellation rather than a genuine error.
   * Covers the explicit cancel() (AbortError) and the page-unload case
   * where the browser kills the in-flight request — that surfaces as a
   * TypeError("Failed to fetch") which we shouldn't show to the user
   * after they refresh.
   */
  private wasCancelled(err: unknown): boolean {
    if (this.isUnloading) return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    return false;
  }

  cancel = () => {
    this.abort?.abort();
    this.abort = null;
    this.setState({ streaming: false });
  };

  clear = () => {
    this.cancel();
    this.setState({ messages: [], error: null, session: null });
  };

  undoEdit = (messageId: string) => {
    this.state = {
      ...this.state,
      messages: this.state.messages.map((m) => {
        if (m.id !== messageId || !m.edits || m.edits.length === 0) return m;
        const last = m.edits[m.edits.length - 1];
        const rest = m.edits.slice(0, -1);
        const head = m.content.slice(0, last.start);
        const tail = m.content.slice(last.start + last.newText.length);
        return {
          ...m,
          content: head + last.originalText + tail,
          edits: rest,
        };
      }),
    };
    this.notify();
    this.persist();
  };

  /**
   * Record the user's answers to an AskUserQuestion tool call and send them
   * as the next chat turn. The answer text is formatted so the model can
   * pick up where it left off.
   */
  submitAskUserAnswer = async (
    messageId: string,
    toolUseId: string,
    answers: AskUserAnswer[],
    skillSlugs: string[],
    snapshot: SkillSnapshot[],
    extra?: {
      contextFiles?: string[];
      artifactNotes?: Record<string, string>;
    },
  ): Promise<void> => {
    if (this.state.streaming) {
      return;
    }
    const beforeMsg = this.state.messages.find((m) => m.id === messageId);
    this.mutateMessage(messageId, (m) => ({
      ...m,
      askUserAnswers: {
        ...(m.askUserAnswers ?? {}),
        [toolUseId]: answers,
      },
    }));
    const afterMsg = this.state.messages.find((m) => m.id === messageId);
    this.persist();

    const lines = answers.map((a) => {
      const ans = Array.isArray(a.answer) ? a.answer.join(", ") : a.answer;
      return `- ${a.question} → ${ans}`;
    });
    const text =
      `Here are my answers to the questions you just asked:\n${lines.join("\n")}\n\n` +
      `Please continue from this.`;

    await this.send({
      text,
      skillSlugs,
      snapshot,
      contextFiles: extra?.contextFiles,
      artifactNotes: extra?.artifactNotes,
    });
  };

  send = async (opts: SendOptions): Promise<void> => {
    const { text, skillSlugs, snapshot, contextFiles, artifactNotes, agentId, runMode, fullAccess } =
      opts;
    if (!text || this.state.streaming) return;
    // Remember the user's choice so follow-up turns that omit it reuse it.
    if (runMode) this.lastRunMode = runMode;
    if (fullAccess !== undefined) this.lastFullAccess = fullAccess;
    if (agentId) this.lastAgentId = agentId;

    const userMsg: ChatMsg = { id: makeId(), role: "user", content: text };
    const assistantMsg: ChatMsg = {
      id: makeId(),
      role: "assistant",
      content: "",
      pending: true,
      activity: [],
      loadedSkills: snapshot,
    };

    const history = [...this.state.messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    this.appendMessages(userMsg, assistantMsg);
    this.setState({ streaming: true, error: null });

    const ctrl = new AbortController();
    this.abort = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          skillSlugs,
          contextFiles: contextFiles ?? [],
          artifactNotes: artifactNotes ?? {},
          ...(agentId ? { agentId } : {}),
          runMode: runMode ?? this.lastRunMode,
          fullAccess: fullAccess ?? this.lastFullAccess,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }
      await this.consumeStream(res.body, assistantMsg.id);
    } catch (err) {
      if (this.wasCancelled(err)) {
        this.mutateMessage(assistantMsg.id, (m) => ({
          ...m,
          pending: false,
          content: m.content || "(cancelled)",
        }));
      } else {
        const reason = err instanceof Error ? err.message : "Request failed.";
        this.setError(reason);
        this.mutateMessage(assistantMsg.id, (m) => ({
          ...m,
          pending: false,
          errored: true,
          content: reason,
        }));
      }
    } finally {
      this.abort = null;
      this.setState({ streaming: false });
      // Post-stream choice extraction: when the assistant finishes a turn
      // without invoking AskUserQuestion, run a fast Haiku pass to detect
      // any plain-text choices ("would you like A or B?") and surface them
      // on the canvas as question nodes. Cheap, async, never blocks the UI.
      const finalAssistant = this.state.messages
        .slice()
        .reverse()
        .find((m) => m.id === assistantMsg.id);
      if (finalAssistant) {
        void this.maybeExtractChoices(finalAssistant.id);
      }
    }
  };

  /**
   * Run the post-stream choice extractor for an assistant message. Skips
   * automatically if (a) the message already used AskUserQuestion (those
   * questions are surfaced via the existing tool-mirror), (b) extraction
   * has already been attempted (idempotent across re-renders), or
   * (c) the message has no real text content.
   */
  maybeExtractChoices = async (messageId: string): Promise<void> => {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (!msg || msg.role !== "assistant") {
      return;
    }
    if (msg.extractionAttempted) {
      return;
    }
    if (msg.errored) {
      return;
    }
    const text = (msg.content ?? "").trim();
    // 10-char threshold catches short replies like "Coffee or tea?"
    // (14 chars). Anything shorter is almost certainly not a question.
    if (text.length < 10) {
      return;
    }
    const hasAskUser = (msg.activity ?? []).some(
      (a) => a.kind === "tool" && a.name === "AskUserQuestion",
    );
    if (hasAskUser) {
      return;
    }
    // Mark attempted up front so concurrent triggers don't double-fire,
    // and flip the in-flight flag so the UI can render a "Extracting…"
    // status while the sub-agent runs (can take 10–60 s on Sonnet).
    this.mutateMessage(messageId, (m) => ({
      ...m,
      extractionAttempted: true,
      extracting: true,
    }));
    this.persist();
    try {
      const res = await fetch("/api/extract-choices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        choices?: unknown;
        phases?: unknown;
        edges?: unknown;
        materials?: unknown;
      };

      // --- Materials (rendered as confirm-or-swap dropdown choices) ---
      // Reagents typically depend on which protocol variant the user
      // picks, so the canvas hides them until a non-material choice
      // from the same round is acted on. They're appended AFTER
      // regular choices so when they do reveal they land to the right
      // of the variant pick they depend on.
      const validatedMaterials: ExtractedChoice[] = [];
      if (Array.isArray(data.materials)) {
        data.materials.forEach((m: unknown, i: number) => {
          if (!m || typeof m !== "object") return;
          const r = m as Record<string, unknown>;
          const name = typeof r.name === "string" ? r.name.trim() : "";
          const alts = Array.isArray(r.alternatives)
            ? (r.alternatives as unknown[])
                .filter((s): s is string => typeof s === "string")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : [];
          if (!name || alts.length < 2) return;
          let parentOptions: string[] | undefined;
          if (Array.isArray(r.appliesTo)) {
            const list = (r.appliesTo as unknown[])
              .filter((s): s is string => typeof s === "string")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (list.length > 0) parentOptions = list;
          } else if (typeof r.option === "string" && r.option.trim()) {
            parentOptions = [r.option.trim()];
          }
          validatedMaterials.push({
            id: `${messageId}-m${i}`,
            question: `Reagent: ${name} — confirm or swap`,
            options: alts,
            multiSelect: false,
            kind: "material",
            parentOptions,
          });
        });
      }

      // --- Choices (with regex fallback) ---
      let rawChoices = Array.isArray(data.choices) ? data.choices : [];
      if (rawChoices.length === 0) {
        const fallback = heuristicExtractChoices(text);
        if (fallback.length > 0) {
          rawChoices = fallback;
        }
      }
      const validatedChoices: ExtractedChoice[] = [];
      rawChoices.forEach((c: unknown, i: number) => {
        if (!c || typeof c !== "object") return;
        const r = c as Record<string, unknown>;
        const q = typeof r.question === "string" ? r.question : "";
        const opts = Array.isArray(r.options)
          ? r.options.filter((o): o is string => typeof o === "string")
          : [];
        if (!q || opts.length < 2) return;
        validatedChoices.push({
          id: `${messageId}-c${i}`,
          question: q,
          options: opts,
          multiSelect: Boolean(r.multiSelect),
        });
      });
      // Regular choices first, then materials — order drives canvas
      // left-to-right placement inside the round's question row, and
      // material reveal is gated on user picking a regular choice.
      const allChoices: ExtractedChoice[] = [
        ...validatedChoices,
        ...validatedMaterials,
      ];

      // --- Phases (the pipeline; recursive) ---
      const phaseIdMap = new Map<string, string>(); // local-id -> canvas-id
      function buildPhase(
        p: unknown,
        parentCanvasId: string,
        index: number,
      ): ExtractedPhase | null {
        if (!p || typeof p !== "object") return null;
        const r = p as Record<string, unknown>;
        const localId = typeof r.id === "string" ? r.id : "";
        const label = typeof r.label === "string" ? r.label.trim() : "";
        if (!localId || !label) return null;
        const canvasId = `${parentCanvasId}-p${index}`;
        phaseIdMap.set(localId, canvasId);
        const subs: ExtractedPhase[] = [];
        if (Array.isArray(r.subPhases)) {
          (r.subPhases as unknown[]).forEach((sp, j) => {
            const child = buildPhase(sp, canvasId, j);
            if (child) subs.push(child);
          });
        }
        return {
          id: canvasId,
          label,
          summary:
            typeof r.summary === "string" ? r.summary.trim() : "",
          subPhases: subs.length > 0 ? subs : undefined,
        };
      }
      const validatedPhases: ExtractedPhase[] = [];
      if (Array.isArray(data.phases)) {
        data.phases.forEach((p: unknown, i: number) => {
          const built = buildPhase(p, messageId, i);
          if (built) validatedPhases.push(built);
        });
      }

      // --- Edges (referencing namespaced phase ids) ---
      const validatedEdges: ExtractedPipelineEdge[] = [];
      if (Array.isArray(data.edges)) {
        for (const e of data.edges as unknown[]) {
          if (!e || typeof e !== "object") continue;
          const r = e as Record<string, unknown>;
          const from = typeof r.from === "string" ? r.from : "";
          const to = typeof r.to === "string" ? r.to : "";
          const sId = phaseIdMap.get(from);
          const tId = phaseIdMap.get(to);
          if (!sId || !tId || sId === tId) continue;
          validatedEdges.push({ source: sId, target: tId });
        }
      }

      if (allChoices.length === 0 && validatedPhases.length === 0) {
        return;
      }
      this.mutateMessage(messageId, (m) => ({
        ...m,
        extractedChoices:
          allChoices.length > 0 ? allChoices : m.extractedChoices,
        extractedPhases:
          validatedPhases.length > 0 ? validatedPhases : m.extractedPhases,
        extractedPipelineEdges:
          validatedEdges.length > 0
            ? validatedEdges
            : m.extractedPipelineEdges,
      }));
      this.persist();
    } catch {
      // Silent — extractor failures shouldn't surface in the UI; the user
      // can still answer in chat the normal way.
    } finally {
      this.mutateMessage(messageId, (m) => ({ ...m, extracting: false }));
      this.persist();
    }
  };

  /**
   * Submit an answer to one of the post-stream-extracted choices on the
   * canvas. Records the answer on the originating assistant message and
   * fires a follow-up user turn ("I picked …") so the chat can continue.
   */
  submitExtractedChoice = async (
    messageId: string,
    choiceId: string,
    answer: string | string[],
    skillSlugs: string[],
    snapshot: SkillSnapshot[],
    extra?: {
      contextFiles?: string[];
      artifactNotes?: Record<string, string>;
    },
  ): Promise<void> => {
    if (this.state.streaming) {
      return;
    }
    const msg = this.state.messages.find((m) => m.id === messageId);
    const choice = msg?.extractedChoices?.find((c) => c.id === choiceId);
    if (!choice) return;
    this.mutateMessage(messageId, (m) => ({
      ...m,
      extractedChoicesAnswered: {
        ...(m.extractedChoicesAnswered ?? {}),
        [choiceId]: answer,
      },
    }));
    this.persist();
    const human = Array.isArray(answer) ? answer.join(", ") : answer;
    const text = `For the choice you offered (${choice.question}): ${human}.\n\nPlease continue.`;
    await this.send({
      text,
      skillSlugs,
      snapshot,
      contextFiles: extra?.contextFiles,
      artifactNotes: extra?.artifactNotes,
    });
  };

  submitEdit = async (opts: EditOptions): Promise<void> => {
    const { messageId, selectionStart, selectionEnd, selectionText, fullMessage, instruction } = opts;
    const target = this.state.messages.find((m) => m.id === messageId);
    if (!target) return;
    if (target.pending) {
      this.setError("Can't edit a message that's still streaming.");
      return;
    }

    this.setState({ streaming: true, error: null });

    let newText = "";
    const applyNewText = () => {
      this.mutateMessage(messageId, (m) => ({
        ...m,
        content:
          fullMessage.slice(0, selectionStart) +
          newText +
          fullMessage.slice(selectionEnd),
      }));
    };
    applyNewText();

    const ctrl = new AbortController();
    this.abort = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "edit",
          skillSlugs: [],
          edit: {
            fullMessage,
            selection: selectionText,
            instruction,
          },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }

      await this.consumeStreamForEdit(res.body, (delta) => {
        newText += delta;
        applyNewText();
      });

      this.mutateMessage(messageId, (m) => ({
        ...m,
        edits: [
          ...(m.edits ?? []),
          {
            start: selectionStart,
            end: selectionEnd,
            originalText: selectionText,
            newText,
            instruction,
          },
        ],
      }));
    } catch (err) {
      // Either path restores the original message text; only a *real* error
      // also surfaces a red banner. Refresh-time aborts go silent.
      this.mutateMessage(messageId, (m) => ({ ...m, content: fullMessage }));
      if (!this.wasCancelled(err)) {
        this.setError(err instanceof Error ? err.message : "Edit failed.");
      }
    } finally {
      this.abort = null;
      this.setState({ streaming: false });
    }
  };

  private async consumeStream(body: ReadableStream<Uint8Array>, aid: string) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (!chunk.trim()) continue;
          const { ev, payload } = parseSSE(chunk);
          if (!ev || !payload) continue;
          this.handleSSE(ev, payload, aid);
        }
      }
    } finally {
      // The stream ended (cleanly, aborted, or errored). Close out any tool
      // whose `content_block_stop` never arrived — e.g. the claude CLI tears
      // down the turn on AskUserQuestion before closing the block. Parse the
      // accumulated inputRaw into input so the question card can still render,
      // and mark it done so it stops showing "still streaming…" forever.
      this.finalizePendingTools(aid);
    }
  }

  /** Finalize tool activity items still marked streaming after the stream ends:
   *  best-effort parse inputRaw → input, and set done. Idempotent. */
  private finalizePendingTools(aid: string) {
    this.mutateMessage(aid, (m) => {
      if (!m.activity?.some((a) => a.kind === "tool" && !a.done)) return m;
      const activity = m.activity.map((a) => {
        if (a.kind !== "tool" || a.done) return a;
        let input = a.input;
        if (input == null && a.inputRaw) {
          try {
            input = JSON.parse(a.inputRaw);
          } catch {
            // incomplete/invalid JSON — leave null; the raw text still shows
          }
        }
        return { ...a, input, done: true };
      });
      return { ...m, activity };
    });
  }

  private async consumeStreamForEdit(
    body: ReadableStream<Uint8Array>,
    onDelta: (text: string) => void,
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!chunk.trim()) continue;
        const { ev, payload } = parseSSE(chunk);
        if (!ev || !payload) continue;
        if (ev === "delta" && typeof payload.text === "string") {
          onDelta(payload.text);
        } else if (ev === "error") {
          throw new Error(String(payload.message ?? "Stream error."));
        }
      }
    }
  }

  private handleSSE(ev: string, payload: Record<string, unknown>, aid: string) {
    switch (ev) {
      case "init":
        this.setState({
          session: {
            model: payload.model as string | undefined,
            session_id: payload.session_id as string | undefined,
            api_key_source: payload.api_key_source as string | undefined,
            claude_code_version: payload.claude_code_version as string | undefined,
            permission_mode: payload.permission_mode as string | undefined,
          },
        });
        break;
      case "status":
        this.mutateMessage(aid, (m) => ({
          ...m,
          pending: true,
          activity: [
            ...(m.activity ?? []).filter((a) => a.kind !== "status"),
            { kind: "status", text: String(payload.status ?? "") },
          ],
        }));
        break;
      case "thinking_start":
        this.mutateMessage(aid, (m) => ({
          ...m,
          activity: [
            ...(m.activity ?? []),
            { kind: "thinking", text: "", done: false },
          ],
        }));
        break;
      case "thinking_delta":
        this.mutateMessage(aid, (m) => {
          const activity = [...(m.activity ?? [])];
          for (let i = activity.length - 1; i >= 0; i--) {
            const a = activity[i];
            if (a.kind === "thinking" && !a.done) {
              activity[i] = { ...a, text: a.text + String(payload.text ?? "") };
              break;
            }
          }
          return { ...m, activity };
        });
        break;
      case "thinking_stop":
        this.mutateMessage(aid, (m) => {
          const activity = [...(m.activity ?? [])];
          for (let i = activity.length - 1; i >= 0; i--) {
            const a = activity[i];
            if (a.kind === "thinking" && !a.done) {
              activity[i] = { ...a, done: true };
              break;
            }
          }
          return { ...m, activity };
        });
        break;
      case "tool_start":
        this.mutateMessage(aid, (m) => ({
          ...m,
          activity: [
            ...(m.activity ?? []),
            {
              kind: "tool",
              id: String(payload.id ?? ""),
              name: String(payload.name ?? ""),
              input: null,
              inputRaw: "",
              done: false,
            },
          ],
        }));
        break;
      case "tool_input_delta":
        this.mutateMessage(aid, (m) => {
          const activity = [...(m.activity ?? [])];
          for (let i = activity.length - 1; i >= 0; i--) {
            const a = activity[i];
            if (a.kind === "tool" && a.id === payload.id && !a.done) {
              activity[i] = {
                ...a,
                inputRaw: a.inputRaw + String(payload.partial_json ?? ""),
              };
              break;
            }
          }
          return { ...m, activity };
        });
        break;
      case "tool_stop":
        this.mutateMessage(aid, (m) => {
          const activity = [...(m.activity ?? [])];
          for (let i = activity.length - 1; i >= 0; i--) {
            const a = activity[i];
            if (a.kind === "tool" && a.id === payload.id && !a.done) {
              activity[i] = {
                ...a,
                input: payload.input ?? null,
                done: true,
              };
              break;
            }
          }
          return { ...m, activity };
        });
        break;
      case "tool_result":
        this.mutateMessage(aid, (m) => {
          const activity = [...(m.activity ?? [])];
          for (let i = activity.length - 1; i >= 0; i--) {
            const a = activity[i];
            if (a.kind === "tool" && a.id === payload.id) {
              activity[i] = {
                ...a,
                result: formatResult(payload.content),
                resultError: Boolean(payload.is_error),
              };
              break;
            }
          }
          return { ...m, activity };
        });
        break;
      case "delta":
        this.mutateMessage(aid, (m) => ({
          ...m,
          content: m.content + String(payload.text ?? ""),
          pending: false,
        }));
        break;
      case "result": {
        // A result with is_error carries the real failure reason (e.g. an
        // upstream API error surfaced by the CLI) — show it, don't just record
        // stats and let a generic trailing "error" event mislabel it.
        if (payload.is_error) {
          const reason = humanizeAgentError(String(payload.result ?? ""));
          this.setError(reason);
          this.mutateMessage(aid, (m) => ({
            ...m,
            pending: false,
            errored: true,
            content: m.content || reason,
          }));
          break;
        }
        this.mutateMessage(aid, (m) => ({
          ...m,
          stats: {
            cost_usd: payload.total_cost_usd as number | undefined,
            duration_ms: payload.duration_ms as number | undefined,
            num_turns: payload.num_turns as number | undefined,
            usage: payload.usage as Record<string, unknown> | undefined,
            model_usage: payload.model_usage as
              | Record<string, Record<string, unknown>>
              | undefined,
          },
        }));
        break;
      }
      case "end":
      case "message_stop":
        break;
      case "error": {
        const reason = humanizeAgentError(String(payload.message ?? "Stream error."));
        this.setError(reason);
        this.mutateMessage(aid, (m) => ({
          ...m,
          pending: false,
          errored: true,
          // Don't overwrite a clearer message already set by a prior is_error result.
          content: m.content || reason,
        }));
        break;
      }
      default:
        break;
    }
  }
}

/** Turn a raw agent/CLI error string into a human-readable message. The claude
 *  CLI surfaces upstream HTTP failures as `API Error: <status> {json}` (and the
 *  Labee inference proxy puts a friendly reason in that json's `error`/`message`),
 *  so unwrap it rather than showing the raw dump or a bare "HTTP 500". */
export function humanizeAgentError(raw: string): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "The request failed.";
  const m = msg.match(/API Error:\s*(\d{3})\s*(\{[\s\S]*\})/);
  if (m) {
    try {
      const body = JSON.parse(m[2]!) as { error?: unknown; message?: unknown };
      const errObj = body.error;
      const nested =
        errObj && typeof errObj === "object"
          ? (errObj as { message?: unknown }).message
          : undefined;
      const inner: string =
        typeof errObj === "string"
          ? errObj
          : typeof nested === "string"
            ? nested
            : typeof body.message === "string"
              ? body.message
              : "";
      if (inner) return inner;
    } catch {
      /* not JSON — fall through */
    }
  }
  // Strip a leading "claude CLI exited with code N: " wrapper if present.
  return msg.replace(/^claude CLI exited with code \d+:\s*/i, "") || msg;
}

function parseSSE(chunk: string): {
  ev: string | null;
  payload: Record<string, unknown> | null;
} {
  const lines = chunk.split("\n");
  let ev = "message";
  let dataLine = "";
  for (const line of lines) {
    if (line.startsWith("event:")) ev = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!dataLine) return { ev: null, payload: null };
  try {
    return { ev, payload: JSON.parse(dataLine) as Record<string, unknown> };
  } catch {
    return { ev: null, payload: null };
  }
}

export const chatStore = new ChatStore();
