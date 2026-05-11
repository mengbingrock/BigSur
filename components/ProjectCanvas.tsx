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

// Plain free-text "step" node. Stored as a custom type so the label is
// editable inline (default React Flow nodes render data.label as a
// non-editable string). When the step represents an extracted pipeline
// phase, `subPhases` carries finer-grained children that the user can
// reveal by clicking the expand button; `expanded` tracks the toggle
// state and is read by a reconciler effect that creates child nodes.
// `originalLabel` / `originalSummary` snapshot the LLM-provided text so
// the serialiser can include a before/after diff when the user has
// edited.
type StepNodeData = {
  label: string;
  /** Optional one-line summary, shown under the label in a smaller font. */
  summary?: string;
  /** Sub-phases that can be drilled into. */
  subPhases?: CanvasPhase[];
  /** Whether sub-phase children are currently materialised on the canvas. */
  expanded?: boolean;
  /** What the extractor originally produced — null/undefined for plain
   *  user-added step nodes (they have no "original"). */
  originalLabel?: string;
  originalSummary?: string;
  /** Set on sub-phase step nodes only — the canvas id of the parent
   *  phase node this child was expanded from. Lets the edge reconciler
   *  draw a parent → child edge without trying to parse the id back
   *  out of the node id (which is fragile when message ids contain
   *  hyphens themselves). */
  parentId?: string;
} & Record<string, unknown>;

type StepNode = Node<StepNodeData, "step">;


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
  /** Extra options the user added to this LLM-emitted question — lets
   *  them answer "none of the above — here's my own answer" without
   *  having to type into the chat. Stored alongside the original
   *  options; the submit handler treats them equally. */
  customOptions?: string[];
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

const StepNodeComponent = memo(function StepNodeComponent({
  id,
  data,
  selected,
}: NodeProps<StepNode>) {
  const { setNodes } = useReactFlow();
  const hasChildren = Array.isArray(data.subPhases) && data.subPhases.length > 0;
  const expanded = Boolean(data.expanded);
  // True only when this node was created from extractor output AND its
  // current text differs from the snapshot. Pure user-added step nodes
  // have no originalLabel and never show as edited.
  const labelEdited =
    data.originalLabel !== undefined &&
    (data.label ?? "") !== (data.originalLabel ?? "");
  const summaryEdited =
    data.originalSummary !== undefined &&
    (data.summary ?? "") !== (data.originalSummary ?? "");
  const isEdited = labelEdited || summaryEdited;
  function patch(partial: Partial<StepNodeData>) {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...(n.data as StepNodeData), ...partial } } as Node)
          : n,
      ),
    );
  }
  function setLabel(label: string) {
    patch({ label });
  }
  function setSummary(summary: string) {
    patch({ summary });
  }
  return (
    <div
      className={`${customNodeShell} w-[200px] ${selected ? "ring-1 ring-ink" : ""} ${
        isEdited ? "border-amber-500" : ""
      }`}
    >
      {/* Four explicitly id'd handles. The horizontal pair carries the
       *  top-level phase → phase workflow line; the vertical pair carries
       *  parent → sub-phase drop-downs. Edges MUST specify sourceHandle/
       *  targetHandle that match these ids — un-id'd edges would be
       *  ambiguous once more than one handle of a given type exists. */}
      <Handle id="left" type="target" position={Position.Left} />
      <Handle id="top" type="target" position={Position.Top} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      {isEdited && (
        <div className="mb-1 inline-block border border-amber-500 bg-amber-50 px-1 text-[9px] uppercase tracking-[0.1em] text-amber-700">
          edited
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <textarea
          className="nodrag flex-1 min-w-0 resize-none bg-transparent text-[12px] leading-snug text-ink placeholder:text-muted focus:outline-none"
          value={data.label ?? ""}
          onChange={(e) => setLabel(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          rows={Math.max(1, Math.min(6, ((data.label ?? "").match(/\n/g)?.length ?? 0) + 1))}
          placeholder="Step description…"
        />
        {hasChildren && (
          <button
            type="button"
            className="nodrag shrink-0 border border-ink bg-paper px-1 py-0 text-[10px] leading-tight text-ink hover:bg-ink hover:text-paper"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              patch({ expanded: !expanded });
            }}
            title={
              expanded
                ? "Collapse — hide sub-phases"
                : `Expand — show ${data.subPhases!.length} sub-phase${data.subPhases!.length === 1 ? "" : "s"}`
            }
          >
            {expanded ? "−" : "+"}
          </button>
        )}
      </div>
      {/* Summary: editable when present OR when this is an extractor-
       *  produced node (has originalSummary, may be empty). User-added
       *  step nodes (no originalSummary) skip this row to stay compact. */}
      {(data.summary !== undefined || data.originalSummary !== undefined) && (
        <textarea
          className="nodrag mt-1 w-full resize-none bg-transparent text-[10px] leading-snug text-muted placeholder:text-muted/60 focus:text-ink focus:outline-none"
          value={data.summary ?? ""}
          onChange={(e) => setSummary(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          rows={Math.max(1, Math.min(4, ((data.summary ?? "").match(/\n/g)?.length ?? 0) + 1))}
          placeholder="Summary…"
        />
      )}
      <Handle id="right" type="source" position={Position.Right} />
    </div>
  );
});

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
  const llmOptionLabels = Array.isArray(data.options)
    ? data.options
        .map((o) =>
          typeof o === "string" ? o : (o as { label?: string })?.label ?? "",
        )
        .filter((s) => s.length > 0)
    : [];
  const customOptions = data.customOptions ?? [];
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
  function addCustomOption() {
    if (isAnswered) return;
    patch({ customOptions: [...customOptions, ""] });
  }
  function setCustomOption(idx: number, value: string) {
    if (isAnswered) return;
    const oldLabel = customOptions[idx];
    const next = customOptions.slice();
    next[idx] = value;
    // If this option was drafted, follow the rename in draft state.
    const renamedSingle = singleChoice === oldLabel ? value : singleChoice;
    const renamedMulti = multiChoice.map((v) => (v === oldLabel ? value : v));
    patch({
      customOptions: next,
      draftSingle: renamedSingle,
      draftMulti: renamedMulti,
    });
  }
  function removeCustomOption(idx: number) {
    if (isAnswered) return;
    const removed = customOptions[idx];
    patch({
      customOptions: customOptions.filter((_, i) => i !== idx),
      draftSingle: singleChoice === removed ? null : singleChoice,
      draftMulti: multiChoice.filter((v) => v !== removed),
    });
  }
  const canSubmit = isMulti
    ? multiChoice.length > 0
    : singleChoice !== null && singleChoice.length > 0;

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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {!isAnswered && (
            <button
              type="button"
              className="nodrag"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                addCustomOption();
              }}
              title="Add your own option"
              style={{
                fontFamily: "monospace",
                letterSpacing: 0,
                textTransform: "none",
                fontSize: 9,
                color: "#666",
                background: "transparent",
                border: "1px solid #ccc",
                padding: "1px 5px",
                cursor: "pointer",
              }}
            >
              + opt
            </button>
          )}
          <span style={{ fontFamily: "monospace", letterSpacing: 0, textTransform: "none", fontSize: 9 }}>
            {data.source === "extracted" ? "inferred" : "from chat"}
          </span>
        </span>
      </div>
      <div style={{ marginBottom: 8, fontFamily: "Georgia, serif", lineHeight: 1.2 }}>
        {data.question}
      </div>
      <ul
        className="nodrag"
        style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}
      >
        {llmOptionLabels.length === 0 && customOptions.length === 0 && (
          <li style={{ fontSize: 11, color: "#999" }}>(no options received)</li>
        )}
        {llmOptionLabels.map((opt) => {
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
            <li key={`llm-${opt}`}>
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
        {/* User-added custom options. Editable; picked the same way as LLM
         *  options. When the user submits, the custom label is sent as the
         *  answer just like an LLM option. */}
        {customOptions.map((opt, idx) => {
          const checked = isAnswered
            ? answeredSet.has(opt)
            : isMulti
              ? multiChoice.includes(opt)
              : singleChoice === opt;
          const togglable = !isAnswered && !submitting && opt.trim().length > 0;
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
            <li key={`custom-${idx}`}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  color: checked ? "#111" : isAnswered ? "#999" : "#666",
                  fontWeight: isAnswered && checked ? 600 : 400,
                }}
              >
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
                    width: 12,
                    height: 12,
                    flexShrink: 0,
                    border: "1px dashed #111",
                    borderRadius: isMulti ? 0 : "50%",
                    background: "#fff",
                    cursor: togglable ? "pointer" : "default",
                    opacity: togglable ? 1 : 0.5,
                    padding: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title={
                    !togglable
                      ? "Type a label first"
                      : checked
                        ? "Picked"
                        : "Pick this option"
                  }
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
                <input
                  type="text"
                  className="nodrag"
                  value={opt}
                  onChange={(e) => setCustomOption(idx, e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  placeholder="My own answer…"
                  disabled={isAnswered}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    borderBottom: "1px dashed #ccc",
                    background: "transparent",
                    fontSize: 11,
                    color: "#111",
                    padding: "0 2px",
                    outline: "none",
                  }}
                />
                {!isAnswered && (
                  <button
                    type="button"
                    className="nodrag"
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeCustomOption(idx);
                    }}
                    title="Remove this option"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#999",
                      fontSize: 11,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                )}
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
  step: StepNodeComponent,
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

/**
 * One phase in the canvas pipeline. Can carry nested sub-phases that
 * the user reveals by clicking the parent's expand button — drives the
 * "hierarchical drill-down" view of the LLM's reply.
 */
export interface CanvasPhase {
  id: string;
  label: string;
  summary: string;
  subPhases?: CanvasPhase[];
}

export interface CanvasPipeline {
  phases: CanvasPhase[];
  edges: { source: string; target: string }[];
}

interface CanvasInnerProps {
  pendingQuestions: PendingCanvasQuestion[];
  pipeline?: CanvasPipeline;
  onAnswer: (
    messageId: string,
    toolUseId: string,
    answers: { question: string; answer: string | string[] }[],
  ) => Promise<void>;
  onSendToChat?: (text: string) => void;
  /** When set, the canvas writes a "consume pending edits" function into
   *  the ref. Chat can call it before each user send so the LLM sees what
   *  the user edited since the last extraction. Calling commits the edits
   *  (current values become the new baseline). */
  editGetterRef?: React.MutableRefObject<(() => string | null) | null>;
}

function CanvasInner({
  pendingQuestions,
  pipeline,
  onAnswer,
  onSendToChat,
  editGetterRef,
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
            customOptions: oldData?.customOptions,
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

  // Pipeline reconciler: bring Haiku-extracted phases onto the canvas as
  // step nodes, with edges between them representing the workflow's
  // sequence. Like the question reconciler: only ADDS new nodes, never
  // removes (Clear chat is the only wipe). Existing user-managed nodes
  // pass through untouched.
  useEffect(() => {
    if (!pipeline || pipeline.phases.length === 0) return;
    const wantNodeIds = new Set(pipeline.phases.map((p) => `phase-${p.id}`));
    const wantEdgeIds = new Set(
      pipeline.edges.map((e) => `phase-edge-${e.source}->${e.target}`),
    );

    setNodes((curr) => {
      const haveIds = new Set(curr.map((n) => n.id));
      // Layout: pack new phases horizontally in a row at the top of the
      // canvas, offset to the right of any existing phase nodes.
      const existingPhases = curr.filter((n) => n.id.startsWith("phase-") && !n.id.startsWith("phase-edge-"));
      let nextX =
        existingPhases.length > 0
          ? Math.max(...existingPhases.map((n) => n.position.x + 220))
          : 320;
      const additions: Node[] = [];
      for (const p of pipeline.phases) {
        const nodeId = `phase-${p.id}`;
        if (haveIds.has(nodeId)) continue;
        if (!wantNodeIds.has(nodeId)) continue;
        additions.push({
          id: nodeId,
          type: "step",
          position: { x: nextX, y: 24 },
          data: {
            label: p.label,
            summary: p.summary || "",
            subPhases: p.subPhases,
            expanded: false,
            // Snapshot the extractor output so future edits can be diffed
            // and surfaced to the LLM on the next turn.
            originalLabel: p.label,
            originalSummary: p.summary || "",
          } satisfies StepNodeData,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        } as StepNode);
        nextX += 220;
      }
      return additions.length > 0 ? [...curr, ...additions] : curr;
    });

    setEdges((curr) => {
      const haveIds = new Set(curr.map((e) => e.id));
      const additions: Edge[] = [];
      for (const e of pipeline.edges) {
        const eid = `phase-edge-${e.source}->${e.target}`;
        if (haveIds.has(eid)) continue;
        if (!wantEdgeIds.has(eid)) continue;
        additions.push({
          id: eid,
          source: `phase-${e.source}`,
          sourceHandle: "right",
          target: `phase-${e.target}`,
          targetHandle: "left",
          animated: true,
          style: { stroke: "#111", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#111" },
        });
      }
      return additions.length > 0 ? [...curr, ...additions] : curr;
    });
  }, [pipeline, setNodes, setEdges]);

  // Drill-down: when a phase node has `expanded: true` and carries
  // sub-phases, materialise child step-nodes below it (and edges from
  // parent → each child). When the user collapses, remove those child
  // nodes and their edges. Driven entirely by the parent's `expanded`
  // flag, so this stays declarative.
  useEffect(() => {
    setNodes((curr) => {
      // Build the desired set of subphase node ids for each expanded
      // parent. Anything else under the `subphase-` prefix should be
      // dropped (came from a now-collapsed parent).
      const desired = new Map<string, { parentId: string; phase: CanvasPhase }>();
      for (const n of curr) {
        if (n.type !== "step") continue;
        const d = n.data as StepNodeData | undefined;
        if (!d?.expanded || !d.subPhases) continue;
        d.subPhases.forEach((sp) => {
          const childId = `subphase-${n.id}-${sp.id}`;
          desired.set(childId, { parentId: n.id, phase: sp });
        });
      }
      // Drop subphase nodes that are no longer desired.
      let filtered = curr.filter((n) => {
        if (!n.id.startsWith("subphase-")) return true;
        return desired.has(n.id);
      });
      // Add subphase nodes that aren't there yet, positioned just below
      // their parent.
      const haveIds = new Set(filtered.map((n) => n.id));
      const additions: Node[] = [];
      // Track per-parent count so siblings spread out horizontally.
      const perParent: Record<string, number> = {};
      for (const [childId, info] of desired.entries()) {
        if (haveIds.has(childId)) continue;
        const parent = filtered.find((n) => n.id === info.parentId);
        if (!parent) continue;
        const idx = perParent[info.parentId] ?? 0;
        perParent[info.parentId] = idx + 1;
        additions.push({
          id: childId,
          type: "step",
          position: {
            x: parent.position.x + idx * 220 - 20,
            y: parent.position.y + 180,
          },
          data: {
            label: info.phase.label,
            summary: info.phase.summary || "",
            // recursive sub-phases are deferred — could expand further if needed
            subPhases: info.phase.subPhases,
            expanded: false,
            originalLabel: info.phase.label,
            originalSummary: info.phase.summary || "",
            parentId: info.parentId,
          } satisfies StepNodeData,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        } as StepNode);
      }
      if (
        additions.length === 0 &&
        filtered.length === curr.length
      ) {
        return curr;
      }
      return additions.length > 0 ? [...filtered, ...additions] : filtered;
    });

    setEdges((curr) => {
      // Mirror the nodes work: the desired edge set is "parent → child"
      // for every materialised subphase node.
      const wantEdgeIds = new Set<string>();
      const wantEdgeSpecs: { id: string; source: string; target: string }[] = [];
      // Recompute parent-expanded map from the latest nodes
      // (snapshot since `curr` here is edges; we look at latest store).
      // We use a small heuristic: scan the current nodes by reading from
      // the store via the data we set above. Simpler: derive from edges
      // and rebuild from scratch each tick.
      // — Pull node list via setNodes(curr => { ... return curr; }) trick is
      // not needed; instead, use a freshly-derived map from `nodes` state
      // available through closure. We approximate by including every edge
      // whose ids match the subphase pattern.
      // Simplest: just diff against existing subphase-edge ids by recomputing
      // them from currently-pending subphase node ids.
      const subphaseNodeIds = new Set(
        curr
          .map((e) => e.target)
          .filter((id) => id.startsWith("subphase-")),
      );
      // Drop subphase edges whose target is no longer a desired subphase
      // (the corresponding node was removed in the previous setNodes call).
      const filtered = curr.filter((e) => {
        if (!e.id.startsWith("subphase-edge-")) return true;
        return subphaseNodeIds.has(e.target);
      });
      void wantEdgeIds;
      void wantEdgeSpecs;
      return filtered;
    });
  }, [nodes, setNodes, setEdges]);

  // Add (and prune) sub-phase edges to mirror the current sub-phase node
  // set. Runs as a second pass because new node ids only become real
  // after the setNodes above commits.
  useEffect(() => {
    setEdges((curr) => {
      const nodeIds = new Set(nodes.map((n) => n.id));
      // 1. Drop sub-phase edges whose source or target node is gone
      //    (e.g. parent collapsed → children just disappeared).
      const pruned = curr.filter((e) => {
        if (!e.id.startsWith("subphase-edge-")) return true;
        return nodeIds.has(e.source) && nodeIds.has(e.target);
      });
      // 2. Add a parent → child edge for every sub-phase node that
      //    doesn't have one yet.
      const have = new Set(pruned.map((e) => e.id));
      const additions: Edge[] = [];
      for (const n of nodes) {
        if (!n.id.startsWith("subphase-")) continue;
        const parentId = (n.data as StepNodeData | undefined)?.parentId;
        if (!parentId || !nodeIds.has(parentId)) continue;
        const eid = `subphase-edge-${parentId}->${n.id}`;
        if (have.has(eid)) continue;
        additions.push({
          id: eid,
          source: parentId,
          sourceHandle: "bottom",
          target: n.id,
          targetHandle: "top",
          animated: false,
          style: { stroke: "#666", strokeWidth: 1, strokeDasharray: "4 3" },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#666" },
        });
      }
      if (pruned.length === curr.length && additions.length === 0) return curr;
      return additions.length > 0 ? [...pruned, ...additions] : pruned;
    });
  }, [nodes, setEdges]);

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
            type: "step",
            position: basePos,
            // Empty label so the placeholder ("Step description…") shows
            // and the user can start typing immediately.
            data: { label: "" },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
          } as StepNode,
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
    // Collect edits to phase nodes so the LLM sees, up front and explicitly,
    // what the user changed about the pipeline since extraction.
    type Edit = {
      id: string;
      labelFrom?: string;
      labelTo?: string;
      summaryFrom?: string;
      summaryTo?: string;
    };
    const edits: Edit[] = [];
    for (const n of nodes) {
      if (n.type !== "step") continue;
      const d = n.data as StepNodeData | undefined;
      if (!d || d.originalLabel === undefined) continue;
      const labelChanged = (d.label ?? "") !== (d.originalLabel ?? "");
      const summaryChanged =
        d.originalSummary !== undefined &&
        (d.summary ?? "") !== (d.originalSummary ?? "");
      if (!labelChanged && !summaryChanged) continue;
      edits.push({
        id: n.id,
        labelFrom: labelChanged ? d.originalLabel : undefined,
        labelTo: labelChanged ? d.label ?? "" : undefined,
        summaryFrom: summaryChanged ? d.originalSummary ?? "" : undefined,
        summaryTo: summaryChanged ? d.summary ?? "" : undefined,
      });
    }
    if (edits.length > 0) {
      lines.push("## Pipeline edits the user made");
      lines.push(
        "The user edited the following phase nodes after you extracted them. " +
          "Treat each edit as the user's correction or refinement of what you " +
          "originally proposed, and respect it going forward:",
      );
      for (const ed of edits) {
        const parts: string[] = [];
        if (ed.labelTo !== undefined) {
          parts.push(
            `label: "${(ed.labelFrom ?? "").replace(/\n/g, " ")}" → "${(ed.labelTo ?? "").replace(/\n/g, " ")}"`,
          );
        }
        if (ed.summaryTo !== undefined) {
          parts.push(
            `summary: "${(ed.summaryFrom ?? "").replace(/\n/g, " ")}" → "${(ed.summaryTo ?? "").replace(/\n/g, " ")}"`,
          );
        }
        lines.push(`- **[${ed.id}]** ${parts.join("; ")}`);
      }
      lines.push("");
    }
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
          const llmOpts = (d.options ?? [])
            .map((o) => (typeof o === "string" ? o : o?.label ?? ""))
            .filter((s) => s.length > 0);
          const customOpts = (d.customOptions ?? [])
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const optStrs = [
            ...llmOpts,
            ...customOpts.map((s) => `${s} (user-added)`),
          ];
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
          const d = n.data as StepNodeData | undefined;
          const label =
            d?.label && typeof d.label === "string" ? d.label : "(unlabelled)";
          const summary =
            d?.summary && typeof d.summary === "string" ? d.summary.trim() : "";
          const wasEdited =
            d?.originalLabel !== undefined &&
            ((d?.label ?? "") !== (d?.originalLabel ?? "") ||
              (d?.originalSummary !== undefined &&
                (d?.summary ?? "") !== (d?.originalSummary ?? "")));
          lines.push(
            `- **[${id}]** step — "${label.replace(/\n/g, " ")}"` +
              (summary ? ` — ${summary.replace(/\n/g, " ")}` : "") +
              (wasEdited ? " — _edited by user_" : ""),
          );
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

  // Build the "what did the user edit since extraction" prefix block and,
  // as a side effect, commit the edits (reset original* baselines to
  // current values). Returns null when there are no edits to surface.
  // Stashed in a ref so the latest closure is always callable from Chat
  // without re-creating callbacks every render.
  const consumePendingEditsRef = useRef<() => string | null>(() => null);
  useEffect(() => {
    consumePendingEditsRef.current = () => {
      const editLines: string[] = [];
      let touched = false;
      const nextNodes = nodes.map((n) => {
        if (n.type !== "step") return n;
        const d = n.data as StepNodeData | undefined;
        if (!d || d.originalLabel === undefined) return n;
        const labelChanged = (d.label ?? "") !== (d.originalLabel ?? "");
        const summaryChanged =
          d.originalSummary !== undefined &&
          (d.summary ?? "") !== (d.originalSummary ?? "");
        if (!labelChanged && !summaryChanged) return n;
        const parts: string[] = [];
        if (labelChanged) {
          parts.push(
            `label: "${(d.originalLabel ?? "").replace(/\n/g, " ")}" → "${(d.label ?? "").replace(/\n/g, " ")}"`,
          );
        }
        if (summaryChanged) {
          parts.push(
            `summary: "${(d.originalSummary ?? "").replace(/\n/g, " ")}" → "${(d.summary ?? "").replace(/\n/g, " ")}"`,
          );
        }
        editLines.push(`- **[${n.id}]** ${parts.join("; ")}`);
        touched = true;
        return {
          ...n,
          data: {
            ...d,
            originalLabel: d.label,
            originalSummary: d.summary ?? "",
          },
        };
      });
      if (!touched) return null;
      setNodes(nextNodes);
      return [
        "The user edited the following pipeline phases on the canvas " +
          "after you extracted them — treat each as the user's correction " +
          "or refinement of what you originally proposed, and respect it " +
          "going forward:",
        ...editLines,
      ].join("\n");
    };
  });
  useEffect(() => {
    if (!editGetterRef) return;
    editGetterRef.current = () => consumePendingEditsRef.current();
    return () => {
      if (editGetterRef.current) editGetterRef.current = null;
    };
  }, [editGetterRef]);

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
  /** Haiku-extracted pipeline (phases + edges) to materialise as step nodes. */
  pipeline?: CanvasPipeline;
  onAnswer?: (
    messageId: string,
    toolUseId: string,
    answers: { question: string; answer: string | string[] }[],
  ) => Promise<void>;
  /** Called when the user authors a single/multi-choice node and clicks
   *  Send to chat. The caller decides how to inject `text` into the chat
   *  (typically as a synthetic user-message turn). */
  onSendToChat?: (text: string) => void;
  /** Optional ref; the canvas registers a "consume pending edits" function
   *  inside it. Chat invokes the function before sending the user's next
   *  textarea message to surface phase-node edits to the LLM. */
  editGetterRef?: React.MutableRefObject<(() => string | null) | null>;
}

export default function ProjectCanvas({
  pendingQuestions = [],
  pipeline,
  onAnswer = async () => {},
  onSendToChat,
  editGetterRef,
}: ProjectCanvasProps) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <CanvasInner
          pendingQuestions={pendingQuestions}
          pipeline={pipeline}
          onAnswer={onAnswer}
          onSendToChat={onSendToChat}
          editGetterRef={editGetterRef}
        />
      </ReactFlowProvider>
    </div>
  );
}
