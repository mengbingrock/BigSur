"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Send,
  Loader2,
  SquareCheck,
  Square,
  Brain,
  Wrench,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Globe,
  FileSearch,
  BookOpen,
  Pencil,
  X,
  Undo2,
} from "lucide-react";
import type { Skill } from "@/lib/types";
import type { DeckFile } from "@/lib/deck-shared";
import {
  chatStore,
  formatResult,
  makeId,
  type ActivityItem,
  type ChatMsg,
  type SessionInfo,
  type SkillSnapshot,
  type Stats,
} from "@/lib/chat-store";
import Markdown from "./Markdown";
import ChatDeckPanel, { type ChatDeckPanelHandle } from "./ChatDeckPanel";

interface Props {
  skills: Skill[];
  initialDeckFiles: DeckFile[];
  deckMaxBytes: number;
}

interface ActiveSelection {
  messageId: string;
  text: string;
  start: number;
  end: number;
  /** Bounding rect of the selection at the moment it was captured, viewport-relative. */
  rect: { top: number; left: number; bottom: number; right: number };
}

const SELECTED_KEY = "monterey.selectedSkills.v1";

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function toolIcon(name: string) {
  if (name === "WebSearch") return <Globe size={13} />;
  if (name === "WebFetch") return <FileSearch size={13} />;
  return <Wrench size={13} />;
}

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "(empty)";
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.url === "string") return obj.url;
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(input);
}

function formatCost(usd?: number) {
  if (typeof usd !== "number") return null;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms?: number) {
  if (typeof ms !== "number") return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function Chat({ skills, initialDeckFiles, deckMaxBytes }: Props) {
  // Chat session state (messages, streaming, error, session) lives in a
  // module-scoped store so the live fetch survives navigation away from
  // /chat. UI-only state (input, selection, scroll) stays local.
  const sessionState = useSyncExternalStore(
    chatStore.subscribe,
    chatStore.getState,
    chatStore.getServerSnapshot,
  );
  const { messages, streaming, error, session } = sessionState;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [input, setInput] = useState("");
  const [pinned, setPinned] = useState(true);
  const [activeSelection, setActiveSelection] =
    useState<ActiveSelection | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const deckPanelRef = useRef<ChatDeckPanelHandle | null>(null);
  const setError = (e: string | null) => chatStore.setError(e);

  useEffect(() => {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_KEY) : null;
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as string[];
      const known = new Set(skills.map((s) => s.slug));
      setSelected(new Set(arr.filter((s) => known.has(s))));
    } catch {
      // ignore
    }
  }, [skills]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SELECTED_KEY,
      JSON.stringify(Array.from(selected)),
    );
  }, [selected]);

  // Refresh the working-directory panel whenever a chat turn ends — the model
  // may have written new files into ./deck/ during the turn.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      deckPanelRef.current?.refresh();
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNewTurn = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    // Scroll to bottom only when a new turn is added (so the user sees their own
    // message land) or when the user was already pinned to the bottom. While
    // content streams into an existing assistant turn, leave the scroll alone
    // if the user has scrolled up to read earlier content.
    if (isNewTurn || stickToBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      stickToBottomRef.current = true;
    }
  }, [messages]);

  const onScrollList = () => {
    const el = scrollRef.current;
    if (!el) return;
    const slack = 48;
    const atBottom =
      el.scrollHeight - (el.scrollTop + el.clientHeight) <= slack;
    stickToBottomRef.current = atBottom;
    if (atBottom !== pinned) setPinned(atBottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setPinned(true);
  };

  const selectedSkills = useMemo(
    () => skills.filter((s) => selected.has(s.slug)),
    [skills, selected],
  );

  // Slash-command picker: when the textarea content is just "/<word>",
  // surface installed skills whose name/slug matches.
  const slashQuery = useMemo<string | null>(() => {
    const m = input.match(/^\s*\/([\w-]*)$/);
    return m ? m[1] : null;
  }, [input]);

  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return skills.slice(0, 8);
    const score = (s: Skill) => {
      const name = s.name.toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      if (s.slug.toLowerCase().startsWith(q)) return 2;
      if (name.includes(q)) return 3;
      return 4;
    };
    return skills
      .map((s) => [score(s), s] as const)
      .filter(([k]) => k < 4 || skills.length < 5)
      .sort(([a], [b]) => a - b)
      .map(([, s]) => s)
      .slice(0, 8);
  }, [skills, slashQuery]);

  const slashOpen = slashQuery !== null && slashMatches.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery, slashMatches.length]);

  const pickSkill = (skill: Skill) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(skill.slug);
      return next;
    });
    setInput("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const toggleSkill = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const cancel = () => chatStore.cancel();

  // Capture a text selection inside an assistant message. We resolve the raw
  // offset in the message's markdown via exact indexOf — works when the
  // selection doesn't straddle markdown syntax like **bold**. If the text
  // can't be located in the raw content, we show a helpful error and ignore.
  const handleMouseUp = (messageId: string, content: string) => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString();
    if (!text || !text.trim()) {
      if (activeSelection?.messageId === messageId) setActiveSelection(null);
      return;
    }
    const start = content.indexOf(text);
    if (start === -1) {
      setError(
        "Can't locate that selection in the raw message markdown — pick a selection that doesn't straddle formatting characters (like **bold**).",
      );
      setActiveSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    setError(null);
    setActiveSelection({
      messageId,
      text,
      start,
      end: start + text.length,
      rect: {
        top: last.top,
        left: last.left,
        bottom: last.bottom,
        right: last.right,
      },
    });
  };

  const clearSelection = () => {
    if (typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
    setActiveSelection(null);
  };

  const undoEdit = (messageId: string) => chatStore.undoEdit(messageId);

  const submitEdit = async (sel: ActiveSelection, instruction: string) => {
    const target = messages.find((m) => m.id === sel.messageId);
    if (!target) return;
    setInput("");
    clearSelection();
    await chatStore.submitEdit({
      messageId: sel.messageId,
      selectionStart: sel.start,
      selectionEnd: sel.end,
      selectionText: sel.text,
      fullMessage: target.content,
      instruction,
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");

    const snapshot: SkillSnapshot[] = selectedSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      sourceLabel: s.sourceLabel,
      allowedTools: s.allowedTools,
      bodyChars: s.body.length,
    }));

    await chatStore.send({
      text,
      skillSlugs: Array.from(selected),
      snapshot,
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = slashMatches[slashIndex];
        if (pick) pickSkill(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[18rem,1fr]">
      <aside className="order-2 lg:order-1">
        <div className="sticky top-6 border border-rule p-5">
          <p className="mb-3 text-xs uppercase tracking-[0.18em] text-muted">
            Active skills
          </p>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Selected skills are symlinked into the spawned{" "}
            <code className="font-mono">claude</code> process. Claude Code&apos;s
            user-level skills (docx, xlsx, pptx, pdf, canvas-design, …) also
            load by default.
          </p>
          <div className="flex flex-col gap-1">
            {skills.length === 0 && (
              <p className="text-sm text-muted">(No skills indexed.)</p>
            )}
            {skills.map((s) => {
              const on = selected.has(s.slug);
              return (
                <button
                  type="button"
                  key={s.slug}
                  onClick={() => toggleSkill(s.slug)}
                  className={`group flex items-start gap-2 rounded-sm px-2 py-2 text-left transition ${
                    on ? "bg-ink/5" : "hover:bg-ink/5"
                  }`}
                >
                  <span className="mt-0.5 text-ink">
                    {on ? <SquareCheck size={16} /> : <Square size={16} />}
                  </span>
                  <span className="flex-1">
                    <span className="block font-serif text-sm leading-tight text-ink">
                      {s.name}
                    </span>
                    {s.description && (
                      <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted">
                        {s.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedSkills.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="mt-4 text-xs text-muted underline underline-offset-2 transition hover:text-ink"
            >
              Clear selection
            </button>
          )}

          <hr className="my-5 border-rule" />

          <ChatDeckPanel
            ref={deckPanelRef}
            initialFiles={initialDeckFiles}
            maxBytes={deckMaxBytes}
          />
        </div>
      </aside>

      <section className="order-1 flex min-h-[60vh] flex-col border border-rule lg:order-2">
        <SessionHeader
          session={session}
          selectedSkills={selectedSkills}
        />

        <div className="relative flex-1 min-h-0">
        {streaming && !pinned && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 right-4 z-10 inline-flex items-center gap-1.5 border border-ink bg-paper px-2.5 py-1 text-[11px] font-medium text-ink shadow-sm transition hover:bg-ink hover:text-paper"
          >
            <ChevronDown size={12} />
            Jump to latest
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={onScrollList}
          className="h-full overflow-y-auto px-6 py-8"
          style={{ maxHeight: "70vh" }}
        >
          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl text-center">
              <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
                Chat
              </p>
              <p className="font-serif text-2xl leading-snug text-ink">
                Ask the selected skills a question.
              </p>
              <p className="mt-4 text-sm text-muted">
                {selectedSkills.length === 0
                  ? "No skill active — you'll get a plain Claude response. Pick a skill on the left to specialize the assistant."
                  : `${selectedSkills.length} skill${
                      selectedSkills.length === 1 ? "" : "s"
                    } active: ${selectedSkills.map((s) => s.name).join(", ")}`}
              </p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-10">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onMouseUp={handleMouseUp}
                  onUndoEdit={undoEdit}
                  selected={activeSelection?.messageId === m.id}
                />
              ))}
            </div>
          )}
        </div>
        </div>

        <div className="border-t border-rule px-4 py-3 sm:px-6 sm:py-4">
          {error && (
            <div className="mb-3 border border-rule bg-ink/5 px-3 py-2 text-xs text-ink">
              {error}
            </div>
          )}
          <div className="relative flex items-end gap-3">
            {slashOpen && (
              <SlashSuggestions
                matches={slashMatches}
                activeIndex={slashIndex}
                onPick={pickSkill}
                onHover={setSlashIndex}
              />
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                selectedSkills.length > 0
                  ? `Ask with ${selectedSkills.length} skill${
                      selectedSkills.length === 1 ? "" : "s"
                    } active…`
                  : "Ask anything… (type / to pick a skill, Shift+Enter for newline)"
              }
              rows={2}
              className="flex-1 resize-none border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none"
              disabled={streaming}
            />
            {streaming ? (
              <button
                type="button"
                onClick={cancel}
                className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 text-sm text-paper transition hover:opacity-90"
              >
                <Loader2 size={14} className="animate-spin" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!input.trim()}
                className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 text-sm text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted"
              >
                Send
                <Send size={14} />
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Using your local <code className="font-mono">claude</code> CLI
            (claude.ai OAuth — no API key). Full toolset (Bash, Read, Write,
            Edit, Grep, Glob, WebSearch, WebFetch, Skill) + user-level skills
            (docx, xlsx, pdf, …). Files the assistant writes appear below the
            message as downloads.
          </p>
        </div>
      </section>

      {activeSelection && (
        <EditPopover
          selection={activeSelection}
          onCancel={clearSelection}
          onSubmit={(instruction) => submitEdit(activeSelection, instruction)}
          streaming={streaming}
        />
      )}
    </div>
  );
}

function SlashSuggestions({
  matches,
  activeIndex,
  onPick,
  onHover,
}: {
  matches: Skill[];
  activeIndex: number;
  onPick: (s: Skill) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto border border-rule bg-paper shadow-md">
      <div className="border-b border-rule px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-muted">
        Skills
      </div>
      <ul role="listbox">
        {matches.map((s, i) => {
          const active = i === activeIndex;
          return (
            <li
              key={s.slug}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown so the textarea doesn't lose focus before click fires
                e.preventDefault();
                onPick(s);
              }}
              className={`flex cursor-pointer items-start gap-3 px-3 py-2 ${
                active ? "bg-ink/5" : ""
              }`}
            >
              <span className="mt-0.5 font-mono text-xs text-muted">/</span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-mono text-sm text-ink">
                  {s.name}
                </span>
                {s.description && (
                  <span className="mt-0.5 line-clamp-2 text-xs text-muted">
                    {s.description}
                  </span>
                )}
              </span>
              <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-muted">
                {s.sourceLabel}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-rule px-3 py-1.5 text-[10px] text-muted">
        ↑↓ to move · Enter / Tab to select · Esc to cancel
      </div>
    </div>
  );
}

function EditPopover({
  selection,
  onCancel,
  onSubmit,
  streaming,
}: {
  selection: ActiveSelection;
  onCancel: () => void;
  onSubmit: (instruction: string) => void;
  streaming: boolean;
}) {
  const [instruction, setInstruction] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      // Don't dismiss if the user is dragging a new selection — let the
      // mouseup handler reset the selection state naturally.
      onCancel();
    };
    const onScroll = () => onCancel();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onCancel]);

  const popoverWidth = 380;
  const popoverHeight = 200;
  const margin = 12;

  // Anchor to the bottom-right corner of the selection; clamp inside the viewport.
  const anchorTop = selection.rect.bottom + 8;
  const anchorLeft = selection.rect.left;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  let top = anchorTop;
  let left = anchorLeft;
  if (left + popoverWidth + margin > vw) left = vw - popoverWidth - margin;
  if (left < margin) left = margin;
  if (top + popoverHeight + margin > vh) {
    // Flip above the selection instead.
    top = selection.rect.top - popoverHeight - 8;
  }
  if (top < margin) top = margin;

  const submit = () => {
    const t = instruction.trim();
    if (!t || streaming) return;
    onSubmit(t);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Edit selection"
      className="fixed z-50 flex flex-col border border-ink bg-paper shadow-lg"
      style={{ top, left, width: popoverWidth }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-rule px-3 py-2">
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted">
            Edit selection · {selection.text.length} chars
          </p>
          <p className="mt-1 line-clamp-2 font-serif text-[12px] italic leading-snug text-ink">
            &ldquo;{truncate(selection.text, 180)}&rdquo;
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-sm p-0.5 text-muted transition hover:bg-ink/10 hover:text-ink"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={onKey}
        placeholder="How should this be rewritten? (e.g. make concise, add catalog #, translate to French)"
        rows={3}
        className="w-full resize-none border-0 bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none"
        disabled={streaming}
      />
      <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-2">
        <p className="text-[10px] text-muted">
          Enter to apply · Esc to cancel
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted underline underline-offset-2 transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!instruction.trim() || streaming}
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3 py-1 text-xs text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted"
          >
            {streaming ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Editing…
              </>
            ) : (
              <>
                <Pencil size={12} />
                Apply edit
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionHeader({
  session,
  selectedSkills,
}: {
  session: SessionInfo | null;
  selectedSkills: Skill[];
}) {
  const skillCount = selectedSkills.length;
  return (
    <div className="border-b border-rule px-6 py-3 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 uppercase tracking-[0.14em]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink" />
          {session?.model ?? "claude-opus (pending)"}
        </span>
        <span>
          {skillCount} skill{skillCount === 1 ? "" : "s"} loaded
        </span>
        <span>WebSearch + WebFetch</span>
        {session?.api_key_source && <span>auth: {session.api_key_source}</span>}
        {session?.session_id && (
          <span className="truncate font-mono text-[10px] normal-case tracking-normal">
            sess {session.session_id.slice(0, 8)}
          </span>
        )}
      </div>
      {skillCount > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectedSkills.map((s) => (
            <span
              key={s.slug}
              title={s.description}
              className="inline-flex items-center gap-1 border border-rule bg-paper px-2 py-0.5 font-mono text-[10px] normal-case tracking-normal text-ink"
            >
              <span className="text-muted">{s.sourceLabel}/</span>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onMouseUp,
  onUndoEdit,
  selected,
}: {
  msg: ChatMsg;
  onMouseUp: (id: string, content: string) => void;
  onUndoEdit: (id: string) => void;
  selected: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs uppercase tracking-[0.18em] text-muted">You</div>
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
          {msg.content}
        </p>
      </div>
    );
  }

  const editable = !msg.pending && !msg.errored && Boolean(msg.content);
  const editCount = msg.edits?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-muted">
        <span>Assistant</span>
        {editCount > 0 && (
          <button
            type="button"
            onClick={() => onUndoEdit(msg.id)}
            className="inline-flex items-center gap-1 text-[11px] normal-case tracking-normal text-muted underline underline-offset-2 transition hover:text-ink"
          >
            <Undo2 size={11} />
            Undo edit{editCount > 1 ? ` (${editCount})` : ""}
          </button>
        )}
      </div>
      {((msg.activity && msg.activity.length > 0) ||
        (msg.loadedSkills && msg.loadedSkills.length > 0) ||
        msg.stats) && (
        <ActivityPanel
          activity={msg.activity ?? []}
          stats={msg.stats}
          pending={msg.pending}
          loadedSkills={msg.loadedSkills ?? []}
        />
      )}
      {msg.errored ? (
        <div className="border border-rule bg-ink/5 p-4 text-sm text-ink">
          <p className="font-medium">Error</p>
          <p className="mt-1 text-muted">{msg.content}</p>
        </div>
      ) : msg.pending && !msg.content ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" />
          Thinking…
        </div>
      ) : (
        <div
          onMouseUp={editable ? () => onMouseUp(msg.id, msg.content) : undefined}
          className={
            selected
              ? "rounded-sm ring-1 ring-ink ring-offset-2 ring-offset-paper"
              : undefined
          }
        >
          <Markdown>{msg.content}</Markdown>
        </div>
      )}
    </div>
  );
}

function ActivityPanel({
  activity,
  stats,
  pending,
  loadedSkills,
}: {
  activity: ActivityItem[];
  stats?: Stats;
  pending?: boolean;
  loadedSkills: SkillSnapshot[];
}) {
  const [open, setOpen] = useState(false);
  const tools = activity.filter((a) => a.kind === "tool") as Extract<
    ActivityItem,
    { kind: "tool" }
  >[];
  const thoughts = activity.filter((a) => a.kind === "thinking") as Extract<
    ActivityItem,
    { kind: "thinking" }
  >[];
  const status = activity.find((a) => a.kind === "status") as
    | Extract<ActivityItem, { kind: "status" }>
    | undefined;

  const hasThinking = thoughts.length > 0;
  const activeTool = tools.find((t) => !t.done);
  const cost = formatCost(stats?.cost_usd);
  const dur = formatDuration(stats?.duration_ms);

  return (
    <div className="border border-rule bg-ink/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-muted transition hover:bg-ink/5"
      >
        <span className="flex items-center gap-3">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {loadedSkills.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <BookOpen size={13} />
              {loadedSkills.length} skill
              {loadedSkills.length === 1 ? "" : "s"} loaded
            </span>
          )}
          {hasThinking && (
            <span className="inline-flex items-center gap-1">
              <Brain size={13} />
              {thoughts.length} thought{thoughts.length === 1 ? "" : "s"}
            </span>
          )}
          {tools.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Wrench size={13} />
              {tools.length} tool call{tools.length === 1 ? "" : "s"}
            </span>
          )}
          {activeTool && (
            <span className="inline-flex items-center gap-1 text-ink">
              <Loader2 size={12} className="animate-spin" />
              {activeTool.name}
            </span>
          )}
          {!activeTool && pending && status && (
            <span className="inline-flex items-center gap-1 text-ink">
              <Loader2 size={12} className="animate-spin" />
              {status.text}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3 text-[11px]">
          {dur && <span>{dur}</span>}
          {cost && <span>{cost}</span>}
          {stats?.num_turns && stats.num_turns > 1 && (
            <span>{stats.num_turns} iterations</span>
          )}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
          {loadedSkills.length > 0 && (
            <SkillsLoadedBlock skills={loadedSkills} />
          )}
          {thoughts.map((t, i) => (
            <ThinkingBlock key={`t-${i}`} item={t} />
          ))}
          {tools.map((t) => (
            <ToolBlock key={t.id} item={t} />
          ))}
          {stats && <StatsBlock stats={stats} />}
        </div>
      )}
    </div>
  );
}

function SkillsLoadedBlock({ skills }: { skills: SkillSnapshot[] }) {
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  return (
    <div className="flex gap-2 text-sm">
      <BookOpen size={14} className="mt-0.5 shrink-0 text-muted" />
      <div className="flex-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted">
          Skills symlinked into .claude/skills/ · available natively via Skill
          tool
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {skills.map((s) => {
            const open = expandedSlug === s.slug;
            return (
              <li key={s.slug} className="border border-rule bg-paper">
                <button
                  type="button"
                  onClick={() => setExpandedSlug(open ? null : s.slug)}
                  className="flex w-full items-start justify-between gap-3 px-2.5 py-1.5 text-left transition hover:bg-ink/5"
                >
                  <span className="flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-muted">
                        {s.sourceLabel}
                      </span>
                      <span className="font-mono text-[12px] font-medium text-ink">
                        {s.name}
                      </span>
                    </span>
                    {s.description && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                        {truncate(s.description, 180)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 text-muted">
                    {open ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-rule px-2.5 py-2 text-[11px] text-muted">
                    {s.allowedTools.length > 0 && (
                      <p className="mb-1">
                        <span className="uppercase tracking-[0.14em]">
                          Original allowed-tools:
                        </span>{" "}
                        <span className="font-mono">
                          {s.allowedTools.join(", ")}
                        </span>
                      </p>
                    )}
                    <p>
                      <a
                        href={`/skills/${s.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-ink"
                      >
                        Open full SKILL.md →
                      </a>
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ThinkingBlock({
  item,
}: {
  item: Extract<ActivityItem, { kind: "thinking" }>;
}) {
  return (
    <div className="flex gap-2 text-sm">
      <Brain size={14} className="mt-0.5 shrink-0 text-muted" />
      <div className="flex-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted">
          Thinking {item.done ? "" : "(streaming…)"}
        </p>
        {item.text ? (
          <p className="mt-1 whitespace-pre-wrap text-[13px] italic leading-relaxed text-muted">
            {item.text}
          </p>
        ) : (
          <p className="mt-1 text-[12px] italic text-muted">
            (reasoning hidden — Opus 4.7 omits thinking text by default)
          </p>
        )}
      </div>
    </div>
  );
}

function ToolBlock({
  item,
}: {
  item: Extract<ActivityItem, { kind: "tool" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = formatInput(item.input);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-2 text-left"
      >
        <span className="mt-0.5 shrink-0 text-ink">{toolIcon(item.name)}</span>
        <span className="flex-1">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-medium text-ink">
              {item.name}
            </span>
            {item.done ? (
              item.resultError ? (
                <XCircle size={12} className="text-ink" />
              ) : item.result !== undefined ? (
                <CheckCircle2 size={12} className="text-ink" />
              ) : (
                <Loader2 size={12} className="animate-spin text-muted" />
              )
            ) : (
              <Loader2 size={12} className="animate-spin text-muted" />
            )}
          </span>
          <span className="mt-1 block truncate font-mono text-[12px] text-muted">
            {truncate(inputStr, 140)}
          </span>
        </span>
        <span className="text-muted">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {expanded && (
        <div className="ml-6 flex flex-col gap-2 border-l border-rule pl-3 text-xs">
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted">
              Input
            </p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm bg-ink/5 px-2 py-1.5 font-mono text-[11px] text-ink">
              {item.input !== null
                ? JSON.stringify(item.input, null, 2)
                : item.inputRaw || "(none)"}
            </pre>
          </div>
          {item.result !== undefined && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted">
                Result {item.resultError ? "(error)" : ""}
              </p>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-sm bg-ink/5 px-2 py-1.5 font-mono text-[11px] text-ink">
                {truncate(item.result, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatsBlock({ stats }: { stats: Stats }) {
  const cost = formatCost(stats.cost_usd);
  const dur = formatDuration(stats.duration_ms);
  const usage = stats.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;

  return (
    <div className="mt-1 border-t border-rule pt-3 text-[11px] text-muted">
      <p className="mb-1.5 uppercase tracking-[0.16em]">Run</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
        {dur && <span>duration {dur}</span>}
        {cost && <span>cost {cost}</span>}
        {typeof stats.num_turns === "number" && (
          <span>turns {stats.num_turns}</span>
        )}
        {usage?.input_tokens !== undefined && (
          <span>in {usage.input_tokens}</span>
        )}
        {usage?.output_tokens !== undefined && (
          <span>out {usage.output_tokens}</span>
        )}
        {usage?.cache_read_input_tokens !== undefined &&
          usage.cache_read_input_tokens > 0 && (
            <span>cache-read {usage.cache_read_input_tokens}</span>
          )}
        {usage?.cache_creation_input_tokens !== undefined &&
          usage.cache_creation_input_tokens > 0 && (
            <span>cache-write {usage.cache_creation_input_tokens}</span>
          )}
      </div>
      {stats.model_usage && (
        <div className="mt-2 flex flex-col gap-0.5 font-mono">
          {Object.entries(stats.model_usage).map(([model, u]) => {
            const mu = u as {
              inputTokens?: number;
              outputTokens?: number;
              costUSD?: number;
            };
            return (
              <span key={model}>
                {model}: in {mu.inputTokens ?? 0} / out {mu.outputTokens ?? 0} /{" "}
                {formatCost(mu.costUSD) ?? "$0"}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
