// Seed the agent marketplace with the "Research" set: four public skills that
// carry the working method (an agent preset itself holds no instructions — it
// bundles skills + engine), plus one published agent preset per skill.
//
// The methods are distilled from the chain-of-evidence research pipeline
// (apps/server/src/research/prompts.ts) into standalone, interactive skills.
//
// Idempotent: re-running rewrites the SKILL.md files and updates the matching
// agents in place, keyed on (owner email, agent name).
//
// Usage (on the server):
//   SKILLS_ROOT=/home/ubuntu/protocol-skills \
//   LABEE_DB=/home/ubuntu/labee/data/labee.sqlite \
//   OWNER=you@example.com node --experimental-sqlite scripts/seed-research-agents.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SKILLS_ROOT = process.env.SKILLS_ROOT || path.join(process.cwd(), "data/skills");
const DB_PATH = process.env.LABEE_DB || path.join(process.cwd(), "data/labee.sqlite");
const OWNER = process.env.OWNER;
if (!OWNER) throw new Error("OWNER (publisher email) is required.");

const EVIDENCE_RULE =
  "Ground every factual statement. Cite literature only by identifiers you actually retrieved " +
  "this session (doi:…, pmid:…, pmcid:…, or a URL you opened) — never from memory, and never " +
  "reconstruct a citation you cannot re-open. When you cannot source a claim, say so plainly " +
  "rather than dressing it up.";

/** The four agents are published as one team: each hands off to the next. */
const TEAM = "ScientistOne Research";

interface Seed {
  skill: string; // folder + frontmatter name
  skillDescription: string;
  body: string;
  agent: string;
  agentDescription: string;
}

const SEEDS: Seed[] = [
  {
    skill: "literature-research",
    skillDescription:
      "Retrieve papers and lab protocols from scholarly sources and turn them into structured, " +
      "citable notes. Use when the user needs a literature survey, background on a method, or " +
      "evidence for a claim. Every note records the identifier it came from so the source can be reopened.",
    body: [
      "# Literature research",
      "",
      EVIDENCE_RULE,
      "",
      "## Method",
      "",
      "1. **Retrieve before writing.** Use `mcp__protocols__search` for protocol/reagent/method",
      "   sources and `mcp__protocols__fetch` with a returned id to read the full text. Use",
      "   WebSearch/WebFetch for everything else. Never summarise a paper you have not opened.",
      "2. **One note per source**, with this shape:",
      "   - `id` — the identifier you fetched (doi:/pmid:/pmcid:/url:)",
      "   - `problem` — what the work is trying to solve",
      "   - `method` — what they actually did",
      "   - `results` — outcomes, with the numbers as reported (metric, value, conditions)",
      "   - `limitations` — what the authors concede, plus what you notice",
      "   - `relevance` — why it matters for the user's question specifically",
      "3. **Separate evidence from inference.** Mark your own synthesis explicitly (e.g.",
      "   \"my inference, not a finding of this paper\") so the user can tell them apart.",
      "4. **Report coverage honestly.** Say how many sources you opened versus how many you found,",
      "   and name the gaps a fuller survey would need to close.",
      "",
      "## Output",
      "",
      "Notes first, then a short synthesis that answers the user's question and cites the note ids",
      "it rests on. If the evidence is thin, lead with that.",
    ].join("\n"),
    agent: "Literature Researcher",
    agentDescription:
      "Surveys the literature and produces structured, citable notes — one per source, each tied to an " +
      "identifier it actually retrieved. Distinguishes findings from its own inference and reports its gaps.",
  },
  {
    skill: "experiment-brief",
    skillDescription:
      "Turn a research question plus source material into a concrete experiment plan: landscape, " +
      "approach, baselines, metrics, and ablations. Use when the user knows what they want to " +
      "investigate but needs a runnable plan with success criteria before committing effort.",
    body: [
      "# Experiment brief",
      "",
      EVIDENCE_RULE,
      "",
      "## Sections to produce",
      "",
      "1. **Landscape** — the techniques that apply and the best known results, each attributed to",
      "   its source. Where a number comes from a different setup than the user's, say so; do not",
      "   present incomparable results as targets.",
      "2. **Plan** — the objective stated so it can fail; candidate approaches; the baseline to beat",
      "   (with where that baseline number comes from); the metric and how it is computed; the",
      "   ablations that would isolate each component's contribution.",
      "3. **Success criteria** — thresholds decided *now*, before any results exist, plus the",
      "   decision rule (e.g. \"median of 5 runs beats the baseline's best of 3\").",
      "4. **Risks and unknowns** — what could invalidate the plan, and the cheapest check that would",
      "   resolve each one. Put the questions that change the whole approach first.",
      "",
      "## Discipline",
      "",
      "- Verify the measurement setup before optimising against it: read the evaluator or scoring",
      "  code if one exists, and state what you confirmed versus what you assumed.",
      "- Prefer a plan that produces an interpretable negative result over one that can only succeed.",
      "- Keep baselines and metrics traceable: a number without a source is a hypothesis, label it as one.",
    ].join("\n"),
    agent: "Experiment Brief Writer",
    agentDescription:
      "Turns a question and its sources into a runnable experiment plan — landscape, baselines with " +
      "provenance, metrics, ablations, and success criteria fixed before any results exist.",
  },
  {
    skill: "experiment-log",
    skillDescription:
      "Implement and iteratively refine a solution while keeping an append-only experimental log " +
      "that records every measured number with its conditions. Use for optimisation work, " +
      "benchmarking, or any task where results must be reproducible and traceable afterwards.",
    body: [
      "# Experimental log discipline",
      "",
      "## The log",
      "",
      "Maintain `experimental_log.md` in the working directory. Every entry is one line:",
      "",
      "```",
      "[NNN] <ISO timestamp> <what you did / what you observed, with exact values>",
      "```",
      "",
      "`NNN` increases monotonically. **Append only** — never rewrite or delete an entry, including",
      "ones that record a failure or a wrong turn. The log is the evidence trail; a tidied log is a",
      "falsified one.",
      "",
      "## What must be logged",
      "",
      "- Every measurement, with its metric name, value, and the conditions it was taken under.",
      "- Baseline reproductions, before any change (you cannot claim an improvement without one).",
      "- Negative results and abandoned approaches, with why they were abandoned.",
      "- Facts you established by reading source/evaluator code, quoted rather than paraphrased.",
      "",
      "## Reporting",
      "",
      "Run measurements more than once and report the spread, not just the best number — then state",
      "the decision rule you are using. When you report any figure to the user, it must already exist",
      "in the log; if you cannot point to the entry, do not report the number.",
    ].join("\n"),
    agent: "Solution Developer",
    agentDescription:
      "Implements and refines solutions while keeping an append-only experimental log of every measured " +
      "number — including failures. Reproduces the baseline first and reports spread, not just best-case.",
  },
  {
    skill: "claim-verification",
    skillDescription:
      "Audit a draft, report, or paper against its own evidence: check that numbers trace to a " +
      "recorded output, citations resolve to real records that support the claim, and method " +
      "descriptions match the implementation. Use before publishing or sharing any result.",
    body: [
      "# Claim verification",
      "",
      "Audit a document claim by claim. Do not rewrite it — report what fails and why.",
      "",
      "## By claim type",
      "",
      "- **Numerical** (\"achieves 87.3%\") — the value must appear in a recorded output: a log entry,",
      "  a results file, a run you can reproduce. Watch for unit and scale mismatches (percent vs",
      "  fraction, ms vs s) before flagging, and for a headline number taken from a different run",
      "  than the one whose code shipped.",
      "- **Citation** (\"Smith et al. showed X\") — the work must exist and actually support the",
      "  specific assertion. A real reference attached to a claim it does not make is still a failure.",
      "- **Methodological** (\"we use a 3-layer MLP\") — must match the implementation. Acceptable",
      "  simplification is fine; a fundamentally different algorithm is not.",
      "- **Conclusion** (\"outperforms by 5%\") — must follow from the supporting claims. Check the",
      "  comparison is fair: same conditions, same metric, baseline measured rather than assumed.",
      "",
      "## Output",
      "",
      "A table of claims with a verdict each (supported / partial / unsupported) and, for every",
      "failure, the specific evidence that contradicts it or the reason none could be found. Finish",
      "with the blocking issues — the ones that must be fixed before the document is shared.",
      "",
      "Flag qualitative overclaims (\"near-optimal\", \"state of the art\") separately: they are rarely",
      "falsifiable but are where unsupported confidence usually hides.",
    ].join("\n"),
    agent: "Claim Verifier",
    agentDescription:
      "Audits a draft against its own evidence — numbers to recorded outputs, citations to records that " +
      "actually support them, methods to code — and reports what blocks publication.",
  },
];

function writeSkill(seed: Seed): string {
  const dir = path.join(SKILLS_ROOT, "_public", seed.skill);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter =
    "---\n" +
    `name: ${seed.skill}\n` +
    "description: >-\n" +
    seed.skillDescription
      .split(/\s+/)
      .reduce<string[]>((lines, word) => {
        const last = lines[lines.length - 1];
        if (last && (last + " " + word).length < 86) lines[lines.length - 1] = last + " " + word;
        else lines.push(word);
        return lines;
      }, [])
      .map((l) => `  ${l}`)
      .join("\n") +
    "\n---\n\n";
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + seed.body + "\n", "utf8");
  return `public--${seed.skill}`;
}

const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

/** The marketplace columns are normally added by the server on boot
 *  (services/db.ts). Add them here too so this script is safe to run against a
 *  database the current server hasn't opened yet. */
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
}
ensureColumn("agents", "is_public", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("agents", "published_at", "TEXT");
ensureColumn("agents", "installs", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("agents", "team", "TEXT");
ensureColumn("agents", "team_order", "INTEGER NOT NULL DEFAULT 0");

for (const [i, seed] of SEEDS.entries()) {
  const order = i + 1; // hand-off position within the team
  const slug = writeSkill(seed);
  const existing = db
    .prepare("SELECT id FROM agents WHERE email = ? AND name = ?")
    .get(OWNER, seed.agent) as { id?: string } | undefined;
  if (existing?.id) {
    db.prepare(
      "UPDATE agents SET description = ?, skill_slugs = ?, is_public = 1, team = ?, team_order = ?, " +
        "published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?",
    ).run(seed.agentDescription, JSON.stringify([slug]), TEAM, order, now, now, existing.id);
    console.log(`updated  ${seed.agent}  (${slug})`);
  } else {
    db.prepare(
      "INSERT INTO agents (id, email, name, description, skill_slugs, working_dir, " +
        "reference_folders, engine, is_public, team, team_order, published_at, installs, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, '', '[]', 'claude', 1, ?, ?, ?, 0, ?, ?)",
    ).run(
      crypto.randomUUID(), OWNER, seed.agent, seed.agentDescription, JSON.stringify([slug]),
      TEAM, order, now, now, now,
    );
    console.log(`created  ${seed.agent}  (${slug})`);
  }
}

console.log("\nmarketplace now lists:");
for (const r of db
  .prepare("SELECT name, team, team_order FROM agents WHERE is_public = 1 ORDER BY (team IS NULL), team, team_order, name")
  .all()) {
  const row = r as { name: string; team: string | null; team_order: number };
  console.log(`  - ${row.team ? `[${row.team} #${row.team_order}] ` : ""}${row.name}`);
}
