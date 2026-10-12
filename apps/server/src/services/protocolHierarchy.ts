/** Source-preserving protocol hierarchy. Node identity is scoped to a source
 * revision; dotted paths are addresses, never a limit on nesting depth. */
import { parseTree, type Section, type Step } from "./protocolTree";

export const PROTOCOL_INDEX_VERSION = "biopro-hierarchy-v1";
export interface ProtocolNode {
  id: string;
  parentId: string | null;
  path: string;
  grain: "section" | "step";
  heading: string;
  /** Original node text. Index-only outlines are never written here. */
  text: string;
}

export function markdownHierarchy(body: string): ProtocolNode[] {
  const tree = parseTree(body);
  const nodes: ProtocolNode[] = [];
  if (tree.preamble)
    nodes.push({
      id: "section:0",
      parentId: null,
      path: "0",
      grain: "section",
      heading: "Introduction",
      text: tree.preamble,
    });
  const step = (s: Step, parentId: string, heading: string) => {
    const id = `step:${s.path}`;
    nodes.push({
      id,
      parentId,
      path: s.path,
      grain: "step",
      heading,
      text: s.text,
    });
    for (const child of s.substeps) step(child, id, heading);
  };
  const section = (s: Section, parentId: string | null) => {
    const id = `section:${s.path}`;
    nodes.push({
      id,
      parentId,
      path: s.path,
      grain: "section",
      heading: s.heading,
      text: s.prose,
    });
    for (const child of s.steps) step(child, id, s.heading);
    for (const child of s.children) section(child, id);
  };
  for (const s of tree.sections) section(s, null);
  return nodes;
}

/** BioProCorpus uses both nested dictionaries and flat dotted-key maps.
 * Preserve its paths/text directly; rendering to Markdown is a display view. */
export function bioProHierarchy(
  raw: Record<string, unknown>,
  materials?: string,
): ProtocolNode[] {
  const entries = new Map<string, { title?: string; text?: string }>();
  const flatten = (value: Record<string, unknown>, prefix = "") => {
    for (const [key, v] of Object.entries(value)) {
      if (!/^\d+(\.\d+)*$/.test(key)) continue;
      const path =
        !prefix || key.startsWith(`${prefix}.`) ? key : `${prefix}.${key}`;
      const entry = entries.get(path) ?? {};
      if (typeof v === "string") entry.text = v;
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if (typeof obj.title === "string") entry.title = obj.title;
        if (typeof obj.text === "string") entry.text = obj.text;
        flatten(obj, path);
      }
      entries.set(path, entry);
    }
  };
  flatten(raw);
  for (const path of [...entries.keys()]) {
    let parent = path;
    while (parent.includes(".")) {
      parent = parent.slice(0, parent.lastIndexOf("."));
      if (!entries.has(parent)) entries.set(parent, {});
    }
  }
  const sorted = [...entries.keys()].toSorted((a, b) => {
    const x = a.split(".").map(Number),
      y = b.split(".").map(Number);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  });
  const nodes: ProtocolNode[] = [];
  const byPath = new Map<string, ProtocolNode>();
  if (materials?.trim())
    nodes.push({
      id: "section:materials",
      parentId: null,
      path: "materials",
      grain: "section",
      heading: "Materials",
      text: materials,
    });
  for (const path of sorted) {
    const entry = entries.get(path)!;
    const parentPath = path.includes(".")
      ? path.slice(0, path.lastIndexOf("."))
      : null;
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    const grain =
      entry.title !== undefined || entry.text === undefined
        ? "section"
        : "step";
    const heading = [parent?.heading, entry.title].filter(Boolean).join(" › ");
    const node: ProtocolNode = {
      id: `${grain}:${path}`,
      parentId: parent?.id ?? null,
      path,
      grain,
      heading,
      text: entry.text ?? "",
    };
    nodes.push(node);
    byPath.set(path, node);
  }
  return nodes;
}

/** Parent outlines aid discovery without embedding repeated copies of every
 * descendant. Exact source text remains available via node reads. */
export function hierarchyIndexText(
  node: ProtocolNode,
  children: readonly ProtocolNode[],
): string {
  const outline = children.map(
    (c) =>
      `${c.path}: ${c.grain === "section" ? c.heading.split(" › ").at(-1) : "Step"}`,
  );
  return [node.text, outline.length ? `Children:\n${outline.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

export function hierarchyNode(nodes: readonly ProtocolNode[], id?: string) {
  const node = id ? nodes.find((n) => n.id === id) : null;
  if (id && !node) return null;
  return {
    node: node ?? null,
    children: nodes.filter((n) => n.parentId === (node?.id ?? null)),
    ancestors: (() => {
      const ancestors: ProtocolNode[] = [];
      let parent = node?.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const value = nodes.find((n) => n.id === parent);
        if (!value) break;
        ancestors.unshift(value);
        parent = value.parentId;
      }
      return ancestors;
    })(),
  };
}

/** Legacy runs only retain their selected execution section. Do not pretend
 * that the missing parts of the original protocol can be reconstructed. */
export function snapshotHierarchy(snapshot: {
  sourceMarkdown?: string;
  section?: string | null;
  steps?: Array<{ n: number; text: string }>;
  materials?: Array<{ text: string }>;
}): ProtocolNode[] {
  if (snapshot.sourceMarkdown)
    return markdownHierarchy(snapshot.sourceMarkdown);
  return [
    {
      id: "section:steps",
      parentId: null,
      path: "steps",
      grain: "section",
      heading: snapshot.section ?? "Recorded execution steps",
      text: "",
    },
    ...(snapshot.steps ?? []).map(
      (s): ProtocolNode => ({
        id: `step:steps.${s.n}`,
        parentId: "section:steps",
        path: `steps.${s.n}`,
        grain: "step",
        heading: snapshot.section ?? "Recorded execution steps",
        text: s.text,
      }),
    ),
    {
      id: "section:materials",
      parentId: null,
      path: "materials",
      grain: "section",
      heading: "Recorded materials",
      text: (snapshot.materials ?? []).map((m) => m.text).join("\n"),
    },
  ];
}
