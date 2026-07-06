import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { getSkillBySlug } from "../services/skills";
import { completeText } from "../services/complete";

const params = HttpRouter.params;
const MAX_INSTRUCTION = 4000;
const REWRITE_TIMEOUT_MS = 90_000;
const SUMMARY_SENTINEL = "---END-OF-SUMMARY---";

const REWRITE_SYSTEM_PROMPT =
  "You are a markdown-rewriting engine. The user supplies a markdown document and an instruction. " +
  "Return TWO parts separated EXACTLY by the sentinel line `" +
  SUMMARY_SENTINEL +
  "` (on its own line, no leading/trailing spaces).\n" +
  "PART 1 — a markdown bullet list of WHAT CHANGED as a result of the user's note. " +
  "Use 1–5 bullets, each starting with `- ` and under ~12 words. Each bullet names ONE concrete change (added X / removed Y / reordered Z / replaced A with B). " +
  "Do not narrate intent or rationale. Do not write paragraphs. No headings, no preamble, no quotation marks.\n" +
  "PART 2 — the full rewritten markdown body. No preamble. No quotation marks around the result. No code-fence wrappers around the whole document.\n" +
  "Preserve existing markdown structure (headings, lists, tables, code blocks, links) in PART 2 unless the instruction asks otherwise. " +
  "If the instruction is ambiguous, make a single best-effort interpretation rather than asking. " +
  "Do not invent facts the user didn't ask for. Keep the document's voice, tone, and language.";

function buildRewritePrompt(body: string, instruction: string): string {
  return [
    "INSTRUCTION:",
    instruction.trim(),
    "",
    "----- BEGIN MARKDOWN BODY -----",
    body,
    "----- END MARKDOWN BODY -----",
    "",
    "Return the rewritten markdown body below, with no other text.",
  ].join("\n");
}

/** POST /api/artifacts/:slug/llm-edit — propose a rewritten artifact body
 *  (summary + proposed). Persistence stays gated to PUT /api/skills/:slug. */
export const llmEditRoute = HttpRouter.add(
  "POST",
  "/api/artifacts/:slug/llm-edit",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);
    const { slug: rawSlug } = yield* params;
    let slug: string;
    try {
      slug = decodeURIComponent(rawSlug ?? "");
    } catch {
      return yield* error("Invalid slug.", 400);
    }
    const skill = getSkillBySlug(slug, user.email);
    if (!skill) return yield* error("Artifact not found.", 404);

    const body = yield* bodyJson<{ instruction?: string }>().pipe(
      Effect.catch(() => Effect.succeed(null as { instruction?: string } | null)),
    );
    const instruction = (body?.instruction ?? "").trim();
    if (!instruction) return yield* error("instruction is required.", 400);
    if (instruction.length > MAX_INSTRUCTION) {
      return yield* error(`instruction must be <= ${MAX_INSTRUCTION} characters.`, 400);
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        completeText({
          email: user.email,
          system: REWRITE_SYSTEM_PROMPT,
          user: buildRewritePrompt(skill.body, instruction),
          effort: "low",
          timeoutMs: REWRITE_TIMEOUT_MS,
          anthropicModel: "haiku",
          openaiModel: "gpt-5.4-mini",
        }),
      catch: (e) => e,
    }).pipe(
      Effect.map((text) => ({ ok: true as const, text })),
      Effect.catch((e) =>
        Effect.succeed({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
      ),
    );
    if (!result.ok) return yield* error(result.message, 500);

    const cleaned = result.text.replace(/^﻿/, "").replace(/\s+$/, "");
    if (!cleaned) return yield* error("The model returned an empty rewrite.", 502);

    let summary = "";
    let proposed = cleaned;
    const sentinelRegex = new RegExp(
      `\\r?\\n[ \\t]*${SUMMARY_SENTINEL.replace(/-/g, "\\-")}[ \\t]*\\r?\\n`,
    );
    const m = cleaned.match(sentinelRegex);
    if (m && m.index !== undefined) {
      summary = cleaned.slice(0, m.index).trim();
      proposed = cleaned.slice(m.index + m[0].length).trim();
    }
    if (!proposed) return yield* error("claude returned a summary but no rewritten body.", 502);

    return yield* json({ slug: skill.slug, current: skill.body, proposed, summary });
  }),
);
