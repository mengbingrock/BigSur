// The quick answer as a function (docs/siri-design.md §3.2, run-design §4.2
// tier 2): retrieval over the protocols plus the run and session context,
// one model call, spoken-length answer, hard time budget. The route and the
// planner's `ask.quick` action both call this.
import { askLibrary } from "../artifactIndex/ask";
import * as rdb from "../runs/db";
import { runContextText, viewOf } from "../runs/service";
import * as sdb from "../sessions/db";
import { logQuickAnswer } from "./router";

const BUDGET_MS = Number(process.env.LABEE_QUICK_ASK_MS ?? 7000);

const SPOKEN_SYSTEM = [
  "You answer a scientist's spoken question from their own laboratory protocols and the notes given.",
  "",
  "Rules:",
  "- Draw your answer only from the numbered passages given. Never add a step,",
  "  a reagent, a concentration or a time that is not written there.",
  "- Cite every claim with the passage number in square brackets, like [2].",
  "- Answer in one or two short spoken sentences. No markdown, no lists. Say",
  "  units in full (five microlitres, fifty degrees).",
  "- A number you compute must be called computed.",
  "- When the passages do not contain the answer, reply exactly: NEEDS_AGENT",
  "  followed by one short reason.",
].join("\n");

export interface QuickAnswer {
  answer: string;
  citations: unknown[];
  needsAgent: boolean;
  reason?: string;
  runId?: string;
  sessionId?: string;
}

export async function quickAnswer(
  email: string,
  q: string,
  opts: { sessionId?: string; runId?: string; device?: string; log?: boolean } = {},
): Promise<QuickAnswer> {
  try {
    const extra: Array<{ name: string; heading: string; text: string }> = [];
    // The run in progress, or the one named.
    const run = opts.runId ? await rdb.getRunForUser(email, opts.runId) : ((await rdb.listRuns(email, { status: ["running", "paused"], limit: 1 }))[0] ?? null);
    if (run) {
      const view = await viewOf(run);
      extra.push({ name: run.protocolName, heading: "Run in progress", text: runContextText(view) });
      if (view.current) extra.push({ name: run.protocolName, heading: `Step ${view.current.n}`, text: view.current.text + (view.current.note ? `\nNote: ${view.current.note}` : "") });
    }
    // The session named, for "what did it find?".
    const sessionId = opts.sessionId ?? run?.sessionId;
    if (sessionId) {
      const s = await sdb.getSession(email, sessionId);
      if (s) {
        const msgs = (await sdb.listMessages(s.id)).filter((m) => m.role !== "system").slice(-4);
        if (msgs.length) extra.push({ name: s.title, heading: "Recent chat", text: msgs.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n") });
      }
    }
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS));
    const r = await Promise.race([askLibrary(q, email, { kind: "protocol", system: SPOKEN_SYSTEM, extraPassages: extra }), timeout]);
    if (!r) return { answer: "", citations: [], needsAgent: true, reason: "That took too long to answer quickly." };
    if (!r.available) return { answer: "", citations: [], needsAgent: true, reason: "No model is available for a quick answer." };
    const m = r.answer.match(/^\s*NEEDS_AGENT\b[:\s-]*(.*)$/is);
    if (m) return { answer: "", citations: [], needsAgent: true, reason: m[1]?.trim() || "That needs your session." };
    const spoken = r.answer.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim();
    if (opts.log !== false) await logQuickAnswer(email, q, spoken, opts.device).catch(() => {});
    return { answer: spoken, citations: r.citations, needsAgent: false, ...(run ? { runId: run.id } : {}), ...(sessionId ? { sessionId } : {}) };
  } catch (e) {
    return { answer: "", citations: [], needsAgent: true, reason: e instanceof Error ? e.message : String(e) };
  }
}
