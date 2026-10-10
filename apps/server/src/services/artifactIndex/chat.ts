// One chat call, shared by the categorisation agent and Ask mode.
//
// Goes to the same target the embeddings use, so it follows the same
// three-way credential routing (own key / provided-tier proxy / box env key).
// LABEE_EMBED_PROVIDER=fake swaps in a deterministic stand-in so both callers
// are testable without a key or a network.
import { useFake, type EmbedTarget } from "./embed";

export function agentModel(): string {
  return process.env.LABEE_AGENT_MODEL || "gpt-4o-mini";
}

/** Returns the model's text, or null when the call failed. Callers treat null
 *  as "no answer" rather than guessing. */
export async function chatComplete(
  target: EmbedTarget,
  system: string,
  user: string,
  opts?: { json?: boolean },
): Promise<string | null> {
  if (useFake()) return fakeComplete(system, user);
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: agentModel(),
      temperature: 0,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? null;
}

/** JSON-mode convenience: parse or give up. */
export async function chatJSON(
  target: EmbedTarget,
  system: string,
  user: string,
): Promise<unknown | null> {
  const text = await chatComplete(target, system, user, { json: true });
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- the stand-in -----------------------------------------------------

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

function commonestWord(names: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const n of names) for (const w of tokens(n)) counts.set(w, (counts.get(w) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  if (!best) return null;
  return best[0].charAt(0).toUpperCase() + best[0].slice(1);
}

/** Deterministic answers, dispatched on which prompt is asking. Good enough to
 *  exercise every branch; never used outside tests. */
function fakeComplete(system: string, user: string): string {
  // Ask mode: quote the first passage and cite it, or decline when the
  // passages do not mention the question's words at all.
  if (system.includes("only from the numbered passages")) {
    const payload = JSON.parse(user) as {
      question: string;
      passages: Array<{ n: number; name: string; heading: string; text: string }>;
    };
    const words = tokens(payload.question);
    const hit = payload.passages.find((p) =>
      words.some((w) => p.text.toLowerCase().includes(w)),
    );
    if (!hit) return "The protocols provided do not cover that.";
    const sentence = hit.text.split(/(?<=\.)\s/)[0] ?? hit.text;
    return `${sentence.trim()} [${hit.n}]`;
  }

  // Purpose layer: a deterministic sentence from each artifact's own words,
  // so a test can see the fields land without a model.
  if (system.includes("purpose layer")) {
    const payload = JSON.parse(user) as {
      artifacts?: Array<{ slug: string; name: string; description: string; category: string | null; text: string }>;
    };
    return JSON.stringify({
      items: (payload.artifacts ?? []).map((a) => ({
        slug: a.slug,
        problem: `Needing to ${a.name.toLowerCase()} reliably.`,
        method: a.description || `Following the ${a.name.toLowerCase()} steps.`,
        application: `Whenever a ${a.name.toLowerCase()} is called for.`,
        domains: [a.category ?? "General"],
        keywords: tokens(a.name).slice(0, 4),
        confidence: 0.6,
      })),
    });
  }

  const payload = JSON.parse(user) as {
    categories?: string[];
    artifacts?: Array<{ slug: string; name: string; text: string }>;
    clusters?: Array<{ id: number; members: string[] }>;
  };
  if (system.includes("name each cluster")) {
    return JSON.stringify({
      names: (payload.clusters ?? []).map((c) => ({
        id: c.id,
        name: commonestWord(c.members) ?? `Group ${c.id + 1}`,
      })),
    });
  }
  const cats = payload.categories ?? [];
  return JSON.stringify({
    assignments: (payload.artifacts ?? []).map((a) => {
      const words = new Set(tokens(a.name));
      let best: { cat: string; n: number } | null = null;
      for (const c of cats) {
        const n = tokens(c).filter((w) => words.has(w)).length;
        if (n > 0 && (!best || n > best.n)) best = { cat: c, n };
      }
      return best
        ? { slug: a.slug, category: best.cat, confidence: 0.7, reason: `Shares wording with ${best.cat}.` }
        : { slug: a.slug, category: null, confidence: 0, reason: "No existing category fits." };
    }),
  });
}
