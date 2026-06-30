import { describe, it, expect } from "vitest";
import { parseHtmlResults, parseLiteResults, ddgSearch } from "../src/ddg.ts";

// A trimmed sample of the rich html.duckduckgo.com results markup.
const HTML_SAMPLE = `
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.takarabio.com%2Fproducts%2Fcdna&amp;rut=abc">
      SMARTer cDNA Synthesis Kit &amp; Guide
    </a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">
    A <b>cDNA</b> synthesis protocol with high yield.
  </a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.takarabio.com%2Fmanual.pdf">
      PrimeScript Manual
    </a>
  </h2>
</div>
`;

// A trimmed sample of the minimal lite.duckduckgo.com table markup.
const LITE_SAMPLE = `
<table>
  <tr><td><a rel="nofollow" href="https://www.neb.com/en-us/products/m0491" class="result-link">Q5 High-Fidelity DNA Polymerase</a></td></tr>
  <tr><td class="result-snippet">High-fidelity PCR with very low error rate.</td></tr>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.neb.com%2Fprotocols%2Fpcr" class="result-link">PCR Protocol</a></td></tr>
  <tr><td class="result-snippet">Standard PCR cycling conditions.</td></tr>
</table>
`;

describe("parseHtmlResults", () => {
  it("unwraps uddg redirect URLs and decodes entities", () => {
    const out = parseHtmlResults(HTML_SAMPLE, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: "SMARTer cDNA Synthesis Kit & Guide",
      url: "https://www.takarabio.com/products/cdna",
    });
    expect(out[0]!.snippet).toContain("cDNA synthesis protocol");
    expect(out[1]!.url).toBe("https://www.takarabio.com/manual.pdf");
  });

  it("respects the limit and dedupes repeated urls", () => {
    expect(parseHtmlResults(HTML_SAMPLE, 1)).toHaveLength(1);
    expect(parseHtmlResults(HTML_SAMPLE + HTML_SAMPLE, 10)).toHaveLength(2);
  });
});

describe("parseLiteResults", () => {
  it("extracts direct and wrapped links with their following snippets", () => {
    const out = parseLiteResults(LITE_SAMPLE, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: "Q5 High-Fidelity DNA Polymerase",
      url: "https://www.neb.com/en-us/products/m0491",
      snippet: "High-fidelity PCR with very low error rate.",
    });
    expect(out[1]!.url).toBe("https://www.neb.com/protocols/pcr");
  });

  it("returns nothing for a CAPTCHA/challenge page", () => {
    expect(parseLiteResults("<html><body>complete the challenge</body></html>", 5)).toEqual([]);
  });
});

describe("ddgSearch", () => {
  it("returns lite results when the lite endpoint answers", async () => {
    const fakeFetch = (async () =>
      new Response(LITE_SAMPLE, { status: 200 })) as unknown as typeof fetch;
    const res = await ddgSearch("site:neb.com pcr", { fetchImpl: fakeFetch });
    expect(res.status).toBe(200);
    expect(res.results).toHaveLength(2);
    expect(res.error).toBeUndefined();
  });

  it("falls back to the html endpoint when lite has no results", async () => {
    const fakeFetch = (async (url: string) =>
      new Response(url.includes("/lite") ? "<html>challenge</html>" : HTML_SAMPLE, {
        status: 200,
      })) as unknown as typeof fetch;
    const res = await ddgSearch("site:takarabio.com cdna", { fetchImpl: fakeFetch });
    expect(res.results).toHaveLength(2);
    expect(res.results[0]!.url).toContain("takarabio.com");
  });

  it("retries both endpoints then reports an error when all are rate-limited", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("<html>challenge</html>", { status: 202 });
    }) as unknown as typeof fetch;
    const res = await ddgSearch("site:neb.com ligase", { fetchImpl: fakeFetch, timeoutMs: 1000 });
    expect(calls).toBe(4); // 2 endpoints x 2 attempts
    expect(res.results).toEqual([]);
    expect(res.error).toMatch(/HTTP 202/);
  });
});
