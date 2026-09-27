// The categorisation agent.
//
// Given a library, it proposes which category each uncategorised artifact
// belongs in. Three steps, escalating only as far as needed, so a tidy library
// costs nothing:
//
//   1. nearest category centroid — free, no model call, explains itself
//   2. one batched model call for whatever the centroids could not place
//   3. cluster the remainder and ask the model to name the clusters, for a
//      library that has no categories to choose from yet
//
// It never writes. Proposals are applied by the existing category and move
// endpoints, one click at a time.
import type { Skill } from "@labee/contracts";
import { getAllSkills, listCategories } from "../skills";
import { artifactVectors, ensureIndexed } from "./index";
import { cosine, normalise, resolveEmbedTarget, useFake, type EmbedTarget } from "./embed";

/** Above this cosine to a category's centroid, that category is the answer and
 *  no model is consulted. Chosen so a clear match lands but a vague one falls
 *  through to step 2 rather than being filed wrongly with confidence. */
const CENTROID_THRESHOLD = 0.55;

function agentModel(): string {
  return process.env.LABEE_AGENT_MODEL || "gpt-4o-mini";
}

export interface CategoryProposal {
  slug: string;
  name: string;
  /** Proposed category, or null when nothing fit. */
  category: string | null;
  /** 0–1. For a centroid match this is the cosine; for a model answer, its own. */
  confidence: number;
  /** One sentence a person can judge the proposal by. */
  reason: string;
  /** True when `category` is not among the caller's existing folders. */
  isNew: boolean;
}

export interface SuggestResult {
  proposals: CategoryProposal[];
  /** Categories that would have to be created to apply these proposals. */
  newCategories: string[];
  /** How far the agent had to escalate, for the UI to explain itself. */
  usedModel: boolean;
}

// ---------- model call -------------------------------------------------------

/** One JSON-mode chat call. Returns parsed JSON, or null when the model
 *  produced something unusable — the caller then leaves those artifacts
 *  unproposed rather than guessing. */
async function chatJSON(
  target: EmbedTarget,
  system: string,
  user: string,
): Promise<unknown | null> {
  if (useFake()) return fakeChat(system, user);
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: agentModel(),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Deterministic stand-in used when LABEE_EMBED_PROVIDER=fake, so the agent
 *  can be tested without a key. Assignment picks the existing category sharing
 *  the most words with the artifact's name; naming titles each cluster after
 *  the commonest significant word among its members. */
function fakeChat(system: string, user: string): unknown {
  const payload = JSON.parse(user) as {
    categories?: string[];
    artifacts?: Array<{ slug: string; name: string; text: string }>;
    clusters?: Array<{ id: number; members: string[] }>;
  };
  if (system.includes("name each cluster")) {
    return {
      names: (payload.clusters ?? []).map((c) => ({
        id: c.id,
        name: commonestWord(c.members) ?? `Group ${c.id + 1}`,
      })),
    };
  }
  const cats = payload.categories ?? [];
  return {
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
  };
}

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

// ---------- clustering -------------------------------------------------------

/** Spherical k-means (cosine). Vectors are unit length, so the mean of a
 *  cluster renormalised is its centroid and the dot product is the distance.
 *  Deterministic: seeds are spread evenly through the input, and restarts
 *  differ only by offset, so the same library always clusters the same way. */
export function kmeans(
  vectors: readonly Float32Array[],
  k: number,
  restarts = 3,
): number[] {
  const n = vectors.length;
  if (n === 0 || k <= 1) return new Array(n).fill(0);
  const kk = Math.min(k, n);
  let bestAssign: number[] = new Array(n).fill(0);
  let bestScore = -Infinity;

  for (let r = 0; r < restarts; r++) {
    let centroids: Float32Array[] = Array.from({ length: kk }, (_, i) =>
      Float32Array.from(vectors[(i * Math.max(1, Math.floor(n / kk)) + r) % n]!),
    );
    let assign: number[] = new Array(n).fill(0);
    for (let iter = 0; iter < 25; iter++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        let best = 0;
        let bestSim = -Infinity;
        for (let c = 0; c < kk; c++) {
          const sim = cosine(vectors[i]!, centroids[c]!);
          if (sim > bestSim) {
            bestSim = sim;
            best = c;
          }
        }
        if (assign[i] !== best) moved = true;
        assign[i] = best;
      }
      const next: Float32Array[] = Array.from(
        { length: kk },
        () => new Float32Array(vectors[0]!.length),
      );
      const counts = new Array(kk).fill(0);
      for (let i = 0; i < n; i++) {
        const c = assign[i]!;
        counts[c] += 1;
        const acc = next[c]!;
        for (let d = 0; d < acc.length; d++) acc[d] = (acc[d] ?? 0) + (vectors[i]![d] ?? 0);
      }
      centroids = next.map((v, c) => (counts[c] > 0 ? normalise(v) : centroids[c]!));
      if (!moved) break;
    }
    const score = vectors.reduce((sum, v, i) => sum + cosine(v, centroids[assign[i]!]!), 0);
    if (score > bestScore) {
      bestScore = score;
      bestAssign = assign;
    }
  }
  return bestAssign;
}

// ---------- the agent --------------------------------------------------------

function firstWords(body: string, chars: number): string {
  return body.replace(/\s+/g, " ").trim().slice(0, chars);
}

/**
 * Propose a category for each uncategorised artifact. `slugs` narrows it to
 * specific artifacts (used by the create and import flows); otherwise every
 * uncategorised protocol the caller owns is considered.
 */
export async function suggestCategories(
  email: string,
  opts?: { slugs?: readonly string[]; kind?: "skill" | "protocol" },
): Promise<SuggestResult> {
  const kind = opts?.kind ?? "protocol";
  await ensureIndexed(email);

  const all = getAllSkills(email).filter((s) => s.artifactKind === kind);
  const mine = all.filter((s) => s.sourceLabel !== "public" && !s.origin);
  const target = opts?.slugs
    ? mine.filter((s) => opts.slugs!.includes(s.slug))
    : mine.filter((s) => !s.category);
  if (target.length === 0) return { proposals: [], newCategories: [], usedModel: false };

  const vectors = await artifactVectors(email, { kind });
  const existing = listCategories(email);

  // --- 1. nearest centroid ---------------------------------------------------
  const centroids = new Map<string, Float32Array>();
  for (const cat of existing) {
    const members = all.filter((s) => s.category === cat && vectors.has(s.sourcePath));
    if (members.length === 0) continue;
    const acc = new Float32Array(vectors.get(members[0]!.sourcePath)!.length);
    for (const m of members) {
      const v = vectors.get(m.sourcePath)!;
      for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
    }
    centroids.set(cat, normalise(acc));
  }

  const proposals: CategoryProposal[] = [];
  const leftover: Skill[] = [];
  for (const s of target) {
    const v = vectors.get(s.sourcePath);
    let best: { cat: string; sim: number } | null = null;
    if (v) {
      for (const [cat, c] of centroids) {
        const sim = cosine(v, c);
        if (!best || sim > best.sim) best = { cat, sim };
      }
    }
    if (best && best.sim >= CENTROID_THRESHOLD) {
      proposals.push({
        slug: s.slug,
        name: s.name,
        category: best.cat,
        confidence: Number(best.sim.toFixed(3)),
        reason: `Closest to the other protocols already in ${best.cat}.`,
        isNew: false,
      });
    } else {
      leftover.push(s);
    }
  }
  if (leftover.length === 0) {
    return { proposals, newCategories: [], usedModel: false };
  }

  const embedTarget = await resolveEmbedTarget(email);
  if (!embedTarget) {
    // No credential: return what the centroids found and say nothing about the
    // rest, rather than inventing categories.
    return { proposals, newCategories: [], usedModel: false };
  }

  // --- 2. ask the model to place the leftovers -------------------------------
  let stillUnplaced = leftover;
  let usedModel = false;
  if (existing.length > 0) {
    usedModel = true;
    const answer = (await chatJSON(
      embedTarget,
      "You file laboratory protocols into folders. Choose only from the given categories, " +
        "or null when none genuinely fits — a wrong folder is worse than no folder. " +
        'Reply as JSON: {"assignments":[{"slug","category","confidence","reason"}]}. ' +
        "Keep each reason to one short sentence.",
      JSON.stringify({
        categories: existing,
        artifacts: leftover.map((s) => ({
          slug: s.slug,
          name: s.name,
          text: `${s.description} ${firstWords(s.body, 300)}`.trim(),
        })),
      }),
    )) as { assignments?: Array<{ slug: string; category: string | null; confidence?: number; reason?: string }> } | null;

    const placed = new Set<string>();
    for (const a of answer?.assignments ?? []) {
      if (!a.category || !existing.includes(a.category)) continue;
      const s = leftover.find((x) => x.slug === a.slug);
      if (!s) continue;
      placed.add(a.slug);
      proposals.push({
        slug: s.slug,
        name: s.name,
        category: a.category,
        confidence: Math.min(1, Math.max(0, Number(a.confidence ?? 0.6))),
        reason: a.reason?.trim() || `The model filed this under ${a.category}.`,
        isNew: false,
      });
    }
    stillUnplaced = leftover.filter((s) => !placed.has(s.slug));
  }

  // --- 3. propose a taxonomy for whatever is still unplaced -------------------
  // Only worth doing when there is enough left to see groups in: below this a
  // person is better off naming one folder themselves.
  const newCategories: string[] = [];
  if (stillUnplaced.length >= 2) {
    usedModel = true;
    const withVectors = stillUnplaced.filter((s) => vectors.has(s.sourcePath));
    if (withVectors.length >= 2) {
      const k = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(withVectors.length / 2))));
      const assign = kmeans(withVectors.map((s) => vectors.get(s.sourcePath)!), k);
      const clusters = new Map<number, Skill[]>();
      assign.forEach((c, i) => {
        const list = clusters.get(c) ?? [];
        list.push(withVectors[i]!);
        clusters.set(c, list);
      });
      const named = (await chatJSON(
        embedTarget,
        "You are naming folders for a laboratory protocol library. For each cluster, " +
          "name each cluster in one or two words as a bench scientist would label a " +
          "folder (Cloning, Cell culture, Imaging). Do not reuse an existing name. " +
          'Reply as JSON: {"names":[{"id","name"}]}.',
        JSON.stringify({
          existing,
          clusters: [...clusters.entries()].map(([id, members]) => ({
            id,
            members: members.map((m) => m.name),
            descriptions: members.map((m) => m.description).filter(Boolean),
          })),
        }),
      )) as { names?: Array<{ id: number; name: string }> } | null;

      const nameById = new Map((named?.names ?? []).map((n) => [Number(n.id), String(n.name).trim()]));
      for (const [id, members] of clusters) {
        const name = nameById.get(id);
        if (!name || existing.includes(name)) continue;
        if (!newCategories.includes(name)) newCategories.push(name);
        for (const m of members) {
          proposals.push({
            slug: m.slug,
            name: m.name,
            category: name,
            confidence: 0.5,
            reason: `Groups with ${members.length - 1} other protocol${members.length === 2 ? "" : "s"} the library has no folder for.`,
            isNew: true,
          });
        }
      }
    }
  }

  return { proposals, newCategories, usedModel };
}
