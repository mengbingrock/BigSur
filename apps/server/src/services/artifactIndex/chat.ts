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
    if (!hit) return "The protocols provided do not cover that. [CONFIDENCE: 0.05]";
    const sentence = hit.text.split(/(?<=\.)\s/)[0] ?? hit.text;
    return `${sentence.trim()} [${hit.n}] [CONFIDENCE: 0.85]`;
  }

  // Review: one deterministic check that still exercises the context the
  // reviewer is given — a CO2 percentage that disagrees with the evidence is
  // a parameter finding, and a centrifuge speed no bench rotor reaches is one
  // too. Enough to see findings land with the right path and class.
  if (system.includes("exactly three kinds of error")) {
    const payload = JSON.parse(user) as {
      steps: Array<{ path: string; text: string; evidence: string[] }>;
    };
    const findings: Array<{ path: string; class: string; message: string; suggestion: string; confidence: number }> = [];
    for (const s of payload.steps) {
      const co2 = /(\d+(?:\.\d+)?)\s*%\s*co2/i.exec(s.text);
      if (co2) {
        const usual = s.evidence.map((e) => /(\d+(?:\.\d+)?)\s*%\s*co2/i.exec(e)?.[1]).find(Boolean);
        if (usual && usual !== co2[1]) {
          findings.push({
            path: s.path,
            class: "parameter",
            message: `${co2[1]}% CO2 disagrees with the ${usual}% CO2 this lab's other protocols use.`,
            suggestion: `${usual}% CO2`,
            confidence: 0.8,
          });
        }
      }
      const rpm = /(\d[\d,]*)\s*rpm/i.exec(s.text);
      if (rpm && Number(rpm[1]!.replace(/,/g, "")) > 20000) {
        findings.push({ path: s.path, class: "parameter", message: `${rpm[0]} is beyond a bench centrifuge.`, suggestion: "", confidence: 0.7 });
      }
      if (/\bwithout (?:the )?(?:ligase|polymerase|enzyme)\b/i.test(s.text)) {
        findings.push({ path: s.path, class: "reagent", message: "The enzyme the step depends on is left out.", suggestion: "", confidence: 0.75 });
      }
    }
    return JSON.stringify({ findings });
  }

  // Ordering: a step that carries a leading number was numbered by its
  // author; sort on that. Otherwise leave the order alone.
  if (system.includes("restore the order")) {
    const payload = JSON.parse(user) as { steps: Array<{ index: number; text: string }> };
    const keyed = payload.steps.map((s) => ({ index: s.index, n: Number(/^\s*\(?(\d+)[.)]/.exec(s.text)?.[1] ?? NaN) }));
    if (keyed.every((k) => Number.isFinite(k.n))) {
      return JSON.stringify({ order: keyed.sort((a, b) => a.n - b.n).map((k) => k.index) });
    }
    return JSON.stringify({ order: payload.steps.map((s) => s.index) });
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
