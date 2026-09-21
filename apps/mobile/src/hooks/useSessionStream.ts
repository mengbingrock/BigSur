// Attach to one server session: seed from GET, then tail events from lastSeq
// through the shared reducer. Reconnects with backoff; iOS suspends streams in
// the background so a foreground resume simply re-opens from lastSeq.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState as RNAppState } from "react-native";
import {
  applyEvent,
  initialState,
  type AskUserAnswer,
  type SessionEvent,
  type SessionSummary,
  type TranscriptState,
  type TurnRequest,
} from "@labee/session-core";
import type { Target } from "~/api/client";
import * as api from "~/api/sessions";

export interface SessionStream {
  state: TranscriptState;
  summary: SessionSummary | null;
  queue: api.QueuedItem[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  send: (req: TurnRequest) => Promise<void>;
  cancel: () => Promise<void>;
  answer: (answers: AskUserAnswer[], voice?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  /** Subscribe to live text deltas (for read-aloud). */
  onDelta: (fn: (turnId: string | null, text: string) => void) => () => void;
  onTurnEnd: (fn: (turnId: string | null) => void) => () => void;
}

export function useSessionStream(target: Target, sessionId: string | undefined): SessionStream {
  const [state, setState] = useState<TranscriptState>(() => initialState());
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [queue, setQueue] = useState<api.QueuedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const deltaSubs = useRef(new Set<(turnId: string | null, text: string) => void>());
  const endSubs = useRef(new Set<(turnId: string | null) => void>());
  const handleRef = useRef<{ close: () => void } | null>(null);
  const generation = useRef(0);

  const apply = useCallback((evt: SessionEvent) => {
    const next = applyEvent(stateRef.current, evt);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
    if (evt.type === "delta" && typeof evt.data.text === "string") {
      for (const fn of deltaSubs.current) fn(evt.turnId, evt.data.text);
    }
    if (evt.type === "turn_ended" || evt.type === "turn_cancelled") {
      for (const fn of endSubs.current) fn(evt.turnId);
    }
    if (evt.type === "turn_started") setSummary((s) => (s ? { ...s, status: "running", activeTurn: evt.turnId } : s));
    if (evt.type === "turn_ended" || evt.type === "turn_cancelled") {
      const cost = (evt.data.stats as { costUsd?: number } | undefined)?.costUsd ?? 0;
      const asked = evt.data.question === true;
      setSummary((s) => (s ? { ...s, status: asked ? "awaiting_input" : "idle", activeTurn: null, costUsd: s.costUsd + cost } : s));
    }
    if (evt.type === "turn_queued" || evt.type === "turn_dequeued") {
      void api.getSession(target, evt.sessionId).then((r) => setQueue(r.queue)).catch(() => {});
    }
    if (evt.type === "session_renamed" && typeof evt.data.title === "string") {
      const title = evt.data.title;
      setSummary((s) => (s ? { ...s, title } : s));
    }
  }, [target]);

  const openTail = useCallback(
    (id: string, gen: number) => {
      handleRef.current?.close();
      let backoff = 500;
      const connect = () => {
        if (generation.current !== gen) return;
        handleRef.current = api.openSessionEvents(
          target,
          id,
          stateRef.current.lastSeq,
          {
            onOpen: () => {
              backoff = 500;
              setConnected(true);
            },
            onEvent: apply,
            onStatus: (st) => {
              setSummary((s) => (s ? { ...s, status: st.status as SessionSummary["status"] } : s));
              if (!st.live && stateRef.current.streaming) {
                // Server says idle but we think a turn is live: resync.
                void reloadRef.current();
              }
            },
            onError: () => {
              setConnected(false);
            },
            onClose: () => {
              setConnected(false);
              if (generation.current !== gen) return;
              setTimeout(connect, backoff);
              backoff = Math.min(backoff * 2, 10_000);
            },
          },
          { coalesce: 150 },
        );
      };
      connect();
    },
    [target, apply],
  );

  const reload = useCallback(async () => {
    if (!sessionId) return;
    const gen = ++generation.current;
    setLoading(true);
    try {
      const r = await api.getSession(target, sessionId);
      if (generation.current !== gen) return;
      setSummary(r.session);
      setQueue(r.queue);
      // Seed from durable messages, then replay only what came after them.
      // A running turn's partial events (seq > lastSeq of its start) are
      // recovered by the tail replay because deltas persist until turn end.
      let seeded = initialState(r.messages, 0);
      // Find the seq to resume from: everything up to the last finished turn
      // is already in messages, so start the tail from the last durable seq
      // only when idle; when a turn is live, replay from 0 filtered by turnId.
      if (r.session.status === "running" && r.session.activeTurn) {
        seeded = { ...seeded, streaming: true, activeTurn: r.session.activeTurn };
        // drop the (already-appended) user message of the live turn: the
        // replayed turn_started re-adds it.
        const idx = seeded.messages.findIndex((m) => m.turnId === r.session.activeTurn);
        if (idx !== -1) seeded = { ...seeded, messages: seeded.messages.slice(0, idx), streaming: false, activeTurn: null };
        stateRef.current = { ...seeded, lastSeq: 0 };
      } else {
        stateRef.current = { ...seeded, lastSeq: r.session.lastSeq };
      }
      setState(stateRef.current);
      setError(null);
      openTail(sessionId, gen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === gen) setLoading(false);
    }
  }, [target, sessionId, openTail]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [reload]);

  // Foreground → re-open the tail from lastSeq (iOS kills it in background).
  useEffect(() => {
    const sub = RNAppState.addEventListener("change", (st) => {
      if (st === "active" && sessionId) openTail(sessionId, ++generation.current);
    });
    return () => sub.remove();
  }, [sessionId, openTail]);

  const send = useCallback(
    async (req: TurnRequest) => {
      if (!sessionId) return;
      await api.startTurn(target, sessionId, req);
    },
    [target, sessionId],
  );
  const cancel = useCallback(async () => {
    if (!sessionId) return;
    await api.cancelTurn(target, sessionId).catch(() => {});
  }, [target, sessionId]);
  const answer = useCallback(
    async (answers: AskUserAnswer[], voice?: boolean) => {
      if (!sessionId) return;
      await api.answerQuestion(target, sessionId, answers, voice !== undefined ? { voice } : {});
    },
    [target, sessionId],
  );
  const onDelta = useCallback((fn: (turnId: string | null, text: string) => void) => {
    deltaSubs.current.add(fn);
    return () => {
      deltaSubs.current.delete(fn);
    };
  }, []);
  const onTurnEnd = useCallback((fn: (turnId: string | null) => void) => {
    endSubs.current.add(fn);
    return () => {
      endSubs.current.delete(fn);
    };
  }, []);

  return { state, summary, queue, connected, loading, error, send, cancel, answer, reload, onDelta, onTurnEnd };
}
