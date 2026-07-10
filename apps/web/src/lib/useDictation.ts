import { useCallback, useEffect, useRef, useState } from "react";
import { apiSend } from "./api";

export type DictationState = "idle" | "recording" | "transcribing";

/** MediaRecorder mime, preferring opus; Safari/older WebKit falls back to mp4. */
function pickMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined;
  if (MR?.isTypeSupported) {
    for (const t of candidates) if (MR.isTypeSupported(t)) return t;
  }
  return undefined;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data:...;base64, prefix
    };
    reader.readAsDataURL(blob);
  });
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow it in your system settings and try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return err instanceof Error ? err.message : "Could not start recording.";
}

/** Push-to-dictate hook: toggle() starts/stops mic recording; on stop it uploads
 *  the clip to /api/transcribe and hands the text to `onText`. Whether it's
 *  supported at all is `supported` (needs mic APIs). */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const transcribe = useCallback(async () => {
    const type = recorderRef.current?.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    if (blob.size === 0) {
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const audio = await blobToBase64(blob);
      const { text } = await apiSend<{ text: string }>("POST", "/api/transcribe", {
        audio,
        mimeType: type,
      });
      const trimmed = (text ?? "").trim();
      if (trimmed) onTextRef.current(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      setState("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (!supported) {
      setError("Voice input isn't supported here.");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, pickMimeType() ? { mimeType: pickMimeType() } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        cleanupStream();
        void transcribe();
      };
      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setState("recording");
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e) {
      cleanupStream();
      setState("idle");
      setError(micErrorMessage(e));
    }
  }, [supported, cleanupStream, transcribe]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop(); // fires onstop → transcribe
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => cleanupStream, [cleanupStream]);

  return { state, error, seconds, supported, toggle, clearError: () => setError(null) };
}
