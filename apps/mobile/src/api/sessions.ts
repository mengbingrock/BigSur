import type { AskUserAnswer, SessionEvent, SessionMessage, SessionSummary, TurnRequest } from "@labee/session-core";
import { apiGet, apiSend, urlFor, type Target } from "./client";
import { openEventStream, type EventStreamHandle } from "./sse";

export interface QueuedItem {
  id: string;
  text: string;
  createdAt: string;
}

export const listSessions = (t: Target) => apiGet<{ sessions: SessionSummary[] }>(t, "/api/sessions");
export const getSession = (t: Target, id: string) =>
  apiGet<{ session: SessionSummary; messages: SessionMessage[]; queue: QueuedItem[] }>(t, `/api/sessions/${id}`);
export const createSession = (t: Target, body: { agentId?: string; title?: string } = {}) =>
  apiSend<{ session: SessionSummary }>(t, "POST", "/api/sessions", body);
export const renameSession = (t: Target, id: string, title: string) =>
  apiSend<{ session: SessionSummary }>(t, "PATCH", `/api/sessions/${id}`, { title });
export const archiveSession = (t: Target, id: string) =>
  apiSend<{ session: SessionSummary }>(t, "PATCH", `/api/sessions/${id}`, { archived: true });
export const deleteSession = (t: Target, id: string) => apiSend<{ ok: true }>(t, "DELETE", `/api/sessions/${id}`);
export const startTurn = (t: Target, id: string, body: TurnRequest) =>
  apiSend<{ ok: true; turnId?: string; queued: boolean; queueId?: string }>(t, "POST", `/api/sessions/${id}/turns`, body);
export const cancelTurn = (t: Target, id: string) => apiSend<{ ok: true }>(t, "POST", `/api/sessions/${id}/cancel`);
export const removeQueued = (t: Target, id: string, queueId: string) =>
  apiSend<{ ok: true }>(t, "DELETE", `/api/sessions/${id}/queue/${queueId}`);
export const answerQuestion = (t: Target, id: string, answers: AskUserAnswer[], extra: { voice?: boolean } = {}) =>
  apiSend<{ ok: true; turnId: string }>(t, "POST", `/api/sessions/${id}/answer`, { answers, ...extra });
export const getDiff = (t: Target, id: string) =>
  apiGet<{ isRepo: boolean; clean?: boolean; files: { path: string; status: string }[]; diff: string }>(t, `/api/sessions/${id}/diff`);

export function eventsUrl(t: Target, id: string, after: number, opts: { coalesce?: number; once?: boolean } = {}) {
  const q = new URLSearchParams({ after: String(after) });
  if (opts.coalesce) q.set("coalesce", String(opts.coalesce));
  if (opts.once) q.set("once", "1");
  return urlFor(t, `/api/sessions/${id}/events?${q.toString()}`);
}

export function openSessionEvents(
  t: Target,
  id: string,
  after: number,
  handlers: {
    onEvent: (evt: SessionEvent) => void;
    onStatus?: (status: { status: string; live: boolean; lastSeq: number }) => void;
    onOpen?: () => void;
    onError?: (e: unknown) => void;
    onClose?: () => void;
  },
  opts: { coalesce?: number } = {},
): EventStreamHandle {
  return openEventStream(eventsUrl(t, id, after, opts), {
    eventName: "session_event",
    onEvent: (data) => {
      const evt = data as unknown as SessionEvent;
      if (evt.type === "session_status") {
        handlers.onStatus?.(evt.data as { status: string; live: boolean; lastSeq: number });
        return;
      }
      handlers.onEvent(evt);
    },
    ...(handlers.onOpen ? { onOpen: handlers.onOpen } : {}),
    ...(handlers.onError ? { onError: handlers.onError } : {}),
    ...(handlers.onClose ? { onClose: handlers.onClose } : {}),
  });
}

export async function transcribe(t: Target, audioBase64: string, mimeType: string): Promise<string> {
  const r = await apiSend<{ text: string }>(t, "POST", "/api/transcribe", { audio: audioBase64, mimeType });
  return r.text ?? "";
}
