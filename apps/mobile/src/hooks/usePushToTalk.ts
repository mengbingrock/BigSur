// Hold-to-talk recording: expo-audio recorder → base64 → /api/transcribe.
// Returns the transcript to the caller (who decides whether it's a command).
// `listen()` is the hands-free variant for Lab mode: one tap starts it, and
// it stops by itself once the person has spoken and gone quiet.
//
// Robustness notes: the release can arrive before the recorder is ready (quick
// taps, slow permission prompts), so readiness lives in a ref and a release
// that comes early is honoured as soon as recording starts. Permission is read
// before it is requested, and the request is bounded by a timeout.
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { Target } from "~/api/client";
import { transcribe } from "~/api/sessions";
import { SpeechEndDetector } from "./speechEnd";

export type PttState = "idle" | "recording" | "transcribing" | "denied" | "unsupported";

export interface PushToTalk {
  state: PttState;
  error: string | null;
  seconds: number;
  start: () => Promise<void>;
  /** Stop and transcribe; resolves with the text ("" when nothing was said). */
  stop: () => Promise<string>;
  /** Tap-to-talk: record until speech is followed by a pause (or a cap),
   *  then transcribe. Resolves "" if `stop()` ended it instead, because the
   *  caller of `stop()` gets the text then. */
  listen: () => Promise<string>;
  cancel: () => Promise<void>;
}

const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

export async function blobUriToBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(uri);
  const blob = await res.blob();
  const mimeType = blob.type || (Platform.OS === "web" ? "audio/webm" : "audio/m4a");
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
  return { base64, mimeType };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const MIN_CLIP_MS = 350;
const t0 = Date.now();
const log = (...args: unknown[]) => {
  if (__DEV__) console.log("[ptt]", `+${Date.now() - t0}ms`, ...args);
};

export function usePushToTalk(target: Target): PushToTalk {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [state, setState] = useState<PttState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const permitted = useRef<boolean | null>(null);
  /** "starting" while permissions/prepare run, "recording" once audio flows. */
  type Phase = "idle" | "starting" | "recording" | "stopping";
  const phase = useRef<Phase>("idle");
  const currentPhase = (): Phase => phase.current;
  /** Release arrived while still starting: stop as soon as recording begins. */
  const stopRequested = useRef<((text: string) => void) | null>(null);
  const startedAt = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const finish = useCallback(async (): Promise<string> => {
    // Recorder is live: stop, read, upload.
    phase.current = "stopping";
    clearTimer();
    setState("transcribing");
    try {
      const clipMs = Date.now() - startedAt.current;
      const tooShort = clipMs < MIN_CLIP_MS;
      log("finish: clipMs=", clipMs, "tooShort=", tooShort);
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      if (tooShort) {
        setState("idle");
        phase.current = "idle";
        return "";
      }
      const uri = recorder.uri;
      log("stopped, uri=", uri);
      if (!uri) throw new Error("No recording was captured.");
      const { base64, mimeType } = await blobUriToBase64(uri);
      log("uploading", base64.length, mimeType);
      const text = await transcribe(targetRef.current, base64, mimeType);
      setState("idle");
      phase.current = "idle";
      return text.trim();
    } catch (e) {
      log("stop failed:", e);
      setState("idle");
      phase.current = "idle";
      setError(e instanceof Error ? e.message : "Transcription failed.");
      return "";
    }
  }, [recorder]);

  const start = useCallback(async () => {
    if (phase.current !== "idle") return;
    phase.current = "starting";
    stopRequested.current = null;
    setError(null);
    log("start: permitted=", permitted.current);
    try {
      if (permitted.current !== true) {
        const existing = await withTimeout(getRecordingPermissionsAsync(), 4000, "Microphone permission check");
        let granted = existing.granted;
        if (!granted && existing.canAskAgain !== false) {
          granted = (await withTimeout(requestRecordingPermissionsAsync(), 20000, "Microphone permission")).granted;
        }
        permitted.current = granted;
        log("permission granted=", granted);
        if (!granted) {
          phase.current = "idle";
          setState("denied");
          setError("Microphone access was denied. Allow it in Settings and try again.");
          return;
        }
      }
      log("audio mode…");
      await withTimeout(setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }), 5000, "Audio session");
      log("prepare…");
      await withTimeout(recorder.prepareToRecordAsync(), 15000, "Recorder setup");
      log("record()");
      recorder.record();
      startedAt.current = Date.now();
      log("recording");
      phase.current = "recording";
      setSeconds(0);
      clearTimer();
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState("recording");
      const pending = stopRequested.current as ((text: string) => void) | null;
      if (pending) {
        // The user let go before we were ready — honour it now.
        stopRequested.current = null;
        pending(await finish());
      }
    } catch (e) {
      log("start failed:", e);
      phase.current = "idle";
      setState("idle");
      setError(e instanceof Error ? e.message : "Could not start recording.");
      const pending = stopRequested.current as ((text: string) => void) | null;
      if (pending) {
        pending("");
        stopRequested.current = null;
      }
    }
  }, [recorder, finish]);

  const stop = useCallback(async (): Promise<string> => {
    const p = currentPhase();
    log("stop: phase=", p);
    if (p === "recording") return finish();
    if (p === "starting") {
      return new Promise<string>((resolve) => {
        stopRequested.current = resolve;
      });
    }
    return "";
  }, [finish]);

  const cancel = useCallback(async () => {
    clearTimer();
    stopRequested.current = null;
    try {
      if (phase.current === "recording") await recorder.stop();
    } catch {
      // ignore
    }
    phase.current = "idle";
    setState("idle");
  }, [recorder]);

  const listen = useCallback(async (): Promise<string> => {
    await start();
    if (phase.current !== "recording") return "";
    return new Promise<string>((resolve) => {
      const detector = new SpeechEndDetector(Date.now());
      const iv = setInterval(() => {
        if (phase.current !== "recording") {
          // Ended by stop() (a second tap) or cancel(): that caller has the text.
          clearInterval(iv);
          resolve("");
          return;
        }
        let level: number | null = null;
        try {
          const m = recorder.getStatus().metering;
          if (typeof m === "number") level = m;
        } catch {
          // No metering: the time caps still end the recording.
        }
        const verdict = detector.push(level, Date.now());
        if (verdict === "listening") return;
        clearInterval(iv);
        log("listen: auto-stop", verdict);
        // Nothing but background the whole time: drop the clip, don't upload it.
        if (verdict === "ended") void finish().then(resolve);
        else void cancel().then(() => resolve(""));
      }, 150);
    });
  }, [start, finish, cancel, recorder]);

  useEffect(() => clearTimer, []);

  return { state, error, seconds, start, stop, listen, cancel };
}
