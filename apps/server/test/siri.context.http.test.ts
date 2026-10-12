import { beforeAll, afterAll, it, expect } from "vitest";
import { applyTestEnv, waitFor } from "./helpers/env";
import { startServer, type TestServer } from "./helpers/server";
let server: TestServer;
let cookie: string;
const email = "context-http@example.com";
beforeAll(async () => {
  applyTestEnv("context-http");
  const { sealSession } = await import("../src/services/session");
  cookie = `monterey_session=${encodeURIComponent(await sealSession({ email }))}`;
  server = await startServer({
    LABEE_DATA_DIR: process.env.LABEE_DATA_DIR!,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    LABEE_MODE: "server",
    LABEE_ANTHROPIC_API_KEY: "test-placeholder-never-sent",
    LABEE_SIRI_CONTEXT: "1",
    LABEE_SIRI_SPOKEN_MS: "100",
    FAKE_CLAUDE_DELAY_MS: "500",
  });
});
afterAll(() => server?.stop());
const post = (path: string, body: unknown, auth = true) =>
  fetch(`${server.base}${path}`, {
    method: "POST",
    headers: {
      ...(auth ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
it("authenticates context tools and runs repeated tool calls over the actual HTTP/provider path", async () => {
  const sdb = await import("../src/services/sessions/db");
  const s = await sdb.createSession({ email, title: "Historical experiment" });
  await sdb.appendMessage(
    s.id,
    null,
    "user",
    "Corrected neon amount is seven milliliters.",
  );
  expect(
    (
      await post(
        "/api/context",
        { tool: "sessions.search", query: "neon" },
        false,
      )
    ).status,
  ).toBe(401);
  const search = await (
    await post("/api/context", { tool: "sessions.search", query: "neon" })
  ).json();
  expect(search.items[0]).toMatchObject({ sessionId: s.id });
  const body = {
    text: "Find the corrected amount [[context-neon]]",
    requestId: "http-retry",
  };
  let answer = await (await post("/api/siri/say", body)).json();
  await waitFor(async () => {
    answer = await (await post("/api/siri/say", body)).json();
    return answer.status === "answered";
  }, 10000);
  expect(answer.spoken).toBe("Corrected neon amount is seven milliliters.");
  const duplicate = await (await post("/api/siri/say", body)).json();
  expect(duplicate).toEqual(answer);
  const db = await (await import("../src/services/db")).getDb();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM siri_requests WHERE email=? AND request_id='http-retry'",
      )
      .get(email)!.n,
  ).toBe(1);
});
it("preserves a late confirmation as a question with its confirmation ID", async () => {
  const sdb = await import("../src/services/sessions/db");
  const { createRun } = await import("../src/services/runs/service");
  const { parseProtocol } = await import("../src/services/runs/parse");
  const s = await sdb.createSession({ email, title: "Late run" });
  const r = await createRun({
    email,
    sessionId: s.id,
    hostId: null,
    protocolSlug: "late",
    protocolName: "Late",
    snapshot: parseProtocol("# Late\n## Steps\n1. Mix.\n2. Wait."),
  });
  const plan = {
    kind: "act",
    say: "Finishing.",
    actions: [{ do: "runs.finish", runId: r.id }],
  };
  const body = {
    text: `Finish [[slow]] [[reply:${JSON.stringify(plan)}]]`,
    requestId: "late-confirm",
  };
  const first = await (await post("/api/siri/say", body)).json();
  expect(first.status).toBe("working");
  let result: any;
  await waitFor(async () => {
    result = await (await post("/api/siri/say", body)).json();
    if (result.status === "answered")
      throw new Error(JSON.stringify({ result, logs: server.logs.slice(-10) }));
    return result.status === "confirm";
  }, 10000);
  expect(result.confirmId).toBeTruthy();
  const db = await (await import("../src/services/db")).getDb();
  await waitFor(
    async () =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM chat_session_messages WHERE json_extract(meta,'$.confirmId')=? AND json_extract(meta,'$.kind')='return'",
          )
          .get(result.confirmId),
      ),
    10000,
  );
  const row = db
    .prepare(
      "SELECT meta FROM chat_session_messages WHERE json_extract(meta,'$.confirmId')=? AND json_extract(meta,'$.kind')='return'",
    )
    .get(result.confirmId)!;
  expect(JSON.parse(String(row.meta)).asks.options).toEqual(["Yes", "No"]);
}, 20000);
