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

/** Cost in cents (may be fractional) for a metered call. */
export function priceUsage(
  model: string | undefined | null,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = rateFor(model);
  const cents =
    (Math.max(0, inputTokens) / 1_000_000) * rate.input +
    (Math.max(0, outputTokens) / 1_000_000) * rate.output;
  return cents * margin();
}
