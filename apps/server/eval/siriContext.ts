/** Opt-in live model eval. Synthetic data only; never opens the user's DB.
 * Run: bun run apps/server/eval/siriContext.ts --live
 * Requires the already authenticated Claude CLI. Does not execute mutations. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to use the authenticated Claude CLI.");
const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const modelId = arg("--model", "haiku");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "labee-siri-live-"));
process.env.LABEE_DATA_DIR = path.join(root, "data");
process.env.DECK_ROOT = path.join(root, "decks");
process.env.SKILLS_ROOTS = path.join(root, "skills");
process.env.LABEE_SEED_PROTOCOLS = "false";
process.env.LABEE_SIRI_CONTEXT = "0";
delete process.env.LABEE_DB_PATH;
const [
  { CONTEXT_SYSTEM, pumpContextTasks },
  store,
  sdb,
  { ensureSiriSession },
  { getDb },
] = await Promise.all([
  import("../src/services/siri/contextRouter"),
  import("../src/services/siri/store"),
  import("../src/services/sessions/db"),
  import("../src/services/siri/router"),
  import("../src/services/db"),
]);
const email = "synthetic-siri-eval@example.invalid";
const siri = await ensureSiriSession(email);
for (let i = 0; i < 1000; i++)
  await sdb.appendMessage(
    siri.id,
    null,
    "user",
    i === 2
      ? "For cobalt preparation we agreed on 37 degrees Celsius."
      : i === 50
        ? "Correction for cobalt preparation: use 42 degrees Celsius, not 37. This is the final temperature."
        : `Unrelated transcript item ${i}.`,
  );
const older = await sdb.createSession({
  email,
  title: "Archived nickel comparison",
});
await sdb.appendMessage(
  older.id,
  null,
  "user",
  "The nickel comparison uses lot K27 because lot K19 failed the purity check.",
);
await sdb.updateSession(older.id, { archived: true });
for (let i = 0; i < 210; i++)
  await sdb.createSession({ email, title: `Recent unrelated session ${i}` });
const { upsertLibraryProtocol } = await import("../src/services/library/store");
const { bioProHierarchy } = await import("../src/services/protocolHierarchy");
await upsertLibraryProtocol({ id: "synthetic-violet", source: "synthetic", sourceUrl: "https://example.invalid/violet", license: "synthetic fixture", title: "Violet sensor calibration", description: "Calibration of a simulated sensor.", domains: [], keywords: [], body: "", hierarchy: bioProHierarchy({ "1": { title: "Calibration", text: "Use the amber reference only after the indicator turns green.", "1.1": "Set the simulated dial to 17.", "1.2": "Wait for the green indicator.", "1.3": "Apply the amber reference.", "1.4": "Record the displayed code Z42." } }) });
await upsertLibraryProtocol({ id: "synthetic-distractor", source: "synthetic", sourceUrl: "https://example.invalid/other", license: "synthetic fixture", title: "Old violet sensor worksheet", description: "Violet sensor calibration reference", domains: [], keywords: [], body: "## Calibration\n1. Set dial to 99 and apply blue reference." });
const cases: Array<{ name: string; request: string; expectedSession?: string; expectedProtocol?: string; expected: RegExp }> = [
  {
    name: "own-history-correction",
    request: "What final temperature did we agree for cobalt preparation?",
    expectedSession: siri.id,
    expected: /42|forty.two/i,
  },
  {
    name: "archived-cross-session",
    request: "In the old nickel comparison, which lot did we choose and why?",
    expectedSession: older.id,
    expected: /K.?27|kay.?twenty.?seven/i,
  },
  { name: "named-protocol-parameter", request: "In the protocol Violet sensor calibration, what value should I set the simulated dial to?", expectedProtocol: "library:synthetic-violet", expected: /17|seventeen/i },
  { name: "named-protocol-condition", request: "According to Violet sensor calibration, when may I apply the amber reference?", expectedProtocol: "library:synthetic-violet", expected: /green/i },
  { name: "named-protocol-order", request: "In Violet sensor calibration, what happens immediately after applying the amber reference?", expectedProtocol: "library:synthetic-violet", expected: /Z.?42|record.*code/i },
];
let calls = 0;
async function model(
  _: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (++calls > 48) throw new Error("Live evaluation call budget exceeded.");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN || "claude",
      [
        "-p",
        JSON.stringify(input),
        "--system-prompt",
        CONTEXT_SYSTEM,
        "--model",
        modelId,
        "--tools",
        "",
        "--output-format",
        "text",
        "--no-session-persistence",
      ],
      { stdio: ["ignore", "pipe", "pipe"], cwd: "/private/tmp" },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Live model timed out."));
    }, 60000);
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              err.slice(-1000) || out.slice(-1000) || `Claude exited ${code}`,
            ),
          );
    });
  });
}
const report: {
  date: string;
  model: string;
  cases: unknown[];
  calls?: number;
} = {
  date: new Date().toISOString(),
  model: modelId,
  cases: [],
};
for (const test of cases) {
  const started = Date.now();
  const task = await store.enqueue(
    email,
    siri.id,
    test.request,
    "eval",
    test.name,
    test.request,
  );
  for (;;) {
    await pumpContextTasks({ model });
    const current = await store.taskById(email, task.id);
    if (current?.result) {
      const result = JSON.parse(current.result);
      const db = await getDb();
      const reads = db
        .prepare(
          "SELECT data FROM siri_task_events WHERE task_id=? AND kind='read' ORDER BY id",
        )
        .all(task.id)
        .map((r) => JSON.parse(String(r.data)));
      const hasSource = reads.some(
        (r) =>
          (test.expectedProtocol ? r.call.protocolSlug === test.expectedProtocol && r.call.tool === "protocols.read" : r.call.sessionId === test.expectedSession && ["messages.read", "sessions.read"].includes(r.call.tool)),
      );
      report.cases.push({
        name: test.name,
        passed: test.expected.test(result.spoken) && hasSource,
        expectedSession: test.expectedSession,
        expectedProtocol: test.expectedProtocol,
        spoken: result.spoken,
        readCalls: reads.map((r) => r.call),
        elapsedMs: Date.now() - started,
      });
      console.log(JSON.stringify(report.cases.at(-1)));
      break;
    }
    if (Date.now() - started > 180000)
      throw new Error("Evaluation exceeded three minutes.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
report.calls = calls;
fs.writeFileSync(
  path.resolve(arg("--out", "docs/siri-context-live-evaluation.json")),
  JSON.stringify(report, null, 2) + "\n",
);
process.exitCode = report.cases.every((c) => (c as { passed: boolean }).passed)
  ? 0
  : 1;
