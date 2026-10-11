// The Siri agent from the app (siri-agent design §3): the Siri chat on
// screen talks to the planner, the same door Siri uses, so what is said
// there is acted on and answered in a sentence rather than sent to a turn.
import { apiGet, apiSend, type Target } from "./client";

export interface SayResult {
  status: "answered" | "working" | "confirm";
  spoken: string;
  siriTurnId: string;
  confirmId?: string;
  via: string;
}

// Pass the same requestId when retrying a failed transport attempt.
const requestId = () => `iphone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const sayToLabee = (t: Target, text: string, device = "iPhone", id = requestId()) =>
  apiSend<SayResult>(t, "POST", "/api/siri/say", { text, device, requestId: id });
export const confirmToLabee = (t: Target, confirmId: string, yes: boolean, device = "iPhone", id = requestId()) =>
  apiSend<SayResult>(t, "POST", "/api/siri/say", { confirmId, yes, device, requestId: id });

export interface NewsItem {
  idx: number;
  sessionId: string;
  title: string;
  spoken: string;
  question: { text: string; options: string[] } | null;
}
export const siriNews = (t: Target) => apiGet<{ items: NewsItem[] }>(t, "/api/siri/news");
