// Research-run API. Runs execute server-side and outlive the browser; the
// events endpoint replays the persisted log (Last-Event-ID / ?after=seq) and
// then tails the live pubsub, so a page refresh reconnects losslessly.
import fs from "node:fs/promises";
import { Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { CreateRunRequest } from "@labee/contracts";
import { bodyJson, error, json, requestUrl, sessionUser } from "../httpKit";
import { answerGate, bootSweep, cancelRun, startRun } from "../research/engine";
import {
  getRun,
  listArtifacts,
  listClaims,
  listEventsAfter,
  listEvidence,
  listRuns,
  listTasks,
} from "../research/runsDb";
import { rowToEnvelope } from "../research/events";
import { getRunHandle, subscribeRun } from "../research/registry";
import { safeRunPath } from "../research/workspace";
import type { RunRow } from "../research/types";

const params = HttpRouter.params;
const safeBody = <T>() => bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

// Settle rows left behind by a previous server process, once, lazily on the
// first research request (keeps server.ts untouched by this feature).
let sweepPromise: Promise<void> | null = null;
const ensureSwept = () => (sweepPromise ??= bootSweep());

function runSummary(run: RunRow) {
  const handle = getRunHandle(run.id);
  return {
    id: run.id,
    title: run.title,
    question: run.spec.question,
    status: run.status,
    stage: run.stage,
    failReason: run.failReason,
    costUsd: run.costUsd,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    pendingGates: handle ? [...handle.gateResolvers.keys()] : [],
  };
}

export const createRunRoute = HttpRouter.add(
  "POST",
  "/api/research/runs",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    yield* Effect.promise(ensureSwept);
    const body = yield* safeBody<CreateRunRequest>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    const result = yield* Effect.promise(() => startRun(user.email, body));
    if (!result.ok) return yield* error(result.error.message, result.error.status);
    return yield* json({ run: runSummary(result.run) }, 201);
  }),
);

export const listRunsRoute = HttpRouter.add(
  "GET",
  "/api/research/runs",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    yield* Effect.promise(ensureSwept);
    const runs = yield* Effect.promise(() => listRuns(user.email));
    return yield* json({ runs: runs.map(runSummary) });
  }),
);

export const getRunRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    yield* Effect.promise(ensureSwept);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const tasks = yield* Effect.promise(() => listTasks(run.id));
    return yield* json({
      run: runSummary(run),
      spec: run.spec,
      tasks,
    });
  }),
);

export const cancelRunRoute = HttpRouter.add(
  "POST",
  "/api/research/runs/:id/cancel",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const ok = yield* Effect.promise(() => cancelRun(user.email, id ?? ""));
    if (!ok) return yield* error("Run not found.", 404);
    return yield* json({ ok: true });
  }),
);

export const gateRoute = HttpRouter.add(
  "POST",
  "/api/research/runs/:id/gate",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const body = yield* safeBody<{ gate?: string; approve?: boolean }>();
    if (!body || typeof body.gate !== "string" || typeof body.approve !== "boolean") {
      return yield* error("Body must be { gate, approve }.", 400);
    }
    const result = yield* Effect.promise(() =>
      answerGate(user.email, id ?? "", body.gate!, body.approve!),
    );
    if (!result.ok) return yield* error(result.message ?? "Gate not pending.", 409);
    return yield* json({ ok: true });
  }),
);

export const runEventsRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id/events",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const url = yield* requestUrl;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const lastEventId = request.headers["last-event-id"];
    const after = Number(url.searchParams.get("after") ?? lastEventId ?? 0) || 0;

    const encoder = new TextEncoder();
    const runId = run.id;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (envelope: { seq: number }) => {
          if (closed) return;
          try {
            const idField = envelope.seq > 0 ? `id: ${envelope.seq}\n` : "";
            controller.enqueue(
              encoder.encode(`${idField}event: run_event\ndata: ${JSON.stringify(envelope)}\n\n`),
            );
          } catch {
            closed = true;
          }
        };

        // Live tail is subscribed BEFORE replay; seen-set dedupes the overlap.
        const seen = new Set<number>();
        const pending: Array<{ seq: number }> = [];
        let replaying = true;
        const unsubscribe = subscribeRun(runId, (evt) => {
          if (replaying) pending.push(evt);
          else {
            if (evt.seq > 0 && seen.has(evt.seq)) return;
            if (evt.seq > 0) seen.add(evt.seq);
            send(evt);
          }
        });

        const rows = await listEventsAfter(runId, after);
        for (const row of rows) {
          const envelope = rowToEnvelope(row);
          seen.add(envelope.seq);
          send(envelope);
        }
        replaying = false;
        for (const evt of pending) {
          if (evt.seq > 0 && seen.has(evt.seq)) continue;
          if (evt.seq > 0) seen.add(evt.seq);
          send(evt);
        }

        // Terminal runs get a final status frame then EOF (no tail to wait on).
        const isLive = Boolean(getRunHandle(runId));
        if (!isLive) {
          send({
            seq: 0,
            runId,
            ts: new Date().toISOString(),
            type: "run_status",
            stage: run.stage,
            role: null,
            taskId: null,
            branch: null,
            data: { status: run.status, failReason: run.failReason, final: true },
          } as never);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
          return;
        }

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            closed = true;
          }
        }, 25_000);

        const cleanup = () => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        // Close the stream when the run reaches a terminal status.
        subscribeRun(runId, (evt) => {
          if (
            evt.type === "run_status" &&
            typeof (evt.data as { status?: string })?.status === "string" &&
            ["completed", "failed", "cancelled", "interrupted"].includes(
              (evt.data as { status: string }).status,
            )
          ) {
            setTimeout(cleanup, 50);
          }
        });
      },
    });

    return HttpServerResponse.stream(
      Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }),
      {
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
      },
    );
  }),
);

export const runArtifactsRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id/artifacts",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const artifacts = yield* Effect.promise(() => listArtifacts(run.id));
    return yield* json({ artifacts });
  }),
);

export const runArtifactFileRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id/artifacts/file",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const url = yield* requestUrl;
    const relPath = url.searchParams.get("path");
    if (!relPath) return yield* error("`path` is required.", 400);
    const content = yield* Effect.promise(async () => {
      try {
        const abs = safeRunPath(run.workspaceDir, relPath);
        return await fs.readFile(abs, "utf8");
      } catch {
        return null;
      }
    });
    if (content === null) return yield* error("File not found.", 404);
    return HttpServerResponse.text(content, {
      contentType: relPath.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
    });
  }),
);

export const runClaimsRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id/claims",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const claims = yield* Effect.promise(() => listClaims(run.id));
    return yield* json({ claims });
  }),
);

export const runEvidenceRoute = HttpRouter.add(
  "GET",
  "/api/research/runs/:id/evidence",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Authentication required.", 401);
    const { id } = yield* params;
    const run = yield* Effect.promise(() => getRun(user.email, id ?? ""));
    if (!run) return yield* error("Run not found.", 404);
    const evidence = yield* Effect.promise(() => listEvidence(run.id));
    return yield* json({ evidence });
  }),
);

export const researchRoutes = [
  createRunRoute,
  listRunsRoute,
  getRunRoute,
  cancelRunRoute,
  gateRoute,
  runEventsRoute,
  runArtifactsRoute,
  runArtifactFileRoute,
  runClaimsRoute,
  runEvidenceRoute,
] as const;
