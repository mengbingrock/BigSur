// Speak the assistant's reply sentence by sentence as tokens arrive, using the
// device's own TTS (free, offline, lock-screen friendly). Barge-in: stop()
// clears the queue immediately.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Speech from "expo-speech";
import { SentenceChunker } from "@labee/session-core";

export interface ReadAloud {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  speaking: boolean;
  /** Feed streamed text for the current turn. */
  feed: (text: string) => void;
  /** Flush the trailing sentence at turn end. */
  flush: () => void;
  stop: () => void;
  say: (text: string) => void;
}

export function useReadAloud(initial = false): ReadAloud {
  const [enabled, setEnabled] = useState(initial);
  const [speaking, setSpeaking] = useState(false);
  const chunker = useRef(new SentenceChunker());
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const pump = useCallback(() => {
    if (busy.current) return;
    const next = queue.current.shift();
    if (!next) {
      setSpeaking(false);
      return;
    }
    busy.current = true;
    setSpeaking(true);
    try {
      speakNow(next);
    } catch (err) {
      console.error("[labee] speech failed", err);
      busy.current = false;
      setSpeaking(false);
    }
  }, []);

  const speakNow = useCallback((next: string) => {
    Speech.speak(next, {
      rate: 1.0,
      onDone: () => {
        busy.current = false;
        pumpRef.current();
      },
      onStopped: () => {
        busy.current = false;
      },
      onError: () => {
        busy.current = false;
        pumpRef.current();
      },
    });
  }, []);
  const pumpRef = useRef<() => void>(() => {});
  pumpRef.current = pump;

  const enqueue = useCallback(
    (sentences: string[]) => {
      if (!enabledRef.current || sentences.length === 0) return;
      queue.current.push(...sentences);
      pump();
    },
    [pump],
  );

  const feed = useCallback((text: string) => enqueue(chunker.current.feed(text)), [enqueue]);
  const flush = useCallback(() => enqueue(chunker.current.end()), [enqueue]);
  const stop = useCallback(() => {
    queue.current = [];
    chunker.current = new SentenceChunker();
    busy.current = false;
    setSpeaking(false);
    void Speech.stop();
  }, []);
  const say = useCallback(
    (text: string) => {
      queue.current.push(text);
      pump();
    },
    [pump],
  );

  useEffect(() => () => void Speech.stop(), []);

  return { enabled, setEnabled, speaking, feed, flush, stop, say };
}
