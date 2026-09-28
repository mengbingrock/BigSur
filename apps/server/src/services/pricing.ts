// Token → cost pricing for metered "Labee Provided" inference. Prices are in
// US cents per 1,000,000 tokens and mirror the public vendor list prices; a
// global margin multiplier (LABEE_USAGE_MARGIN, default 1 = at cost) is applied
// on top. Matching is by substring on the request's model id, so new point
// releases (e.g. claude-opus-4-9) inherit the family's price automatically.

interface Rate {
  /** cents per 1M input tokens */
  input: number;
  /** cents per 1M output tokens */
  output: number;
}

// Ordered most-specific → least-specific; first substring match wins.
const TABLE: Array<{ match: string; rate: Rate }> = [
  // Anthropic
  { match: "haiku", rate: { input: 80, output: 400 } },
  { match: "sonnet", rate: { input: 300, output: 1500 } },
  { match: "opus", rate: { input: 1500, output: 7500 } },
  // OpenAI
  { match: "gpt-4o-mini", rate: { input: 15, output: 60 } },
  { match: "gpt-4o", rate: { input: 250, output: 1000 } },
  { match: "gpt-4.1-mini", rate: { input: 40, output: 160 } },
  { match: "gpt-4.1", rate: { input: 200, output: 800 } },
  { match: "o4-mini", rate: { input: 110, output: 440 } },
  { match: "o3-mini", rate: { input: 110, output: 440 } },
  { match: "o3", rate: { input: 200, output: 800 } },
  { match: "o1-mini", rate: { input: 110, output: 440 } },
  { match: "o1", rate: { input: 1500, output: 6000 } },
];

// Fallback for an unrecognised model — priced as a mid-tier (Sonnet) model so
// an unknown model is never billed as free.
const DEFAULT_RATE: Rate = { input: 300, output: 1500 };

function margin(): number {
  const n = Number.parseFloat(process.env.LABEE_USAGE_MARGIN ?? "");
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function rateFor(model: string | undefined | null): Rate {
  const m = (model ?? "").toLowerCase();
  for (const row of TABLE) if (m.includes(row.match)) return row.rate;
  return DEFAULT_RATE;
}

/** Prompt-cache multipliers on the input rate, as both vendors price them:
 *  writing a cache entry costs more than plain input, reading one costs far
 *  less. Counting a cache read as full input overcharges by 10x; ignoring it
 *  altogether — which is what we did before — undercharges to nothing. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the prompt cache. */
  cacheWriteTokens?: number;
  /** Tokens served from the prompt cache. */
  cacheReadTokens?: number;
}

/** Cost in cents (may be fractional) for a metered call. */
export function priceUsage(
  model: string | undefined | null,
  inputTokens: number,
  outputTokens: number,
  cache: { write?: number; read?: number } = {},
): number {
  const rate = rateFor(model);
  const per = (tokens: number, centsPerM: number) => (Math.max(0, tokens) / 1_000_000) * centsPerM;
  const cents =
    per(inputTokens, rate.input) +
    per(outputTokens, rate.output) +
    per(cache.write ?? 0, rate.input * CACHE_WRITE_MULTIPLIER) +
    per(cache.read ?? 0, rate.input * CACHE_READ_MULTIPLIER);
  return cents * margin();
}
