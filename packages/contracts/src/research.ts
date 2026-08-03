import { Schema } from "effect";

// ── Research runs (ScientistOne-style multi-agent pipeline) ────────────────
// A run walks three stages — investigate (literature grounding), discover
// (parallel explore-exploit solving), write (claim-grounded composition) —
// plus a final verify pass. Stages communicate via file-backed artifacts in
// the run workspace; every factual claim in the output traces to a recorded
// evidence source (chain-of-evidence).

export const ResearchStage = Schema.Literals(["investigate", "discover", "write", "verify"]);
export type ResearchStage = typeof ResearchStage.Type;

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "awaiting_gate",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = typeof RunStatus.Type;

/** Sub-agent roles, each one CLI invocation shape (prompt, model tier, tools). */
export const ResearchRole = Schema.Literals([
  "echo", // M1 smoke-test role: one trivial task producing one artifact
  // stage 1 — problem investigator
  "literature_filter",
  "librarian",
  "researcher",
  "pi",
  "subdomain_writer",
  "island_consolidator",
  "direction_auditor",
  "brief_writer",
  "brief_critic",
  // stage 2 — discovery
  "ideator",
  "solver",
  "report_writer",
  "evaluator_rubric",
  "ablation",
  // stage 3 — writer + verification
  "conceive",
  "critic",
  "resolver",
  "composer_section",
  "entailment_judge",
]);
export type ResearchRole = typeof ResearchRole.Type;

/** A literature seed: a stable retrievable id (doi:… | pmid:… | pmcid:… |
 *  openalex:W… | url:…) plus an optional display title. */
export const SeedRef = Schema.Struct({
  refId: Schema.String,
  title: Schema.optional(Schema.String),
});
export type SeedRef = typeof SeedRef.Type;

/** Golden evaluator for Stage 2. "command" runs in the solution node's
 *  workspace; its last stdout line must be `{"score": <number>, ...}`.
 *  "none" degrades to LLM-rubric scoring (PEE pruning only — the final paper
 *  must label quantitative outcomes as unverified). */
export const EvaluatorSpec = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("command"),
    command: Schema.String,
    timeoutMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type EvaluatorSpec = typeof EvaluatorSpec.Type;

/** Loop bounds and fan-out knobs. All optional on the wire; the server fills
 *  DEFAULT_RUN_BUDGET. Base config mirrors ScientistOne (I=5,B=5,K=2,E=4). */
export const RunBudget = Schema.Struct({
  /** PEE iterations (I). */
  iterations: Schema.optional(Schema.Number),
  /** PEE parallel branches (B). */
  branches: Schema.optional(Schema.Number),
  /** Branches retained per iteration (K). */
  keepK: Schema.optional(Schema.Number),
  /** Max evaluated solution versions per node (E). */
  evalsPerNode: Schema.optional(Schema.Number),
  /** Parallel researcher agents per investigation round. */
  researcherFanout: Schema.optional(Schema.Number),
  investigationRounds: Schema.optional(Schema.Number),
  briefCriticRounds: Schema.optional(Schema.Number),
  /** Ground→Critic→Resolve rounds before plateau/convergence stop. */
  writerRounds: Schema.optional(Schema.Number),
  maxConcurrentAgents: Schema.optional(Schema.Number),
  /** Fail the run closed when accumulated CLI cost exceeds this. */
  maxCostUsd: Schema.optional(Schema.Number),
  /** Candidate-paper cap for the citation-graph crawl. */
  maxCandidates: Schema.optional(Schema.Number),
  /** Target paper notes across investigation rounds. */
  targetNotes: Schema.optional(Schema.Number),
});
export type RunBudget = typeof RunBudget.Type;

export interface ResolvedBudget {
  iterations: number;
  branches: number;
  keepK: number;
  evalsPerNode: number;
  researcherFanout: number;
  investigationRounds: number;
  briefCriticRounds: number;
  writerRounds: number;
  maxConcurrentAgents: number;
  maxCostUsd: number | null;
  maxCandidates: number;
  targetNotes: number;
}

export const DEFAULT_RUN_BUDGET: ResolvedBudget = {
  iterations: 5,
  branches: 5,
  keepK: 2,
  evalsPerNode: 4,
  researcherFanout: 5,
  investigationRounds: 3,
  briefCriticRounds: 5,
  writerRounds: 2,
  maxConcurrentAgents: 4,
  maxCostUsd: null,
  maxCandidates: 5000,
  targetNotes: 100,
};

/** Fail-closed quality gates. Aborting beats emitting ungrounded output. */
export const RunGates = Schema.Struct({
  /** Stage 1 tier gate: abort when fewer Core+Adjacent papers survive filtering. */
  minCoreAdjacent: Schema.optional(Schema.Number),
  /** Stage 3 Ground gate: abort when supported/total falls below this. */
  groundingRatioMin: Schema.optional(Schema.Number),
  /** Relative tolerance for numerical claim verification. */
  numericTolerance: Schema.optional(Schema.Number),
  /** Pause the run for explicit user approval at these checkpoints. */
  approveAfterBrief: Schema.optional(Schema.Boolean),
  approveBeforeWrite: Schema.optional(Schema.Boolean),
});
export type RunGates = typeof RunGates.Type;

export interface ResolvedGates {
  minCoreAdjacent: number;
  groundingRatioMin: number;
  numericTolerance: number;
  approveAfterBrief: boolean;
  approveBeforeWrite: boolean;
}

export const DEFAULT_RUN_GATES: ResolvedGates = {
  minCoreAdjacent: 5,
  groundingRatioMin: 0.85,
  numericTolerance: 0.01,
  approveAfterBrief: true,
  approveBeforeWrite: false,
};

export const ModelTier = Schema.Literals(["opus", "sonnet", "haiku"]);
export type ModelTier = typeof ModelTier.Type;

/** Body of POST /api/research/runs. */
export const CreateRunRequest = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** The research question / task specification. */
  question: Schema.String,
  /** 1–4 seed references anchoring the literature crawl. */
  seeds: Schema.Array(SeedRef),
  evaluator: Schema.optional(EvaluatorSpec),
  budget: Schema.optional(RunBudget),
  gates: Schema.optional(RunGates),
  /** Per-role model-tier overrides, e.g. { solver: "opus" }. */
  modelTiers: Schema.optional(Schema.Record(Schema.String, ModelTier)),
});
export type CreateRunRequest = typeof CreateRunRequest.Type;

export const ResearchRunSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  question: Schema.String,
  status: RunStatus,
  stage: Schema.NullOr(ResearchStage),
  failReason: Schema.NullOr(Schema.String),
  costUsd: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type ResearchRunSummary = typeof ResearchRunSummary.Type;

export const ResearchTaskRecord = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  stage: ResearchStage,
  role: Schema.String,
  branch: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "cancelled"]),
  model: Schema.NullOr(Schema.String),
  outputPath: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});
export type ResearchTaskRecord = typeof ResearchTaskRecord.Type;

/** One multiplexed run event on the SSE wire (event name: "run_event").
 *  `seq` is 0 for live-only delta events, which are never persisted. */
export const ResearchEventType = Schema.Literals([
  "run_status",
  "stage_started",
  "stage_finished",
  "task_started",
  "task_finished",
  "gate_waiting",
  "gate_passed",
  "gate_failed",
  "artifact_created",
  "evidence_cached",
  "claim_checked",
  "eval_scored",
  "tree_updated",
  "agent_delta",
  "agent_tool",
  "error",
]);
export type ResearchEventType = typeof ResearchEventType.Type;

export const ResearchEventEnvelope = Schema.Struct({
  seq: Schema.Number,
  runId: Schema.String,
  ts: Schema.String,
  type: ResearchEventType,
  stage: Schema.NullOr(ResearchStage),
  role: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  data: Schema.Unknown,
});
export type ResearchEventEnvelope = typeof ResearchEventEnvelope.Type;

export const ArtifactRecord = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  stage: ResearchStage,
  kind: Schema.String,
  relPath: Schema.String,
  producedByTask: Schema.NullOr(Schema.String),
  sha256: Schema.String,
  bytes: Schema.Number,
  meta: Schema.NullOr(Schema.Unknown),
  createdAt: Schema.String,
});
export type ArtifactRecord = typeof ArtifactRecord.Type;

export const EvidenceRecord = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  sourceTool: Schema.String,
  refId: Schema.NullOr(Schema.String),
  relPath: Schema.String,
  createdAt: Schema.String,
});
export type EvidenceRecord = typeof EvidenceRecord.Type;

export const ClaimType = Schema.Literals([
  "numerical",
  "citation",
  "methodological",
  "unsourced",
  "malformed",
]);
export type ClaimType = typeof ClaimType.Type;

export const ClaimStatus = Schema.Literals(["supported", "partial", "unsupported", "dropped"]);
export type ClaimStatus = typeof ClaimStatus.Type;

export const ClaimRecord = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  artifactId: Schema.String,
  claimType: ClaimType,
  text: Schema.String,
  sourceTag: Schema.String,
  status: ClaimStatus,
  breakCode: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.Unknown),
  checkedAt: Schema.NullOr(Schema.String),
});
export type ClaimRecord = typeof ClaimRecord.Type;
