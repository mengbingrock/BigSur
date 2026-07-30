// Provider-aware, non-streaming text completion for the auxiliary calls
// (canvas extraction, passage rewrite). Mirrors the chat route's provider
// dispatch but returns a single string.
import { getSettings, resolveCredential } from "./llmSettings";
import { openAIComplete } from "./openai";
import { runClaudeText } from "./claudeRunner";

/** Complete a prompt with the user's active provider/credential. */
export async function completeText(opts: {
  email: string;
  system: string;
  user: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  anthropicModel: string;
  openaiModel: string;
}): Promise<string> {
  const settings = await getSettings(opts.email);
  const provider = settings.provider;
  const cred = await resolveCredential(opts.email, provider);
  if (cred.unavailable) throw new Error(cred.reason ?? "No usable LLM credential.");

  if (provider === "openai") {
    return openAIComplete({
      apiKey: cred.apiKey!,
      model: opts.openaiModel,
      system: opts.system,
      user: opts.user,
    });
  }
  return runClaudeText({
    prompt: opts.user,
    systemPrompt: opts.system,
    model: opts.anthropicModel,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    ...(cred.apiKey ? { extraEnv: { ANTHROPIC_API_KEY: cred.apiKey } } : {}),
  });
}
