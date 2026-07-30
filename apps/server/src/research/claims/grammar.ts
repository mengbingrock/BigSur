// Claim-tag grammar for the research representation / tagged draft.
// One tag per factual sentence:
//   {{src: log:<relPath>:<line>}}      numbered experimental-log line
//   {{src: cite:<refId>}}              literature reference
//   {{src: ablation:<relPath>#<key>}}  ablation result entry
//   {{src: brief:<sectionId>}}         Experiment Brief baseline/fact
//   {{src: unsourced}}                 explicit "cannot source this"
// Pure functions — no I/O — so the parser is trivially unit-testable.
import type { ClaimType } from "@labee/contracts";

export const TAG_RE = /\{\{src:\s*(log|cite|ablation|brief|unsourced)(?::([^}#\s]+))?(?:#([^}\s]+))?\s*\}\}/;
const TAG_RE_G = new RegExp(TAG_RE.source, "g");
/** Anything that looks like it wanted to be a tag, well-formed or not. */
const TAG_LIKE_G = /\{\{[^}]*\}\}/g;

export interface ParsedTag {
  kind: "log" | "cite" | "ablation" | "brief" | "unsourced";
  /** log: relPath — cite: refId — ablation: relPath — brief: sectionId */
  target: string | null;
  /** log: line number — ablation: entry key */
  detail: string | null;
  raw: string;
}

export interface ParsedClaim {
  /** The sentence text with the tag removed, trimmed. */
  text: string;
  tag: ParsedTag | null;
  raw: string;
  claimType: ClaimType;
  /** 1-based line in the source document where the claim's tag sits. */
  line: number;
}

export function parseTag(raw: string): ParsedTag | null {
  const m = TAG_RE.exec(raw);
  if (!m) return null;
  const kind = m[1] as ParsedTag["kind"];
  if (kind === "unsourced") return { kind, target: null, detail: null, raw: m[0] };
  const target = m[2] ?? null;
  const detail = m[3] ?? null;
  if (!target) return null;
  if (kind === "log") {
    // log tags are log:<relPath>:<line> — split the trailing line number off.
    const idx = target.lastIndexOf(":");
    if (idx <= 0) return null;
    const line = target.slice(idx + 1);
    if (!/^\d+$/.test(line)) return null;
    return { kind, target: target.slice(0, idx), detail: line, raw: m[0] };
  }
  if (kind === "ablation" && !detail) return null;
  return { kind, target, detail, raw: m[0] };
}

const NUMBER_RE = /(?<![\w.])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?\s*(?:%|×|x\b|ms\b|s\b|k\b|M\b)?/i;

/** Does the sentence assert a quantity? (drives numerical-claim typing) */
export function hasNumberToken(text: string): boolean {
  // Strip markdown emphasis/inline code first so "``v2``" doesn't count.
  const cleaned = text.replace(/`[^`]*`/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "");
  return NUMBER_RE.test(cleaned);
}

export function classifyClaim(text: string, tag: ParsedTag | null): ClaimType {
  if (!tag) return "malformed";
  if (tag.kind === "unsourced") return "unsourced";
  if (tag.kind === "cite") return "citation";
  if (tag.kind === "log" || tag.kind === "ablation") {
    return hasNumberToken(text) ? "numerical" : "methodological";
  }
  // brief:
  return hasNumberToken(text) ? "numerical" : "methodological";
}

/** Segment a tagged markdown document into claims. Each tag closes the claim
 *  consisting of the text since the previous tag (within the same paragraph).
 *  Tag-like fragments that fail the grammar produce `malformed` claims. */
export function parseClaims(doc: string): ParsedClaim[] {
  const claims: ParsedClaim[] = [];
  const lines = doc.split("\n");
  let buffer = "";
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    // Paragraph breaks and headers reset the accumulation buffer.
    if (lineText.trim() === "" || /^#{1,6}\s/.test(lineText)) {
      buffer = "";
      continue;
    }
    let cursor = 0;
    TAG_LIKE_G.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_LIKE_G.exec(lineText)) !== null) {
      const before = lineText.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      const text = (buffer + before).trim();
      buffer = "";
      const tag = parseTag(m[0]);
      if (!tag) {
        claims.push({ text, tag: null, raw: m[0], claimType: "malformed", line: i + 1 });
        continue;
      }
      claims.push({ text, tag, raw: m[0], claimType: classifyClaim(text, tag), line: i + 1 });
    }
    buffer += lineText.slice(cursor) + " ";
  }
  return claims.filter((c) => c.text.length > 0 || c.claimType === "malformed");
}

/** Strip every tag-like fragment (used when rendering the final document). */
export function stripTags(doc: string): string {
  return doc
    .replace(TAG_LIKE_G, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/ {2,}/g, " "))
    .join("\n");
}

/** Extract all well-formed cite:<refId> targets in a document. */
export function citedRefIds(doc: string): string[] {
  const out = new Set<string>();
  TAG_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE_G.exec(doc)) !== null) {
    if (m[1] === "cite" && m[2]) out.add(m[2]);
  }
  return [...out];
}
