import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadCorpus } from "../eval/bioprobench/corpus";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const row = (id = "1", text = "Measure the inert reference.") => ({ id, title: "Reference check", hierarchical_protocol: { "1": { title: "Preparation", "1.1": text } } });
function fixture(collections: unknown[][]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "biopro-corpus-")); dirs.push(dir);
  const sources = collections.map((rows, i) => {
    const file = `source-${i}.json`, data = JSON.stringify(rows);
    fs.writeFileSync(path.join(dir, file), data);
    return { file, source: `source-${i}`, sha256: createHash("sha256").update(data).digest("hex"), url: `https://example.org/revision/${file}`, revision: "pinned", license: "isolated test", expectedRawRecords: rows.length };
  });
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, sources }));
  return { dir, manifest };
}
describe("BioProBench corpus completeness", () => {
  it("loads every declared collection, retains section addresses, and accounts for unusable records", () => {
    const { dir, manifest } = fixture([[row()], [row()], [row(), { ...row("empty"), hierarchical_protocol: { "1": { title: "Empty" } } }]]);
    const corpus = loadCorpus(dir, manifest);
    expect(corpus.records).toHaveLength(3);
    expect(new Set(corpus.records.map((r) => r.id)).size).toBe(3);
    expect(corpus.aliases.find((a) => a.protocolId === "source-2:1" && a.title === "Preparation")).toMatchObject({ nodeId: "section:1", path: "1", normalized: "preparation" });
    expect(corpus.audit[2]?.rejected).toEqual([{ id: "source-2:empty", reason: "no usable procedure steps" }]);
  });
  it("fails closed on missing or changed sources", () => {
    const { dir, manifest } = fixture([[row()], [row()]]);
    fs.rmSync(path.join(dir, "source-1.json"));
    expect(() => loadCorpus(dir, manifest)).toThrow("Missing required source");
    fs.writeFileSync(path.join(dir, "source-1.json"), "[]");
    expect(() => loadCorpus(dir, manifest)).toThrow("Checksum mismatch");
  });
  it("rejects benchmark answer records even in a checksum-valid manifest", () => {
    const { dir, manifest } = fixture([[{ ...row(), question: "A held-out question", answer: "hidden" }]]);
    expect(() => loadCorpus(dir, manifest)).toThrow("Not a raw protocol source record");
  });
  it("deduplicates identical records and preserves conflicting source versions with stable IDs", () => {
    const { dir, manifest } = fixture([[row(), row(), row("1", "Different source version.")]]);
    const corpus = loadCorpus(dir, manifest);
    expect(corpus.records).toHaveLength(2);
    expect(corpus.audit[0]?.duplicates).toEqual(["source-0:1"]);
    expect(corpus.records[1]?.id).toMatch(/^source-0:1:revision:[a-f0-9]{64}$/);
    expect(loadCorpus(dir, manifest).records.map((r) => r.id)).toEqual(corpus.records.map((r) => r.id));
  });
});
