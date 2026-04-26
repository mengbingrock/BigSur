"use client";

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
}

export interface SessionInfo {
  model?: string;
  session_id?: string;
  api_key_source?: string;
  claude_code_version?: string;
  permission_mode?: string;
}

export interface ChatState {
  messages: ChatMsg[];
  streaming: boolean;
  error: string | null;
  session: SessionInfo | null;
}

export interface SendOptions {
  text: string;
  skillSlugs: string[];
  snapshot: SkillSnapshot[];
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

function readPersistedMessages(): ChatMsg[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
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
        // activity intentionally dropped on persist
      }));
  } catch {
    return [];
  }
}

function persistMessages(messages: ChatMsg[]): void {
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
    }));
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
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
  };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private hydrated = false;

  /**
   * Hydrate from localStorage on first read in the browser. Lazy so the
   * server snapshot stays empty (no SSR/CSR mismatch).
   */
  private ensureHydrated() {
    if (this.hydrated) return;
    this.hydrated = true;
    if (typeof window === "undefined") return;
    const messages = readPersistedMessages();
    if (messages.length > 0) {
      this.state = { ...this.state, messages };
    }
  }

  getState = (): ChatState => {
    this.ensureHydrated();
    return this.state;
  };

  /** Stable empty snapshot for SSR. */
  getServerSnapshot = (): ChatState => ({
    messages: [],
    streaming: false,
    error: null,
    session: null,
  });

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
    if (!this.state.streaming) persistMessages(this.state.messages);
  }

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
    persistMessages(this.state.messages);
  };

  send = async (opts: SendOptions): Promise<void> => {
    const { text, skillSlugs, snapshot } = opts;
    if (!text || this.state.streaming) return;

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
        body: JSON.stringify({ messages: history, skillSlugs }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }
      await this.consumeStream(res.body, assistantMsg.id);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
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
    }
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
      if ((err as Error).name === "AbortError") {
        this.mutateMessage(messageId, (m) => ({ ...m, content: fullMessage }));
      } else {
        this.mutateMessage(messageId, (m) => ({ ...m, content: fullMessage }));
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
      case "result":
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
      case "end":
      case "message_stop":
        break;
      case "error": {
        const reason = String(payload.message ?? "Stream error.");
        this.setError(reason);
        this.mutateMessage(aid, (m) => ({
          ...m,
          pending: false,
          errored: true,
          content: m.content || reason,
        }));
        break;
      }
      default:
        break;
    }
  }
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
