// Protocols follow their source hierarchy. Generic skills retain the legacy
// section windows. Oversized protocol nodes have linked fragments only to fit
// embedding-provider input limits; fragments retain the original node path.
//
//   section  a source section's own text and child outline
//   step     one numbered step, for "how long / how much / what temperature";
//            a parameter lives in a step, and a step is small enough that the
//            number is not drowned by the rest of the section
//   summary  the protocol's purpose — name, description and the purpose-layer
//            fields — so a question phrased as a goal ("measure viability in
//            a 3D culture") finds a protocol whose steps never say "viability"
//
// Skills (folders with scripts) get section chunks only; the other two grains
// are for protocols, which have steps and a purpose.
import {
  markdownHierarchy,
  hierarchyIndexText,
  type ProtocolNode,
} from "../protocolHierarchy";

/** ~4 characters per token is close enough for budgeting; no tokeniser needed. */
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 400;
const OVERLAP_TOKENS = 60;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
/** Below this a trailing window is folded back into the previous chunk rather
 *  than stored as a fragment nobody would want to read. */
const MIN_TAIL_CHARS = 120;

export type Grain = "section" | "step" | "summary";

export interface Chunk {
  /** "Materials › Buffers", or "" for text before the first heading. */
  heading: string;
  /** The chunk as a person should read it — no synthetic prefix. */
  text: string;
  grain: Grain;
  /** Tree path: "2" for a section, "2.3" for a step, "" when not applicable. */
  path: string;
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
        : (lastStructuralBreak(window) ?? window.lastIndexOf("\n") + 1);
    const cut = at > MIN_TAIL_CHARS ? at : TARGET_CHARS;
    out.push(rest.slice(0, cut).trim());
    // Step back by the overlap so a step spanning the cut appears whole in the
    // next chunk too — but always move forward. A break point just past the
    // minimum tail (a short paragraph before a long list) made `cut − overlap`
    // zero or negative, so the window never advanced and this loop appended
    // the same chunk until the process ran out of memory.
    const advance =
      cut - OVERLAP_CHARS >= MIN_TAIL_CHARS ? cut - OVERLAP_CHARS : cut;
    rest = rest.slice(advance);
  }
  const tail = rest.trim();
  if (tail) {
    if (tail.length < MIN_TAIL_CHARS && out.length > 0)
      out[out.length - 1] += `\n${tail}`;
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

/** Section chunks of any artifact. Always yields at least one chunk when there
 *  is any text, so an artifact is never silently absent from the index. */
export function chunkArtifact(body: string): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sections(body)) {
    const text = s.lines.join("\n").trim();
    if (!text) continue;
    for (const piece of splitSection(text)) {
      if (piece.trim())
        out.push({
          heading: s.heading,
          text: piece.trim(),
          grain: "section",
          path: "",
        });
    }
  }
  return out;
}

export interface ProtocolForChunking {
  name: string;
  description: string;
  body: string;
  hierarchy?: ProtocolNode[] | undefined;
  problem?: string | undefined;
  method?: string | undefined;
  application?: string | undefined;
  domains?: readonly string[] | undefined;
  keywords?: readonly string[] | undefined;
}

/** The summary chunk's text: what the protocol is for, in the protocol's own
 *  words. The purpose-layer fields are optional; name and description alone
 *  still make a useful summary. */
export function summaryText(p: ProtocolForChunking): string {
  const lines = [`${p.name}.`, p.description];
  if (p.problem) lines.push(`Problem: ${p.problem}`);
  if (p.method) lines.push(`Method: ${p.method}`);
  if (p.application) lines.push(`Application: ${p.application}`);
  if (p.domains?.length) lines.push(`Domains: ${p.domains.join(", ")}`);
  if (p.keywords?.length) lines.push(`Keywords: ${p.keywords.join(", ")}`);
  return lines.filter(Boolean).join("\n");
}

/**
 * Chunk a protocol at all three grains, from its tree. Section chunks carry
 * the section's path so a citation can name it; step chunks carry the step's
 * path. The preamble, if any, is a section at path "0".
 */
export function chunkProtocol(p: ProtocolForChunking): Chunk[] {
  const out: Chunk[] = [];
  const nodes = p.hierarchy ?? markdownHierarchy(p.body);
  out.push({ heading: "", text: summaryText(p), grain: "summary", path: "" });
  const children = new Map<string, ProtocolNode[]>();
  for (const node of nodes) {
    if (node.parentId)
      children.set(node.parentId, [
        ...(children.get(node.parentId) ?? []),
        node,
      ]);
  }
  for (const node of nodes) {
    const text = hierarchyIndexText(node, children.get(node.id) ?? []);
    if (text.trim() || node.heading) {
      for (const fragment of protocolEmbeddingFragments(text || node.heading))
        out.push({
          heading: node.heading,
          text: fragment,
          grain: node.grain,
          path: node.path,
        });
    }
  }
  return out;
}

/** Conservative provider ceiling measured in UTF-8 bytes (not estimated
 * tokens). Prefer paragraph/line boundaries; every piece reopens the same
 * complete source node. No overlapping or independent character windows. */
export function protocolEmbeddingFragments(text: string): string[] {
  const fragments: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > 6000) {
    let bytes = 0,
      end = 0;
    for (const char of rest) {
      const size = Buffer.byteLength(char, "utf8");
      if (bytes + size > 6000) break;
      bytes += size;
      end += char.length;
    }
    const window = rest.slice(0, end);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut =
      paragraph > end / 2 ? paragraph + 2 : line > end / 2 ? line + 1 : end;
    fragments.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) fragments.push(rest);
  return fragments;
}

/** What actually gets embedded. The name and heading path ride along so a
 *  chunk reading only "spin 5 min at 16,000 g" still matches a query naming
 *  the protocol ("how long do I spin in the miniprep"). A step adds its
 *  position. The stored text stays clean; this prefix exists only for the
 *  vector. */
export function embeddingText(
  name: string,
  heading: string,
  text: string,
  grain: Grain = "section",
  path = "",
): string {
  const where = heading ? ` — ${heading}` : "";
  const at = grain === "step" && path ? ` › step ${path}` : "";
  const kind = grain === "summary" ? "Protocol summary" : "Protocol";
  return `${kind}: ${name}${where}${at}\n\n${text}`;
}
