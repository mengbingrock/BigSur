import { beforeAll, describe, it, expect } from "vitest";
import { applyTestEnv, waitFor } from "./helpers/env";
applyTestEnv("siri-context");
let store: typeof import("../src/services/siri/store");
let router: typeof import("../src/services/siri/contextRouter");
let sdb: typeof import("../src/services/sessions/db");
let rdb: typeof import("../src/services/runs/db");
let actions: typeof import("../src/services/siri/actions");
let db: import("../src/services/db").SqlDb;
const email = "router@example.com";
let siri: string;
beforeAll(async () => {
  store = await import("../src/services/siri/store");
  router = await import("../src/services/siri/contextRouter");
  sdb = await import("../src/services/sessions/db");
  rdb = await import("../src/services/runs/db");
  actions = await import("../src/services/siri/actions");
  db = await (await import("../src/services/db")).getDb();
  siri = (
    await (await import("../src/services/siri/router")).ensureSiriSession(email)
  ).id;
});
async function enqueue(text: string, options: Record<string, unknown> = {}) {
  const id = sdb.newId("request");
  return store.enqueue(
    email,
    siri,
    text,
    "test",
    id,
    JSON.stringify({ text, options }),
    { options },
  );
}
async function run(
  task: import("../src/services/siri/store").Task,
  model: (input: Record<string, unknown>) => unknown,
) {
  for (let i = 0; i < 20; i++) {
    await router.pumpContextTasks({
      model: async (_, input) => JSON.stringify(model(input)),
    });
    await waitFor(
      async () => (await store.taskById(email, task.id))?.status !== "running",
    );
    const current = (await store.taskById(email, task.id))!;
    if (current.result) return JSON.parse(current.result);
  }
  throw new Error("test task did not finish");
}
async function createRun() {
  const s = await sdb.createSession({ email, title: "Test run" });
  const { parseProtocol } = await import("../src/services/runs/parse");
  const service = await import("../src/services/runs/service");
  return service.createRun({
    email,
    sessionId: s.id,
    hostId: null,
    protocolSlug: "test",
    protocolName: "Test",
    snapshot: parseProtocol(
      "# Test\n\n## Steps\n1. Mix the buffer.\n2. Wait for ten minutes.\n3. Collect the pellet.",
    ),
  });
}
describe("durable dynamic router", () => {
  it("requires an original source read before answering from search excerpts", async () => {
    const source = await sdb.createSession({
      email,
      title: "Verified specimen",
    });
    await sdb.appendMessage(
      source.id,
      null,
      "user",
      "Zircon specimen needs 9 milliliters.",
    );
    let calls = 0;
    const reply = await run(
      await enqueue("How much for the zircon specimen?"),
      (input) => {
        calls++;
        if (calls === 1)
          return {
            kind: "read",
            call: { tool: "sessions.search", query: "zircon" },
          };
        if (calls === 2)
          return { kind: "answer", say: "Unverified excerpt answer." };
        if (calls === 3) {
          expect(input.retrievalFeedback).toContain("original source");
          return {
            kind: "read",
            call: {
              tool: "messages.read",
              sessionId: source.id,
              messageIdx: 0,
            },
          };
        }
        return { kind: "answer", say: "Verified: nine milliliters." };
      },
    );
    expect(calls).toBe(4);
    expect(reply.spoken).toBe("Verified: nine milliliters.");
  });
  it("performs repeated reads across scheduling slices and answers from an old correction", async () => {
    const old = await sdb.createSession({ email, title: "Past experiment" });
    for (let i = 0; i < 1000; i++)
      await sdb.appendMessage(
        old.id,
        null,
        "user",
        i === 1
          ? "Neon reagent: use 4 milliliters."
          : i === 5
            ? "Correction: use 7 milliliters for neon reagent."
            : `filler ${i}`,
      );
    const task = await enqueue("What was the corrected neon amount?");
    let calls = 0;
    const reply = await run(task, (input) => {
      calls++;
      const evidence = input.evidence as Array<{
        result: { items: Array<{ content?: string; sessionId?: string }> };
      }>;
      if (calls === 1)
        return {
          kind: "read",
          call: { tool: "sessions.search", query: "neon" },
        };
      if (calls < 12)
        return {
          kind: "read",
          call: {
            tool: "sessions.read",
            sessionId: old.id,
            messageIdx: calls - 2,
            limit: 1,
          },
        };
      expect(
        evidence.some((e) =>
          e.result.items.some((i) => i.content?.includes("7 milliliters")),
        ),
      ).toBe(true);
      return { kind: "answer", say: "Use seven milliliters." };
    });
    expect(calls).toBe(12);
    expect(reply.spoken).toBe("Use seven milliliters.");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM siri_task_events WHERE task_id=? AND kind='read'",
        )
        .get(task.id)!.n,
    ).toBe(11);
  });
  it("deduplicates client retries and rejects reuse for different input", async () => {
    const a = await store.enqueue(
      email,
      siri,
      "hello",
      "test",
      "same-request",
      "hello",
    );
    const b = await store.enqueue(
      email,
      siri,
      "hello",
      "test",
      "same-request",
      "hello",
    );
    expect(b.id).toBe(a.id);
    await expect(
      store.enqueue(
        email,
        siri,
        "different",
        "test",
        "same-request",
        "different",
      ),
    ).rejects.toThrow(/different request/);
    await run(a, () => ({ kind: "answer", say: "Hello." }));
  });
  it("asks which task an ambiguous yes means and accepts an exact confirmation", async () => {
    const r1 = await createRun();
    const r2 = await createRun();
    const a = await enqueue("finish first");
    const b = await enqueue("finish second");
    const respond = (input: Record<string, unknown>) => ({
      kind: "act",
      say: "Finishing.",
      actions: [
        { do: "runs.finish", runId: input.taskId === a.id ? r1.id : r2.id },
      ],
    });
    const ar = await run(a, respond);
    const br = await run(b, respond);
    expect(ar.status).toBe("confirm");
    expect(br.status).toBe("confirm");
    const yes = await run(await enqueue("yes"), () => {
      throw new Error("confirmation should not call the model");
    });
    expect(yes.spoken).toContain("Which task");
    expect((await rdb.getRunForUser(email, r1.id))!.status).toBe("running");
    const exact = await run(
      await enqueue("Yes", { confirmId: ar.confirmId, yes: true }),
      () => {
        throw new Error("no model");
      },
    );
    expect(exact.actions[0].ok).toBe(true);
    expect((await rdb.getRunForUser(email, r1.id))!.status).toBe("done");
    await run(
      await enqueue("No", { confirmId: br.confirmId, yes: false }),
      () => {
        throw new Error("no model");
      },
    );
  });
  it("rejects stale confirmation after a run changes", async () => {
    const r = await createRun();
    const ask = await run(await enqueue("finish"), () => ({
      kind: "act",
      say: "Finishing.",
      actions: [{ do: "runs.finish", runId: r.id }],
    }));
    await (await import("../src/services/runs/service")).advance(r);
    const yes = await run(
      await enqueue("Yes", { confirmId: ask.confirmId, yes: true }),
      () => {
        throw new Error("no model");
      },
    );
    expect(yes.actions[0].ok).toBe(false);
    expect(yes.spoken).toContain("changed");
    expect((await rdb.getRunForUser(email, r.id))!.status).toBe("running");
  });
  it("replays action receipts without advancing twice, including concurrent retries", async () => {
    const r = await createRun();
    const action = { do: "runs.advance" as const, runId: r.id };
    const inspect = await actions.inspectLocalAction(email, action);
    const req = {
      action,
      mode: "execute" as const,
      operationId: "advance-once",
      expected: inspect.version,
      taskId: "receipt-test",
    };
    const [a, b] = await Promise.all([
      actions.executeOwnedAction(email, req),
      actions.executeOwnedAction(email, req),
    ]);
    expect(a).toEqual(b);
    expect((await rdb.getRunForUser(email, r.id))!.current).toBe(2);
    expect(await actions.executeOwnedAction(email, req)).toEqual(a);
    expect((await rdb.getRunForUser(email, r.id))!.current).toBe(2);
    await expect(
      actions.executeOwnedAction(email, {
        ...req,
        action: { do: "runs.back", runId: r.id },
      }),
    ).rejects.toThrow(/reused/);
  });
  it("resumes expired leases from checkpoint and keeps old evidence readable", async () => {
    const task = await enqueue("resume history");
    const seq = await store.addEvent(task, "read", {
      call: { tool: "sessions.read", sessionId: siri },
      result: { items: [{ content: "Durable earlier fact" }] },
    });
    await store.updateTask(task.id, {
      status: "running",
      lease_owner: "dead-worker",
      lease_until: Date.now() - 1,
      checkpoint: JSON.stringify({ initialized: true, compactedThrough: seq }),
    });
    let calls = 0;
    const result = await run(task, (input) => {
      calls++;
      if (calls === 1) {
        expect(input.compactedEvidence).toMatchObject({
          taskId: task.id,
          through: seq,
        });
        return {
          kind: "read",
          call: {
            tool: "tasks.read",
            taskId: task.id,
            part: "events",
            eventSeq: seq,
          },
        };
      }
      expect(JSON.stringify(input.evidence)).toContain("Durable earlier fact");
      return { kind: "answer", say: "Recovered the earlier fact." };
    });
    expect(result.spoken).toMatch(/Recovered/);
  });
  it("settles two children independently", async () => {
    const task = await enqueue("two children");
    await store.updateTask(task.id, { status: "delegated" });
    for (const id of ["child-one", "child-two"])
      db.prepare(
        "INSERT INTO siri_delegations(email,task_id,session_id,status,id,origin_id) VALUES(?,?,?,'working',?,?)",
      ).run(email, task.id, id, id, task.id);
    await store.settleTaskDelegation(
      email,
      task.id,
      "child-one",
      "First result",
    );
    expect((await store.taskById(email, task.id))!.status).toBe("delegated");
    await store.settleTaskDelegation(
      email,
      task.id,
      "child-two",
      "Second result",
    );
    expect((await store.taskById(email, task.id))!.status).toBe("completed");
  });
});
it("does not execute an unconfirmed plan after recovering its checkpoint", async () => {
  const r = await createRun();
  const task = await enqueue("finish after recovery");
  const confirmation = await run(task, () => ({
    kind: "act",
    say: "Finishing.",
    actions: [{ do: "runs.finish", runId: r.id }],
  }));
  await store.updateTask(task.id, {
    status: "running",
    result: null,
    lease_until: 0,
    lease_owner: "dead",
  });
  const resumed = await run(task, () => {
    throw new Error("must resume the saved confirmation");
  });
  expect(resumed.confirmId).toBe(confirmation.confirmId);
  expect((await rdb.getRunForUser(email, r.id))!.status).toBe("running");
  await store.updateTask(task.id, { status: "cancelled" });
});
it("leaves an interrupted action receipt uncertain instead of executing it twice", async () => {
  const r = await createRun();
  const action = { do: "runs.advance" as const, runId: r.id };
  const inspected = await actions.inspectLocalAction(email, action);
  const req = {
    action,
    mode: "execute" as const,
    operationId: "interrupted",
    expected: inspected.version,
    taskId: "interrupted-task",
  };
  db.prepare("INSERT INTO siri_actions VALUES(?,?,?,'pending',NULL,?)").run(
    email,
    req.operationId,
    JSON.stringify([action, req.expected, req.taskId]),
    new Date().toISOString(),
  );
  const result = await actions.executeOwnedAction(email, req);
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).toContain("uncertain");
  expect((await rdb.getRunForUser(email, r.id))!.current).toBe(1);
});
it("accepts cancellation while another model call is still running", async () => {
  const r = await createRun();
  const task = await enqueue("slow action");
  let resolve!: (s: string) => void;
  const blocked = new Promise<string>((r) => {
    resolve = r;
  });
  await router.pumpContextTasks({ model: async () => blocked });
  await waitFor(
    async () => (await store.taskById(email, task.id))!.status === "running",
  );
  const cancel = await enqueue("cancel the slow task");
  await run(cancel, () => ({ kind: "cancel", taskId: task.id }));
  expect((await store.taskById(email, task.id))!.status).toBe("cancelled");
  resolve(
    JSON.stringify({
      kind: "act",
      say: "Advanced.",
      actions: [{ do: "runs.advance", runId: r.id }],
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  expect((await rdb.getRunForUser(email, r.id))!.current).toBe(1);
});
it("keeps two delegated turns in the same session distinct", async () => {
  const task = await enqueue("two turns");
  await store.updateTask(task.id, { status: "delegated" });
  for (const id of ["delegation-a", "delegation-b"])
    db.prepare(
      "INSERT INTO siri_delegations(email,task_id,session_id,status,id,origin_id) VALUES(?,?,?,'working',?,?)",
    ).run(email, task.id, "same-session", id, task.id);
  await store.settleTaskDelegation(
    email,
    task.id,
    "same-session",
    "First done",
    false,
    "delegation-a",
  );
  expect((await store.taskById(email, task.id))!.status).toBe("delegated");
  await store.settleTaskDelegation(
    email,
    task.id,
    "same-session",
    "Second done",
    false,
    "delegation-b",
  );
  expect((await store.taskById(email, task.id))!.status).toBe("completed");
});
