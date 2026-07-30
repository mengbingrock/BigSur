// Engine-internal shapes. Wire types live in @labee/contracts (research.ts);
// these are the resolved, fully-defaulted forms the engine actually runs on.
import type {
  EvaluatorSpec,
  ModelTier,
  ResearchStage,
  ResolvedBudget,
  ResolvedGates,
  SeedRef,
} from "@labee/contracts";

/** The frozen spec a run executes — stored verbatim in research_runs.spec_json. */
export interface RunSpec {
  title: string;
  question: string;
  seeds: SeedRef[];
  evaluator: EvaluatorSpec;
  budget: ResolvedBudget;
  gates: ResolvedGates;
  modelTiers: Record<string, ModelTier>;
}

export interface RunRow {
  id: string;
  email: string;
  title: string;
  spec: RunSpec;
  status: string;
  stage: ResearchStage | null;
  workspaceDir: string;
  failReason: string | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Thrown when the user cancels a run; maps to status "cancelled". */
export class RunCancelled extends Error {
  constructor() {
    super("Run cancelled.");
    this.name = "RunCancelled";
  }
}

/** Thrown when a fail-closed gate trips; `code` lands in fail_reason. */
export class RunFailed extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RunFailed";
  }
}

export class GateRejected extends Error {
  constructor(public readonly gate: string) {
    super(`Gate "${gate}" rejected by user.`);
    this.name = "GateRejected";
  }
}
