// A session that lives on one of your Macs, read through the box's mirror
// and tailed live through the tunnel while the Mac is online. Sending a
// message works whenever the Mac is reachable; otherwise the transcript is
// read-only (the box has no agent of its own, by design).
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  applyEvent,
  initialState,
  type SessionEvent,
  type SessionMessage,
  type SessionSummary,
  type TranscriptState,
} from "@labee/session-core";
import { apiGet, apiSend } from "~/lib/api";

export const Route = createFileRoute("/macs/$hostId/$sessionId")({ component: MacSessionPage });

function MacSessionPage() {
  const { hostId, sessionId } = Route.useParams();
  const base = `/api/hosts/${encodeURIComponent(hostId)}/api/sessions/${encodeURIComponent(sessionId)}`;
  const [state, setState] = useState<TranscriptState>(() => initialState());
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ session: SessionSummary; messages: SessionMessage[] }>(base);
      setSummary(r.session);
      let seeded = initialState(r.messages, 0);
      if (r.session.status === "running" && r.session.activeTurn) {
        const idx = seeded.messages.findIndex((m) => m.turnId === r.session.activeTurn);
        if (idx !== -1) seeded = { ...seeded, messages: seeded.messages.slice(0, idx) };
        stateRef.current = { ...seeded, lastSeq: 0 };
      } else {
        stateRef.current = { ...seeded, lastSeq: r.session.lastSeq };
      }
      setState(stateRef.current);
      setError(null);
      esRef.current?.close();
      const es = new EventSource(`${base}/events?after=${stateRef.current.lastSeq}&coalesce=150`, { withCredentials: true });
      esRef.current = es;
      es.addEventListener("session_event", (e) => {
        const evt = JSON.parse((e as MessageEvent<string>).data) as SessionEvent;
        if (evt.type === "session_status") {
          const d = evt.data as { status?: string; hostOnline?: boolean };
          setSummary((s) => (s ? { ...s, status: (d.status as SessionSummary["status"]) ?? s.status, ...(d.hostOnline === false ? { hostOnline: false } : {}) } : s));
          return;
        }
        const next = applyEvent(stateRef.current, evt);
        if (next !== stateRef.current) {
          stateRef.current = next;
          setState(next);
        }
        if (evt.type === "turn_started") setSummary((s) => (s ? { ...s, status: "running" } : s));
        if (evt.type === "turn_ended" || evt.type === "turn_cancelled") setSummary((s) => (s ? { ...s, status: evt.data.question ? "awaiting_input" : "idle" } : s));
      });
      es.onerror = () => {
        /* EventSource retries by itself; the mirror closes when offline */
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  useEffect(() => {
    void load();
    return () => esRef.current?.close();
  }, [load]);

  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    try {
      await apiSend("POST", `${base}/turns`, { text: v, device: "web" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const offline = summary?.hostOnline === false;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-background/80 px-6 backdrop-blur">
        <Link to="/macs" className="text-sm text-ink-light hover:text-ink">← Your Macs</Link>
        <span className="min-w-0 truncate font-display text-[1.0625rem] text-ink">{summary?.title ?? "Session"}</span>
        <span className="text-xs text-ink-light">{offline ? "Mac offline · read-only" : summary?.status ?? ""}</span>
      </header>
      <div className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {state.messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "self-end rounded-2xl bg-sidebar-accent px-4 py-2 text-sm text-ink" : "text-sm text-ink"}>
              <div className="mb-1 text-[11px] text-ink-light">
                {m.role === "user" ? "You" : "Labee"}
                {m.device ? ` · ${m.device}` : ""}
                {m.pending ? " · working…" : ""}
              </div>
              <div className="whitespace-pre-wrap">{m.content || (m.pending ? "…" : "")}</div>
              {m.activity.filter((a) => a.kind === "tool").length > 0 ? (
                <div className="mt-1 text-[11px] text-ink-light">
                  {Array.from(new Set(m.activity.filter((a) => a.kind === "tool").map((a) => (a as { name: string }).name))).join(" · ")}
                </div>
              ) : null}
              {m.error ? <div className="mt-1 text-xs text-destructive">{m.error}</div> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="sticky bottom-0 border-t border-border bg-background p-4">
        <form
          className="mx-auto flex w-full max-w-3xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={offline}
            placeholder={offline ? "The Mac is offline" : "Message this Mac's session…"}
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-ink"
          />
          <button type="submit" disabled={offline || !text.trim()} className="rounded-lg bg-ink px-4 py-2 text-sm text-background disabled:opacity-50">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
