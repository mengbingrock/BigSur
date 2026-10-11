/** Account-scoped, source-linked retrieval. Page sizes bound a response, never
 * the searchable history. Source rows, rather than summaries, are read back. */
import {
  buildContextEmbeddings,
  contextEmbeddingStatus,
  semanticCandidates,
} from "./embeddings";
import { createHash } from "node:crypto";
import type {
  ContextCall,
  ContextCoverage,
  ContextResult,
} from "@labee/contracts";
import { getDb, type SqlDb } from "../db";
import { getAllSkills, getSkillBySlug } from "../skills";
import { getHost, listHosts, requestHostJson } from "../deviceLink/hosts";
import { isDesktop, boxSessionCookie, proxyServerBase } from "../llmSettings";
import { stableHostId } from "../deviceLink/client";

export class ContextError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const TOOLS = new Set([
  "index.status",
  "index.build",
  "sessions.search",
  "sessions.read",
  "messages.read",
  "sessions.events",
  "runs.search",
  "runs.read",
  "protocols.search",
  "protocols.read",
  "tasks.search",
  "tasks.read",
]);
const CHUNK = 6000;
export function validateContextCall(value: unknown): ContextCall {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContextError(400, "Expected a context request.");
  const c = value as ContextCall;
  if (
    c.mode !== undefined &&
    !["lexical", "semantic", "hybrid"].includes(c.mode)
  )
    throw new ContextError(400, "Invalid retrieval mode.");
  if (!TOOLS.has(c.tool)) throw new ContextError(400, "Unknown context tool.");
  for (const k of [
    "query",
    "hostId",
    "sessionId",
    "runId",
    "cursor",
    "status",
    "since",
    "until",
    "protocolSlug",
    "taskId",
  ] as const) {
    if (c[k] !== undefined && (typeof c[k] !== "string" || c[k]!.length > 8192))
      throw new ContextError(400, `Invalid ${k}.`);
  }
  for (const k of ["limit", "messageIdx", "eventSeq", "offset"] as const) {
    if (c[k] !== undefined && (!Number.isSafeInteger(c[k]) || c[k]! < 0))
      throw new ContextError(400, `Invalid ${k}.`);
  }
  if (c.direction !== undefined && !["before", "after"].includes(c.direction))
    throw new ContextError(400, "Invalid direction.");
  if (c.part !== undefined && !["state", "snapshot", "events"].includes(c.part))
    throw new ContextError(400, "Invalid part.");
  for (const k of ["archived", "localOnly", "includeEvents"] as const)
    if (c[k] !== undefined && typeof c[k] !== "boolean")
      throw new ContextError(400, `Invalid ${k}.`);
  return c;
}
function json(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(value ?? "{}"));
  } catch {
    return {};
  }
}
function scope(email: string, c: ContextCall): string {
  const { cursor: _, limit: __, ...rest } = c;
  return createHash("sha256")
    .update(JSON.stringify([email, Object.entries(rest).toSorted()]))
    .digest("hex");
}
function decode(
  email: string,
  c: ContextCall,
): {
  after: number;
  ceiling: number;
  generation?: number;
  indexVersion?: string;
} | null {
  if (!c.cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(c.cursor, "base64url").toString());
    if (
      v.scope !== scope(email, c) ||
      !Number.isSafeInteger(v.after) ||
      !Number.isSafeInteger(v.ceiling)
    )
      throw new Error();
    return v;
  } catch {
    throw new ContextError(400, "Invalid cursor for this account or query.");
  }
}
function cursor(email: string, c: ContextCall, v: object): string {
  return Buffer.from(JSON.stringify({ scope: scope(email, c), ...v })).toString(
    "base64url",
  );
}
async function coverage(
  db: SqlDb,
  email: string,
  host?: string,
): Promise<ContextCoverage> {
  const indexing = Boolean(
    db.prepare("SELECT 1 FROM context_backfill WHERE complete=0 LIMIT 1").get(),
  );
  const mirrored = db
    .prepare(
      `SELECT host_id,MAX(updated_at) synced_at FROM mirror_sessions WHERE email=? GROUP BY host_id`,
    )
    .all(email);
  const sources: ContextCoverage["sources"] = [
    { hostId: "local", mirrored: false, online: true, complete: !indexing },
  ];
  for (const h of new Set([
    ...mirrored.map((r) => String(r.host_id)),
    ...listHosts(email).map((h) => h.hostId),
  ])) {
    const row = mirrored.find((r) => r.host_id === h);
    sources.push({
      hostId: h,
      mirrored: true,
      online: !!getHost(email, h),
      ...(row ? { syncedAt: String(row.synced_at) } : {}),
      complete: false,
    });
  }
  const selected = host ? sources.filter((s) => s.hostId === host) : sources;
  return {
    indexing,
    complete: selected.length > 0 && selected.every((s) => s.complete),
    sources: selected,
    unavailableHosts: selected.filter((s) => !s.online).map((s) => s.hostId),
  };
}
function chunk(
  content: string,
  offset = 0,
  size = CHUNK,
): Record<string, unknown> {
  if (offset > content.length)
    throw new ContextError(400, "Offset is past the end of this record.");
  const end = offset + size;
  return {
    content: content.slice(offset, end),
    offset,
    totalLength: content.length,
    ...(end < content.length ? { nextOffset: end } : {}),
  };
}

/** A named online host is authoritative. Offline mirrors are explicitly
 * incomplete. A broad search discovers mirrors and lists hosts to search;
 * callers must inspect coverage before concluding that nothing exists. */
export async function retrieveContext(
  email: string,
  value: unknown,
): Promise<ContextResult> {
  const c = validateContextCall(value);
  if (
    c.hostId &&
    c.hostId !== "local" &&
    isDesktop() &&
    c.hostId !== stableHostId() &&
    boxSessionCookie() &&
    !c.localOnly
  ) {
    const res = await fetch(`${proxyServerBase()}/api/context`, {
      method: "POST",
      headers: {
        cookie: boxSessionCookie()!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...c,
        hostId: c.hostId === "box" ? undefined : c.hostId,
        localOnly: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json()) as ContextResult & { error?: string };
    if (!res.ok)
      throw new ContextError(
        res.status,
        data.error ?? "Box context unavailable.",
      );
    for (const item of data.items)
      if (!item.hostId || item.hostId === "local") item.hostId = "box";
    data.coverage.sources = data.coverage.sources.map((s) =>
      s.hostId === "local" ? { ...s, hostId: "box" } : s,
    );
    return data;
  }
  if (
    c.hostId &&
    !["local", "box", ...(isDesktop() ? [stableHostId()] : [])].includes(
      c.hostId,
    ) &&
    !c.localOnly
  ) {
    const conn = getHost(email, c.hostId);
    if (conn) {
      const r = await requestHostJson<ContextResult>(conn, "/api/context", {
        ...c,
        hostId: undefined,
        localOnly: true,
      });
      for (const item of r.items) item.hostId = c.hostId;
      r.coverage.sources = r.coverage.sources.map((s) => ({
        ...s,
        hostId: c.hostId!,
      }));
      return r;
    }
  }
  return retrieveLocal(email, c);
}

export async function retrieveLocal(
  email: string,
  c: ContextCall,
): Promise<ContextResult> {
  const db = await getDb();
  const host =
    !c.hostId ||
    c.hostId === "local" ||
    (isDesktop() && c.hostId === stableHostId())
      ? ""
      : c.hostId === "box" && !isDesktop()
        ? ""
        : c.hostId;
  const cov = await coverage(db, email, c.hostId ? host || "local" : undefined);
  if (isDesktop() && !c.localOnly && !c.hostId && boxSessionCookie()) {
    cov.complete = false;
    cov.sources.push({
      hostId: "box",
      mirrored: false,
      online: true,
      complete: false,
    });
  }
  const result = (
    items: Record<string, unknown>[],
    more: Partial<ContextResult> = {},
  ): ContextResult => ({ items, coverage: cov, hasMore: false, ...more });
  const n = Math.max(1, Math.min(c.limit ?? 20, 50));
  const page = decode(email, c);
  if (c.tool === "index.status" || c.tool === "index.build") {
    if (host) throw new ContextError(503, "The index owner is offline.");
    const status =
      c.tool === "index.build"
        ? await buildContextEmbeddings(email, n)
        : await contextEmbeddingStatus(email);
    return result([{ ...status }], { embedding: status });
  }
  if (c.tool === "protocols.search" || c.tool === "protocols.read") {
    if (host) throw new ContextError(503, "Protocol source is offline.");
    if (c.tool === "protocols.read") {
      const p = c.protocolSlug ? getSkillBySlug(c.protocolSlug, email) : null;
      if (!p || p.artifactKind !== "protocol")
        throw new ContextError(404, "Protocol not found.");
      return result([
        { protocolSlug: p.slug, name: p.name, ...chunk(p.body, c.offset) },
      ]);
    }
    const all = getAllSkills(email)
      .filter(
        (p) =>
          p.artifactKind === "protocol" &&
          (!c.query ||
            `${p.slug} ${p.name} ${p.body}`
              .toLowerCase()
              .includes(c.query.toLowerCase())),
      )
      .toSorted((a, b) => a.slug.localeCompare(b.slug));
    const generation = createHash("sha256")
      .update(JSON.stringify(all.map((p) => [p.slug, p.body])))
      .digest("hex");
    // Protocol files may change independently of SQLite.
    if (c.cursor && String(page?.generation) !== generation)
      throw new ContextError(409, "Protocols changed; repeat the search.");
    const after = page?.after ?? 0;
    return result(
      all
        .slice(after, after + n)
        .map((p) => ({ protocolSlug: p.slug, name: p.name })),
      {
        hasMore: after + n < all.length,
        ...(after + n < all.length
          ? {
              nextCursor: cursor(email, c, {
                after: after + n,
                ceiling: all.length,
                generation,
              }),
            }
          : {}),
      },
    );
  }
  if (c.tool.startsWith("tasks.")) {
    if (host) throw new ContextError(503, "Task owner is offline.");
    if (c.tool === "tasks.read") {
      if (!c.taskId) throw new ContextError(400, "taskId is required.");
      const task = db
        .prepare("SELECT * FROM siri_tasks WHERE email=? AND id=?")
        .get(email, c.taskId);
      if (!task) throw new ContextError(404, "Task not found.");
      if (c.part !== "events")
        return result([
          {
            taskId: task.id,
            status: task.status,
            sessionId: task.session_id,
            ...chunk(
              JSON.stringify({
                request: task.request,
                result: json(task.result),
                checkpoint: json(task.checkpoint),
              }),
              c.offset,
            ),
          },
        ]);
      if (
        c.eventSeq !== undefined &&
        !db
          .prepare(
            "SELECT 1 FROM siri_task_events WHERE email=? AND task_id=? AND id=?",
          )
          .get(email, c.taskId, c.eventSeq)
      )
        throw new ContextError(404, "Task event not found.");
      const ceiling =
        page?.ceiling ??
        Number(
          db
            .prepare(
              "SELECT COALESCE(MAX(id),0) n FROM siri_task_events WHERE email=? AND task_id=?",
            )
            .get(email, c.taskId)!.n,
        );
      const exact = c.eventSeq !== undefined && !c.direction;
      const before = c.direction === "before";
      const after =
        page?.after ??
        (c.eventSeq !== undefined
          ? c.eventSeq + (before ? 1 : -1)
          : before
            ? ceiling + 1
            : 0);
      const rows = db
        .prepare(
          `SELECT * FROM siri_task_events WHERE email=? AND task_id=? AND id${exact ? "=" : before ? "<" : ">"}? AND id<=? ORDER BY id ${before ? "DESC" : "ASC"} LIMIT ?`,
        )
        .all(
          email,
          c.taskId,
          exact ? c.eventSeq : after,
          ceiling,
          exact ? 1 : n + 1,
        );
      const chosen = rows.slice(0, n);
      const more = !exact && rows.length > n;
      return result(
        chosen.map((r) => ({
          taskId: c.taskId,
          eventSeq: r.id,
          kind: r.kind,
          ...chunk(String(r.data), c.offset),
        })),
        {
          hasMore: more,
          ...(more
            ? {
                nextCursor: cursor(email, c, {
                  after: Number(chosen.at(-1)!.id),
                  ceiling,
                }),
              }
            : {}),
        },
      );
    }
    const args: unknown[] = [email];
    let where = "email=?";
    if (c.taskId) {
      where += " AND id=?";
      args.push(c.taskId);
    }
    if (c.status) {
      where += " AND status=?";
      args.push(c.status);
    }
    if (c.query) {
      where += " AND (instr(lower(request),lower(?))>0 OR id=?)";
      args.push(c.query, c.query);
    }
    const ceiling =
      page?.ceiling ??
      Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(rowid),0) n FROM siri_tasks WHERE email=?",
          )
          .get(email)!.n,
      );
    const rows = db
      .prepare(
        `SELECT rowid ordinal,id,status,request,session_id,created_at,updated_at,result FROM siri_tasks WHERE ${where} AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`,
      )
      .all(...args, page?.after ?? 0, ceiling, n + 1);
    const more = rows.length > n;
    const selected = rows.slice(0, n);
    return result(
      selected.map((r) => ({
        taskId: r.id,
        status: r.status,
        sessionId: r.session_id,
        request: r.request,
        result: r.result,
        updatedAt: r.updated_at,
      })),
      {
        hasMore: more,
        ...(more
          ? {
              nextCursor: cursor(email, c, {
                after: Number(selected.at(-1)!.ordinal),
                ceiling,
              }),
            }
          : {}),
      },
    );
  }
  if (c.tool.endsWith(".search")) {
    const run = c.tool === "runs.search";
    const args: unknown[] = [email];
    let where = "d.email=?";
    where += run
      ? " AND d.kind IN ('run','run_event')"
      : ` AND d.kind IN ('session','message'${c.includeEvents ? ",'event'" : ""})`;
    if (c.hostId || c.localOnly) {
      where += " AND d.host_id=?";
      args.push(host);
    }
    if (c.sessionId || c.runId) {
      where += " AND d.entity_id=?";
      args.push(c.sessionId ?? c.runId);
    }
    if (c.since) {
      where += " AND d.ts>=?";
      args.push(c.since);
    }
    if (c.until) {
      where += " AND d.ts<=?";
      args.push(c.until);
    }
    const statusExpr = run
      ? "r.status"
      : "CASE WHEN d.host_id='' THEN s.status ELSE json_extract(m.summary,'$.status') END";
    if (c.status) {
      where += ` AND ${statusExpr}=?`;
      args.push(c.status);
    }
    if (!run && c.archived !== undefined) {
      where += ` AND (CASE WHEN d.host_id='' THEN s.archived_at ELSE json_extract(m.summary,'$.archivedAt') END) IS ${c.archived ? "NOT " : ""}NULL`;
    }
    const sourceJoin = `LEFT JOIN chat_sessions s ON d.host_id='' AND s.id=d.entity_id AND s.email=d.email
      LEFT JOIN mirror_sessions m ON m.host_id=d.host_id AND m.id=d.entity_id AND m.email=d.email
      LEFT JOIN protocol_runs r ON r.id=d.entity_id AND r.email=d.email`;
    where += run
      ? " AND r.id IS NOT NULL"
      : " AND (s.id IS NOT NULL OR m.id IS NOT NULL)";
    const semanticWhere = where,
      semanticArgs = [...args];
    if (c.query?.trim()) {
      const words = c.query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
      const fts = words
        .map((w) => `"${w.replaceAll('"', '""')}"`)
        .join(" AND ");
      if (fts) {
        where +=
          " AND (d.id IN (SELECT rowid FROM context_fts WHERE context_fts MATCH ?) OR d.entity_id=?)";
        args.push(fts, c.query);
      } else {
        where += " AND instr(d.content,?)>0";
        args.push(c.query);
      }
    }
    const generation = Number(
      db
        .prepare("SELECT value FROM context_generation WHERE email=?")
        .get(email)?.value ?? 0,
    );
    if (page && page.generation !== generation)
      throw new ContextError(
        409,
        "History changed; repeat the search rather than skipping results.",
      );
    let fallbackEmbedding: ContextResult["embedding"];
    if (c.query?.trim() && c.mode && c.mode !== "lexical") {
      const embedding = await contextEmbeddingStatus(email);
      fallbackEmbedding = embedding;
      const dense = await semanticCandidates(
        email,
        c.query,
        semanticWhere,
        semanticArgs,
        sourceJoin,
      ).catch(() => null);
      if (dense) {
        if (
          Number(
            db
              .prepare("SELECT value FROM context_generation WHERE email=?")
              .get(email)?.value ?? 0,
          ) !== generation
        )
          throw new ContextError(
            409,
            "History changed during search; repeat the query.",
          );
        if (page?.indexVersion && page.indexVersion !== dense.version)
          throw new ContextError(
            409,
            "Embedding index changed; repeat the search.",
          );
        const expression = (c.query.match(/[\p{L}\p{N}_-]+/gu) ?? [])
          .map((w) => `"${w.replaceAll('"', '""')}"`)
          .join(" AND ");
        const lexical =
          c.mode === "hybrid" && expression
            ? db
                .prepare(
                  `SELECT d.id FROM context_fts JOIN context_documents d ON d.id=context_fts.rowid ${sourceJoin} WHERE ${semanticWhere} AND context_fts MATCH ? ORDER BY bm25(context_fts),d.id`,
                )
                .all(...semanticArgs, expression)
            : [];
        if (c.mode === "hybrid")
          for (const r of db
            .prepare(
              `SELECT d.id FROM context_documents d ${sourceJoin} WHERE ${semanticWhere} AND d.entity_id=? ORDER BY d.id`,
            )
            .all(...semanticArgs, c.query)
            .toReversed())
            if (!lexical.some((x) => x.id === r.id)) lexical.unshift(r);
        if (!embedding.ready) {
          cov.complete = false;
          cov.indexing = true;
        }
        const ranked = new Map<
          number,
          { id: number; score: number; offset: number }
        >();
        dense.hits.forEach((h, i) =>
          ranked.set(h.id, { ...h, score: 1 / (60 + i + 1) }),
        );
        lexical.forEach((r, i) => {
          const id = Number(r.id);
          const prev = ranked.get(id);
          ranked.set(id, {
            id,
            score: (prev?.score ?? 0) + 1 / (60 + i + 1),
            offset: prev?.offset ?? 0,
          });
        });
        const sorted = [...ranked.values()].toSorted(
          (a, b) => b.score - a.score || a.id - b.id,
        );
        const after = page?.after ?? 0;
        const selected = sorted.slice(after, after + n);
        const more = after + n < sorted.length;
        const items = selected.map((hit) => {
          const r = db
            .prepare(
              `SELECT d.*,s.title local_title,s.archived_at,m.summary,r.protocol_name FROM context_documents d ${sourceJoin} WHERE d.id=? AND d.email=?`,
            )
            .get(hit.id, email)!;
          return {
            hostId: r.host_id || "local",
            ...(run ? { runId: r.entity_id } : { sessionId: r.entity_id }),
            kind: r.kind,
            ...(r.kind === "message"
              ? { messageIdx: r.ordinal }
              : ["event", "run_event"].includes(String(r.kind))
                ? { eventSeq: r.ordinal }
                : {}),
            title: r.local_title ?? json(r.summary).title ?? r.protocol_name,
            archivedAt: r.archived_at ?? json(r.summary).archivedAt ?? null,
            excerpt: String(r.content).slice(hit.offset, hit.offset + 600),
            offset: hit.offset,
            truncated: String(r.content).length > 600,
            score: hit.score,
            timestamp: r.ts,
          };
        });
        return result(items, {
          embedding,
          mode: dense.hits.length ? c.mode : "lexical",
          hasMore: more,
          ...(more
            ? {
                nextCursor: cursor(email, c, {
                  after: after + n,
                  ceiling: sorted.length,
                  generation,
                  indexVersion: dense.version,
                }),
              }
            : {}),
        });
      }
      if (page?.indexVersion)
        throw new ContextError(
          503,
          "Semantic index is temporarily unavailable; retry this cursor later.",
        );
      if (c.mode === "semantic")
        throw new ContextError(
          503,
          "Semantic search is unavailable. Configure the embedding provider, build the index, or use lexical search.",
        );
    }
    const ceiling =
      page?.ceiling ??
      Number(
        db.prepare("SELECT COALESCE(MAX(id),0) n FROM context_documents").get()!
          .n,
      );
    const rows = db
      .prepare(
        `SELECT d.*,s.title local_title,s.archived_at,m.summary,r.protocol_name FROM context_documents d
      LEFT JOIN chat_sessions s ON d.host_id='' AND s.id=d.entity_id AND s.email=d.email
      LEFT JOIN mirror_sessions m ON m.host_id=d.host_id AND m.id=d.entity_id AND m.email=d.email
      LEFT JOIN protocol_runs r ON r.id=d.entity_id AND r.email=d.email
      WHERE ${where} AND ${run ? "r.id IS NOT NULL" : "(s.id IS NOT NULL OR m.id IS NOT NULL)"} AND d.id>? AND d.id<=? ORDER BY d.id LIMIT ?`,
      )
      .all(...args, page?.after ?? 0, ceiling, n + 1);
    const selected = rows.slice(0, n);
    const more = rows.length > n;
    return result(
      selected.map((r) => ({
        hostId: r.host_id || "local",
        ...(run ? { runId: r.entity_id } : { sessionId: r.entity_id }),
        kind: r.kind,
        ...(r.kind === "message"
          ? { messageIdx: r.ordinal }
          : ["event", "run_event"].includes(String(r.kind))
            ? { eventSeq: r.ordinal }
            : {}),
        title: r.local_title ?? json(r.summary).title ?? r.protocol_name,
        archivedAt: r.archived_at ?? json(r.summary).archivedAt ?? null,
        excerpt: String(r.content).slice(0, 600),
        truncated: String(r.content).length > 600,
        timestamp: r.ts,
      })),
      {
        hasMore: more,
        mode: "lexical",
        ...(fallbackEmbedding ? { embedding: fallbackEmbedding } : {}),
        ...(more
          ? {
              nextCursor: cursor(email, c, {
                after: Number(selected.at(-1)!.id),
                ceiling,
                generation,
              }),
            }
          : {}),
      },
    );
  }
  const run = c.tool === "runs.read";
  const id = run ? c.runId : c.sessionId;
  if (!id)
    throw new ContextError(
      400,
      run ? "runId is required." : "sessionId is required.",
    );
  const parent = run
    ? !host &&
      db
        .prepare("SELECT * FROM protocol_runs WHERE email=? AND id=?")
        .get(email, id)
    : host
      ? db
          .prepare(
            "SELECT * FROM mirror_sessions WHERE email=? AND host_id=? AND id=?",
          )
          .get(email, host, id)
      : db
          .prepare("SELECT * FROM chat_sessions WHERE email=? AND id=?")
          .get(email, id);
  if (!parent)
    throw new ContextError(404, "Context source not found for this account.");
  if (run && c.part !== "events") {
    const { snapshot, ...state } = parent;
    return result([
      {
        hostId: "local",
        runId: id,
        ...state,
        ...(c.part === "snapshot"
          ? chunk(String(snapshot), c.offset)
          : { snapshotAvailable: true }),
      },
    ]);
  }
  const events = c.tool === "sessions.events" || run;
  const table = run
    ? "protocol_run_events"
    : host
      ? events
        ? "mirror_events"
        : "mirror_messages"
      : events
        ? "chat_session_events"
        : "chat_session_messages";
  const key = run ? "run_id" : "session_id";
  const ordinal = events ? "seq" : "idx";
  const args: unknown[] = host ? [email, host, id] : [id];
  const where = host ? `email=? AND host_id=? AND ${key}=?` : `${key}=?`;
  const anchor = events ? c.eventSeq : c.messageIdx;
  if (c.tool === "messages.read" && anchor === undefined)
    throw new ContextError(400, "messageIdx is required.");
  if (
    anchor !== undefined &&
    !db
      .prepare(`SELECT 1 FROM ${table} WHERE ${where} AND ${ordinal}=?`)
      .get(...args, anchor)
  )
    throw new ContextError(
      404,
      "Exact source record is missing; it may have been deleted or not mirrored.",
    );
  const ceiling =
    page?.ceiling ??
    Number(
      db
        .prepare(
          `SELECT COALESCE(MAX(${ordinal}),-1) n FROM ${table} WHERE ${where}`,
        )
        .get(...args)!.n,
    );
  const before = c.direction === "before";
  const exact =
    c.tool === "messages.read" ||
    (events && anchor !== undefined && c.direction === undefined);
  const after =
    page?.after ??
    (anchor !== undefined
      ? anchor + (before ? 1 : -1)
      : before
        ? ceiling + 1
        : -1);
  const rows = db
    .prepare(
      `SELECT * FROM ${table} WHERE ${where} AND ${ordinal}${exact ? "=" : before ? "<" : ">"}? AND ${ordinal}<=? ORDER BY ${ordinal} ${before ? "DESC" : "ASC"} LIMIT ?`,
    )
    .all(...args, exact ? anchor : after, ceiling, exact ? 1 : n + 1);
  const selected = rows.slice(0, n);
  const more = !exact && rows.length > n;
  const items = selected.map((r) => {
    const v = host ? json(r.data) : r;
    const content = events
      ? host
        ? JSON.stringify(v)
        : `${r.type}\n${r.data}`
      : String(v.content ?? "");
    return {
      hostId: host || "local",
      ...(run ? { runId: id } : { sessionId: id }),
      ...(events
        ? { eventSeq: r[ordinal], type: v.type }
        : {
            messageIdx: r[ordinal],
            role: v.role,
            turnId: v.turn_id ?? v.turnId,
          }),
      ...chunk(
        content,
        c.offset,
        Math.min(CHUNK, Math.floor(24000 / Math.max(selected.length, 1))),
      ),
      timestamp: v.created_at ?? v.createdAt ?? v.ts,
    };
  });
  if (host) {
    const source = cov.sources.find((s) => s.hostId === host);
    const mc = db
      .prepare(
        "SELECT MAX(idx) n FROM mirror_messages WHERE email=? AND host_id=? AND session_id=?",
      )
      .get(email, host, id);
    const ec = db
      .prepare(
        "SELECT MAX(seq) n FROM mirror_events WHERE email=? AND host_id=? AND session_id=?",
      )
      .get(email, host, id);
    if (source) {
      source.messageThrough = Number(mc?.n ?? -1);
      source.eventThrough = Number(ec?.n ?? 0);
    }
  }
  return result(items, {
    hasMore: more,
    ...(more
      ? {
          nextCursor: cursor(email, c, {
            after: Number(selected.at(-1)![ordinal]),
            ceiling,
          }),
        }
      : {}),
  });
}
