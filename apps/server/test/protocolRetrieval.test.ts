import { describe, expect, it } from "vitest";
import { bioProHierarchy } from "../src/services/protocolHierarchy";
import { expandProtocolEvidence, resolveProtocolIdentity } from "../src/services/protocolRetrieval";
import { applyTestEnv } from "./helpers/env";
applyTestEnv("protocol-retrieval");
process.env.LABEE_EMBED_PROVIDER = "fake";

describe("protocol identity and source context", () => {
  it("routes explicit titles and IDs, but preserves ambiguous/global queries", () => {
    const headers = [{ id: "one", title: "Exact buffer preparation" }, { id: "two", title: "Other buffer preparation" }];
    expect(resolveProtocolIdentity("Sort steps titled 'Exact buffer preparation' in the correct order", headers)).toBe("one");
    expect(resolveProtocolIdentity("What comes after mixing in Exact buffer preparation?", headers)).toBe("one");
    expect(resolveProtocolIdentity("library:two", headers)).toBe("two");
    expect(resolveProtocolIdentity("library:two-other", headers)).toBeNull();
    expect(resolveProtocolIdentity("Sort steps titled 'Missing protocol' in the correct order. Exact buffer preparation", headers)).toBeNull();
    expect(resolveProtocolIdentity("Sort steps titled 'Exact buffer preparation' in the correct order. Other buffer preparation", headers)).toBe("one");
    expect(resolveProtocolIdentity("How to prepare a buffer?", headers)).toBeNull();
    expect(resolveProtocolIdentity("Exact buffer preparation", [...headers, { id: "copy", title: headers[0]!.title }])).toBeNull();
  });
  it("fills a budget with original ordered siblings, parents and substeps without truncating or repeating nodes", () => {
    const nodes = bioProHierarchy({ "1": { title: "Preparation", text: "Keep the parent qualification.", "1.1": "First instruction.", "1.2": { text: "Second instruction.", "1.2.1": "Required substep." }, "1.3": "Third instruction." } });
    const evidence = expandProtocolEvidence({ id: "p", title: "P", nodes }, ["step:1.2", "step:1.2"], "preparation", 2000);
    expect(evidence.map((n) => n.path)).toEqual(["1", "1.1", "1.2", "1.2.1", "1.3"]);
    expect(evidence.map((n) => n.text)).toEqual(nodes.map((n) => n.text));
    const limited = expandProtocolEvidence({ id: "p", title: "P", nodes }, ["step:1.2"], "", 190);
    expect(JSON.stringify(limited).length).toBeLessThanOrEqual(190);
    expect(limited.map((n) => n.text)).toEqual(["Second instruction."]);
    expect(expandProtocolEvidence({ id: "p", title: "P", nodes }, ["step:missing"], "", 2000)).toEqual([]);
  });
  it("selects a title absent from step text and returns revision-linked expanded library evidence", async () => {
    const { upsertLibraryProtocol, getLibraryProtocol } = await import("../src/services/library/store");
    const { searchLibrary, libraryPassages } = await import("../src/services/library/search");
    const r = { id: "unique", source: "test", sourceUrl: "https://example.invalid/unique", license: "test", title: "Violet calibration procedure", description: "", domains: [], keywords: [], body: "", hierarchy: bioProHierarchy({ "1": { title: "Sequence", "1.1": "First alpha.", "1.2": "Second beta.", "1.3": "Third gamma." } }) };
    await upsertLibraryProtocol(r);
    await upsertLibraryProtocol({ ...r, id: "distractor", title: "Unrelated", body: "## Violet calibration procedure\n1. Wrong instruction.", hierarchy: undefined });
    const found = await searchLibrary("Violet calibration procedure");
    expect(found?.hits.map((h) => h.id)).toEqual(["unique"]);
    const evidence = await libraryPassages("Violet calibration procedure");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.nodeIds).toEqual(["step:1.1", "step:1.2", "step:1.3"]);
    expect(evidence[0]?.revision).toBe((await getLibraryProtocol("unique"))?.contentHash);
    expect(evidence[0]?.text).not.toContain("Wrong instruction");
    const broad = await libraryPassages("First alpha");
    expect(broad.some((p) => p.text.includes("First alpha"))).toBe(true);
    expect(broad.every((p) => !p.nodeIds)).toBe(true);
    const explicit = await libraryPassages("First alpha", { expand: true });
    expect(explicit.some((p) => p.nodeIds?.includes("step:1.2"))).toBe(true);
    const { retrieveContext } = await import("../src/services/context/service");
    const read = await retrieveContext("reader@example.invalid", { tool: "protocols.read", protocolSlug: "library:unique", nodeId: "step:1.2", part: "context" });
    expect((read.items[0]?.evidence as Array<{ path: string }>).map((n) => n.path)).toEqual(["1.1", "1.2", "1.3"]);
    await upsertLibraryProtocol({ ...r, description: "New revision" });
    await expect(retrieveContext("reader@example.invalid", { tool: "protocols.read", protocolSlug: "library:unique", part: "context", revision: read.items[0]?.revision })).rejects.toMatchObject({ status: 409 });
  });
});
