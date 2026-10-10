// The run a session tracks: fetched from the account server, refreshed on
// each action, on a timer, and whenever the session stream shows a run line.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Target } from "~/api/client";
import { amountFor, cancelRunTimer, getRun, runAction, type AmountAnswer, type RunPayload, type RunTimer } from "~/api/runs";
import { cancelTimerNotification, scheduleTimerNotification } from "~/runs/timers";

export interface RunHandle {
  data: RunPayload | null;
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  advance: () => Promise<void>;
  back: () => Promise<void>;
  skip: (reason?: string) => Promise<void>;
  jump: (step: number) => Promise<void>;
  note: (text: string, step?: number) => Promise<void>;
  startTimer: (opts?: { seconds?: number; label?: string }) => Promise<RunTimer | null>;
  cancelTimer: (timerId: string) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  finish: () => Promise<void>;
  howMuch: (material: string) => Promise<AmountAnswer>;
}

export function useRun(target: Target, runId: string | null | undefined, device = "iPhone"): RunHandle {
  const [data, setData] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef(runId);
  idRef.current = runId;

  const refresh = useCallback(async () => {
    const id = idRef.current;
    if (!id) {
      setData(null);
      return;
    }
    try {
      const r = await getRun(target, id);
      setData({ run: r.run, view: r.view });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [target]);

  useEffect(() => {
    void refresh();
    if (!runId) return;
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh, runId]);

  const act = useCallback(
    async <T extends RunPayload>(fn: (id: string) => Promise<T>): Promise<T | null> => {
      const id = idRef.current;
      if (!id) return null;
      setBusy(true);
      try {
        const r = await fn(id);
        setData({ run: r.run, view: r.view });
        setError(null);
        return r;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const advance = useCallback(async () => void (await act((id) => runAction(target, id, "advance", { device }))), [act, target, device]);
  const back = useCallback(async () => void (await act((id) => runAction(target, id, "back", { device }))), [act, target, device]);
  const skip = useCallback(async (reason?: string) => void (await act((id) => runAction(target, id, "skip", { device, ...(reason ? { reason } : {}) }))), [act, target, device]);
  const jump = useCallback(async (step: number) => void (await act((id) => runAction(target, id, "jump", { device, step }))), [act, target, device]);
  const note = useCallback(async (text: string, step?: number) => void (await act((id) => runAction(target, id, "note", { device, text, ...(step ? { step } : {}) }))), [act, target, device]);
  const pause = useCallback(async () => void (await act((id) => runAction(target, id, "pause"))), [act, target]);
  const resume = useCallback(async () => void (await act((id) => runAction(target, id, "resume"))), [act, target]);
  const finish = useCallback(async () => void (await act((id) => runAction(target, id, "finish", { device }))), [act, target, device]);

  const startTimer = useCallback(
    async (opts: { seconds?: number; label?: string } = {}) => {
      const r = await act((id) => runAction<RunPayload & { timer: RunTimer }>(target, id, "timer", { device, ...opts }));
      if (r?.timer) await scheduleTimerNotification({ id: r.run.id, sessionId: r.run.sessionId, protocolName: r.run.protocolName }, r.timer);
      return r?.timer ?? null;
    },
    [act, target, device],
  );
  const cancelTimer = useCallback(
    async (timerId: string) => {
      await cancelTimerNotification(timerId);
      await act((id) => cancelRunTimer(target, id, timerId));
    },
    [act, target],
  );
  const howMuch = useCallback(
    async (material: string) => {
      const id = idRef.current;
      if (!id) throw new Error("No run.");
      return amountFor(target, id, material);
    },
    [target],
  );

  return { data, error, busy, refresh, advance, back, skip, jump, note, startTimer, cancelTimer, pause, resume, finish, howMuch };
}
