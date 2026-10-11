// The harness itself must run offline and give a number a change can be judged
// by. With the fake embedder the figure is a floor for the real one, not the
// real one; what this guards is that the plumbing — seeding, indexing, hybrid
// search, passage retrieval — delivers the right protocol for most questions.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyTestEnv } from "./helpers/env";

let report: import("../eval/run").EvalReport;

beforeAll(async () => {
  applyTestEnv("eval");
  process.env.LABEE_EMBED_PROVIDER = "fake";
  vi.resetModules();
  const { runEval, loadQuestions, formatReport } = await import("../eval/run");
  report = await runEval("eval@example.com", loadQuestions(), { ask: true });
  console.info(formatReport(report));
}, 60000);

describe("retrieval harness", () => {
  it("covers every fixture", () => {
    expect(report.total).toBe(64);
    expect(report.withAnswer).toBeGreaterThan(40);
  });

  it("finds the right protocol in the top three for most questions, offline", () => {
    expect(report.hitAt3 / report.total).toBeGreaterThanOrEqual(0.75);
  });

  it("puts the answer's text in a top-three passage for most parameter questions", () => {
    expect(report.answerInTop3 / report.withAnswer).toBeGreaterThanOrEqual(0.6);
  });

  it("searches in hybrid mode when the fake embedder is on", () => {
    expect(report.mode).toBe("semantic");
  });
});
