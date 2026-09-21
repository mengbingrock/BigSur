// Event-stream transport. On web the browser's EventSource carries cookies;
// on native we use react-native-sse (an XHR-based EventSource) so we can add
// the device bearer header. Reconnects are handled by the caller via lastSeq.
import { Platform } from "react-native";
import { authHeaders } from "./client";

export interface EventStreamHandle {
  close: () => void;
}

export interface OpenEventStreamOpts {
  eventName: string;
  onEvent: (data: Record<string, unknown>, id?: string) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  onClose?: () => void;
}

export function openEventStream(url: string, opts: OpenEventStreamOpts): EventStreamHandle {
  if (Platform.OS === "web" && typeof EventSource !== "undefined") {
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener(opts.eventName, (e) => {
      try {
        const me = e as MessageEvent<string>;
        opts.onEvent(JSON.parse(me.data) as Record<string, unknown>, me.lastEventId || undefined);
      } catch (err) {
        // A handler bug must not kill the stream, but it must be visible.
        console.error("[labee] event handler failed", err);
      }
    });
    es.onopen = () => opts.onOpen?.();
    es.onerror = (err) => {
      opts.onError?.(err);
      if (es.readyState === EventSource.CLOSED) opts.onClose?.();
    };
    return { close: () => es.close() };
  }
  // Native: lazy-require so the web bundle never touches it.
  const RNEventSource = require("react-native-sse").default as typeof import("react-native-sse").default;
  const es = new RNEventSource(url, { headers: authHeaders(), withCredentials: true, pollingInterval: 0 });
  es.addEventListener(opts.eventName as never, ((e: { data: string | null; lastEventId?: string | null }) => {
    if (!e.data) return;
    try {
      opts.onEvent(JSON.parse(e.data) as Record<string, unknown>, e.lastEventId ?? undefined);
    } catch (err) {
      console.error("[labee] event handler failed", err);
    }
  }) as never);
  es.addEventListener("open", () => opts.onOpen?.());
  es.addEventListener("error", (e) => opts.onError?.(e));
  es.addEventListener("close", () => opts.onClose?.());
  return { close: () => es.close() };
}
