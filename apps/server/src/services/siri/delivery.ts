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
  delegationId?: string;
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
const delivering = new Map<string,Promise<ReturnLine|null>>();
export function deliverReturn(evt: SessionEventEnvelope, session: SessionRow | null): Promise<ReturnLine|null> {
  const key=`${evt.sessionId}:${evt.seq}`;
  const existing=delivering.get(key);if(existing)return existing;
  const work=deliverReturnOnce(evt,session).finally(()=>delivering.delete(key));delivering.set(key,work);return work;
}
async function deliverReturnOnce(evt: SessionEventEnvelope, session: SessionRow | null): Promise<ReturnLine | null> {
  const origin = evt.data.origin as Origin | undefined;
  if (evt.type !== "turn_ended" || origin?.kind !== "siri") return null;
  const chat = session ?? (await sdb.getSessionById(evt.sessionId));
  if (!chat) return null;
  const email = chat.email;
  const { getDb } = await import("../db");
  const db = await getDb();
  const returnEventId = `${evt.sessionId}:${evt.seq}`;
  if (db.prepare("SELECT 1 FROM chat_session_messages m JOIN chat_sessions s ON s.id=m.session_id WHERE s.email=? AND (json_extract(m.meta,'$.returnEventId')=? OR (json_extract(m.meta,'$.returnEventId') IS NULL AND json_extract(m.meta,'$.kind')='return' AND json_extract(m.meta,'$.sessionId')=? AND json_extract(m.meta,'$.siriTurnId')=?))").get(email,returnEventId,chat.id,origin.siriTurnId ?? '')) return null;
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
    returnEventId,
    ...(origin.delegationId ? {delegationId:origin.delegationId} : {}),
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
  await pushOut(email, push);

  // The exchange that delegated this chat can settle now (planner.ts).
  if (origin.siriTurnId) {
    const { settleDelegation } = await import("./planner");
    await settleDelegation(email, origin.siriTurnId, spoken, chat.id).catch(() => {});
    const { settleTaskDelegation } = await import("./store");
    await settleTaskDelegation(email, origin.siriTurnId, chat.id, spoken, Boolean(question), origin.delegationId);
  }

  return { idx: row.idx, sessionId: chat.id, title: chat.title, spoken, question, siriTurnId: origin.siriTurnId ?? null, createdAt: row.createdAt };
}

/** Send a push to the account's phones from wherever this runs: directly on
 *  the box, through the box's `notify` frame from a Mac. */
export async function pushOut(email: string, push: PushMessage): Promise<void> {
  try {
    if (isDesktop()) {
      if (!sendToBox({ t: "mirror", notify: push })) console.warn("[siri] push not sent: the box is not connected");
    } else {
      await sendPush(email, push);
    }
  } catch (e) {
    console.warn("[siri] push failed:", e instanceof Error ? e.message : e);
  }
}

/** A planner answer that came after Siri's budget (design §4): the person
 *  heard "give me a moment", so the answer goes the same way a chat's return
 *  does — a line in the Siri session, unread, and an announced push. */
const lateDeliveries = new Map<string,Promise<void>>();
export function announceLate(email: string, spoken: string, siriTurnId: string, result?: {status: string;confirmId?:string}): Promise<void> {
  const key=`${email}:${siriTurnId}`;
  const pending=lateDeliveries.get(key);if(pending)return pending;
  const work=announceLateOnce(email,spoken,siriTurnId,result).finally(()=>lateDeliveries.delete(key));
  lateDeliveries.set(key,work);return work;
}
async function announceLateOnce(email: string, spoken: string, siriTurnId: string, result?: {status: string;confirmId?:string}): Promise<void> {
  const siri = await ensureSiriSession(email);
  const { getDb } = await import("../db");
  const db = await getDb();
  if (db.prepare("SELECT 1 FROM chat_session_messages WHERE session_id=? AND json_extract(meta,'$.kind')='return' AND json_extract(meta,'$.siriTurnId')=? AND json_extract(meta,'$.sessionId')=?").get(siri.id,siriTurnId,siri.id)) return;
  await sdb.appendSystemMessage(siri.id, `← ${spoken}`, { kind: "return", sessionId: siri.id, title: "Labee", spoken, unread: true, siriTurnId, ...(result?.status === "confirm" ? {asks:{text:spoken,options:["Yes","No"]},confirmId:result.confirmId} : {}) });
  await pushOut(email, {
    title: "Labee",
    body: spoken,
    data: { sessionId: siri.id, kind: result?.status === "confirm" ? "question" : "done", origin: "siri", siriTurnId, ...(result?.confirmId ? {confirmId:result.confirmId,options:["Yes","No"]} : {}) },
    categoryId: result?.status === "confirm" ? "labee.question" : "labee.reply",
    interruptionLevel: "time-sensitive",
  });
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

/** Restart recovery uses the durable turn-ended event, not a live listener.
 * Only the owner delivers; mirror events settle tasks without duplicate push. */
let recovering: Promise<void> | null = null;
export function recoverSiriReturns(): Promise<void> {
  if(recovering)return recovering;
  recovering=(async()=>{
    const {getDb}=await import("../db");const db=await getDb();
    const rows=db.prepare(`SELECT e.* FROM chat_session_events e JOIN chat_sessions s ON s.id=e.session_id
      WHERE e.type='turn_ended' AND json_extract(e.data,'$.origin.kind')='siri'
      AND NOT EXISTS(SELECT 1 FROM chat_session_messages m JOIN chat_sessions owner ON owner.id=m.session_id
        WHERE owner.email=s.email AND (json_extract(m.meta,'$.returnEventId')=e.session_id || ':' || e.seq OR (json_extract(m.meta,'$.returnEventId') IS NULL AND json_extract(m.meta,'$.kind')='return' AND json_extract(m.meta,'$.sessionId')=e.session_id AND json_extract(m.meta,'$.siriTurnId')=json_extract(e.data,'$.origin.siriTurnId'))))
      ORDER BY e.created_at LIMIT 10`).all();
    for(const r of rows)await deliverReturn({sessionId:String(r.session_id),seq:Number(r.seq),turnId:r.turn_id as string|null,type:"turn_ended",data:JSON.parse(String(r.data)),ts:String(r.created_at)},null);
    const {settleTaskDelegation}=await import("./store");
    for(const d of db.prepare("SELECT * FROM siri_delegations WHERE status='working'").all()){
      const local=db.prepare("SELECT e.data FROM chat_session_events e JOIN chat_sessions s ON s.id=e.session_id WHERE s.email=? AND e.session_id=? AND e.type='turn_ended' AND json_extract(e.data,'$.origin.delegationId')=? ORDER BY e.seq DESC LIMIT 1").get(d.email,d.session_id,d.id);
      const mirrored=local?null:db.prepare("SELECT data FROM mirror_events WHERE email=? AND host_id=? AND session_id=? AND json_extract(data,'$.type')='turn_ended' AND json_extract(data,'$.data.origin.delegationId')=? ORDER BY seq DESC LIMIT 1").get(d.email,d.host_id,d.session_id,d.id);
      const data=local?JSON.parse(String(local.data)):mirrored?JSON.parse(String(mirrored.data)).data:null;
      if(data)await settleTaskDelegation(String(d.email),String(d.origin_id),String(d.session_id),String(data.content ?? ""),Boolean(data.question),String(d.id));
    }
  })().finally(()=>{recovering=null;});return recovering;
}
