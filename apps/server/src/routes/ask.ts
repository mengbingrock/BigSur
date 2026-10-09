// Quick answers for Siri (docs/siri-design.md §3.2, run-design §4.2 tier 2):
// retrieval over the protocols plus the run and session context, one model
// call, spoken-length answer, hard time budget. Past the budget, or when the
// model says so, the caller sends the question to the session instead.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { askLibrary } from "../services/artifactIndex/ask";
import * as rdb from "../services/runs/db";
import { runContextText, viewOf } from "../services/runs/service";
import * as sdb from "../services/sessions/db";
import { logQuickAnswer } from "../services/siri/router";

const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

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

export const quickAskRoute = HttpRouter.add(
  "POST",
  "/api/ask/quick",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const body = yield* safeBody<{ q?: string; sessionId?: string; runId?: string; device?: string }>();
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    if (!q) return yield* error("`q` is required.", 400);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const device = body?.device ?? (request.headers["x-labee-device"] as string | undefined);

    const result = yield* Effect.tryPromise({ try: async () => {
      const extra: Array<{ name: string; heading: string; text: string }> = [];
      // The run in progress, or the one named.
      const run = body?.runId ? await rdb.getRunForUser(user.email, body.runId) : (await rdb.listRuns(user.email, { status: ["running", "paused"], limit: 1 }))[0] ?? null;
      if (run) {
        const view = await viewOf(run);
        extra.push({ name: run.protocolName, heading: "Run in progress", text: runContextText(view) });
        if (view.current) extra.push({ name: run.protocolName, heading: `Step ${view.current.n}`, text: view.current.text + (view.current.note ? `\nNote: ${view.current.note}` : "") });
      }
      // The session named, for "what did it find?".
      const sessionId = body?.sessionId ?? run?.sessionId;
      if (sessionId) {
        const s = await sdb.getSession(user.email, sessionId);
        if (s) {
          const msgs = (await sdb.listMessages(s.id)).filter((m) => m.role !== "system").slice(-4);
          if (msgs.length) extra.push({ name: s.title, heading: "Recent chat", text: msgs.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n") });
        }
      }
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS));
      const r = await Promise.race([askLibrary(q, user.email, { kind: "protocol", system: SPOKEN_SYSTEM, extraPassages: extra }), timeout]);
      if (!r) return { answer: "", citations: [], needsAgent: true as const, reason: "That took too long to answer quickly." };
      if (!r.available) return { answer: "", citations: [], needsAgent: true as const, reason: "No model is available for a quick answer." };
      const m = r.answer.match(/^\s*NEEDS_AGENT\b[:\s-]*(.*)$/is);
      if (m) return { answer: "", citations: [], needsAgent: true as const, reason: m[1]?.trim() || "That needs your session." };
      const spoken = r.answer.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim();
      await logQuickAnswer(user.email, q, spoken, device).catch(() => {});
      return { answer: spoken, citations: r.citations, needsAgent: false as const, ...(run ? { runId: run.id } : {}), ...(sessionId ? { sessionId } : {}) };
    }, catch: (e) => e }).pipe(
      Effect.catch((e) => Effect.succeed({ answer: "", citations: [], needsAgent: true as const, reason: e instanceof Error ? e.message : String(e) })),
    );
    return yield* json(result);
  }),
);

export const askRoutes = [quickAskRoute] as const;
