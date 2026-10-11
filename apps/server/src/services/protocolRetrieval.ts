import type { ProtocolNode } from "./protocolHierarchy";

export const normalizeProtocolTitle = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Resolve only explicit identities. Ambiguous titles retain global retrieval;
 * words describing a protocol are not treated as a confident identity. */
export function resolveProtocolIdentity(query: string, headers: readonly { id: string; title: string }[]): string | null {
  // An explicitly titled target outranks incidental protocol names inside
  // quoted/shuffled steps. A missing target must not resolve to a distractor.
  const named = /\b(?:titled|named|called)\s+(?:"([^"]+)"|“([^”]+)”|'(.+?)'(?=\s|[.,?!]|$))/i.exec(query);
  const target = named?.[1] ?? named?.[2] ?? named?.[3];
  if (target) {
    const matches = headers.filter((h) => normalizeProtocolTitle(h.title) === normalizeProtocolTitle(target));
    return matches.length === 1 ? matches[0]!.id : null;
  }
  const quoted = [...query.matchAll(/["“]([^"”]+)["”]|'(.+?)'(?=\s+(?:in|protocol|procedure|and|for)\b|[.,?!]|$)/g)]
    .map((m) => normalizeProtocolTitle(m[1] ?? m[2]!));
  const normalized = ` ${normalizeProtocolTitle(query)} `;
  const mentionedIds = new Set(query.match(/library:[\w:.-]+/g) ?? []);
  const matches = headers.filter((h) => {
    const title = normalizeProtocolTitle(h.title);
    return query.trim() === h.id || mentionedIds.has(`library:${h.id}`) ||
      quoted.includes(title) || (title.length >= 16 && title.split(" ").length >= 3 && normalized.includes(` ${title} `));
  });
  return matches.length === 1 ? matches[0]!.id : null;
}

export interface ProtocolEvidence {
  protocolId: string;
  title: string;
  nodeId: string;
  path: string;
  heading: string;
  text: string;
  grain: "section" | "step";
}

/** Grow from ranked nodes through their source tree, with a serialized evidence
 * budget rather than a fixed number of small chunks. Never crop instructions.
 * Callers retain node IDs and a revision so omitted/oversized nodes can be read. */
export function expandProtocolEvidence(
  protocol: { id: string; title: string; nodes: readonly ProtocolNode[] },
  seeds: readonly string[],
  query: string,
  budget = 8000,
): ProtocolEvidence[] {
  const byId = new Map(protocol.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, ProtocolNode[]>();
  const positions = new Map<string, number>();
  for (const node of protocol.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    positions.set(node.id, siblings.length);
    siblings.push(node); children.set(node.parentId, siblings);
  }
  const priority: ProtocolNode[] = [];
  const seen = new Set<string>();
  const add = (node: ProtocolNode | undefined) => {
    if (node && !seen.has(node.id)) { seen.add(node.id); priority.push(node); }
  };
  for (const id of seeds) add(byId.get(id));
  for (const id of seeds) {
    const anchor = byId.get(id);
    let parent = anchor?.parentId;
    const ancestry = new Set<string>();
    while (parent && !ancestry.has(parent)) {
      ancestry.add(parent);
      const node = byId.get(parent); add(node); parent = node?.parentId;
    }
  }
  // Expand one ring at a time: children and adjacent siblings before distant
  // steps. The final evidence is restored to original source order.
  for (let i = 0; i < priority.length; i++) {
    const node = priority[i]!;
    const siblings = children.get(node.parentId) ?? [];
    const position = positions.get(node.id)!;
    add(siblings[position - 1]); add(siblings[position + 1]);
    for (const child of children.get(node.id) ?? []) add(child);
  }
  const terms = new Set(normalizeProtocolTitle(query).split(" ").filter((t) => t.length > 3));
  for (const node of protocol.nodes) {
    if (/material|note|caution|critical|troubleshoot/i.test(node.heading) &&
      normalizeProtocolTitle(`${node.heading} ${node.text}`).split(" ").some((t) => terms.has(t))) add(node);
  }
  const selected = new Map<string, ProtocolEvidence>();
  let used = 2;
  for (const node of priority) {
    if (!node.text.trim()) continue;
    const evidence = { protocolId: protocol.id, title: protocol.title, nodeId: node.id, path: node.path, heading: node.heading, text: node.text, grain: node.grain };
    const cost = JSON.stringify(evidence).length + 1;
    if (used + cost > budget) continue;
    selected.set(node.id, evidence); used += cost;
  }
  return protocol.nodes.flatMap((node) => selected.has(node.id) ? [selected.get(node.id)!] : []);
}
