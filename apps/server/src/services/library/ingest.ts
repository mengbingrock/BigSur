// Ingest: a source corpus → library rows.
//
// The only corpus shape so far is BioProCorpus's (the BioProBench JSON files):
// a `hierarchical_protocol` tree keyed by dotted step numbers, with a purpose
// layer beside it. It is rendered into Labee's markdown — sections and
// numbered steps — through the same tree renderer the personal library uses,
// so one chunker, one linter and one reviewer serve both.
//
// Licence is not read from the record, because the records do not carry one:
// the operator asserts it for the file being ingested, and only files under
// a licence on the allow-list go in. CC BY is in; NC and SA variants are not.
import { renderTree, type ProtocolTree, type Section, type Step } from "../protocolTree";
import { embedLibraryPending, upsertLibraryProtocol, type LibraryRecord } from "./store";
import { resolveEmbedTarget } from "../artifactIndex/embed";

/** Licences the library may carry. Compared case- and punctuation-insensitively. */
export const DEFAULT_ALLOWED_LICENSES = ["CC BY 4.0", "CC BY 3.0", "CC BY", "CC0 1.0", "CC0", "Public domain"];

const normLicence = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function licenseAllowed(license: string, allow: readonly string[] = DEFAULT_ALLOWED_LICENSES): boolean {
  const l = normLicence(license);
  if (!l) return false;
  // "cc by nc 4 0" must not pass because it starts with "cc by".
  if (/\b(nc|nd|sa)\b/.test(l)) return allow.some((a) => normLicence(a) === l);
  return allow.some((a) => normLicence(a) === l);
}

/** A record as BioProCorpus writes it; only the fields used. */
export interface BioProRecord {
  id: string;
  url?: string;
  title?: string;
  keywords?: string;
  abstract?: string;
  description?: string;
  input?: string;
  hierarchical_protocol?: Record<string, unknown>;
  problem?: string;
  method?: string;
  innovation?: string;
  application?: string;
  classification?: { primary_domain?: string; all_domains?: string[]; confidence?: number };
}

/** Collapse the hard line breaks scraping left mid-sentence. */
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();

const isPath = (k: string) => /^\d+(\.\d+)*$/.test(k);

function byPath(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** One node of the corpus tree: a titled group, a step's text, or both. */
interface RawNode {
  title?: string;
  text?: string;
}

/**
 * The corpus writes the tree in two shapes, sometimes mixed: nested, where
 * "1" is a dict holding "1.1", "1.2"; and flat, where "1.1" and "1.2" sit
 * beside "1" at the top. Both reduce to one map of dotted path → node.
 */
function flattenTree(hp: Record<string, unknown>, prefix = "", out = new Map<string, RawNode>()): Map<string, RawNode> {
  for (const key of Object.keys(hp)) {
    if (!isPath(key)) continue;
    const path = !prefix || key.startsWith(`${prefix}.`) ? key : `${prefix}.${key}`;
    const v = hp[key];
    const node = out.get(path) ?? {};
    if (typeof v === "string") {
      const text = oneLine(v);
      if (text) node.text = text;
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.title === "string" && o.title.trim()) node.title = oneLine(o.title);
      flattenTree(o, path, out);
    }
    if (node.title || node.text) out.set(path, node);
  }
  return out;
}

interface Built extends RawNode {
  path: string;
  children: Built[];
}

/** Hang every node under its parent by path; a missing parent is made up so
 *  "2.1" with no "2" still has somewhere to go. */
function buildTree(nodes: Map<string, RawNode>): Built[] {
  const built = new Map<string, Built>();
  const get = (path: string): Built => {
    let b = built.get(path);
    if (!b) {
      b = { path, children: [], ...(nodes.get(path) ?? {}) };
      built.set(path, b);
      const parent = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : null;
      if (parent) get(parent).children.push(b);
    }
    return b;
  };
  for (const path of [...nodes.keys()].sort(byPath)) get(path);
  for (const b of built.values()) b.children.sort((x, y) => byPath(x.path, y.path));
  return [...built.values()].filter((b) => !b.path.includes(".")).sort((x, y) => byPath(x.path, y.path));
}

/** A node (and everything under it) as a step with sub-steps. Deeper levels
 *  are flattened into the sub-steps, in order, since the tree keeps one. */
function toStep(b: Built, path: string): Step {
  const step: Step = { path, text: b.text ?? b.title ?? `Part ${b.path}`, substeps: [] };
  const walk = (n: Built) => {
    for (const c of n.children) {
      const text = c.text ?? c.title;
      if (text) step.substeps.push({ path: `${path}.${step.substeps.length + 1}`, text, substeps: [] });
      walk(c);
    }
  };
  walk(b);
  return step;
}

/** A titled node as a section: its titled children become child sections
 *  (one level), everything else becomes steps. */
function toSection(b: Built, path: string, parentHeading: string, depth: number): Section {
  const title = b.title ?? `Part ${b.path}`;
  const heading = parentHeading ? `${parentHeading} › ${title}` : title;
  const section: Section = { path, title, heading, prose: "", steps: [], children: [] };
  if (b.text) section.steps.push({ path: `${path}.1`, text: b.text, substeps: [] });
  for (const c of b.children) {
    const group = Boolean(c.title) && c.children.length > 0;
    if (group && depth < 1) {
      section.children.push(toSection(c, `${path}.${section.children.length + 1}`, heading, depth + 1));
    } else {
      section.steps.push(toStep(c, `${path}.${section.steps.length + 1}`));
    }
  }
  return section;
}

/** The materials list from the corpus's `input` field, one item per line. */
function materialsFrom(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[-*•]\s*/, ""))
    .filter((l) => l.length > 1);
}

function keywordsFrom(raw: string | undefined): string[] {
  if (!raw || raw.trim().toLowerCase() === "null") return [];
  return raw
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** One corpus record → a library record, or null when it has no steps. */
export function mapBioProRecord(raw: BioProRecord, opts: { source: string; license: string }): LibraryRecord | null {
  const tree: ProtocolTree = { preamble: "", sections: [] };
  const materials = materialsFrom(raw.input);
  if (materials.length) {
    tree.sections.push({ path: "1", title: "Materials", heading: "Materials", prose: materials.map((m) => `- ${m}`).join("\n"), steps: [], children: [] });
  }
  // Titled top-level nodes are sections. Bare steps at the top — a protocol
  // written as a plain numbered list — gather into one "Procedure" section.
  let procedure: Section | null = null;
  for (const root of buildTree(flattenTree(raw.hierarchical_protocol ?? {}))) {
    if (root.title) {
      tree.sections.push(toSection(root, String(tree.sections.length + 1), "", 0));
      continue;
    }
    if (!procedure) {
      const path = String(tree.sections.length + 1);
      procedure = { path, title: "Procedure", heading: "Procedure", prose: "", steps: [], children: [] };
      tree.sections.push(procedure);
    }
    procedure.steps.push(toStep(root, `${procedure.path}.${procedure.steps.length + 1}`));
  }
  const hasSteps = tree.sections.some((s) => s.steps.length > 0 || s.children.some((c) => c.steps.length > 0));
  if (!hasSteps) return null;

  const title = oneLine(raw.title ?? "") || `Protocol ${raw.id}`;
  const description = oneLine(raw.abstract ?? raw.description ?? "");
  const domains = (raw.classification?.all_domains ?? []).map(oneLine).filter(Boolean).slice(0, 4);
  return {
    id: `${opts.source}:${raw.id}`,
    source: opts.source,
    sourceUrl: (raw.url ?? "").trim(),
    doi: /doi\.org\//.test(raw.url ?? "") ? (raw.url ?? "").trim().replace(/^.*doi\.org\//, "") : undefined,
    license: opts.license,
    title,
    description: description.slice(0, 600),
    category: raw.classification?.primary_domain ? oneLine(raw.classification.primary_domain) : undefined,
    domains,
    keywords: keywordsFrom(raw.keywords),
    problem: raw.problem ? oneLine(raw.problem) : undefined,
    method: raw.method ? oneLine(raw.method) : undefined,
    application: raw.application ? oneLine(raw.application) : undefined,
    body: renderTree(tree),
  };
}

export interface IngestReport {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Records with no steps, or under a licence not allowed. */
  skipped: number;
  embedded: number;
}

/**
 * Ingest mapped records. `embed` runs the embedding pass afterwards, in
 * batches, until nothing is pending; without a credential it is skipped and
 * the words alone make the rows searchable.
 */
export async function ingestRecords(
  records: readonly LibraryRecord[],
  opts: { allow?: readonly string[]; embed?: boolean; email?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<IngestReport> {
  const report: IngestReport = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, embedded: 0 };
  let done = 0;
  for (const r of records) {
    done += 1;
    if (!licenseAllowed(r.license, opts.allow)) {
      report.skipped += 1;
      continue;
    }
    const what = await upsertLibraryProtocol(r);
    report[what] += 1;
    opts.onProgress?.(done, records.length);
  }
  if (opts.embed) {
    const target = await resolveEmbedTarget(opts.email);
    if (target) {
      for (;;) {
        const n = await embedLibraryPending(target, { limit: 20 });
        if (n === 0) break;
        report.embedded += n;
      }
    }
  }
  return report;
}
