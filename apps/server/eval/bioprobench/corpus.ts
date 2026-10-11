/** Raw source collections only. Benchmark task records never enter the index. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mapBioProRecord } from "../../src/services/library/ingest";
import { normalizeProtocolTitle } from "../../src/services/protocolRetrieval";

export const defaultManifest = fileURLToPath(new URL("./sources.json", import.meta.url));
export interface SourceSpec {
  file: string; source: string; url: string; revision: string; sha256: string;
  license: string; expectedRawRecords: number;
}
export interface Alias { protocolId: string; title: string; normalized: string; nodeId: string | null; path: string; }
export function sourceAliases(record: { id: string; title: string; hierarchy?: readonly { id: string; path: string; grain: string; heading: string }[] | undefined }): Alias[] {
  return [{ protocolId: record.id, title: record.title, normalized: normalizeProtocolTitle(record.title), nodeId: null, path: "" },
    ...(record.hierarchy ?? []).filter((n) => n.grain === "section" && n.heading && n.path !== "materials").map((n) => {
      const title = n.heading.split(" › ").at(-1)!;
      return { protocolId: record.id, title, normalized: normalizeProtocolTitle(title), nodeId: n.id, path: n.path };
    })];
}

export function readSourceManifest(file = defaultManifest): SourceSpec[] {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.sources) || !manifest.sources.length)
    throw new Error("Expected a nonempty version 1 source manifest");
  const files = new Set<string>(), sources = new Set<string>();
  for (const s of manifest.sources as SourceSpec[]) {
    if (!s.file || path.basename(s.file) !== s.file || !s.file.endsWith(".json") || files.has(s.file) || !s.source || sources.has(s.source) ||
      !/^[a-f0-9]{64}$/.test(s.sha256) || !s.url?.startsWith("https://") || !s.revision || !s.license || !Number.isInteger(s.expectedRawRecords) || s.expectedRawRecords < 1)
      throw new Error(`Invalid or duplicate source manifest entry: ${s.file}`);
    files.add(s.file); sources.add(s.source);
  }
  return manifest.sources;
}

export function loadCorpus(directory: string, manifestFile = defaultManifest) {
  const specs = readSourceManifest(manifestFile);
  const records: NonNullable<ReturnType<typeof mapBioProRecord>>[] = [];
  const aliases: Alias[] = [];
  const checksums: Record<string, string> = {};
  const audit: (SourceSpec & { accepted: number; rejected: { id: string; reason: string }[]; duplicates: string[]; revisions: { originalId: string; indexedId: string }[] })[] = [];
  const ids = new Map<string, Set<string>>();
  for (const spec of specs) {
    const filename = path.join(directory, spec.file);
    if (!fs.existsSync(filename)) throw new Error(`Missing required source ${spec.file}; run fetchCorpus.py --out ${directory}`);
    const bytes = fs.readFileSync(filename);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== spec.sha256) throw new Error(`Checksum mismatch: ${spec.file}`);
    checksums[spec.file] = hash;
    const raw = JSON.parse(bytes.toString());
    if (!Array.isArray(raw) || raw.length !== spec.expectedRawRecords) throw new Error(`Record count mismatch: ${spec.file}`);
    const entry = { ...spec, accepted: 0, rejected: [] as { id: string; reason: string }[], duplicates: [] as string[], revisions: [] as { originalId: string; indexedId: string }[] };
    for (const row of raw) {
      if (!row || typeof row.id !== "string" || typeof row.title !== "string" || !row.hierarchical_protocol || typeof row.hierarchical_protocol !== "object" || Array.isArray(row.hierarchical_protocol) ||
        ["question", "answer", "correct_steps", "wrong_steps", "generated_response", "corrected_text", "corrupted_text", "instruction", "output"].some((field) => field in row))
        throw new Error(`Not a raw protocol source record: ${spec.file}:${row?.id}`);
      const id = `${spec.source}:${row.id}`;
      const record = mapBioProRecord(row, { source: spec.source, license: spec.license });
      if (!record) { entry.rejected.push({ id, reason: "no usable procedure steps" }); continue; }
      // Upstream repeats IDs, sometimes with different source content. Deduplicate
      // identical mapped records; preserve conflicting versions under explicit IDs.
      // Never let a Map silently overwrite a version while FTS retains both.
      const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
      const versions = ids.get(id) ?? new Set<string>();
      if (versions.has(hash)) { entry.duplicates.push(id); continue; }
      if (versions.size) {
        record.id = `${id}:revision:${hash}`;
        entry.revisions.push({ originalId: id, indexedId: record.id });
      }
      versions.add(hash); ids.set(id, versions);
      records.push(record); aliases.push(...sourceAliases(record)); entry.accepted++;
    }
    audit.push(entry);
  }
  return { records, aliases, checksums, audit };
}
