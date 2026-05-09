"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  ConnectionMode,
  Position,
  MarkerType,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  type Edge,
  type Node,
  type NodeProps,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const NODE_STYLE = {
  width: 160,
  padding: 8,
  borderRadius: 6,
  border: "1px solid #111",
  background: "#fff",
  fontSize: 12,
  lineHeight: "1.3",
  color: "#111",
  whiteSpace: "pre-wrap" as const,
};

// Horizontal flow: source handle on the right, target handle on the left.
// This makes "drag from right edge of A to left edge of B" the obvious gesture.
const NODE_BASE = {
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  style: NODE_STYLE,
};

// ---------- Custom node types --------------------------------------------

// xyflow v12 requires node-data types to satisfy Record<string, unknown>.
// We widen each shape with the index signature so a Node<X, "..."> typing
// works without losing the named fields.
//
// Picks are tracked by INDEX (not label) so the radio is always clickable
// even before the user has typed an option name — and renaming an option
// in place keeps the pick stable instead of orphaning it.
type SingleChoiceData = {
  label: string;
  options: string[];
  /** Index of the currently picked option, or null if none. */
  value: number | null;
  /** Once the user has fired the choice into the chat, the node locks. */
  sent?: boolean;
} & Record<string, unknown>;

type MultiChoiceData = {
  label: string;
  options: string[];
  /** Indexes of picked options. */
  values: number[];
  /** Once the user has fired the choice into the chat, the node locks. */
  sent?: boolean;
} & Record<string, unknown>;

type SingleChoiceNode = Node<SingleChoiceData, "singleChoice">;
type MultiChoiceNode = Node<MultiChoiceData, "multiChoice">;

// Question pushed onto the canvas by the chat layer. Two origins are
// supported (see `source`):
//   - "tool": the LLM invoked the AskUserQuestion tool. Submit goes through
//     submitAskUserAnswer so it's a proper tool-result.
//   - "extracted": Haiku post-processed a plain-text reply and inferred
//     this choice. Submit fires a synthetic user-message follow-up.
// `answer` is set once the user has submitted; the node then renders in
// read-only "answered" mode so the canvas keeps a visible history of
// every choice in the session, not a disappearing pile.
export interface PendingCanvasQuestion {
  messageId: string;
  toolUseId: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  source?: "tool" | "extracted";
  answer?: string | string[];
}

type PendingQuestionData = PendingCanvasQuestion & {
  onAnswer: (
    messageId: string,
    toolUseId: string,
    answers: { question: string; answer: string | string[] }[],
  ) => Promise<void>;
  /** Pre-submit draft pick for single-choice. Stored on data (not local
   *  state) so the canvas serialiser can include the user's intended
   *  answer even if they haven't clicked Submit yet. */
  draftSingle?: string | null;
  /** Pre-submit draft picks for multi-choice. */
  draftMulti?: string[];
} & Record<string, unknown>;

type PendingQuestionNode = Node<PendingQuestionData, "pendingQuestion">;

const customNodeShell =
  "rounded-md border border-ink bg-paper px-2.5 py-2 text-[12px] text-ink shadow-sm";

// Context lets user-created custom nodes reach back into Chat-side state
// without each node having to carry callbacks in its `data` field. CanvasInner
// provides the current onSendToChat from props on every render.
interface CanvasInteractionCtxValue {
  onSendToChat?: (text: string) => void;
}
const CanvasInteractionContext = createContext<CanvasInteractionCtxValue>({});

const SingleChoiceNodeComponent = memo(function SingleChoiceNodeComponent({
  id,
  data,
  selected,
}: NodeProps<SingleChoiceNode>) {
  const { setNodes } = useReactFlow();
  const ctx = useContext(CanvasInteractionContext);
  const sent = Boolean(data.sent);

  function patch(partial: Partial<SingleChoiceData>) {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...(n.data as SingleChoiceData), ...partial } } as Node)
          : n,
      ),
    );
  }
  const onPick = (idx: number) => {
    if (sent) return;
    patch({ value: idx });
  };
  function setLabel(label: string) {
    if (sent) return;
    patch({ label });
  }
  function setOption(idx: number, value: string) {
    if (sent) return;
    const next = data.options.slice();
    next[idx] = value;
    // Renames are by-index, so the pick stays attached to the same row.
    patch({ options: next });
  }
  function addOption() {
    if (sent) return;
    patch({ options: [...data.options, ""] });
  }
  function removeOption(idx: number) {
    if (sent || data.options.length <= 1) return;
    const nextValue =
      data.value === idx
        ? null
        : data.value !== null && data.value > idx
          ? data.value - 1
          : data.value;
    patch({
      options: data.options.filter((_, i) => i !== idx),
      value: nextValue,
    });
  }
  const pickedLabel =
    data.value !== null ? data.options[data.value]?.trim() ?? "" : "";
  function onSend() {
    if (sent || data.value === null || !ctx.onSendToChat) return;
    if (!pickedLabel) return; // don't send a blank pick
    const q = (data.label || "(no question)").trim();
    const text = `From the canvas: ${q} → I pick **${pickedLabel}**.\n\nPlease use this answer in your next reply.`;
    ctx.onSendToChat(text);
    patch({ sent: true });
  }

  return (
    <div
      className={`${customNodeShell} w-[220px] ${selected ? "ring-1 ring-ink" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-muted">
        <span>{sent ? "Sent to chat" : "Single choice"}</span>
        {!sent && (
          <button
            type="button"
            className="nodrag font-mono normal-case tracking-normal text-[10px] text-muted hover:text-ink"
            title="Add an option"
            onClick={addOption}
          >
            + opt
          </button>
        )}
      </div>
      <input
        type="text"
        className="nodrag mb-1.5 w-full border-b border-rule bg-transparent pb-0.5 font-serif text-[12px] leading-tight text-ink focus:border-ink focus:outline-none"
        value={data.label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Type your question…"
        disabled={sent}
      />
      <ul className="nodrag flex flex-col gap-0.5">
        {data.options.map((opt, idx) => {
          const checked = data.value === idx;
          return (
            <li
              key={`${id}-${idx}`}
              className="nodrag flex items-center gap-1.5"
            >
              {/* Custom radio: a clickable circle. Bypasses native <input>
               *  which React Flow's pointer-event handling sometimes
               *  swallows on certain Mac/Chrome combos. */}
              <button
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={sent}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(idx);
                }}
                className="nodrag flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-ink bg-paper transition disabled:cursor-not-allowed disabled:opacity-50"
                title={checked ? "Picked" : "Pick this option"}
              >
                {checked && (
                  <span className="block h-1.5 w-1.5 rounded-full bg-ink" />
                )}
              </button>
              <input
                type="text"
                className="nodrag flex-1 border-b border-transparent bg-transparent text-[11px] text-ink focus:border-rule focus:outline-none disabled:text-muted"
                value={opt}
                onChange={(e) => setOption(idx, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder={`Option ${idx + 1}`}
                disabled={sent}
              />
              {!sent && data.options.length > 1 && (
                <button
                  type="button"
                  className="nodrag text-[10px] text-muted hover:text-red-700"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeOption(idx);
                  }}
                  title="Remove option"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {sent ? (
        <div className="mt-2 border border-ink bg-ink/[0.06] px-2 py-1 text-center text-[10px] uppercase tracking-[0.1em] text-ink">
          ✓ Sent: {pickedLabel || "(unnamed)"}
        </div>
      ) : (
        <button
          type="button"
          className="nodrag mt-2 w-full border border-ink bg-ink px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-paper transition disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
          onClick={onSend}
          disabled={data.value === null || !pickedLabel}
          title={
            data.value === null
              ? "Pick an option first"
              : !pickedLabel
                ? "The picked option needs a label before sending"
                : "Send this choice to the chat"
          }
        >
          Send to chat
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const MultiChoiceNodeComponent = memo(function MultiChoiceNodeComponent({
  id,
  data,
  selected,
}: NodeProps<MultiChoiceNode>) {
  const { setNodes } = useReactFlow();
  const ctx = useContext(CanvasInteractionContext);
  const sent = Boolean(data.sent);
  const values = data.values ?? [];

  function patch(partial: Partial<MultiChoiceData>) {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...(n.data as MultiChoiceData), ...partial } } as Node)
          : n,
      ),
    );
  }
  function onToggle(idx: number) {
    if (sent) return;
    const next = values.includes(idx)
      ? values.filter((v) => v !== idx)
      : [...values, idx];
    patch({ values: next });
  }
  function setLabel(label: string) {
    if (sent) return;
    patch({ label });
  }
  function setOption(idx: number, value: string) {
    if (sent) return;
    const next = data.options.slice();
    next[idx] = value;
    patch({ options: next });
  }
  function addOption() {
    if (sent) return;
    patch({ options: [...data.options, ""] });
  }
  function removeOption(idx: number) {
    if (sent || data.options.length <= 1) return;
    const remaining = values
      .filter((v) => v !== idx)
      .map((v) => (v > idx ? v - 1 : v));
    patch({
      options: data.options.filter((_, i) => i !== idx),
      values: remaining,
    });
  }
  const pickedLabels = values
    .map((i) => data.options[i]?.trim() ?? "")
    .filter((s) => s.length > 0);
  function onSend() {
    if (sent || pickedLabels.length === 0 || !ctx.onSendToChat) return;
    const q = (data.label || "(no question)").trim();
    const list = pickedLabels.map((v) => `**${v}**`).join(", ");
    const text = `From the canvas: ${q} → I pick ${list}.\n\nPlease use these picks in your next reply.`;
    ctx.onSendToChat(text);
    patch({ sent: true });
  }

  return (
    <div
      className={`${customNodeShell} w-[220px] ${selected ? "ring-1 ring-ink" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-muted">
        <span>{sent ? "Sent to chat" : "Multiple choice"}</span>
        {!sent && (
          <button
            type="button"
            className="nodrag font-mono normal-case tracking-normal text-[10px] text-muted hover:text-ink"
            title="Add an option"
            onClick={addOption}
          >
            + opt
          </button>
        )}
      </div>
      <input
        type="text"
        className="nodrag mb-1.5 w-full border-b border-rule bg-transparent pb-0.5 font-serif text-[12px] leading-tight text-ink focus:border-ink focus:outline-none"
        value={data.label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Type your question…"
        disabled={sent}
      />
      <ul className="nodrag flex flex-col gap-0.5">
        {data.options.map((opt, idx) => {
          const checked = values.includes(idx);
          return (
            <li
              key={`${id}-${idx}`}
              className="nodrag flex items-center gap-1.5"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={sent}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(idx);
                }}
                className="nodrag flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-ink bg-paper transition disabled:cursor-not-allowed disabled:opacity-50"
                title={checked ? "Picked" : "Pick this option"}
              >
                {checked && (
                  <span className="block h-2 w-2 bg-ink" />
                )}
              </button>
              <input
                type="text"
                className="nodrag flex-1 border-b border-transparent bg-transparent text-[11px] text-ink focus:border-rule focus:outline-none disabled:text-muted"
                value={opt}
                onChange={(e) => setOption(idx, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder={`Option ${idx + 1}`}
                disabled={sent}
              />
              {!sent && data.options.length > 1 && (
                <button
                  type="button"
                  className="nodrag text-[10px] text-muted hover:text-red-700"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeOption(idx);
                  }}
                  title="Remove option"
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {sent ? (
        <div className="mt-2 border border-ink bg-ink/[0.06] px-2 py-1 text-center text-[10px] uppercase tracking-[0.1em] text-ink">
          ✓ Sent: {pickedLabels.join(", ") || "(unnamed)"}
        </div>
      ) : (
        <button
          type="button"
          className="nodrag mt-2 w-full border border-ink bg-ink px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-paper transition disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
          onClick={onSend}
          disabled={pickedLabels.length === 0}
          title={
            values.length === 0
              ? "Pick at least one option first"
              : pickedLabels.length === 0
                ? "Picked options need labels before sending"
                : "Send these choices to the chat"
          }
        >
          Send to chat
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const PendingQuestionNodeComponent = memo(function PendingQuestionNodeComponent({
  id,
  data,
  selected,
}: NodeProps<PendingQuestionNode>) {
  const { setNodes } = useReactFlow();
  const isMulti = data.multiSelect;
  // Defensive: if options arrived in an unexpected shape, fall back to []
  // so .map() doesn't throw and silently kill the render.
  const optionLabels = Array.isArray(data.options)
    ? data.options
        .map((o) =>
          typeof o === "string" ? o : (o as { label?: string })?.label ?? "",
        )
        .filter((s) => s.length > 0)
    : [];
  // If answer is recorded on the data, render in read-only "answered" mode.
  const isAnswered = data.answer !== undefined;
  const answeredSet =
    data.answer === undefined
      ? new Set<string>()
      : Array.isArray(data.answer)
        ? new Set(data.answer)
        : new Set([data.answer]);
  // Pre-submit draft picks live on `data` (not local useState) so the
  // canvas serialiser can read them when "Send graph" runs.
  const singleChoice = data.draftSingle ?? null;
  const multiChoice = data.draftMulti ?? [];
  const [submitting, setSubmitting] = useState(false);
  function patch(partial: Partial<PendingQuestionData>) {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...(n.data as PendingQuestionData), ...partial } } as Node)
          : n,
      ),
    );
  }
  const setSingleChoice = (next: string | null) => patch({ draftSingle: next });
  const setMultiChoice = (
    updater: string[] | ((cur: string[]) => string[]),
  ) => {
    const cur = multiChoice;
    const next = typeof updater === "function" ? updater(cur) : updater;
    patch({ draftMulti: next });
  };
  const canSubmit = isMulti
    ? multiChoice.length > 0
    : singleChoice !== null;

  async function onSubmit() {
    if (!canSubmit || submitting || isAnswered) return;
    setSubmitting(true);
    try {
      const answer = isMulti
        ? { question: data.question, answer: multiChoice }
        : { question: data.question, answer: singleChoice as string };
      await data.onAnswer(data.messageId, data.toolUseId, [answer]);
    } catch (err) {
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        width: 240,
        background: "#fff",
        border: "2px solid #111",
        borderRadius: 6,
        padding: 10,
        fontSize: 12,
        color: "#111",
        boxShadow: selected ? "0 0 0 1px #111" : "0 1px 2px rgba(0,0,0,0.06)",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: isAnswered ? "#111" : "#777",
        }}
      >
        <span>
          {isAnswered ? "Answered" : isMulti ? "Multiple choice" : "Single choice"}
        </span>
        <span style={{ fontFamily: "monospace", letterSpacing: 0, textTransform: "none", fontSize: 9 }}>
          {data.source === "extracted" ? "inferred" : "from chat"}
        </span>
      </div>
      <div style={{ marginBottom: 8, fontFamily: "Georgia, serif", lineHeight: 1.2 }}>
        {data.question}
      </div>
      <ul
        className="nodrag"
        style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}
      >
        {optionLabels.length === 0 && (
          <li style={{ fontSize: 11, color: "#999" }}>(no options received)</li>
        )}
        {optionLabels.map((opt) => {
          // Once answered, "checked" reflects what the user submitted (read
          // from data.answer); before that, it's the local draft state.
          const checked = isAnswered
            ? answeredSet.has(opt)
            : isMulti
              ? multiChoice.includes(opt)
              : singleChoice === opt;
          const togglable = !isAnswered && !submitting;
          const handlePick = () => {
            if (!togglable) return;
            if (isMulti) {
              setMultiChoice((cur) =>
                cur.includes(opt)
                  ? cur.filter((v) => v !== opt)
                  : [...cur, opt],
              );
            } else {
              setSingleChoice(opt);
            }
          };
          return (
            <li key={opt}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  fontSize: 11,
                  color: checked ? "#111" : isAnswered ? "#999" : "#666",
                  fontWeight: isAnswered && checked ? 600 : 400,
                }}
              >
                {/* Custom radio/checkbox: a button styled to look like the
                 *  native control. Avoids React Flow's pointer-event
                 *  contention that swallows native input clicks. */}
                <button
                  type="button"
                  role={isMulti ? "checkbox" : "radio"}
                  aria-checked={checked}
                  disabled={!togglable}
                  className="nodrag"
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePick();
                  }}
                  style={{
                    marginTop: 2,
                    width: 12,
                    height: 12,
                    flexShrink: 0,
                    border: "1px solid #111",
                    borderRadius: isMulti ? 0 : "50%",
                    background: "#fff",
                    cursor: togglable ? "pointer" : "default",
                    opacity: togglable ? 1 : 0.7,
                    padding: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title={checked ? "Picked" : "Pick this option"}
                >
                  {checked && (
                    <span
                      style={{
                        display: "block",
                        width: isMulti ? 6 : 5,
                        height: isMulti ? 6 : 5,
                        background: "#111",
                        borderRadius: isMulti ? 0 : "50%",
                      }}
                    />
                  )}
                </button>
                <span
                  onClick={togglable ? handlePick : undefined}
                  style={{ cursor: togglable ? "pointer" : "default" }}
                >
                  {opt}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {isAnswered ? (
        <div
          style={{
            marginTop: 8,
            padding: "4px 8px",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            background: "#f1efe9",
            color: "#111",
            border: "1px solid #111",
            textAlign: "center",
          }}
        >
          ✓ Picked
        </div>
      ) : (
        <button
          type="button"
          className="nodrag"
          disabled={!canSubmit || submitting}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSubmit();
          }}
          style={{
            marginTop: 8,
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "4px 8px",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            background: !canSubmit || submitting ? "#999" : "#111",
            color: "#fff",
            border: "1px solid #111",
            cursor: !canSubmit || submitting ? "not-allowed" : "pointer",
            opacity: !canSubmit || submitting ? 0.6 : 1,
          }}
        >
          {submitting ? "Submitting…" : "Submit answer"}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const NODE_TYPES = {
  singleChoice: SingleChoiceNodeComponent,
  multiChoice: MultiChoiceNodeComponent,
  pendingQuestion: PendingQuestionNodeComponent,
};

// ---------- Initial graph -------------------------------------------------

// The canvas always starts empty. Use the toolbar (+ Step / + Single / + Multi)
// to add nodes; LLM-driven question nodes appear automatically when the chat
// asks the user to pick something.
const INITIAL_NODES: Node[] = [];
const INITIAL_EDGES: Edge[] = [];

const DEFAULT_EDGE_OPTIONS = {
  animated: true,
  style: { stroke: "#111", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#111" },
};

// ---------- Canvas inner --------------------------------------------------

interface CanvasInnerProps {
  pendingQuestions: PendingCanvasQuestion[];
  onAnswer: (
    messageId: string,
    toolUseId: string,
    answers: { question: string; answer: string | string[] }[],
  ) => Promise<void>;
  onSendToChat?: (text: string) => void;
}

function CanvasInner({
  pendingQuestions,
  onAnswer,
  onSendToChat,
}: CanvasInnerProps) {
  const [nodes, setNodes] = useNodesState<Node>(INITIAL_NODES);
  const [edges, setEdges] = useEdgesState<Edge>(INITIAL_EDGES);
  const rf = useReactFlow();

  // Stash latest onAnswer in a ref so the reconciler effect doesn't re-fire
  // on every chat turn just because Chat.tsx recreates its inline callback.
  // The effect should fire only when the SET of pending questions actually
  // changes (added or answered), not on cosmetic reference churn.
  const onAnswerRef = useRef(onAnswer);
  useEffect(() => {
    onAnswerRef.current = onAnswer;
  }, [onAnswer]);

  // Sync question nodes (pending + answered) INTO the controlled nodes
  // state. We NEVER remove a question node once it's on the canvas — even
  // after the user submits an answer it stays as a read-only record. Only
  // "Clear chat" wipes the canvas (via the key-driven remount).
  // User-managed nodes (step / single / multi added by the user
  // themselves) are completely untouched here.
  useEffect(() => {
    setNodes((curr) => {
      const havePendingIds = new Set(
        curr.filter((n) => n.id.startsWith("pending-")).map((n) => n.id),
      );

      // Refresh data on every existing pending node so a new answer flows
      // through and re-renders the component in answered mode. Stable for
      // user nodes — same reference returned.
      const refreshed = curr.map((n) => {
        if (!n.id.startsWith("pending-")) return n;
        const q = pendingQuestions.find(
          (x) => `pending-${x.toolUseId}` === n.id,
        );
        if (!q) return n;
        // Preserve pre-submit drafts the user has been building inside the
        // node — refreshing the question text from the chat shouldn't wipe
        // the user's in-progress pick.
        const oldData = n.data as PendingQuestionData | undefined;
        return {
          ...n,
          // selectable / draggable MUST stay true. React Flow applies
          // `pointer-events: none` to the wrapper when a node is
          // non-selectable, which silently swallows clicks on every
          // child element including our custom radio/checkbox buttons.
          selectable: true,
          draggable: true,
          data: {
            ...q,
            onAnswer: onAnswerRef.current,
            draftSingle: oldData?.draftSingle,
            draftMulti: oldData?.draftMulti,
          } as PendingQuestionData,
        };
      });

      // Append any incoming question that doesn't have a node yet.
      // Position below the lowest existing pending node so new ones stack
      // without overlapping previous answered ones.
      const additions: Node[] = [];
      let nextY = (() => {
        const pending = refreshed.filter((n) => n.id.startsWith("pending-"));
        return pending.length > 0
          ? Math.max(...pending.map((n) => n.position.y + ((n.height ?? 180) + 20)))
          : 24;
      })();
      for (const q of pendingQuestions) {
        const id = `pending-${q.toolUseId}`;
        if (havePendingIds.has(id)) continue;
        additions.push({
          id,
          type: "pendingQuestion",
          position: { x: 24, y: nextY },
          data: { ...q, onAnswer: onAnswerRef.current },
          // selectable + draggable kept true so React Flow doesn't put
          // `pointer-events: none` on the wrapper. We control deletion
          // via `deletable: false` (Clear chat is the only way out).
          selectable: true,
          deletable: false,
          draggable: true,
          width: 240,
          height: 180,
        } as PendingQuestionNode);
        nextY += 200;
      }
      return additions.length > 0 ? [...refreshed, ...additions] : refreshed;
    });
  }, [pendingQuestions, setNodes]);

  // Fit the viewport exactly ONCE — when the canvas first transitions from
  // empty to populated. After that the camera belongs to the user; new
  // questions appearing or old ones being answered must NOT yank the
  // viewport, or the user's manual pan/zoom is lost on every turn.
  const nodesInitialized = useNodesInitialized();
  const hasFitOnceRef = useRef(false);
  useEffect(() => {
    if (!nodesInitialized) return;
    if (hasFitOnceRef.current) return;
    if (nodes.length === 0) return;
    hasFitOnceRef.current = true;
    rf.fitView({ padding: 0.3, duration: 280, maxZoom: 1.1, minZoom: 0.5 });
  }, [nodes.length, nodesInitialized, rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) =>
      setNodes((curr) => applyNodeChanges<Node>(changes, curr)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setEdges((curr) => applyEdgeChanges<Edge>(changes, curr)),
    [setEdges],
  );
  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((curr) =>
        addEdge<Edge>({ ...params, ...DEFAULT_EDGE_OPTIONS }, curr),
      ),
    [setEdges],
  );

  function addNode(kind: "step" | "singleChoice" | "multiChoice") {
    const id = `node-${Date.now()}`;
    const basePos = {
      x: 80 + Math.random() * 80,
      y: 200 + Math.random() * 80,
    };
    setNodes((curr) => {
      if (kind === "step") {
        return [
          ...curr,
          {
            id,
            position: basePos,
            data: { label: "New step" },
            ...NODE_BASE,
          },
        ];
      }
      if (kind === "singleChoice") {
        return [
          ...curr,
          {
            id,
            type: "singleChoice",
            position: basePos,
            data: {
              label: "",
              options: ["", "", ""],
              value: null,
            },
          } as SingleChoiceNode,
        ];
      }
      // multiChoice
      return [
        ...curr,
        {
          id,
          type: "multiChoice",
          position: basePos,
          data: {
            label: "",
            options: ["", "", ""],
            values: [],
          },
        } as MultiChoiceNode,
      ];
    });
  }

  // What the user has highlighted right now — used to enable the Delete button.
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  const selectionCount = selectedNodes.length + selectedEdges.length;
  const deleteEnabled = selectionCount > 0;

  /**
   * Serialise the entire canvas graph into a markdown description suitable
   * for injection into the next chat turn. Captures node type, label,
   * options + picked answer (for choice/question nodes), and the edges
   * between them so the LLM can reason about the user's flow.
   */
  function serializeCanvas(): string {
    if (nodes.length === 0 && edges.length === 0) {
      return "";
    }
    const lines: string[] = [];
    lines.push("The user has built the following on the canvas:");
    lines.push("");
    lines.push("## Nodes");
    if (nodes.length === 0) {
      lines.push("- _(none)_");
    } else {
      for (const n of nodes) {
        const id = n.id;
        const type = (n.type as string | undefined) ?? "default";
        if (type === "singleChoice") {
          const d = n.data as SingleChoiceData;
          const picked =
            d.value !== null && d.value !== undefined && d.options[d.value]
              ? d.options[d.value]
              : null;
          const opts = d.options
            .map((o, i) => o.trim() || `Option ${i + 1}`)
            .join(", ");
          lines.push(
            `- **[${id}]** single-choice — "${d.label || "(no question)"}" ` +
              `[options: ${opts}]` +
              (picked ? ` — picked: **${picked}**` : " — _no pick yet_") +
              (d.sent ? " — sent" : ""),
          );
        } else if (type === "multiChoice") {
          const d = n.data as MultiChoiceData;
          const picks = (d.values ?? [])
            .map((i) => d.options[i])
            .filter((s): s is string => Boolean(s && s.trim()));
          const opts = d.options
            .map((o, i) => o.trim() || `Option ${i + 1}`)
            .join(", ");
          lines.push(
            `- **[${id}]** multi-choice — "${d.label || "(no question)"}" ` +
              `[options: ${opts}]` +
              (picks.length > 0
                ? ` — picked: **${picks.join(", ")}**`
                : " — _no picks yet_") +
              (d.sent ? " — sent" : ""),
          );
        } else if (type === "pendingQuestion") {
          const d = n.data as PendingQuestionData;
          const optStrs = (d.options ?? [])
            .map((o) => (typeof o === "string" ? o : o?.label ?? ""))
            .filter((s) => s.length > 0);
          const ans = d.answer;
          let ansStr: string;
          if (ans !== undefined) {
            ansStr = Array.isArray(ans)
              ? `picked: **${ans.join(", ")}** (submitted)`
              : `picked: **${ans}** (submitted)`;
          } else if (
            d.multiSelect &&
            Array.isArray(d.draftMulti) &&
            d.draftMulti.length > 0
          ) {
            ansStr = `draft pick (not yet submitted): **${d.draftMulti.join(", ")}**`;
          } else if (!d.multiSelect && d.draftSingle) {
            ansStr = `draft pick (not yet submitted): **${d.draftSingle}**`;
          } else {
            ansStr = "_unanswered_";
          }
          lines.push(
            `- **[${id}]** ${d.multiSelect ? "multi" : "single"}-choice ` +
              `(from chat, ${d.source ?? "tool"}) — "${d.question}" ` +
              `[options: ${optStrs.join(", ")}] — ${ansStr}`,
          );
        } else {
          // Default / step node: data.label is a string.
          const label =
            (n.data as { label?: unknown })?.label &&
            typeof (n.data as { label?: unknown }).label === "string"
              ? ((n.data as { label: string }).label as string)
              : "(unlabelled)";
          lines.push(`- **[${id}]** step — "${label.replace(/\n/g, " ")}"`);
        }
      }
    }
    lines.push("");
    lines.push("## Edges (flow direction)");
    if (edges.length === 0) {
      lines.push("- _(none)_");
    } else {
      for (const e of edges) {
        lines.push(`- [${e.source}] → [${e.target}]`);
      }
    }
    lines.push("");
    lines.push(
      "Please treat this graph as authoritative context. " +
        "Reference the nodes and edges in your reply when relevant " +
        "and continue the workflow accordingly.",
    );
    return lines.join("\n");
  }

  function sendCanvasToChat() {
    const text = serializeCanvas();
    if (!text || !onSendToChat) return;
    onSendToChat(text);
  }

  function deleteSelection() {
    if (!deleteEnabled) return;
    const nodeIds = new Set(selectedNodes.map((n) => n.id));
    const edgeIds = new Set(selectedEdges.map((e) => e.id));
    setNodes((curr) => curr.filter((n) => !nodeIds.has(n.id)));
    setEdges((curr) =>
      curr.filter(
        (e) =>
          !edgeIds.has(e.id) &&
          !nodeIds.has(e.source) &&
          !nodeIds.has(e.target),
      ),
    );
  }

  return (
    <div className="relative h-full w-full">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        <button
          type="button"
          onClick={deleteSelection}
          disabled={!deleteEnabled}
          className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] transition ${
            deleteEnabled
              ? "border-red-700 bg-red-700 text-paper hover:opacity-90"
              : "cursor-not-allowed border-rule text-muted/60"
          }`}
          title={
            deleteEnabled
              ? `Delete ${selectionCount} selected element${selectionCount === 1 ? "" : "s"} (or press Backspace/Delete)`
              : "Click a node or edge to select, then delete"
          }
        >
          Delete{deleteEnabled ? ` (${selectionCount})` : ""}
        </button>
        <button
          type="button"
          onClick={() => addNode("step")}
          className="inline-flex items-center gap-1 border border-ink bg-ink px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-paper transition hover:opacity-90"
          title="Add a plain step node"
        >
          + Step
        </button>
        <button
          type="button"
          onClick={() => addNode("singleChoice")}
          className="inline-flex items-center gap-1 border border-ink bg-paper px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-ink transition hover:bg-ink hover:text-paper"
          title="Add a single-choice (radio) node"
        >
          + Single
        </button>
        <button
          type="button"
          onClick={() => addNode("multiChoice")}
          className="inline-flex items-center gap-1 border border-ink bg-paper px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-ink transition hover:bg-ink hover:text-paper"
          title="Add a multi-choice (checkbox) node"
        >
          + Multi
        </button>
        <button
          type="button"
          onClick={sendCanvasToChat}
          disabled={(nodes.length === 0 && edges.length === 0) || !onSendToChat}
          className="inline-flex items-center gap-1 border border-ink bg-ink px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            nodes.length === 0 && edges.length === 0
              ? "Build something on the canvas first"
              : `Send all ${nodes.length} node${nodes.length === 1 ? "" : "s"} and ${edges.length} edge${edges.length === 1 ? "" : "s"} as chat context for the next turn`
          }
        >
          ↗ Send graph
        </button>
      </div>
      <CanvasInteractionContext.Provider value={{ onSendToChat }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: "#111", strokeWidth: 1.5 }}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        deleteKeyCode={["Backspace", "Delete"]}
        // No `fitView` prop here — it'd run once before nodes are measured
        // and leave the camera zoomed onto a 0×0 rectangle. The
        // post-initialised effect above does the right thing instead.
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      </CanvasInteractionContext.Provider>
    </div>
  );
}

export interface ProjectCanvasProps {
  pendingQuestions?: PendingCanvasQuestion[];
  onAnswer?: (
    messageId: string,
    toolUseId: string,
    answers: { question: string; answer: string | string[] }[],
  ) => Promise<void>;
  /** Called when the user authors a single/multi-choice node and clicks
   *  Send to chat. The caller decides how to inject `text` into the chat
   *  (typically as a synthetic user-message turn). */
  onSendToChat?: (text: string) => void;
}

export default function ProjectCanvas({
  pendingQuestions = [],
  onAnswer = async () => {},
  onSendToChat,
}: ProjectCanvasProps) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <CanvasInner
          pendingQuestions={pendingQuestions}
          onAnswer={onAnswer}
          onSendToChat={onSendToChat}
        />
      </ReactFlowProvider>
    </div>
  );
}
