/** Receipts live at the mutation owner. A pending receipt after a crash is
 * uncertain and is never replayed blindly; completed receipts replay exactly. */
import { createHash } from "node:crypto";
import { getDb } from "../db";
import * as sdb from "../sessions/db";
import * as rdb from "../runs/db";
import { getSkillBySlug } from "../skills";
import { isDesktop, boxSessionCookie, proxyServerBase } from "../llmSettings";
import { stableHostId } from "../deviceLink/client";
import type { ContextResult } from "@labee/contracts";
import { getHost, requestHostJson, requestParse } from "../deviceLink/hosts";
import {
  executePlan,
  validatePlan,
  needsConfirmation,
  describe,
  type Action,
  type Executed,
  type SiriState,
} from "./planner";
export interface OwnedAction {
  action: Action;
  hostId?: string;
}
export interface Inspection {
  version: string;
  question: string | null;
  description: string;
  protocolHash?: string;
}
export interface ActionRequest extends OwnedAction {
  mode: "inspect" | "execute";
  protocolHostId?: string;
  operationId?: string;
  expected?: string;
  taskId?: string;
  device?: string;
  said?: string;
}
function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
export async function inspectLocalAction(
  email: string,
  a: Action,
  protocolHostId?: string,
): Promise<Inspection> {
  if (!a || typeof a !== "object") throw new Error("Missing action.");
  const state: SiriState = {
    now: new Date().toISOString(),
    runs: [],
    chats: [],
    protocols: [],
    unread: [],
  };
  const facts: unknown[] = [];
  let protocolHash: string | undefined;
  if ("runId" in a) {
    const r = await rdb.getRunForUser(email, a.runId);
    if (!r) throw new Error("Run not found.");
    facts.push(r);
    state.runs.push({
      id: r.id,
      protocol: r.protocolName,
      status: r.status,
      step: r.current,
      of: r.snapshot.steps.length,
      stepText: null,
      amounts: null,
      timer: null,
      notes: 0,
      sessionId: r.sessionId,
    });
  }
  if ("sessionId" in a) {
    const s = await sdb.getSession(email, a.sessionId);
    if (!s || s.kind === "siri" || s.archivedAt)
      throw new Error("Chat is unavailable.");
    facts.push([
      s.id,
      s.status,
      s.activeTurn,
      s.pendingQuestion,
      s.lastSeq,
      s.archivedAt,
    ]);
    state.chats.push({
      id: s.id,
      title: s.title,
      status: s.status,
      lastUser: "",
      lastAssistant: "",
      waitingOn: null,
      updatedAt: s.updatedAt,
    });
    if (a.do === "chats.answer" && !s.pendingQuestion)
      throw new Error("This chat is no longer waiting for an answer.");
  }
  if (a.do === "runs.start") {
    let skill: {
      slug: string;
      name: string;
      body: string;
      artifactKind?: string | undefined;
    } | undefined = getSkillBySlug(a.protocolSlug, email);
    if (protocolHostId) {
      const host = getHost(email, protocolHostId);
      if (!host) throw new Error("The protocol's Mac is offline.");
      let body = "",
        name = "",
        offset = 0;
      do {
        const result = await requestHostJson<ContextResult>(
          host,
          "/api/context",
          {
            tool: "protocols.read",
            protocolSlug: a.protocolSlug,
            offset,
            localOnly: true,
          },
        );
        const item = result.items[0];
        if (!item) throw new Error("Protocol unavailable on its owner.");
        body += String(item.content);
        name = String(item.name);
        offset = Number(item.nextOffset ?? 0);
      } while (offset);
      skill = { slug: a.protocolSlug, name, body, artifactKind: "protocol" };
    }
    if (!skill || skill.artifactKind !== "protocol")
      throw new Error("Protocol not found on the run owner.");
    state.protocols.push({ slug: skill.slug, name: skill.name });
    facts.push([skill.body, protocolHostId ?? null]);
    protocolHash = (await import("../runs/parse")).parseProtocol(
      skill.body,
    ).hash;
    const db = await getDb();
    const open = db
      .prepare(
        "SELECT id,status,current,last_seq FROM protocol_runs WHERE email=? AND protocol_slug=? AND status IN ('running','paused') ORDER BY id",
      )
      .all(email, a.protocolSlug);
    facts.push(open);
    for (const r of open)
      state.runs.push({
        id: String(r.id),
        protocol: skill.name,
        status: String(r.status),
        step: Number(r.current),
        of: 0,
        stepText: null,
        amounts: null,
        timer: null,
        notes: 0,
        sessionId: "",
      });
  }
  const plan = {
    say: "",
    actions: [a],
    need: null,
    confirm: null,
    continues: false,
  };
  const rejection = validatePlan(plan, state);
  if (rejection) throw new Error(rejection.reason);
  if (a.do === "chats.new" && (typeof a.title !== "string" || !a.title.trim()))
    throw new Error("A new chat needs a title.");
  return {
    version: hash([a, facts]),
    question: needsConfirmation(plan, state),
    description: describe(a, state),
    ...(protocolHash ? { protocolHash } : {}),
  };
}
const running = new Map<string, Promise<Executed>>();
export async function executeOwnedAction(
  email: string,
  req: ActionRequest,
): Promise<Inspection | Executed> {
  if (req.mode === "inspect")
    return inspectLocalAction(email, req.action, req.protocolHostId);
  if (
    req.mode !== "execute" ||
    !req.operationId ||
    !req.expected ||
    !req.taskId
  )
    throw new Error("Missing action receipt or version.");
  const db = await getDb();
  const body = JSON.stringify([
    req.action,
    req.expected,
    req.taskId,
    ...(req.protocolHostId ? [req.protocolHostId] : []),
  ]);
  const key = `${email}\0${req.operationId}`;
  const prior = db
    .prepare("SELECT * FROM siri_actions WHERE email=? AND operation_id=?")
    .get(email, req.operationId);
  if (prior) {
    if (prior.body !== body)
      throw new Error("Operation id was reused with different arguments.");
    if (prior.status === "done")
      return JSON.parse(String(prior.result)) as Executed;
    if (running.has(key)) return running.get(key)!;
    return {
      action: req.action,
      ok: false,
      error:
        "The previous attempt has an uncertain outcome. Check the current run or chat before requesting another action.",
    };
  }
  // Reserve synchronously before any await so concurrent retries cannot act twice.
  db.prepare("INSERT INTO siri_actions VALUES(?,?,?,'pending',NULL,?)").run(
    email,
    req.operationId,
    body,
    new Date().toISOString(),
  );
  const work = (async (): Promise<Executed> => {
    let result: Executed;
    try {
      const current = await inspectLocalAction(
        email,
        req.action,
        req.protocolHostId,
      );
      if (current.version !== req.expected)
        throw new Error(
          "The target changed since this action was proposed. Please ask again.",
        );
      if (req.action.do === "runs.start" && req.protocolHostId) {
        const host = getHost(email, req.protocolHostId);
        if (!host) throw new Error("The protocol's Mac is offline.");
        const parsed = await requestParse(host, {
          protocolSlug: req.action.protocolSlug,
          user: email,
        });
        if (parsed.error || !parsed.snapshot || !parsed.sessionId)
          throw new Error(parsed.error ?? "The protocol could not be parsed.");
        if (parsed.snapshot.hash !== current.protocolHash)
          throw new Error(
            "The protocol changed before starting. Please ask again.",
          );
        const { createRun } = await import("../runs/service");
        await createRun({
          email,
          sessionId: parsed.sessionId,
          hostId: req.protocolHostId,
          protocolSlug: req.action.protocolSlug,
          protocolName: parsed.protocolName ?? req.action.protocolSlug,
          snapshot:
            parsed.snapshot as unknown as import("../runs/parse").ProtocolSnapshot,
        });
        result = {
          action: req.action,
          ok: true,
          said: `Started ${parsed.protocolName ?? req.action.protocolSlug}.`,
        };
      } else
        result = (
          await executePlan(
            email,
            {
              say: "",
              actions: [req.action],
              need: null,
              confirm: null,
              continues: false,
            },
            {
              siriTurnId: req.taskId!,
              device: req.device ?? "Siri",
              said: req.said ?? "",
              delegationId: req.operationId!,
            },
          )
        )[0]!;
    } catch (e) {
      result = {
        action: req.action,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    db.prepare(
      "UPDATE siri_actions SET status='done',result=? WHERE email=? AND operation_id=?",
    ).run(JSON.stringify(result), email, req.operationId);
    return result;
  })();
  running.set(key, work);
  try {
    return await work;
  } finally {
    running.delete(key);
  }
}
export async function actionAtOwner(
  email: string,
  req: ActionRequest,
): Promise<Inspection | Executed> {
  const run = req.action?.do?.startsWith("runs.");
  if (
    isDesktop() &&
    boxSessionCookie() &&
    (run ||
      (req.hostId && req.hostId !== "local" && req.hostId !== stableHostId()))
  ) {
    const res = await fetch(`${proxyServerBase()}/api/siri/action`, {
      method: "POST",
      headers: {
        cookie: boxSessionCookie()!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...req,
        hostId: run || req.hostId === "box" ? undefined : req.hostId,
        ...(req.action.do === "runs.start"
          ? {
              protocolHostId:
                req.protocolHostId ??
                (req.hostId && !["box", "local"].includes(req.hostId)
                  ? req.hostId
                  : stableHostId()),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = (await res.json()) as (Inspection | Executed) & {
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? "Action owner unavailable.");
    return data;
  }
  if (run && !isDesktop())
    return executeOwnedAction(email, {
      ...req,
      ...(req.action.do === "runs.start" &&
      req.hostId &&
      !["local", "box"].includes(req.hostId)
        ? { protocolHostId: req.hostId }
        : {}),
    });
  if (
    req.hostId &&
    !["local", "box", ...(isDesktop() ? [stableHostId()] : [])].includes(
      req.hostId,
    )
  ) {
    const host = getHost(email, req.hostId);
    if (!host)
      throw new Error(
        "The chat's Mac is offline. Reconnect it to continue there.",
      );
    return requestHostJson(
      host,
      "/api/siri/action",
      { ...req, hostId: undefined },
      30000,
    );
  }
  return executeOwnedAction(email, req);
}
