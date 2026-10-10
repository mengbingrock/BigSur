// A protocol as a tree of sections and numbered steps, derived from its
// markdown and rendered back to it.
//
// The markdown file stays the source of truth — it is what people edit, sync
// and read. The tree is what makes a *step* addressable: "Reaction › step 3"
// can be cited, chunked on its own for a parameter question, linted, and
// reviewed with its neighbours. Paths are dotted positions ("2", "2.2",
// "2.2.1"), the convention BioProBench uses for its hierarchical protocols,
// so the same renderer turns that corpus into Labee files.
//
// Conventions the parser reads (and the renderer writes):
//   ##  section            ###  child section
//   1.  step               nested "   1." sub-step
//   anything else in a section is prose (paragraphs, bullet lists, tables)
// Fenced code is opaque. A heading level is relative: whatever the shallowest
// heading in the file is counts as a section.

export interface Step {
  /** "2.3" — section path, then position. */
  path: string;
  text: string;
  substeps: Step[];
}

export interface Section {
  /** "2", or "2.1" for a child section. */
  path: string;
  title: string;
  /** Heading titles from the root down, joined with " › ". */
  heading: string;
  /** Text in the section that is not a numbered step. */
  prose: string;
  steps: Step[];
  children: Section[];
}

export interface ProtocolTree {
  /** Text before the first heading, if any. */
  preamble: string;
  sections: Section[];
}

interface Line {
  text: string;
  inFence: boolean;
}

/** Tag each line with whether it sits inside a fenced block, so a `#` or a
 *  `1.` in code is never read as structure. */
function fenceAware(body: string): Line[] {
  const out: Line[] = [];
  let inFence = false;
  let fence = "";
  for (const text of body.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(text);
    if (m) {
      const marker = m[1]![0]!;
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      out.push({ text, inFence: true });
      continue;
    }
    out.push({ text, inFence });
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

/** Parse the lines of one section body into prose and steps. A numbered item
 *  starts a step; a numbered item indented under a step is a sub-step; an
 *  indented continuation line belongs to the step above it; everything else
 *  is prose. Sub-steps nest one level — deeper indents fold into the
 *  sub-step, which keeps the paths readable. */
function parseBody(lines: Line[], sectionPath: string): { prose: string; steps: Step[] } {
  const prose: string[] = [];
  const steps: Step[] = [];
  let current: Step | null = null;
  let currentSub: Step | null = null;
  let stepIndent = 0;

  const flushProseBreak = () => {
    current = null;
    currentSub = null;
  };

  for (const line of lines) {
    const m = line.inFence ? null : ORDERED.exec(line.text);
    if (m) {
      const indent = m[1]!.length;
      const text = m[3]!.trim();
      if (current && indent > stepIndent) {
        const sub: Step = { path: `${current.path}.${current.substeps.length + 1}`, text, substeps: [] };
        current.substeps.push(sub);
        currentSub = sub;
        continue;
      }
      const step: Step = { path: `${sectionPath}.${steps.length + 1}`, text, substeps: [] };
      steps.push(step);
      current = step;
      currentSub = null;
      stepIndent = indent;
      continue;
    }
    // A blank line ends a step only if what follows is not indented under it;
    // keep it simple: blank lines inside a step list are swallowed, and any
    // non-indented, non-numbered text returns to prose.
    const trimmed = line.text.trim();
    if (current && trimmed === "") continue;
    if (current && /^\s+\S/.test(line.text) && !line.inFence) {
      const target = currentSub ?? current;
      target.text = `${target.text} ${trimmed}`.trim();
      continue;
    }
    if (trimmed !== "" || prose.length > 0) {
      prose.push(line.text);
    }
    if (trimmed !== "") flushProseBreak();
  }
  return { prose: prose.join("\n").replace(/\s+$/, ""), steps };
}

/** Split the file into a preamble and a flat list of headed blocks. */
function blocks(body: string): { preamble: Line[]; headed: Array<{ depth: number; title: string; lines: Line[] }> } {
  const preamble: Line[] = [];
  const headed: Array<{ depth: number; title: string; lines: Line[] }> = [];
  let cur: { depth: number; title: string; lines: Line[] } | null = null;
  for (const line of fenceAware(body)) {
    const h = line.inFence ? null : HEADING.exec(line.text);
    if (h) {
      cur = { depth: h[1]!.length, title: h[2]!.trim(), lines: [] };
      headed.push(cur);
      continue;
    }
    (cur ? cur.lines : preamble).push(line);
  }
  return { preamble, headed };
}

export function parseTree(body: string): ProtocolTree {
  const { preamble, headed } = blocks(body);
  const tree: ProtocolTree = {
    preamble: preamble.map((l) => l.text).join("\n").trim(),
    sections: [],
  };
  if (headed.length === 0) return tree;

  const base = Math.min(...headed.map((h) => h.depth));
  // Stack of open sections by relative level (0 = top).
  const stack: Section[] = [];
  for (const h of headed) {
    const level = Math.min(h.depth - base, 1); // sections and one level of children
    while (stack.length > level) stack.pop();
    const parent = stack[stack.length - 1];
    const siblings = parent ? parent.children : tree.sections;
    const path = parent ? `${parent.path}.${siblings.length + 1}` : String(siblings.length + 1);
    const heading = parent ? `${parent.heading} › ${h.title}` : h.title;
    const { prose, steps } = parseBody(h.lines, path);
    const section: Section = { path, title: h.title, heading, prose, steps, children: [] };
    siblings.push(section);
    stack.push(section);
  }
  return tree;
}

// ---------- rendering --------------------------------------------------------

function renderSteps(steps: readonly Step[], indent = ""): string {
  return steps
    .map((s, i) => {
      const head = `${indent}${i + 1}. ${s.text}`;
      return s.substeps.length ? `${head}\n${renderSteps(s.substeps, `${indent}   `)}` : head;
    })
    .join("\n");
}

function renderSection(s: Section, depth: number): string {
  const parts = [`${"#".repeat(depth)} ${s.title}`];
  if (s.prose) parts.push("", s.prose);
  if (s.steps.length) parts.push("", renderSteps(s.steps));
  for (const c of s.children) parts.push("", renderSection(c, depth + 1));
  return parts.join("\n");
}

/** Markdown for a tree, with `##` for sections. The inverse of parseTree up to
 *  whitespace: parse(render(t)) equals t. */
export function renderTree(tree: ProtocolTree): string {
  const parts: string[] = [];
  if (tree.preamble) parts.push(tree.preamble);
  for (const s of tree.sections) parts.push(renderSection(s, 2));
  return parts.join("\n\n").replace(/\s+$/, "") + "\n";
}

/** The text of one section as a person reads it: prose, then steps. Child
 *  sections are their own units and are not included. */
export function sectionText(s: Section): string {
  const parts: string[] = [];
  if (s.prose) parts.push(s.prose);
  if (s.steps.length) parts.push(renderSteps(s.steps));
  return parts.join("\n\n");
}

/** A step with its sub-steps, as one readable unit. */
export function stepText(s: Step): string {
  return s.substeps.length ? `${s.text}\n${renderSteps(s.substeps, "   ")}` : s.text;
}

/** Every section in reading order, children after their parent. */
export function allSections(tree: ProtocolTree): Section[] {
  const out: Section[] = [];
  const walk = (s: Section) => {
    out.push(s);
    s.children.forEach(walk);
  };
  tree.sections.forEach(walk);
  return out;
}

/** Every step in reading order with the section it belongs to. Sub-steps are
 *  part of their step; they are not listed on their own. */
export function allSteps(tree: ProtocolTree): Array<{ section: Section; step: Step }> {
  const out: Array<{ section: Section; step: Step }> = [];
  for (const section of allSections(tree)) for (const step of section.steps) out.push({ section, step });
  return out;
}

/** The step at a dotted path, or null. */
export function stepAt(tree: ProtocolTree, path: string): Step | null {
  for (const { step } of allSteps(tree)) {
    if (step.path === path) return step;
    for (const sub of step.substeps) if (sub.path === path) return sub;
  }
  return null;
}

/** Items of the Materials section (any heading starting with "material"),
 *  one per bullet or line. Empty when there is no such section. */
export function materialsOf(tree: ProtocolTree): string[] {
  const section = allSections(tree).find((s) => /^materials?\b/i.test(s.title));
  if (!section) return [];
  const items: string[] = [];
  for (const line of section.prose.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("|")) continue;
    items.push(t.replace(/^[-*+]\s+/, ""));
  }
  for (const s of section.steps) items.push(s.text);
  return items;
}
