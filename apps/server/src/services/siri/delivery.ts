// The return path (docs/siri-agent-design.md §5). A turn the Siri agent
// delegated carries `origin: { kind: "siri" }`; when it ends, this server
// (the one that ran it) does three things: a line in the Siri session,
// marked unread; a spoken-length summary; a time-sensitive push with it,
// announced on the AirPods. On a Mac the push goes to the box as a `notify`
// frame, since the phone's tokens live there; the box sends its own.
//
// Nothing here waits on the person: a failed summary falls back to the
// reply's first words, a failed push is logged, the line is written first.
import { normalizeQuestions } from "@labee/session-core";
import { auxModel } from "../llm";
import { completeText } from "../complete";
import { isDesktop } from "../llmSettings";
import { sendToBox } from "../deviceLink/client";
import { sendPush, type PushMessage } from "../push";
import * as sdb from "../sessions/db";
import type { SessionRow } from "../sessions/db";
import { subscribeAll, type SessionEventEnvelope } from "../sessions/runner";
import { ensureSiriSession } from "./router";

const SUMMARY_MS = Number(process.env.LABEE_SIRI_SUMMARY_MS ?? 12000);

export interface ReturnLine {
  idx: number;
  sessionId: string;
  title: string;
  /** The sentence or two to speak. */
  spoken: string;
  /** Set when the chat is waiting on an answer: the question and its options. */
  question: { text: string; options: string[] } | null;
  siriTurnId: string | null;
  createdAt: string;
}

interface Origin {
  kind: "siri";
  siriTurnId?: string;
  said?: string;
}

/** The first sentences of a reply, cleaned of markdown, for when the
 *  summary call is unavailable or slow. */
export function fallbackSummary(content: string, max = 220): string {
  const text = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s\S*$/, "")}…`).trim();
}

async function spokenSummary(email: string, title: string, said: string | undefined, content: string): Promise<string> {
  const base = fallbackSummary(content);
  if (!content.trim()) return "It finished without saying anything.";
  const system =
    "You turn an assistant's written reply into something to be read aloud to a scientist at the bench. " +
    "Two short spoken sentences at most. Lead with the answer. Say units in full. No markdown, no lists, no preamble. " +
    "If the reply asks the person something, end with that question in one sentence.";
  const user = JSON.stringify({ chat: title, ...(said ? { theyAsked: said } : {}), reply: content.slice(0, 6000) });
  try {
    const raw = await Promise.race([
      completeText({ email, system, user, effort: "low", timeoutMs: SUMMARY_MS, anthropicModel: "haiku", openaiModel: auxModel("openai") }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("summary timeout")), SUMMARY_MS)),
    ]);
    const spoken = raw.replace(/\s+/g, " ").trim();
    return spoken && spoken.length < 600 ? spoken : base;
  } catch {
    return base;
  }
}

function pendingQuestionOf(session: SessionRow | null): { text: string; options: string[] } | null {
  const first = normalizeQuestions(session?.pendingQuestion?.input)[0];
  if (!first) return null;
  return { text: first.question, options: first.options.map((o) => o.label).slice(0, 4) };
}

/** Deliver one ended turn. Exported for tests; the listener below calls it. */
export async function deliverReturn(evt: SessionEventEnvelope, session: SessionRow | null): Promise<ReturnLine | null> {
  const origin = evt.data.origin as Origin | undefined;
  if (evt.type !== "turn_ended" || origin?.kind !== "siri") return null;
  const chat = session ?? (await sdb.getSessionById(evt.sessionId));
  if (!chat) return null;
  const email = chat.email;
  const content = typeof evt.data.content === "string" ? evt.data.content : "";
  const error = typeof evt.data.error === "string" ? evt.data.error : null;
  const question = evt.data.question ? pendingQuestionOf(chat) : null;

  let spoken: string;
  if (error) spoken = `It hit an error: ${fallbackSummary(error, 120)}`;
  else if (question) {
    const opts = question.options.length ? ` ${question.options.slice(0, 3).join(", or ")}?` : "";
    spoken = `${question.text}${opts}`.trim();
  } else spoken = await spokenSummary(email, chat.title, origin.said, content);

  const siri = await ensureSiriSession(email);
  const line = question ? `← "${chat.title}" asks: ${spoken}` : `← "${chat.title}": ${spoken}`;
  const row = await sdb.appendSystemMessage(siri.id, line, {
    kind: "return",
    sessionId: chat.id,
    title: chat.title,
    spoken,
    unread: true,
    ...(question ? { asks: question } : {}),
    ...(origin.siriTurnId ? { siriTurnId: origin.siriTurnId } : {}),
    ...(error ? { error: true } : {}),
  });

  const push: PushMessage = {
    title: chat.title,
    body: spoken,
    data: {
      sessionId: chat.id,
      kind: error ? "error" : question ? "question" : "done",
      origin: "siri",
      ...(question ? { options: question.options } : {}),
      ...(origin.siriTurnId ? { siriTurnId: origin.siriTurnId } : {}),
    },
    categoryId: error ? "labee.attention" : question ? "labee.question" : "labee.reply",
    interruptionLevel: "time-sensitive",
  };
  try {
    if (isDesktop()) {
      if (!sendToBox({ t: "mirror", notify: push })) console.warn("[siri] return not pushed: the box is not connected");
    } else {
      await sendPush(email, push);
    }
  } catch (e) {
    console.warn("[siri] return push failed:", e instanceof Error ? e.message : e);
  }

  return { idx: row.idx, sessionId: chat.id, title: chat.title, spoken, question, siriTurnId: origin.siriTurnId ?? null, createdAt: row.createdAt };
}

/** Unread returns, newest first, for "Any news from Labee?". */
export async function unreadReturns(email: string, limit = 5): Promise<ReturnLine[]> {
  const siri = await ensureSiriSession(email);
  const msgs = await sdb.listMessages(siri.id);
  return msgs
    .filter((m) => m.role === "system" && m.meta?.kind === "return" && m.meta?.unread === true)
    .reverse()
    .slice(0, limit)
    .map((m) => ({
      idx: m.idx,
      sessionId: String(m.meta?.sessionId ?? ""),
      title: String(m.meta?.title ?? ""),
      spoken: String(m.meta?.spoken ?? m.content),
      question: (m.meta?.asks as ReturnLine["question"]) ?? null,
      siriTurnId: (m.meta?.siriTurnId as string | undefined) ?? null,
      createdAt: m.createdAt,
    }));
}

export async function markReturnsRead(email: string, idxs: number[]): Promise<number> {
  const siri = await ensureSiriSession(email);
  let n = 0;
  for (const idx of idxs) {
    await sdb.patchMessageMeta(siri.id, idx, { unread: false, readAt: new Date().toISOString() });
    n++;
  }
  return n;
}

let started = false;

/** Return every Siri-delegated turn that ends on this server. */
export function startSiriDelivery(): void {
  if (started) return;
  started = true;
  subscribeAll((evt, session) => {
    if (evt.type !== "turn_ended") return;
    void deliverReturn(evt, session).catch((e) => console.warn("[siri] return failed:", e instanceof Error ? e.message : e));
  });
}
