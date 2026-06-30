import { describe, it, expect } from "vitest";
import { searchProtocols, renderMarkdown } from "../src/search.ts";

// Lite-format markup mixing results from two vendors, returned for a combined
// `(site:neb.com OR site:takarabio.com) ...` query.
const MIXED_LITE = `
<table>
  <tr><td><a href="https://www.neb.com/en-us/products/m0491" class="result-link">Q5 Polymerase</a></td></tr>
  <tr><td class="result-snippet">High-fidelity PCR.</td></tr>
  <tr><td><a href="https://www.takarabio.com/products/cdna" class="result-link">SMARTer cDNA Kit</a></td></tr>
  <tr><td class="result-snippet">cDNA synthesis.</td></tr>
  <tr><td><a href="https://www.neb.com/protocols/pcr" class="result-link">PCR Protocol</a></td></tr>
  <tr><td class="result-snippet">Cycling conditions.</td></tr>
</table>
`;

describe("searchProtocols", () => {
  const fakeFetch = (async () =>
    new Response(MIXED_LITE, { status: 200 })) as unknown as typeof fetch;

  it("buckets combined-query results back to the right vendor by URL", async () => {
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "takarabio"],
      ddg: { fetchImpl: fakeFetch },
    });
    const neb = resp.vendors.find((v) => v.id === "neb")!;
    const takara = resp.vendors.find((v) => v.id === "takarabio")!;
    expect(neb.results.map((r) => r.title)).toEqual(["Q5 Polymerase", "PCR Protocol"]);
    expect(takara.results.map((r) => r.title)).toEqual(["SMARTer cDNA Kit"]);
    expect(resp.partial).toBe(false);
  });

  it("always attaches a deterministic vendor search URL", async () => {
    const resp = await searchProtocols("gibson assembly", {
      vendors: ["neb"],
      ddg: { fetchImpl: fakeFetch },
    });
    expect(resp.vendors[0]!.searchUrl).toBe(
      "https://www.neb.com/en-us/search?searchValue=gibson%20assembly",
    );
  });

  it("reports unknown vendor ids and an empty query", async () => {
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "nope"],
      ddg: { fetchImpl: fakeFetch },
    });
    expect(resp.unknownVendors).toEqual(["nope"]);
    expect((await searchProtocols("   ")).query).toBe("");
  });

  it("marks the response partial and still returns search URLs when rate-limited", async () => {
    const blocked = (async () =>
      new Response("<html>challenge</html>", { status: 202 })) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb"],
      ddg: { fetchImpl: blocked, timeoutMs: 500 },
    });
    expect(resp.partial).toBe(true);
    expect(resp.vendors[0]!.results).toEqual([]);
    expect(resp.vendors[0]!.error).toBeTruthy();
    expect(resp.vendors[0]!.searchUrl).toContain("neb.com");
    expect(renderMarkdown(resp)).toContain("rate-limited");
  });

  it("does not cross-attribute lookalike hostnames", async () => {
    const evil = (async () =>
      new Response(
        `<table><tr><td><a href="https://neb.com.evil.com/x" class="result-link">Phish</a></td></tr></table>`,
        { status: 200 },
      )) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb"],
      ddg: { fetchImpl: evil },
    });
    expect(resp.vendors[0]!.results).toEqual([]);
  });
});
