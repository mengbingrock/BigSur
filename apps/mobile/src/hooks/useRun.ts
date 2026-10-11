// The run a session tracks: fetched from the account server, refreshed on
// each action, on a timer, and whenever the session stream shows a run line.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Target } from "~/api/client";
import { amountFor, cancelRunTimer, getRun, runAction, type AmountAnswer, type RunPayload, type RunTimer } from "~/api/runs";
import { cancelTimerNotification, scheduleTimerNotification } from "~/runs/timers";
import { endRunActivity, startRunActivity, syncRunActivity } from "~/siri";

export interface RunHandle {
  data: RunPayload | null;
  error: string | null;
  busy: boolean;
  /** Re-fetch, resolving with the fresh run (null if none or on failure). */
  refresh: () => Promise<RunPayload | null>;
  /** Each action resolves with the run as it stands afterwards (null on
   *  failure, with `error` set), so a caller can say what changed. */
  advance: () => Promise<RunPayload | null>;
  back: () => Promise<RunPayload | null>;
  skip: (reason?: string) => Promise<RunPayload | null>;
  jump: (step: number) => Promise<RunPayload | null>;
  note: (text: string, step?: number) => Promise<RunPayload | null>;
  startTimer: (opts?: { seconds?: number; label?: string }) => Promise<RunTimer | null>;
  cancelTimer: (timerId: string) => Promise<RunPayload | null>;
  pause: () => Promise<RunPayload | null>;
  resume: () => Promise<RunPayload | null>;
  finish: () => Promise<RunPayload | null>;
  howMuch: (material: string) => Promise<AmountAnswer>;
}

export function useRun(target: Target, runId: string | null | undefined, device = "iPhone"): RunHandle {
  const [data, setData] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef(runId);
  idRef.current = runId;

  const refresh = useCallback(async (): Promise<RunPayload | null> => {
    const id = idRef.current;
    if (!id) {
      setData(null);
      return null;
    }
    try {
      const r = await getRun(target, id);
      const payload = { run: r.run, view: r.view };
      setData(payload);
      setError(null);
      return payload;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
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
        // Keep the lock screen in step; it ends itself when the run does.
        void syncRunActivity({ run: r.run, view: r.view });
        if (r.run.status === "done" || r.run.status === "abandoned") void endRunActivity(r.run.id);
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

  const advance = useCallback(() => act((id) => runAction(target, id, "advance", { device })), [act, target, device]);
  const back = useCallback(() => act((id) => runAction(target, id, "back", { device })), [act, target, device]);
  const skip = useCallback((reason?: string) => act((id) => runAction(target, id, "skip", { device, ...(reason ? { reason } : {}) })), [act, target, device]);
  const jump = useCallback((step: number) => act((id) => runAction(target, id, "jump", { device, step })), [act, target, device]);
  const note = useCallback((text: string, step?: number) => act((id) => runAction(target, id, "note", { device, text, ...(step ? { step } : {}) })), [act, target, device]);
  const pause = useCallback(() => act((id) => runAction(target, id, "pause")), [act, target]);
  const resume = useCallback(() => act((id) => runAction(target, id, "resume")), [act, target]);
  const finish = useCallback(() => act((id) => runAction(target, id, "finish", { device })), [act, target, device]);

  const startTimer = useCallback(
    async (opts: { seconds?: number; label?: string } = {}) => {
      const r = await act((id) => runAction<RunPayload & { timer: RunTimer }>(target, id, "timer", { device, ...opts }));
      if (r?.timer) {
        await scheduleTimerNotification({ id: r.run.id, sessionId: r.run.sessionId, protocolName: r.run.protocolName }, r.timer);
        void startRunActivity({ run: r.run, view: r.view });
      }
      return r?.timer ?? null;
    },
    [act, target, device],
  );
  const cancelTimer = useCallback(
    async (timerId: string) => {
      await cancelTimerNotification(timerId);
      return act((id) => cancelRunTimer(target, id, timerId));
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
