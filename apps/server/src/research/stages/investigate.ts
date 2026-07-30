// Stage 1 — Problem Investigator. Five sub-stages, per ScientistOne:
// (1) citation-graph crawl from the seeds (OpenAlex, evidence-cached);
// (2) LLM literature filter → Core/Adjacent/Spark/Noise tiers with the
//     fail-closed topic-relevance gate;
// (3) multi-round investigation: PI goal → Librarian picks → parallel
//     Researchers (protocols-MCP full text, notes) → SubdomainWriter →
//     IslandConsolidator;
// (4) per-direction checklist audit with targeted literature refresh;
// (5) Experiment Brief synthesis with a writer↔critic loop.
// Output: stage1/brief.md + brief.refs.json (every reference traceable to a
// cached retrieval), and the winning direction dossier.
import { emitRunEvent } from "../events";
import { hasEvidenceForRef } from "../runsDb";
import { crawlCitationGraph, type CandidatePaper } from "../citationGraph";
import { mapConcurrent, runStructuredTask, type RunCtx } from "../agentTask";
import { clipForPrompt, writeArtifact } from "../workspace";
import { RunFailed } from "../types";
import {
  fsSlug,
  vArray,
  vBoolean,
  vNumber,
  vObject,
  vString,
  vStringArray,
} from "../validate";

const STAGE = "investigate" as const;

export interface PaperNote {
  refId: string;
  title: string;
  fetched: boolean;
  problem: string;
  method: string;
  results: string;
  limitations: string;
  relevance: string;
  keyNumbers: Array<{ metric: string; value: string; context: string }>;
  subtopics: string[];
}

export interface Direction {
  key: string;
  title: string;
  summary: string;
  evidence: string[];
  openQuestions: string[];
  body: string;
  auditPass?: boolean;
  auditScore?: number;
}

export interface InvestigateResult {
  brief: string;
  references: Array<{ refId: string; title: string }>;
  baselines: Array<{ name: string; value: string; source: string }>;
  winningDirection: Direction;
  notes: PaperNote[];
}

type Tier = "core" | "adjacent" | "spark" | "noise";

function tierOf(methodology: number, alignment: number): Tier {
  if (methodology >= 4 && alignment >= 4) return "core";
  if ((methodology >= 4 && alignment >= 3) || (alignment >= 4 && methodology >= 3)) {
    return "adjacent";
  }
  if (methodology >= 3 || alignment >= 3) return "spark";
  return "noise";
}

function candidateLine(c: CandidatePaper & { tier?: Tier; score?: number }): string {
  return `- ${c.refId} (${c.year ?? "n.d."}${c.tier ? `, ${c.tier}` : ""}${
    c.score ? `, score ${c.score}` : ""
  }) ${c.title}${c.abstract ? ` — ${c.abstract.slice(0, 260)}` : ""}`;
}

function noteSummary(n: PaperNote): string {
  return (
    `### ${n.refId} — ${n.title}\n` +
    `problem: ${n.problem}\nmethod: ${n.method}\nresults: ${n.results}\n` +
    `relevance: ${n.relevance}\n` +
    (n.keyNumbers.length
      ? `key numbers: ${n.keyNumbers.map((k) => `${k.metric}=${k.value} (${k.context})`).join("; ")}\n`
      : "") +
    `subtopics: ${n.subtopics.join(", ")}`
  );
}

function directionText(d: Direction): string {
  return (
    `### ${d.key} — ${d.title}\n${d.summary}\nevidence: ${d.evidence.join(", ")}\n` +
    `open questions: ${d.openQuestions.join("; ")}\n\n${d.body}`
  );
}

const validateNote = (u: unknown): PaperNote => {
  const o = vObject(u);
  return {
    refId: vString(o.refId, "refId"),
    title: vString(o.title, "title"),
    fetched: typeof o.fetched === "boolean" ? o.fetched : false,
    problem: vString(o.problem, "problem"),
    method: vString(o.method, "method"),
    results: vString(o.results, "results"),
    limitations: vString(o.limitations, "limitations"),
    relevance: vString(o.relevance, "relevance"),
    keyNumbers: vArray(o.keyNumbers ?? [], "keyNumbers").map((k) => {
      const ko = vObject(k, "keyNumbers[]");
      return {
        metric: vString(ko.metric, "metric"),
        value: String(ko.value ?? ""),
        context: String(ko.context ?? ""),
      };
    }),
    subtopics: vStringArray(o.subtopics ?? [], "subtopics"),
  };
};

const validateDirections = (u: unknown): Direction[] => {
  const o = vObject(u);
  return vArray(o.directions ?? o.keep, "directions").map((d) => {
    const dd = vObject(d, "directions[]");
    return {
      key: fsSlug(vString(dd.key, "key")),
      title: vString(dd.title, "title"),
      summary: vString(dd.summary, "summary"),
      evidence: vStringArray(dd.evidence ?? [], "evidence"),
      openQuestions: vStringArray(dd.openQuestions ?? [], "openQuestions"),
      body: vString(dd.body, "body"),
    };
  });
};

export async function runInvestigateStage(ctx: RunCtx): Promise<InvestigateResult> {
  const { budget, gates } = ctx.spec;
  await emitRunEvent(ctx.runId, "stage_started", { stage: STAGE }, { stage: STAGE });

  // ── 1. citation-graph crawl ───────────────────────────────────────────
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "seeds",
    relPath: "stage1/seeds.json",
    content: JSON.stringify(ctx.spec.seeds, null, 2),
  });
  const { seeds, candidates } = await crawlCitationGraph(
    ctx,
    ctx.spec.seeds.map((s) => s.refId),
    { maxCandidates: budget.maxCandidates },
  );
  if (seeds.length === 0) {
    throw new RunFailed("SEEDS_UNRESOLVED", "None of the seed references resolved on OpenAlex.");
  }
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "candidates",
    relPath: "stage1/candidates.jsonl",
    content: [...seeds, ...candidates].map((c) => JSON.stringify(c)).join("\n"),
  });

  // ── 2. literature filter + fail-closed tier gate ──────────────────────
  const scored: Array<CandidatePaper & { tier: Tier; score: number }> = [];
  const toScore = [...seeds, ...candidates].filter((c) => c.title !== "(untitled)");
  const BATCH = 40;
  const batches: CandidatePaper[][] = [];
  for (let i = 0; i < toScore.length; i += BATCH) batches.push(toScore.slice(i, i + BATCH));
  const batchResults = await mapConcurrent(batches, 3, async (batch) => {
    const prompt =
      `RESEARCH QUESTION:\n${ctx.spec.question}\n\nCANDIDATES (${batch.length}):\n` +
      batch.map(candidateLine).join("\n");
    try {
      const res = await runStructuredTask(
        ctx,
        { stage: STAGE, role: "literature_filter", prompt },
        (u) => {
          const o = vObject(u);
          return vArray(o.scores, "scores").map((s) => {
            const so = vObject(s, "scores[]");
            return {
              refId: vString(so.refId, "refId"),
              methodologyRelevance: vNumber(so.methodologyRelevance, "methodologyRelevance"),
              problemAlignment: vNumber(so.problemAlignment, "problemAlignment"),
            };
          });
        },
      );
      return res as Array<{ refId: string; methodologyRelevance: number; problemAlignment: number }>;
    } catch {
      return []; // a failed batch loses its candidates, not the run
    }
  });
  const scoreByRef = new Map(batchResults.flat().map((s) => [s.refId, s]));
  for (const c of toScore) {
    const s = scoreByRef.get(c.refId);
    if (!s) continue;
    scored.push({
      ...c,
      tier: tierOf(s.methodologyRelevance, s.problemAlignment),
      score: s.methodologyRelevance + s.problemAlignment,
    });
  }
  const coreAdjacent = scored.filter((c) => c.tier === "core" || c.tier === "adjacent");
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "tiers",
    relPath: "stage1/filter/tiers.json",
    content: JSON.stringify(
      {
        counts: {
          core: scored.filter((c) => c.tier === "core").length,
          adjacent: scored.filter((c) => c.tier === "adjacent").length,
          spark: scored.filter((c) => c.tier === "spark").length,
          noise: scored.filter((c) => c.tier === "noise").length,
        },
        scored: scored.map(({ abstract: _a, ...rest }) => rest),
      },
      null,
      2,
    ),
  });
  if (coreAdjacent.length < gates.minCoreAdjacent) {
    await emitRunEvent(
      ctx.runId,
      "gate_failed",
      {
        gate: "TOPIC_RELEVANCE_GATE",
        coreAdjacent: coreAdjacent.length,
        required: gates.minCoreAdjacent,
      },
      { stage: STAGE },
    );
    throw new RunFailed(
      "TOPIC_RELEVANCE_GATE",
      `Only ${coreAdjacent.length} Core+Adjacent papers survived filtering (need ${gates.minCoreAdjacent}). ` +
        "The seeds are too weak to ground this question — refine seeds or question.",
    );
  }
  await emitRunEvent(
    ctx.runId,
    "gate_passed",
    { gate: "TOPIC_RELEVANCE_GATE", coreAdjacent: coreAdjacent.length },
    { stage: STAGE },
  );

  const elitePool = [...scored]
    .sort((a, b) => (a.tier === b.tier ? b.score - a.score : rankTier(a.tier) - rankTier(b.tier)))
    .slice(0, 500);

  // ── 3. multi-round investigation ───────────────────────────────────────
  const notes: PaperNote[] = [];
  let directions: Direction[] = [];
  const readRefs = new Set<string>();

  const readPapers = async (picks: Array<{ refId: string }>, round: number): Promise<void> => {
    const byRef = new Map(elitePool.map((c) => [c.refId, c]));
    const fresh = picks.filter((p) => !readRefs.has(p.refId) && byRef.has(p.refId));
    for (const p of fresh) readRefs.add(p.refId);
    const results = await mapConcurrent(fresh, budget.researcherFanout, async (pick) => {
      const cand = byRef.get(pick.refId)!;
      try {
        const note = await runStructuredTask(
          ctx,
          {
            stage: STAGE,
            role: "researcher",
            branch: `r${round}`,
            prompt:
              `RESEARCH QUESTION:\n${ctx.spec.question}\n\n` +
              `ASSIGNED PAPER: ${cand.refId}\nTITLE: ${cand.title} (${cand.year ?? "n.d."})\n` +
              `ABSTRACT (fallback if fetch fails):\n${cand.abstract || "(none)"}\n\n` +
              `Fetch the full text with mcp__protocols__fetch id="${cand.refId}" ` +
              "(if that exact id fails and a DOI/PMID variant is apparent, try it), then write the note.",
          },
          validateNote,
        );
        return note as PaperNote;
      } catch {
        return null; // a failed read is a skipped note, not a failed run
      }
    });
    for (const note of results) {
      if (!note) continue;
      notes.push(note);
      await writeArtifact({
        runId: ctx.runId,
        workspaceDir: ctx.workspaceDir,
        stage: STAGE,
        kind: "paper_note",
        relPath: `stage1/notes/note_${fsSlug(note.refId)}.md`,
        content:
          `---\nrefId: ${note.refId}\nfetched: ${note.fetched}\n---\n\n# ${note.title}\n\n` +
          `## Problem\n${note.problem}\n\n## Method\n${note.method}\n\n## Results\n${note.results}\n\n` +
          `## Limitations\n${note.limitations}\n\n## Relevance\n${note.relevance}\n\n` +
          `## Key numbers\n${note.keyNumbers.map((k) => `- ${k.metric}: ${k.value} (${k.context})`).join("\n")}\n\n` +
          `## Subtopics\n${note.subtopics.map((s) => `- ${s}`).join("\n")}\n`,
      });
    }
  };

  for (let round = 1; round <= budget.investigationRounds; round++) {
    // PI sets the round goal from the current state.
    let roundGoal = "Broad coverage of the question's core methods and results.";
    try {
      const pi = await runStructuredTask(
        ctx,
        {
          stage: STAGE,
          role: "pi",
          branch: `r${round}`,
          prompt:
            `RESEARCH QUESTION:\n${ctx.spec.question}\n\nROUND ${round}/${budget.investigationRounds}\n\n` +
            `CURRENT DIRECTIONS (${directions.length}):\n` +
            (directions.map((d) => `- ${d.key}: ${d.title} — ${d.summary}`).join("\n") || "(none yet)") +
            `\n\nNOTES SO FAR (${notes.length}):\n` +
            (notes.map((n) => `- ${n.refId}: ${n.title}`).join("\n") || "(none yet)"),
        },
        (u) => {
          const o = vObject(u);
          return {
            roundGoal: vString(o.roundGoal, "roundGoal"),
            lookFor: vStringArray(o.lookFor ?? [], "lookFor"),
          };
        },
      );
      roundGoal = `${pi.roundGoal}\nLook for: ${pi.lookFor.join("; ")}`;
    } catch {
      // PI is advisory; the default goal is fine
    }

    // Librarian picks the papers to read this round.
    const unread = elitePool.filter((c) => !readRefs.has(c.refId));
    if (unread.length === 0) break;
    const picks = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "librarian",
        branch: `r${round}`,
        prompt:
          `RESEARCH QUESTION:\n${ctx.spec.question}\n\nINVESTIGATION GOAL:\n${roundGoal}\n\n` +
          `PICK up to ${budget.researcherFanout} papers to deep-read.\n` +
          `ALREADY READ: ${[...readRefs].join(", ") || "(none)"}\n\nCANDIDATES:\n` +
          clipForPrompt(unread.map(candidateLine).join("\n"), 120_000),
      },
      (u) => {
        const o = vObject(u);
        return vArray(o.picks, "picks").map((p) => ({
          refId: vString(vObject(p, "picks[]").refId, "refId"),
        }));
      },
    );
    await readPapers(picks.slice(0, budget.researcherFanout), round);

    // SubdomainWriter proposes/updates directions from the notes.
    const proposed = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "subdomain_writer",
        branch: `r${round}`,
        prompt:
          `RESEARCH QUESTION:\n${ctx.spec.question}\n\nEXISTING DIRECTIONS:\n` +
          (directions.map(directionText).join("\n\n") || "(none)") +
          `\n\nPAPER NOTES:\n` +
          clipForPrompt(notes.map(noteSummary).join("\n\n"), 160_000),
      },
      validateDirections,
    );

    // IslandConsolidator merges/retires.
    directions = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "island_consolidator",
        branch: `r${round}`,
        prompt:
          `RESEARCH QUESTION:\n${ctx.spec.question}\n\nDOSSIERS (existing + proposed):\n` +
          clipForPrompt(
            [...directions, ...proposed].map(directionText).join("\n\n"),
            160_000,
          ),
      },
      validateDirections,
    );
    for (const d of directions) {
      await writeArtifact({
        runId: ctx.runId,
        workspaceDir: ctx.workspaceDir,
        stage: STAGE,
        kind: "dossier",
        relPath: `stage1/directions/dir_${d.key}.md`,
        content: directionText(d),
      });
    }
    await emitRunEvent(
      ctx.runId,
      "tree_updated",
      { round, notes: notes.length, directions: directions.map((d) => d.key) },
      { stage: STAGE },
    );
  }
  if (directions.length === 0) {
    throw new RunFailed("NO_DIRECTIONS", "Investigation produced no research directions.");
  }

  // ── 4. direction audits + targeted refresh ────────────────────────────
  for (const direction of directions) {
    for (let auditRound = 1; auditRound <= 2; auditRound++) {
      const audit = await runStructuredTask(
        ctx,
        {
          stage: STAGE,
          role: "direction_auditor",
          branch: direction.key,
          prompt:
            `RESEARCH QUESTION:\n${ctx.spec.question}\n\nDOSSIER:\n${directionText(direction)}\n\n` +
            `EVIDENCE NOTES:\n` +
            clipForPrompt(
              notes
                .filter((n) => direction.evidence.includes(n.refId))
                .map(noteSummary)
                .join("\n\n") || "(none of the cited notes exist!)",
              80_000,
            ),
        },
        (u) => {
          const o = vObject(u);
          const scores = vObject(o.scores ?? {}, "scores");
          const total = Object.values(scores).reduce<number>(
            (acc, v) => acc + (typeof v === "number" ? v : 0),
            0,
          );
          return {
            pass: vBoolean(o.pass, "pass"),
            total,
            literatureGaps: vStringArray(o.literatureGaps ?? [], "literatureGaps"),
          };
        },
      );
      await writeArtifact({
        runId: ctx.runId,
        workspaceDir: ctx.workspaceDir,
        stage: STAGE,
        kind: "direction_audit",
        relPath: `stage1/audit/dir_${direction.key}.round${auditRound}.json`,
        content: JSON.stringify(audit, null, 2),
      });
      direction.auditPass = audit.pass;
      direction.auditScore = audit.total;
      if (audit.pass || audit.literatureGaps.length === 0) break;

      // Targeted refresh: read a few more papers aimed at the audit's gaps.
      const unread = elitePool.filter((c) => !readRefs.has(c.refId));
      if (unread.length === 0) break;
      try {
        const picks = await runStructuredTask(
          ctx,
          {
            stage: STAGE,
            role: "librarian",
            branch: direction.key,
            prompt:
              `TARGETED REFRESH for direction "${direction.title}". ` +
              `GAPS TO FILL:\n${audit.literatureGaps.map((g) => `- ${g}`).join("\n")}\n\n` +
              `PICK up to 3 papers.\nCANDIDATES:\n` +
              clipForPrompt(unread.map(candidateLine).join("\n"), 100_000),
          },
          (u) => {
            const o = vObject(u);
            return vArray(o.picks, "picks").map((p) => ({
              refId: vString(vObject(p, "picks[]").refId, "refId"),
            }));
          },
        );
        await readPapers(picks.slice(0, 3), 90 + auditRound);
      } catch {
        break;
      }
    }
  }
  const passing = directions.filter((d) => d.auditPass);
  const ranked = (passing.length > 0 ? passing : directions).sort(
    (a, b) => (b.auditScore ?? 0) - (a.auditScore ?? 0),
  );
  const winner = ranked[0]!;
  if (passing.length === 0) {
    await emitRunEvent(
      ctx.runId,
      "gate_failed",
      { gate: "DIRECTION_AUDIT", note: "no direction passed; proceeding with best-scoring" },
      { stage: STAGE },
    );
  }

  // ── 5. experiment brief: writer ↔ critic loop ─────────────────────────
  const retrievedNotes = notes.filter(
    (n) => winner.evidence.includes(n.refId) || n.subtopics.length > 0,
  );
  let brief = "";
  let references: Array<{ refId: string; title: string }> = [];
  let baselines: Array<{ name: string; value: string; source: string }> = [];
  let criticIssues = "";
  for (let round = 1; round <= budget.briefCriticRounds; round++) {
    const written = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "brief_writer",
        branch: `brief-r${round}`,
        prompt:
          `RESEARCH QUESTION:\n${ctx.spec.question}\n\nWINNING DIRECTION:\n${directionText(winner)}\n\n` +
          `ALLOWED REF IDS (cite nothing outside this list):\n${notes.map((n) => n.refId).join(", ")}\n\n` +
          `PAPER NOTES:\n${clipForPrompt(retrievedNotes.map(noteSummary).join("\n\n"), 140_000)}\n\n` +
          (round > 1
            ? `PREVIOUS BRIEF:\n${clipForPrompt(brief, 60_000)}\n\nCRITIC ISSUES TO FIX:\n${criticIssues}`
            : "(first draft)"),
      },
      (u) => {
        const o = vObject(u);
        return {
          brief: vString(o.brief, "brief"),
          references: vArray(o.references ?? [], "references").map((r) => {
            const ro = vObject(r, "references[]");
            return { refId: vString(ro.refId, "refId"), title: String(ro.title ?? "") };
          }),
          baselines: vArray(o.baselines ?? [], "baselines").map((b) => {
            const bo = vObject(b, "baselines[]");
            return {
              name: vString(bo.name, "name"),
              value: String(bo.value ?? ""),
              source: String(bo.source ?? "assumption"),
            };
          }),
        };
      },
    );
    brief = written.brief;
    references = written.references;
    baselines = written.baselines;

    const critique = await runStructuredTask(
      ctx,
      {
        stage: STAGE,
        role: "brief_critic",
        branch: `brief-r${round}`,
        prompt:
          `RESEARCH QUESTION:\n${ctx.spec.question}\n\nALLOWED REF IDS:\n` +
          `${notes.map((n) => n.refId).join(", ")}\n\nBRIEF:\n${clipForPrompt(brief, 120_000)}`,
      },
      (u) => {
        const o = vObject(u);
        return {
          pass: vBoolean(o.pass, "pass"),
          issues: vArray(o.issues ?? [], "issues").map((i) => JSON.stringify(i)),
        };
      },
    );
    if (critique.pass) break;
    criticIssues = critique.issues.join("\n");
  }

  // Retrieval-only references: drop any ref without cached evidence.
  const verifiedRefs: Array<{ refId: string; title: string }> = [];
  const droppedRefs: string[] = [];
  for (const ref of references) {
    if (await hasEvidenceForRef(ctx.runId, ref.refId)) verifiedRefs.push(ref);
    else droppedRefs.push(ref.refId);
  }
  if (droppedRefs.length > 0) {
    await emitRunEvent(
      ctx.runId,
      "claim_checked",
      { check: "brief_references", dropped: droppedRefs },
      { stage: STAGE },
    );
  }

  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "brief",
    relPath: "stage1/brief.md",
    content: brief,
  });
  await writeArtifact({
    runId: ctx.runId,
    workspaceDir: ctx.workspaceDir,
    stage: STAGE,
    kind: "brief_refs",
    relPath: "stage1/brief.refs.json",
    content: JSON.stringify({ references: verifiedRefs, baselines, dropped: droppedRefs }, null, 2),
  });
  await emitRunEvent(ctx.runId, "stage_finished", { stage: STAGE }, { stage: STAGE });
  return { brief, references: verifiedRefs, baselines, winningDirection: winner, notes };
}

function rankTier(tier: Tier): number {
  return tier === "core" ? 0 : tier === "adjacent" ? 1 : tier === "spark" ? 2 : 3;
}
