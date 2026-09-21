// Role registry: how each sub-agent role maps onto one claude CLI invocation.
// Pure-LLM roles run with no tools; agentic roles get the default toolset
// minus everything that would break the chain-of-evidence (web access) or the
// pipeline's autonomy (AskUserQuestion). Only solver/ablation may write files.
import type { ModelTier, ResearchRole } from "@labee/contracts";
import * as prompts from "./prompts";

export interface RoleConfig {
  systemPrompt: string;
  tier: ModelTier;
  /** "" = pure LLM call; "default" = agentic toolset (minus disallowed). */
  tools: "" | "default";
  disallowedTools: readonly string[];
  /** Wire the protocols MCP server (literature retrieval) into this role. */
  protocolsMcp: boolean;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
}

const MIN = 60_000;
/** Opus can spend several minutes in extended thinking before emitting text.
 * Keep every role above the old short-task limits so valid subscription turns
 * are not killed while they are still reasoning. Long-running solver roles
 * retain their larger existing allowance. */
const MIN_ROLE_TIMEOUT_MIN = 30;

const timeoutMs = (timeoutMin: number): number =>
  Math.max(timeoutMin, MIN_ROLE_TIMEOUT_MIN) * MIN;

/** Tools always denied to agentic research roles: the pipeline is
 *  non-interactive, and all knowledge must flow through cached retrievals. */
const AGENT_DENY = ["AskUserQuestion", "WebSearch", "WebFetch", "Task", "Skill"] as const;
/** Additionally denied to read-only agentic roles (researcher). */
const READONLY_DENY = [...AGENT_DENY, "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] as const;

const pure = (systemPrompt: string, effort: RoleConfig["effort"], timeoutMin: number): RoleConfig => ({
  systemPrompt,
  tier: "opus",
  tools: "",
  disallowedTools: [],
  protocolsMcp: false,
  effort,
  timeoutMs: timeoutMs(timeoutMin),
});

export const ROLES: Record<ResearchRole, RoleConfig> = {
  echo: pure(prompts.ECHO_PROMPT, "low", 3),

  // stage 1
  literature_filter: pure(prompts.LITERATURE_FILTER_PROMPT, "low", 6),
  librarian: pure(prompts.LIBRARIAN_PROMPT, "medium", 6),
  researcher: {
    systemPrompt: prompts.RESEARCHER_PROMPT,
    tier: "opus",
    tools: "default",
    disallowedTools: READONLY_DENY,
    protocolsMcp: true,
    effort: "medium",
    timeoutMs: timeoutMs(15),
  },
  pi: pure(prompts.PI_PROMPT, "high", 10),
  subdomain_writer: pure(prompts.SUBDOMAIN_WRITER_PROMPT, "medium", 12),
  island_consolidator: pure(prompts.ISLAND_CONSOLIDATOR_PROMPT, "medium", 10),
  direction_auditor: pure(prompts.DIRECTION_AUDITOR_PROMPT, "high", 10),
  brief_writer: pure(prompts.BRIEF_WRITER_PROMPT, "high", 20),
  brief_critic: pure(prompts.BRIEF_CRITIC_PROMPT, "high", 10),

  // stage 2
  ideator: pure(prompts.IDEATOR_PROMPT, "high", 12),
  solver: {
    systemPrompt: prompts.SOLVER_PROMPT,
    tier: "opus",
    tools: "default",
    disallowedTools: AGENT_DENY,
    protocolsMcp: false,
    effort: "high",
    timeoutMs: timeoutMs(45),
  },
  report_writer: pure(prompts.REPORT_WRITER_PROMPT, "medium", 10),
  evaluator_rubric: pure(prompts.EVALUATOR_RUBRIC_PROMPT, "medium", 8),
  ablation: {
    systemPrompt: prompts.ABLATION_PROMPT,
    tier: "opus",
    tools: "default",
    disallowedTools: AGENT_DENY,
    protocolsMcp: false,
    effort: "high",
    timeoutMs: timeoutMs(45),
  },

  // stage 3
  conceive: pure(prompts.CONCEIVE_PROMPT, "high", 20),
  critic: pure(prompts.CRITIC_PROMPT, "high", 12),
  resolver: pure(prompts.RESOLVER_PROMPT, "high", 20),
  composer_section: pure(prompts.COMPOSER_SECTION_PROMPT, "medium", 10),
  entailment_judge: pure(prompts.ENTAILMENT_JUDGE_PROMPT, "low", 4),
};

/** Effective model for a role: the run's per-role override, else the default. */
export function roleModel(
  role: ResearchRole,
  overrides: Record<string, ModelTier> | undefined,
): ModelTier {
  return overrides?.[role] ?? ROLES[role].tier;
}
