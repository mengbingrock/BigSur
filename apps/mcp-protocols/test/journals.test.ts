import { describe, it, expect } from "vitest";
import { searchJournal } from "../src/journals.ts";
import type { JournalInfo } from "../src/vendors.ts";

const STAR: JournalInfo = { crossrefContainer: "STAR Protocols", europepmcJournal: "STAR Protocols" };

const CROSSREF_BODY = JSON.stringify({
  message: {
    items: [
      {
        title: ["CRISPR knockout protocol"],
        DOI: "10.1016/j.xpro.2023.102406",
        URL: "https://doi.org/10.1016/j.xpro.2023.102406",
        abstract: "<jats:p>A <b>CRISPR</b> protocol.</jats:p>",
      },
    ],
  },
});

const EUROPEPMC_BODY = JSON.stringify({
  resultList: { result: [{ title: "Backup CRISPR protocol", doi: "10.1016/j.xpro.2024.1", abstractText: "x" }] },
});

describe("searchJournal", () => {
  it("uses Crossref first and maps items to results", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toContain("api.crossref.org");
      expect(url).toContain("container-title:STAR");
      return new Response(CROSSREF_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR knockout", 3, { fetchImpl: fakeFetch });
    expect(out.source).toBe("crossref");
    expect(out.results[0]).toMatchObject({
      title: "CRISPR knockout protocol",
      url: "https://doi.org/10.1016/j.xpro.2023.102406",
    });
    expect(out.results[0]!.snippet).toContain("CRISPR protocol"); // tags stripped
  });

  it("falls back to Europe PMC when Crossref fails", async () => {
    const fakeFetch = (async (url: string) => {
      if (url.includes("crossref")) return new Response("oops", { status: 500 });
      expect(url).toContain("europepmc");
      return new Response(EUROPEPMC_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: fakeFetch });
    expect(out.source).toBe("europepmc");
    expect(out.results[0]!.url).toBe("https://doi.org/10.1016/j.xpro.2024.1");
  });

  it("reports an error when both backends are empty", async () => {
    const fakeFetch = (async (url: string) =>
      new Response(JSON.stringify(url.includes("crossref") ? { message: { items: [] } } : { resultList: { result: [] } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "zzz", 3, { fetchImpl: fakeFetch });
    expect(out.results).toEqual([]);
    expect(out.error).toBeTruthy();
  });
});
