// `bun run eval` — run the retrieval harness and print the report.
//
//   LABEE_EMBED_PROVIDER=fake bun run eval          offline, deterministic
//   bun run eval                                     real embeddings (needs an
//                                                    OpenAI key in the env)
//   bun run eval -- --ask                            also exercise Ask
//
// Uses a throwaway data directory unless LABEE_DATA_DIR / SKILLS_ROOTS are
// set, so it never touches a real library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "labee-eval-"));
process.env.LABEE_DATA_DIR ??= path.join(scratch, "data");
process.env.DECK_ROOT ??= path.join(scratch, "decks");
process.env.SKILLS_ROOTS ??= path.join(scratch, "skills");
process.env.SESSION_PASSWORD ??= "eval-password-at-least-32-chars-long!!";
if (!process.env.LABEE_EMBED_PROVIDER && !process.env.OPENAI_API_KEY && !process.env.LABEE_OPENAI_API_KEY) {
  process.env.LABEE_EMBED_PROVIDER = "fake";
}
fs.mkdirSync(process.env.SKILLS_ROOTS, { recursive: true });

const { runEval, loadQuestions, formatReport } = await import("./run");
const report = await runEval("eval@labee.local", loadQuestions(), { ask: process.argv.includes("--ask") });
console.log(formatReport(report));
