// Embedding provider for artifact retrieval.
//
// Two implementations behind one function: OpenAI's embeddings API, and a
// deterministic fake selected with LABEE_EMBED_PROVIDER=fake so the index and
// search can be tested offline without a key or a network call.
//
// Credentials follow the same three-way routing as every other model call
// (services/llmSettings.ts): the caller's own key, the labee.online inference
// proxy on the provided tier, or the box's own env key.
import { createHash } from "node:crypto";
import { providedKey, resolveCredential } from "../llmSettings";

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

/** Vectors are keyed by model: change the model and every row goes stale. */
export function embedModel(): string {
  if (useFake()) return "fake-hash-64";
  return process.env.LABEE_EMBED_MODEL || "text-embedding-3-small";
}

export function useFake(): boolean {
  return process.env.LABEE_EMBED_PROVIDER === "fake";
}

export interface EmbedTarget {
  apiKey: string;
  baseUrl: string;
}

/** Resolve who pays for embedding calls on behalf of `email`, or null when no
 *  credential is available (the caller then falls back to lexical search). */
export async function resolveEmbedTarget(email?: string): Promise<EmbedTarget | null> {
  if (useFake()) return { apiKey: "fake", baseUrl: "fake" };
  if (email) {
    const cred = await resolveCredential(email, "openai").catch(() => null);
    if (cred && !cred.unavailable && cred.apiKey) {
      return {
        apiKey: cred.apiKey,
        baseUrl: (cred.proxyBaseUrl || OPENAI_API_BASE).replace(/\/+$/, ""),
      };
    }
  }
  const key = providedKey("openai");
  if (key) return { apiKey: key, baseUrl: OPENAI_API_BASE.replace(/\/+$/, "") };
  return null;
}

/** 64-dimension deterministic bag-of-words vector. Words hash to a dimension,
 *  so two texts sharing words land near each other and identical texts are
 *  identical. Only good enough to prove the plumbing; never used in prod. */
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(64);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    const h = createHash("sha1").update(word).digest();
    const a = h[0]! % 64;
    const b = h[1]! % 64;
    v[a] = (v[a] ?? 0) + 1;
    // A second, weaker dimension spreads related words so cosine is not
    // all-or-nothing on a single bucket.
    v[b] = (v[b] ?? 0) + 0.5;
  }
  return normalise(v);
}

export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Cosine similarity of two unit vectors (a plain dot product). Mismatched
 *  lengths score 0 rather than throwing, so a stale row cannot break a query. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** One batched embedding call. OpenAI takes up to 2048 inputs per request;
 *  callers chunk to that. Throws on a provider error so the indexer can leave
 *  the artifact unindexed and retry later. */
export async function embedBatch(
  texts: readonly string[],
  target: EmbedTarget,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (useFake()) return texts.map(fakeEmbed);

  const res = await fetch(`${target.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({ model: embedModel(), input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ index: number; embedding: number[] }>;
  };
  const rows = json.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(`Embedding provider returned ${rows.length} vectors for ${texts.length} inputs.`);
  }
  // The API may return out of order; `index` is authoritative.
  const out: Float32Array[] = new Array(texts.length);
  for (const r of rows) out[r.index] = normalise(Float32Array.from(r.embedding));
  return out;
}

// ---------- BLOB encoding ---------------------------------------------------

export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToVector(b: Uint8Array | ArrayBuffer | Buffer): Float32Array {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  // Copy rather than view: the source may not be 4-byte aligned.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
