
import {
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { diffLines, structuredPatch } from "diff";

// React Flow needs the DOM (uses ResizeObserver, measures container) — load
// it lazily so it never weighs on the chat bundle.
const ProjectCanvas = lazy(() => import("./ProjectCanvas"));

// Type-only import: bundlers strip these at compile time, so it doesn't
// pull ProjectCanvas back into the chat bundle.
import type { PendingCanvasQuestion } from "./ProjectCanvas";
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
  Trash2,
  Wand2,
  Bot,
} from "lucide-react";
import type { Agent, Skill } from "@labee/contracts";
import type { DeckFile } from "@labee/contracts";
import {
  chatStore,
  formatResult,
  makeId,
  type ActivityItem,
  type AskUserAnswer,
  type ChatMsg,
  type SessionInfo,
  type SkillSnapshot,
  type Stats,
} from "../store/chat-store";
import { Markdown } from "./Markdown";
import ChatDeckPanel, { type ChatDeckPanelHandle } from "./ChatDeckPanel";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
import { Button } from "./ui/button";

interface Props {
  skills: Skill[];
  initialDeckFiles: DeckFile[];
  deckMaxBytes: number;
  agent?: Agent | null;
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

export default function Chat({
  skills,
  initialDeckFiles,
  deckMaxBytes,
  agent = null,
}: Props) {
  const queryClient = useQueryClient();
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
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    () => new Set(),
  );
  const [artifactNotes, setArtifactNotes] = useState<Record<string, string>>(
    () => ({}),
  );
  const [input, setInput] = useState("");
  // Bumped on every "Clear chat" — used as React key for ProjectCanvas so
  // the canvas remounts (drops user-added step/choice nodes and edges)
  // alongside the chat reset.
  const [canvasResetKey, setCanvasResetKey] = useState(0);
  // ProjectCanvas writes a getter into this ref. Each call returns a
  // markdown block describing pipeline-phase edits since the last
  // extraction (or null), and commits the edits so they aren't replayed.
  const canvasEditGetterRef = useRef<(() => string | null) | null>(null);
  // Height of the top canvas pane in CSS px. Persisted so the user's
  // chosen split survives reloads. Clamped at drag time to [180, 1200].
  const CANVAS_HEIGHT_KEY = "monterey.canvasHeight.v1";
  const CANVAS_HEIGHT_MIN = 180;
  const CANVAS_HEIGHT_MAX = 1200;
  const CANVAS_HEIGHT_DEFAULT = 360;
  const [canvasHeight, setCanvasHeight] = useState<number>(CANVAS_HEIGHT_DEFAULT);
  const [canvasResizing, setCanvasResizing] = useState(false);

  // Height of the bottom chat pane in CSS px. Persisted across reloads.
  // The chat is normally `flex-1` so it fills whatever the canvas leaves;
  // this value is applied as a `min-height` instead so dragging the bottom
  // handle DOWN can push the chat past the viewport (page scrolls), and
  // dragging UP shrinks it back toward the default flex-fill.
  const CHAT_HEIGHT_KEY = "monterey.chatHeight.v1";
  const CHAT_HEIGHT_MIN = 0;
  const CHAT_HEIGHT_MAX = 2400;
  const CHAT_HEIGHT_DEFAULT = 0;
  const [chatHeight, setChatHeight] = useState<number>(CHAT_HEIGHT_DEFAULT);
  const [chatResizing, setChatResizing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(CANVAS_HEIGHT_KEY);
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      setCanvasHeight(
        Math.max(CANVAS_HEIGHT_MIN, Math.min(CANVAS_HEIGHT_MAX, n)),
      );
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CANVAS_HEIGHT_KEY, String(canvasHeight));
  }, [canvasHeight]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(CHAT_HEIGHT_KEY);
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      setChatHeight(Math.max(CHAT_HEIGHT_MIN, Math.min(CHAT_HEIGHT_MAX, n)));
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_HEIGHT_KEY, String(chatHeight));
  }, [chatHeight]);

  // While the splitter is being dragged, force a row-resize cursor over the
  // whole document so it doesn't flicker back to the default when the
  // pointer briefly leaves the handle.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (canvasResizing || chatResizing) {
      const prev = document.body.style.cursor;
      document.body.style.cursor = "row-resize";
      return () => {
        document.body.style.cursor = prev;
      };
    }
  }, [canvasResizing, chatResizing]);
  const [pinned, setPinned] = useState(true);
  const [activeSelection, setActiveSelection] =
    useState<ActiveSelection | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatSectionRef = useRef<HTMLElement | null>(null);
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

  // When launched with a saved agent, preselect its skills.
  useEffect(() => {
    if (!agent) return;
    const known = new Set(skills.map((s) => s.slug));
    setSelected(new Set(agent.skillSlugs.filter((s) => known.has(s))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, skills]);

  // Refresh the working-directory panel as the model writes files. We do
  // three things:
  //   1. Poll every 2.5s while streaming so files appear as they're created,
  //      not just at turn-end.
  //   2. Do one final refresh the moment streaming flips false, in case the
  //      last write landed between polls.
  //   3. Stop polling cleanly when the component unmounts or streaming ends.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      deckPanelRef.current?.refresh();
    }
    wasStreamingRef.current = streaming;
    if (!streaming) return;
    const interval = setInterval(() => {
      deckPanelRef.current?.refresh();
    }, 2500);
    return () => clearInterval(interval);
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

  const skillsOnly = useMemo(
    () => skills.filter((s) => s.artifactKind !== "protocol"),
    [skills],
  );
  const protocolsOnly = useMemo(
    () => skills.filter((s) => s.artifactKind === "protocol"),
    [skills],
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

  const buildSkillSnapshot = (): SkillSnapshot[] =>
    selectedSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      sourceLabel: s.sourceLabel,
      allowedTools: [...s.allowedTools],
      bodyChars: s.body.length,
    }));

  // Canvas-surfaced questions (pending + already-answered). Only extracted
  // choices from plain-text replies are surfaced here; AskUserQuestion tool
  // calls live exclusively in the chatbox. The node renderer reads the
  // optional `answer` field to switch between pickable and read-only states.
  const pendingCanvasQuestions = useMemo<
    (PendingCanvasQuestion & { source: "tool" | "extracted" })[]
  >(() => {
    const out: (PendingCanvasQuestion & { source: "tool" | "extracted" })[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      // AskUserQuestion tool calls are intentionally NOT surfaced on the
      // canvas — they render only in the chatbox via AskUserQuestionBlock.
      // (1) Extracted choices from plain-text replies.
      const ec = m.extractedChoices ?? [];
      for (const c of ec) {
        const answer = m.extractedChoicesAnswered?.[c.id];
        out.push({
          messageId: m.id,
          toolUseId: c.id, // re-use the field as a unique routing key
          question: c.question,
          options: c.options.map((label) => ({ label })),
          multiSelect: c.multiSelect,
          source: "extracted",
          answer,
          kind: c.kind ?? "choice",
          parentOptions: c.parentOptions,
        });
      }
    }
    return out;
  }, [messages]);

  // Pipeline (extracted phases + edges) for the canvas — derived from all
  // assistant messages' extractor output. Phases are hierarchical;
  // sub-phases come along via the recursive type. The canvas reconciler
  // materialises top-level phases immediately, then reveals sub-phases
  // on demand when the user clicks expand.
  const canvasPipeline = useMemo<{
    phases: import("./ProjectCanvas").CanvasPhase[];
    edges: { source: string; target: string }[];
  }>(() => {
    const phases: import("./ProjectCanvas").CanvasPhase[] = [];
    const edges: { source: string; target: string }[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.extractedPhases ?? []) {
        phases.push(p);
      }
      for (const e of m.extractedPipelineEdges ?? []) {
        edges.push({ source: e.source, target: e.target });
      }
    }
    return { phases, edges };
  }, [messages]);

  const onAnswerAskUserQuestion = async (
    messageId: string,
    toolUseId: string,
    answers: AskUserAnswer[],
  ) => {
    // No closure-based `streaming` check here — that flag could be a stale
    // capture from an earlier render of Chat (the canvas's `data.onAnswer`
    // is refreshed by a reconciler effect that runs from prior renders, so
    // its closures lag the live store). chatStore.submitAskUserAnswer has
    // its own runtime check against the current store state.
    await chatStore.submitAskUserAnswer(
      messageId,
      toolUseId,
      answers,
      Array.from(selected),
      buildSkillSnapshot(),
      {
        contextFiles: Array.from(selectedFiles),
        artifactNotes,
      },
    );
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");

    // Pull any pending pipeline-phase edits from the canvas and prefix
    // them to the user message so the LLM sees the user's corrections
    // alongside whatever they just typed.
    const editPrefix = canvasEditGetterRef.current?.() ?? null;
    const composed = editPrefix ? `${editPrefix}\n\n${text}` : text;

    await chatStore.send({
      text: composed,
      skillSlugs: Array.from(selected),
      contextFiles: Array.from(selectedFiles),
      artifactNotes,
      snapshot: buildSkillSnapshot(),
      ...(agent ? { agentId: agent.id } : {}),
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

  // Pointer-driven handle on the BOTTOM edge of the chat. Drag down to
  // grow chat height (page scrolls past the viewport), drag up to shrink
  // back to the flex-1 default (chat-h reaches 0). Same window-level
  // listener pattern as the canvas/chat splitter above.
  const onChatResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    // Anchor to the chat's CURRENT rendered height (not the stored
    // chat-h, which may still be 0 from flex-1 default). This way the
    // very first pixel of drag immediately grows the chat instead of
    // doing nothing until the user passes the existing height.
    const measured =
      chatSectionRef.current?.getBoundingClientRect().height ?? 0;
    const startHeight = Math.max(chatHeight, measured);
    setChatResizing(true);
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const next = Math.max(
        CHAT_HEIGHT_MIN,
        Math.min(CHAT_HEIGHT_MAX, startHeight + dy),
      );
      setChatHeight(next);
    };
    const onUp = () => {
      setChatResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Pointer-driven splitter between canvas (top) and chat (bottom). Height
  // grows when the handle moves down. Listeners attach to `window` so a fast
  // cursor doesn't lose the drag mid-flight.
  const onCanvasResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = canvasHeight;
    setCanvasResizing(true);
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const next = Math.max(
        CANVAS_HEIGHT_MIN,
        Math.min(CANVAS_HEIGHT_MAX, startHeight + dy),
      );
      setCanvasHeight(next);
    };
    const onUp = () => {
      setCanvasResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[18rem_1fr] ${
        canvasResizing || chatResizing ? "select-none" : ""
      }`}
      style={
        {
          "--canvas-h": `${canvasHeight}px`,
          "--chat-h": `${chatHeight}px`,
        } as React.CSSProperties
      }
    >
      <aside className="order-2 min-h-0 lg:order-1">
        <div className="flex h-full flex-col overflow-y-auto rounded-lg border border-border bg-card p-5">
          {agent ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Bot size={15} className="shrink-0 text-brand" />
                <span className="min-w-0 flex-1 truncate font-display text-base text-ink" title={agent.name}>
                  {agent.name}
                </span>
                <a
                  href={`/agents/${agent.id}/edit`}
                  className="shrink-0 text-xs text-ink-light underline underline-offset-2 transition hover:text-ink"
                >
                  Edit
                </a>
              </div>
              {agent.description ? (
                <p className="mb-3 text-xs text-ink-light">{agent.description}</p>
              ) : null}
              <AgentWorkspacePanel agent={agent} streaming={streaming} />
            </>
          ) : (
            <ChatDeckPanel
              ref={deckPanelRef}
              initialFiles={initialDeckFiles}
              maxBytes={deckMaxBytes}
              selectedFiles={selectedFiles}
              onToggleFile={(qualifiedPath) =>
                setSelectedFiles((cur) => {
                  const next = new Set(cur);
                  if (next.has(qualifiedPath)) next.delete(qualifiedPath);
                  else next.add(qualifiedPath);
                  return next;
                })
              }
            />
          )}

          <hr className="my-5 border-rule" />

          <ArtifactToggleSection
            label="Active skills"
            description={
              <>
                Selected skills are symlinked into the spawned{" "}
                <code className="font-mono">claude</code> process. Claude Code&apos;s
                user-level skills (docx, xlsx, pptx, pdf, canvas-design, …) also load by default.
              </>
            }
            emptyText="(No skills indexed.)"
            artifacts={skillsOnly}
            selected={selected}
            onToggle={toggleSkill}
            artifactNotes={artifactNotes}
            onSetNote={(slug, body) =>
              setArtifactNotes((prev) => ({ ...prev, [slug]: body }))
            }
            onClearNote={(slug) =>
              setArtifactNotes((prev) => {
                const next = { ...prev };
                delete next[slug];
                return next;
              })
            }
            onApplied={() => queryClient.invalidateQueries({ queryKey: ["skills"] })}
          />

          <hr className="my-5 border-rule" />

          <ArtifactToggleSection
            label="Active protocols"
            description={
              <>
                Protocols are reference text — their full body is injected into the
                system prompt as authoritative procedure for this session, not
                wired in as a callable skill.
              </>
            }
            emptyText="(No protocols yet. Create one on the Artifacts page.)"
            artifacts={protocolsOnly}
            selected={selected}
            onToggle={toggleSkill}
            artifactNotes={artifactNotes}
            onSetNote={(slug, body) =>
              setArtifactNotes((prev) => ({ ...prev, [slug]: body }))
            }
            onClearNote={(slug) =>
              setArtifactNotes((prev) => {
                const next = { ...prev };
                delete next[slug];
                return next;
              })
            }
            onApplied={() => queryClient.invalidateQueries({ queryKey: ["skills"] })}
          />

          {selectedSkills.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="mt-4 text-xs text-muted underline underline-offset-2 transition hover:text-ink"
            >
              Clear selection
            </button>
          )}
        </div>
      </aside>

      <div className="order-1 flex h-full min-h-0 flex-col gap-0 lg:order-2">
      <aside className="relative shrink-0" style={{ height: "var(--canvas-h)" }}>
        <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-ink-light">
            <span className="flex items-center gap-2">
              <span>Canvas</span>
              {(() => {
                const extracting = messages.some((m) => m.extracting);
                if (extracting) {
                  return (
                    <span className="inline-flex items-center gap-1 border border-rule bg-paper px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-muted">
                      <Loader2 size={10} className="animate-spin" />
                      Extracting structure…
                    </span>
                  );
                }
                const unanswered = pendingCanvasQuestions.filter(
                  (q) => q.answer === undefined,
                ).length;
                return unanswered > 0 ? (
                  <span className="inline-flex items-center gap-1 border border-ink bg-ink px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal text-paper">
                    {unanswered} question{unanswered === 1 ? "" : "s"}
                  </span>
                ) : null;
              })()}
            </span>
            <span className="font-mono normal-case tracking-normal text-[10px] text-muted">
              drag · zoom · connect
            </span>
          </div>
          <div className="relative flex-1 min-h-0">
            <ProjectCanvas
              key={canvasResetKey}
              pendingQuestions={pendingCanvasQuestions}
              pipeline={canvasPipeline}
              editGetterRef={canvasEditGetterRef}
              onSendToChat={(text) => {
                // Fire the canvas-authored choice as a regular chat turn
                // — same path the textarea Send button takes, so all the
                // skill / protocol / artifactNotes / contextFiles plumbing
                // applies.
                if (streaming) return;
                void chatStore.send({
                  text,
                  skillSlugs: Array.from(selected),
                  contextFiles: Array.from(selectedFiles),
                  artifactNotes,
                  snapshot: buildSkillSnapshot(),
                  ...(agent ? { agentId: agent.id } : {}),
                });
              }}
              onAnswer={async (messageId, toolUseId, raw) => {
                const meta = pendingCanvasQuestions.find(
                  (p) => p.toolUseId === toolUseId,
                );
                if (meta?.source === "extracted") {
                  const a = raw[0]?.answer;
                  if (a === undefined) return;
                  await chatStore.submitExtractedChoice(
                    messageId,
                    toolUseId,
                    a,
                    Array.from(selected),
                    buildSkillSnapshot(),
                    {
                      contextFiles: Array.from(selectedFiles),
                      artifactNotes,
                    },
                  );
                  return;
                }
                const answers: AskUserAnswer[] = raw.map((r) => ({
                  question: r.question,
                  answer: r.answer,
                }));
                await onAnswerAskUserQuestion(messageId, toolUseId, answers);
              }}
            />
          </div>
        </div>
      </aside>
      {/* Horizontal drag-handle for resizing the canvas / chat split. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize canvas / chat split"
        onPointerDown={onCanvasResizeStart}
        onDoubleClick={() => setCanvasHeight(CANVAS_HEIGHT_DEFAULT)}
        title="Drag to resize · double-click to reset"
        className={`relative my-1 h-2 shrink-0 cursor-row-resize transition ${
          canvasResizing ? "bg-ink/40" : "hover:bg-ink/20"
        }`}
      />
      <section
        ref={chatSectionRef}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
        style={{ minHeight: "var(--chat-h)" }}
      >
        <SessionHeader
          session={session}
          selectedSkills={selectedSkills}
          selectedFileCount={selectedFiles.size}
          hasMessages={messages.length > 0}
          streaming={streaming}
          onClear={() => {
            if (streaming) return;
            if (
              !confirm(
                "Clear the chat? Canvas state (user-added nodes/edges) will reset too. Deck files are not affected.",
              )
            )
              return;
            chatStore.clear();
            setCanvasResetKey((k) => k + 1);
          }}
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
          className="absolute inset-0 overflow-y-auto px-6 py-8"
        >
          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl text-center">
              <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
                Chat
              </p>
              <p className="font-serif text-2xl leading-snug text-ink">
                Ask the selected artifacts a question.
              </p>
              <p className="mt-4 text-sm text-muted">
                {(() => {
                  const skillsActive = selectedSkills.filter(
                    (s) => s.artifactKind !== "protocol",
                  );
                  const protocolsActive = selectedSkills.filter(
                    (s) => s.artifactKind === "protocol",
                  );
                  if (selectedSkills.length === 0) {
                    return "Nothing active — you'll get a plain Claude response. Pick a skill or protocol on the left to specialize the assistant.";
                  }
                  const parts: string[] = [];
                  if (skillsActive.length > 0) {
                    parts.push(
                      `${skillsActive.length} skill${skillsActive.length === 1 ? "" : "s"}: ${skillsActive
                        .map((s) => s.name)
                        .join(", ")}`,
                    );
                  }
                  if (protocolsActive.length > 0) {
                    parts.push(
                      `${protocolsActive.length} protocol${protocolsActive.length === 1 ? "" : "s"}: ${protocolsActive
                        .map((s) => s.name)
                        .join(", ")}`,
                    );
                  }
                  return parts.join(" • ");
                })()}
              </p>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-10">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onMouseUp={handleMouseUp}
                  onUndoEdit={undoEdit}
                  onAnswerAskUserQuestion={onAnswerAskUserQuestion}
                  streaming={streaming}
                  selected={activeSelection?.messageId === m.id}
                />
              ))}
            </div>
          )}
        </div>
        </div>

        <div className="border-t border-border px-4 py-3 sm:px-6 sm:py-4">
          <div className="mx-auto w-full max-w-4xl">
          {error && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
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
                  ? `Ask with ${selectedSkills.length} artifact${
                      selectedSkills.length === 1 ? "" : "s"
                    } active…`
                  : "Ask anything… (type / to pick a skill, Shift+Enter for newline)"
              }
              rows={2}
              className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
              disabled={streaming}
            />
            {streaming ? (
              <Button type="button" variant="default" onClick={cancel}>
                <Loader2 size={14} className="animate-spin" />
                Stop
              </Button>
            ) : (
              <Button type="button" variant="default" onClick={send} disabled={!input.trim()}>
                Send
                <Send size={14} />
              </Button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-ink-light">
            Using your local <code className="font-mono">claude</code> CLI
            (claude.ai OAuth — no API key). Full toolset (Bash, Read, Write,
            Edit, Grep, Glob, WebSearch, WebFetch, Skill) + user-level skills
            (docx, xlsx, pdf, …). Files the assistant writes appear below the
            message as downloads.
          </p>
          </div>
        </div>
      </section>
      {/* Bottom drag-handle on the chat. Drag down to extend the chat
       *  past the viewport (page scrolls); drag back up to collapse to
       *  the flex-1 default. Same row-resize pattern as the canvas/chat
       *  splitter above. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat height — drag down to grow"
        onPointerDown={onChatResizeStart}
        onDoubleClick={() => setChatHeight(CHAT_HEIGHT_DEFAULT)}
        title="Drag down to grow the chat · double-click to reset"
        className={`relative mt-1 h-2 shrink-0 cursor-row-resize transition ${
          chatResizing ? "bg-ink/40" : "hover:bg-ink/20"
        }`}
      />
      </div>

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
  selectedFileCount,
  hasMessages,
  streaming,
  onClear,
}: {
  session: SessionInfo | null;
  selectedSkills: Skill[];
  selectedFileCount: number;
  hasMessages: boolean;
  streaming: boolean;
  onClear: () => void;
}) {
  const skillsActive = selectedSkills.filter(
    (s) => s.artifactKind !== "protocol",
  );
  const protocolsActive = selectedSkills.filter(
    (s) => s.artifactKind === "protocol",
  );
  const skillCount = selectedSkills.length;
  return (
    <div className="border-b border-rule px-6 py-3 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 uppercase tracking-[0.14em]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink" />
          {session?.model ?? "claude-opus (pending)"}
        </span>
        <span>
          {skillsActive.length} skill{skillsActive.length === 1 ? "" : "s"}
          {protocolsActive.length > 0
            ? ` + ${protocolsActive.length} protocol${protocolsActive.length === 1 ? "" : "s"}`
            : ""}
          {selectedFileCount > 0
            ? ` + ${selectedFileCount} file${selectedFileCount === 1 ? "" : "s"}`
            : ""}{" "}
          loaded
        </span>
        <span>WebSearch + WebFetch</span>
        {session?.api_key_source && <span>auth: {session.api_key_source}</span>}
        {session?.session_id && (
          <span className="truncate font-mono text-[10px] normal-case tracking-normal">
            sess {session.session_id.slice(0, 8)}
          </span>
        )}
        {hasMessages && (
          <button
            type="button"
            onClick={onClear}
            disabled={streaming}
            title="Clear the chat history (your deck files are unaffected)"
            className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-muted underline underline-offset-2 transition hover:text-ink disabled:no-underline disabled:opacity-50"
          >
            <Trash2 size={11} />
            Clear chat
          </button>
        )}
      </div>
      {skillCount > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectedSkills.map((s) => {
            const isProtocol = s.artifactKind === "protocol";
            return (
              <span
                key={s.slug}
                title={s.description}
                className={`inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] normal-case tracking-normal ${
                  isProtocol
                    ? "border-ink bg-ink text-paper"
                    : "border-rule bg-paper text-ink"
                }`}
              >
                <span className={isProtocol ? "opacity-70" : "text-muted"}>
                  {isProtocol ? "protocol" : s.sourceLabel}/
                </span>
                {s.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onMouseUp,
  onUndoEdit,
  onAnswerAskUserQuestion,
  streaming,
  selected,
}: {
  msg: ChatMsg;
  onMouseUp: (id: string, content: string) => void;
  onUndoEdit: (id: string) => void;
  onAnswerAskUserQuestion: (
    messageId: string,
    toolUseId: string,
    answers: AskUserAnswer[],
  ) => Promise<void>;
  streaming: boolean;
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

  // AskUserQuestion tool calls get a prominent interactive card instead of
  // being buried inside the activity panel.
  const askUserItems = (msg.activity ?? []).filter(
    (a): a is Extract<ActivityItem, { kind: "tool" }> =>
      a.kind === "tool" && a.name === "AskUserQuestion",
  );
  const showAsErrored =
    msg.errored && askUserItems.length === 0; // suppress error UI when we have an interactive card
  const showThinkingPlaceholder =
    msg.pending && !msg.content && askUserItems.length === 0;

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
      {showAsErrored ? (
        <div className="border border-rule bg-ink/5 p-4 text-sm text-ink">
          <p className="font-medium">Error</p>
          <p className="mt-1 text-muted">{msg.content}</p>
        </div>
      ) : showThinkingPlaceholder ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" />
          Thinking…
        </div>
      ) : msg.content ? (
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
      ) : null}
      {askUserItems.map((tool) => (
        <AskUserQuestionBlock
          key={tool.id}
          tool={tool}
          existingAnswers={msg.askUserAnswers?.[tool.id]}
          disabled={streaming}
          onSubmit={(answers) =>
            onAnswerAskUserQuestion(msg.id, tool.id, answers)
          }
        />
      ))}
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
  const tools = (
    activity.filter((a) => a.kind === "tool") as Extract<
      ActivityItem,
      { kind: "tool" }
    >[]
  ).filter((t) => t.name !== "AskUserQuestion");
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

interface AskUserOption {
  label: string;
  description?: string;
}

interface AskUserQuestionInput {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

/**
 * Best-effort parse of the AskUserQuestion tool's input. The model could
 * mis-emit, so we tolerate missing fields and return null when the shape
 * is unrecoverable (caller falls back to the generic ToolBlock view).
 */
function parseAskUserInput(input: unknown): AskUserQuestionInput[] | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const arr = obj.questions;
  if (!Array.isArray(arr)) return null;
  const out: AskUserQuestionInput[] = [];
  for (const q of arr) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== "string" || !Array.isArray(r.options)) continue;
    const options: AskUserOption[] = [];
    for (const o of r.options) {
      if (!o || typeof o !== "object") continue;
      const ro = o as Record<string, unknown>;
      if (typeof ro.label !== "string") continue;
      options.push({
        label: ro.label,
        description:
          typeof ro.description === "string" ? ro.description : undefined,
      });
    }
    if (options.length === 0) continue;
    out.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : undefined,
      options,
      multiSelect: Boolean(r.multiSelect),
    });
  }
  return out.length > 0 ? out : null;
}

function AskUserQuestionBlock({
  tool,
  existingAnswers,
  disabled,
  onSubmit,
}: {
  tool: Extract<ActivityItem, { kind: "tool" }>;
  existingAnswers: AskUserAnswer[] | undefined;
  disabled: boolean;
  onSubmit: (answers: AskUserAnswer[]) => Promise<void>;
}) {
  const parsed = useMemo(() => parseAskUserInput(tool.input), [tool.input]);
  // One state slot per question. Single → string | null; multi → string[].
  const [picks, setPicks] = useState<(string | string[] | null)[]>(() =>
    parsed ? parsed.map((q) => (q.multiSelect ? [] : null)) : [],
  );
  const [submitting, setSubmitting] = useState(false);

  // Tool input streams in via partial JSON deltas; resync local picks once
  // the parsed shape stabilizes (questions count changed → reset).
  useEffect(() => {
    if (!parsed) return;
    setPicks((prev) => {
      if (prev.length === parsed.length) return prev;
      return parsed.map((q) => (q.multiSelect ? [] : null));
    });
  }, [parsed]);

  if (!parsed) {
    return (
      <div className="border border-rule p-3 text-xs text-muted">
        <p className="font-medium text-ink">Question (still streaming…)</p>
        <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
          {tool.inputRaw || "(empty)"}
        </pre>
      </div>
    );
  }

  // Already answered → show the user's picks as a resolved card.
  if (existingAnswers && existingAnswers.length > 0) {
    return (
      <div className="border border-rule bg-ink/[0.02] p-4">
        <p className="mb-3 inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.18em] text-muted">
          <CheckCircle2 size={12} />
          Answered
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {existingAnswers.map((a, i) => (
            <li key={i}>
              <p className="text-muted">{a.question}</p>
              <p className="mt-0.5 font-mono text-[13px] text-ink">
                {Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}
              </p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const allAnswered = parsed.every((q, i) => {
    const pick = picks[i];
    if (q.multiSelect)
      return Array.isArray(pick) && pick.length > 0;
    return typeof pick === "string" && pick.length > 0;
  });

  async function submit() {
    if (!parsed) return;
    setSubmitting(true);
    try {
      const answers: AskUserAnswer[] = parsed.map((q, i) => ({
        question: q.question,
        answer: q.multiSelect ? ((picks[i] as string[] | null) ?? []) : ((picks[i] as string | null) ?? ""),
      }));
      await onSubmit(answers);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border border-ink bg-paper p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted">
        I need a few details
      </p>
      {parsed.map((q, qi) => {
        const pick = picks[qi];
        return (
          <div key={qi} className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">{q.question}</p>
            <ul className="flex flex-col gap-1">
              {q.options.map((opt) => {
                const checked = q.multiSelect
                  ? Array.isArray(pick) && pick.includes(opt.label)
                  : pick === opt.label;
                const toggle = () => {
                  setPicks((prev) => {
                    const next = [...prev];
                    if (q.multiSelect) {
                      const arr = Array.isArray(next[qi]) ? [...(next[qi] as string[])] : [];
                      const idx = arr.indexOf(opt.label);
                      if (idx >= 0) arr.splice(idx, 1);
                      else arr.push(opt.label);
                      next[qi] = arr;
                    } else {
                      next[qi] = opt.label;
                    }
                    return next;
                  });
                };
                return (
                  <li key={opt.label}>
                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-sm border px-3 py-2 transition ${
                        checked
                          ? "border-ink bg-ink/5"
                          : "border-rule hover:border-ink"
                      } ${disabled || submitting ? "opacity-60" : ""}`}
                    >
                      <input
                        type={q.multiSelect ? "checkbox" : "radio"}
                        name={`aq-${tool.id}-${qi}`}
                        checked={checked}
                        disabled={disabled || submitting}
                        onChange={toggle}
                        className="mt-1 h-3.5 w-3.5 accent-ink"
                      />
                      <span className="flex-1">
                        <span className="block text-sm text-ink">
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 block text-xs text-muted">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="flex items-center justify-end border-t border-rule pt-3">
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered || disabled || submitting}
          className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted"
        >
          {submitting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : null}
          {submitting ? "Sending…" : "Send answers"}
        </button>
      </div>
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

interface ArtifactToggleSectionProps {
  label: string;
  description: React.ReactNode;
  emptyText: string;
  artifacts: Skill[];
  selected: Set<string>;
  onToggle: (slug: string) => void;
  /** Per-session body overrides keyed by slug, lifted from the parent. */
  artifactNotes: Record<string, string>;
  onSetNote: (slug: string, body: string) => void;
  onClearNote: (slug: string) => void;
  /** Called after a successful permanent edit (PUT /api/skills/[slug]) so
   *  the parent can re-fetch skill data. NOT called for session-only saves
   *  — those don't change the on-disk artifact. */
  onApplied?: () => void;
}

function ArtifactToggleSection({
  label,
  description,
  emptyText,
  artifacts,
  selected,
  onToggle,
  artifactNotes,
  onSetNote,
  onClearNote,
  onApplied,
}: ArtifactToggleSectionProps) {
  // One row at a time can be in edit mode. State lives at the section level
  // so opening one row's editor closes any other.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [proposed, setProposed] = useState<string | null>(null);
  const [originalBody, setOriginalBody] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [showFullBody, setShowFullBody] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [busyMode, setBusyMode] = useState<null | "rewriting" | "applying">(
    null,
  );

  function openEdit(slug: string) {
    setEditingSlug(slug);
    setInstruction("");
    setProposed(null);
    setOriginalBody(null);
    setSummary("");
    setShowFullBody(false);
    setEditError(null);
    setBusyMode(null);
  }
  function closeEdit() {
    setEditingSlug(null);
    setInstruction("");
    setProposed(null);
    setOriginalBody(null);
    setSummary("");
    setShowFullBody(false);
    setEditError(null);
    setBusyMode(null);
  }

  async function requestRewrite(skill: Skill) {
    const text = instruction.trim();
    if (!text) return;
    setEditError(null);
    setBusyMode("rewriting");
    try {
      const res = await fetch(
        `/api/artifacts/${encodeURIComponent(skill.slug)}/llm-edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: text }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        proposed?: string;
        current?: string;
        summary?: string;
        error?: string;
      };
      if (!res.ok || typeof data.proposed !== "string") {
        throw new Error(data.error ?? `Rewrite failed (HTTP ${res.status})`);
      }
      setProposed(data.proposed);
      setOriginalBody(typeof data.current === "string" ? data.current : skill.body);
      setSummary(typeof data.summary === "string" ? data.summary : "");
      setShowFullBody(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Rewrite failed.");
    } finally {
      setBusyMode(null);
    }
  }

  async function applyProposedPersistent(skill: Skill) {
    if (proposed == null) return;
    setEditError(null);
    setBusyMode("applying");
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skill.name,
          description: skill.description,
          allowedTools: skill.allowedTools,
          license: skill.license,
          body: proposed,
          kind: skill.artifactKind,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Apply failed (HTTP ${res.status})`);
      }
      // The on-disk artifact now matches; clear any session note so we don't
      // double-apply the same body via the override path.
      onClearNote(skill.slug);
      closeEdit();
      onApplied?.();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setBusyMode(null);
    }
  }

  function applyProposedSession(skill: Skill) {
    if (proposed == null) return;
    onSetNote(skill.slug, proposed);
    closeEdit();
  }

  return (
    <div>
      <p className="mb-3 text-xs uppercase tracking-[0.18em] text-muted">
        {label}
      </p>
      <p className="mb-4 text-xs leading-relaxed text-muted">{description}</p>
      <div className="flex flex-col gap-1">
        {artifacts.length === 0 && (
          <p className="text-sm text-muted">{emptyText}</p>
        )}
        {artifacts.map((s) => {
          const on = selected.has(s.slug);
          const persistable = s.source.kind === "user";
          const isEditing = editingSlug === s.slug;
          const hasSessionNote = Object.prototype.hasOwnProperty.call(
            artifactNotes,
            s.slug,
          );
          const noteButtonClass = isEditing
            ? "border-ink bg-ink text-paper"
            : hasSessionNote
              ? "border-ink text-ink"
              : "border-rule text-muted hover:border-ink hover:text-ink";
          return (
            <div key={s.slug} className="flex flex-col">
              <div
                className={`flex items-start gap-2 rounded-sm px-2 py-2 transition ${
                  on ? "bg-ink/5" : "hover:bg-ink/5"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onToggle(s.slug)}
                  className="mt-0.5 shrink-0 text-ink transition hover:opacity-70"
                  title={on ? "Remove from this turn" : "Add to this turn"}
                >
                  {on ? <SquareCheck size={16} /> : <Square size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(s.slug)}
                  className="flex-1 min-w-0 text-left"
                >
                  <span className="block font-serif text-sm leading-tight text-ink">
                    {s.name}
                  </span>
                  {s.description && (
                    <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted">
                      {s.description}
                    </span>
                  )}
                  {hasSessionNote && (
                    <span className="mt-1 block text-[10px] uppercase tracking-[0.12em] text-ink">
                      session note active
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => (isEditing ? closeEdit() : openEdit(s.slug))}
                  title={
                    isEditing
                      ? "Close note"
                      : persistable
                        ? "Add a note — tell the AI how to tweak this artifact"
                        : "Read-only artifact: your note will apply only to this session, won't be saved to disk"
                  }
                  className={`mt-0.5 inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] transition ${noteButtonClass}`}
                >
                  <Wand2 size={11} />
                  Note
                </button>
              </div>

              {isEditing && (
                <div className="mb-1 ml-7 mr-1 mt-1 flex flex-col gap-2 border-l-2 border-ink/30 bg-ink/[0.02] p-3 text-xs">
                  {proposed == null ? (
                    <>
                      {hasSessionNote && (
                        <div className="flex items-center justify-between gap-3 border border-ink/30 bg-ink/[0.04] px-2 py-1.5 text-[11px] text-ink">
                          <span>
                            A session-only note is active for this artifact.
                            New rewrites will replace it.
                          </span>
                          <button
                            type="button"
                            onClick={() => onClearNote(s.slug)}
                            className="shrink-0 text-muted underline underline-offset-2 transition hover:text-ink"
                          >
                            Clear
                          </button>
                        </div>
                      )}
                      <label className="text-muted">
                        What should change in this artifact?{" "}
                        {!persistable && (
                          <span className="text-[10px] uppercase tracking-[0.1em] text-ink">
                            (read-only — your note will apply to this session only)
                          </span>
                        )}
                      </label>
                      <textarea
                        autoFocus
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        rows={3}
                        placeholder="e.g. Always prioritise Thermo Fisher kits when listing options."
                        className="resize-y border border-rule bg-paper px-2 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                        disabled={busyMode !== null}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => requestRewrite(s)}
                          disabled={
                            busyMode !== null || instruction.trim().length === 0
                          }
                          className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3 py-1 text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busyMode === "rewriting" ? (
                            <>
                              <Loader2 size={11} className="animate-spin" />
                              Rewriting…
                            </>
                          ) : (
                            <>
                              <Wand2 size={11} />
                              Rewrite with AI
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={closeEdit}
                          disabled={busyMode !== null}
                          className="text-muted transition hover:text-ink"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {summary && (
                        <div className="border border-rule bg-paper px-3 py-2 text-[11px] leading-relaxed text-ink">
                          <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                            Summary of changes
                          </p>
                          {(() => {
                            const lines = summary
                              .split("\n")
                              .map((l) => l.trim())
                              .filter((l) => l.length > 0);
                            const bullets = lines
                              .filter((l) => /^[-*•]\s+/.test(l))
                              .map((l) => l.replace(/^[-*•]\s+/, ""));
                            if (
                              bullets.length > 0 &&
                              bullets.length === lines.length
                            ) {
                              return (
                                <ul className="ml-4 list-disc space-y-0.5">
                                  {bullets.map((b, i) => (
                                    <li key={i}>{b}</li>
                                  ))}
                                </ul>
                              );
                            }
                            return <p className="whitespace-pre-wrap">{summary}</p>;
                          })()}
                        </div>
                      )}
                      {(() => {
                        const before = originalBody ?? s.body;
                        const after = proposed;
                        const stats = diffLines(before, after).reduce(
                          (acc, p) => {
                            const n = p.count ?? p.value.split("\n").length - 1;
                            if (p.added) acc.added += n;
                            else if (p.removed) acc.removed += n;
                            return acc;
                          },
                          { added: 0, removed: 0 },
                        );
                        const noChange = stats.added === 0 && stats.removed === 0;
                        return (
                          <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                            <span>
                              {noChange ? (
                                <span>No changes proposed — try a different instruction.</span>
                              ) : (
                                <>
                                  <span className="text-emerald-700">
                                    +{stats.added} added
                                  </span>
                                  {", "}
                                  <span className="text-red-700">
                                    −{stats.removed} removed
                                  </span>
                                </>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowFullBody((v) => !v)}
                              className="underline underline-offset-2 transition hover:text-ink"
                            >
                              {showFullBody ? "Show diff" : "Edit manually"}
                            </button>
                          </div>
                        );
                      })()}
                      {showFullBody ? (
                        <textarea
                          value={proposed}
                          onChange={(e) => setProposed(e.target.value)}
                          rows={10}
                          spellCheck={false}
                          className="resize-y border border-rule bg-paper px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink focus:border-ink focus:outline-none"
                          disabled={busyMode !== null}
                        />
                      ) : (
                        <DiffView
                          before={originalBody ?? s.body}
                          after={proposed}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {persistable && (
                          <button
                            type="button"
                            onClick={() => applyProposedPersistent(s)}
                            disabled={busyMode !== null}
                            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3 py-1 text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            title="Save to your artifact on disk"
                          >
                            {busyMode === "applying" ? (
                              <>
                                <Loader2 size={11} className="animate-spin" />
                                Saving…
                              </>
                            ) : (
                              "Save to artifact"
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => applyProposedSession(s)}
                          disabled={busyMode !== null}
                          className={`inline-flex items-center gap-1.5 border px-3 py-1 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            persistable
                              ? "border-rule text-ink hover:border-ink"
                              : "border-ink bg-ink text-paper hover:opacity-90"
                          }`}
                          title="Apply only for this session — no on-disk change"
                        >
                          Use this session only
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setProposed(null);
                            setEditError(null);
                          }}
                          disabled={busyMode !== null}
                          className="text-muted transition hover:text-ink"
                        >
                          Try another instruction
                        </button>
                        <button
                          type="button"
                          onClick={closeEdit}
                          disabled={busyMode !== null}
                          className="text-muted transition hover:text-ink"
                        >
                          Discard
                        </button>
                        {hasSessionNote && (
                          <button
                            type="button"
                            onClick={() => {
                              onClearNote(s.slug);
                              closeEdit();
                            }}
                            disabled={busyMode !== null}
                            className="ml-auto text-muted underline underline-offset-2 transition hover:text-ink"
                          >
                            Clear session note
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {editError && (
                    <p className="text-[11px] text-red-600">{editError}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Compact unified-diff renderer for the Note review pane. Shows changed
 * hunks with 3 lines of context, and elides identical regions between
 * hunks ("… N unchanged lines …").
 */
function DiffView({ before, after }: { before: string; after: string }) {
  const patch = useMemo(
    () =>
      structuredPatch("current", "proposed", before, after, "", "", {
        context: 3,
      }),
    [before, after],
  );

  if (patch.hunks.length === 0) {
    return (
      <div className="border border-rule bg-paper px-3 py-3 text-[11px] italic text-muted">
        Identical to the current body.
      </div>
    );
  }

  // Compute the gap between hunks so we can show "… N unchanged lines …".
  const beforeLineCount = before.split("\n").length;

  return (
    <div className="max-h-72 overflow-y-auto border border-rule bg-paper font-mono text-[11px] leading-snug">
      {patch.hunks.map((h, hi) => {
        const previousEnd =
          hi === 0
            ? 1
            : patch.hunks[hi - 1].oldStart + patch.hunks[hi - 1].oldLines;
        const gap = h.oldStart - previousEnd;
        return (
          <div key={hi}>
            {gap > 0 && (
              <div className="bg-ink/[0.04] px-2 py-0.5 text-[10px] text-muted">
                … {gap} unchanged line{gap === 1 ? "" : "s"} …
              </div>
            )}
            {h.lines.map((line, li) => {
              const sigil = line[0];
              const text = line.slice(1);
              if (sigil === "+") {
                return (
                  <div
                    key={li}
                    className="whitespace-pre-wrap break-words bg-emerald-100/60 px-2 text-emerald-900"
                  >
                    <span className="select-none text-emerald-700">+ </span>
                    {text}
                  </div>
                );
              }
              if (sigil === "-") {
                return (
                  <div
                    key={li}
                    className="whitespace-pre-wrap break-words bg-red-100/60 px-2 text-red-900"
                  >
                    <span className="select-none text-red-700">− </span>
                    {text}
                  </div>
                );
              }
              return (
                <div
                  key={li}
                  className="whitespace-pre-wrap break-words px-2 text-muted"
                >
                  <span className="select-none text-muted/70">  </span>
                  {text}
                </div>
              );
            })}
          </div>
        );
      })}
      {(() => {
        const last = patch.hunks[patch.hunks.length - 1];
        const tail = beforeLineCount - (last.oldStart + last.oldLines - 1);
        if (tail > 0) {
          return (
            <div className="bg-ink/[0.04] px-2 py-0.5 text-[10px] text-muted">
              … {tail} unchanged line{tail === 1 ? "" : "s"} after this …
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}

