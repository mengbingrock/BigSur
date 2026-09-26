// Split an artifact body into retrieval chunks.
//
// The unit a person wants back from a protocol is a section ("the lysis step",
// "the buffer recipe"), so chunks follow the Markdown headings and carry their
// heading path. Long sections are windowed with an overlap so a step that
// straddles a boundary is still found whole in one chunk or the other.

/** ~4 characters per token is close enough for budgeting; no tokeniser needed. */
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 400;
const OVERLAP_TOKENS = 60;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
/** Below this a trailing window is folded back into the previous chunk rather
 *  than stored as a fragment nobody would want to read. */
const MIN_TAIL_CHARS = 120;

export interface Chunk {
  /** "Materials › Buffers", or "" for text before the first heading. */
  heading: string;
  /** The chunk as a person should read it — no synthetic prefix. */
  text: string;
}

interface Section {
  heading: string;
  lines: string[];
}

/** Split into sections on ATX headings, tracking the heading path. Fenced code
 *  blocks are opaque: a `#` inside one is a comment, not a heading. */
function sections(body: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let current: Section = { heading: "", lines: [] };
  let inFence = false;
  let fence = "";

  for (const line of body.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!inFence) {
        inFence = true;
        fence = marker[0]!;
      } else if (marker[0] === fence) {
        inFence = false;
      }
      current.lines.push(line);
      continue;
    }
    const h = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (current.lines.some((l) => l.trim())) out.push(current);
      const depth = h[1]!.length;
      const title = h[2]!.trim();
      path.length = Math.min(path.length, depth - 1);
      path[depth - 1] = title;
      current = { heading: path.filter(Boolean).join(" › "), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim())) out.push(current);
  return out;
}

/** Break points inside a section, preferred in this order: a blank line, the
 *  start of a list item or table row, then any line end. Keeps a table or a
 *  list from being cut mid-row. */
function splitSection(text: string): string[] {
  if (text.length <= TARGET_CHARS) return [text];
  const out: string[] = [];
  let rest = text;

  while (rest.length > TARGET_CHARS) {
    const window = rest.slice(0, TARGET_CHARS);
    const at =
      window.lastIndexOf("\n\n") >= MIN_TAIL_CHARS
        ? window.lastIndexOf("\n\n") + 2
        : lastStructuralBreak(window) ?? window.lastIndexOf("\n") + 1;
    const cut = at > MIN_TAIL_CHARS ? at : TARGET_CHARS;
    out.push(rest.slice(0, cut).trim());
    // Step back by the overlap so a step spanning the cut appears whole in the
    // next chunk too.
    rest = rest.slice(Math.max(0, cut - OVERLAP_CHARS));
  }
  const tail = rest.trim();
  if (tail) {
    if (tail.length < MIN_TAIL_CHARS && out.length > 0) out[out.length - 1] += `\n${tail}`;
    else out.push(tail);
  }
  return out;
}

/** Offset of the last line start that begins a list item or table row. */
function lastStructuralBreak(window: string): number | null {
  const lines = window.split("\n");
  let offset = window.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    offset -= lines[i]!.length + 1;
    if (offset < MIN_TAIL_CHARS) break;
    if (/^\s*([-*+]|\d+[.)]|\|)/.test(lines[i]!)) return offset + 1;
  }
  return null;
}

/** Chunk an artifact. Always yields at least one chunk when there is any text,
 *  so an artifact is never silently absent from the index. */
export function chunkArtifact(body: string): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sections(body)) {
    const text = s.lines.join("\n").trim();
    if (!text) continue;
    for (const piece of splitSection(text)) {
      if (piece.trim()) out.push({ heading: s.heading, text: piece.trim() });
    }
  }
  return out;
}

/** What actually gets embedded. The name and heading path ride along so a
 *  chunk reading only "spin 5 min at 16,000 g" still matches a query naming
 *  the protocol ("how long do I spin in the miniprep"). The stored text stays
 *  clean; this prefix exists only for the vector. */
export function embeddingText(name: string, heading: string, text: string): string {
  const where = heading ? ` — ${heading}` : "";
  return `Protocol: ${name}${where}\n\n${text}`;
}
