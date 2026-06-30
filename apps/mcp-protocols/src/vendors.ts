// The catalog of laboratory-protocol / reagent vendors this server can search.
//
// Each vendor exposes two things:
//   - searchUrl(query): a deterministic, always-valid deep link into the
//     vendor's own search page. This never fails and never gets bot-blocked —
//     it's a URL, not a fetch — so it's the guaranteed-useful part of every
//     result, even when live result extraction is blocked.
//   - ddgSite: the domain (optionally with a path prefix) used to scope a
//     DuckDuckGo `site:` query. DuckDuckGo indexes all of these vendors and is
//     reachable where the vendors themselves hard-block automated fetches
//     (Akamai/Cloudflare 403/503), so it is the universal content backend.
//
// Why not scrape each vendor's own search page directly? Empirically most of
// them (bio-rad, takarabio, cell.com/star-protocols, nature, idtdna, and
// intermittently sigma/neb) return 403/503 to non-browser clients regardless
// of User-Agent, and the ones that do respond are heavy JS apps with no stable
// result markup. One DuckDuckGo parser that works for all ten beats ten
// brittle per-vendor parsers that mostly don't.

export interface Vendor {
  /** Stable id used in tool arguments and CLI flags. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this vendor is good for (shown to the model so it can pick well). */
  blurb: string;
  /** Domain (optionally `domain/path`) scoping the DuckDuckGo `site:` query. */
  ddgSite: string;
  /** Build the vendor's own on-site search URL for `query`. */
  searchUrl: (query: string) => string;
}

const enc = encodeURIComponent;

export const VENDORS: Vendor[] = [
  {
    id: "star-protocols",
    name: "STAR Protocols (Cell Press)",
    blurb: "Peer-reviewed step-by-step life-science protocols.",
    ddgSite: "cell.com/star-protocols",
    searchUrl: (q) =>
      `https://www.cell.com/action/doSearch?journalCode=star-protocols&field1=AllField&text1=${enc(q)}`,
  },
  {
    id: "nature-protocols",
    name: "Nature Protocols",
    blurb: "Peer-reviewed protocols across the life sciences (often paywalled).",
    ddgSite: "nature.com/nprot",
    searchUrl: (q) => `https://www.nature.com/search?journal=nprot&q=${enc(q)}`,
  },
  {
    id: "thermofisher",
    name: "Thermo Fisher Scientific",
    blurb: "Reagents, kits, instruments; extensive product protocols and manuals.",
    ddgSite: "thermofisher.com",
    searchUrl: (q) =>
      `https://www.thermofisher.com/search/results?query=${enc(q)}&focusarea=Search%20All`,
  },
  {
    id: "qiagen",
    name: "QIAGEN",
    blurb: "Nucleic-acid extraction/purification kits and their handbooks.",
    ddgSite: "qiagen.com",
    searchUrl: (q) => `https://www.qiagen.com/us/search?q=${enc(q)}`,
  },
  {
    id: "neb",
    name: "New England Biolabs (NEB)",
    blurb: "Enzymes, cloning/library-prep reagents; detailed molecular-biology protocols.",
    ddgSite: "neb.com",
    searchUrl: (q) => `https://www.neb.com/en-us/search?searchValue=${enc(q)}`,
  },
  {
    id: "bio-rad",
    name: "Bio-Rad",
    blurb: "Electrophoresis, blotting, qPCR, chromatography reagents and protocols.",
    ddgSite: "bio-rad.com",
    searchUrl: (q) => `https://www.bio-rad.com/en-us/search?text=${enc(q)}`,
  },
  {
    id: "sigma-aldrich",
    name: "Sigma-Aldrich (Merck)",
    blurb: "Broad chemicals/biochemicals catalog; SDS and product protocols.",
    ddgSite: "sigmaaldrich.com",
    searchUrl: (q) =>
      `https://www.sigmaaldrich.com/US/en/search/${enc(q)}?focus=products&type=product`,
  },
  {
    id: "emd-millipore",
    name: "EMD Millipore (MilliporeSigma)",
    blurb: "Life-science reagents, filtration, antibodies; product protocols.",
    ddgSite: "emdmillipore.com",
    searchUrl: (q) =>
      `https://www.emdmillipore.com/US/en/search/-/Search?SearchTerm=${enc(q)}`,
  },
  {
    id: "takarabio",
    name: "Takara Bio",
    blurb: "cDNA synthesis, PCR, NGS library-prep kits and user manuals.",
    ddgSite: "takarabio.com",
    searchUrl: (q) => `https://www.takarabio.com/search?q=${enc(q)}`,
  },
  {
    id: "promega",
    name: "Promega",
    blurb: "Reporter assays, purification, cell-viability reagents and protocols.",
    ddgSite: "promega.com",
    searchUrl: (q) => `https://www.promega.com/search/?q=${enc(q)}`,
  },
  {
    id: "idt",
    name: "Integrated DNA Technologies (IDT)",
    blurb: "Custom oligos/primers/gBlocks; primer-design and oligo-handling protocols.",
    ddgSite: "idtdna.com",
    searchUrl: (q) => `https://www.idtdna.com/site/search?searchterm=${enc(q)}`,
  },
];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

export function getVendor(id: string): Vendor | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve a list of requested vendor ids to Vendor objects. Unknown ids are
 * collected separately so the caller can report them instead of silently
 * dropping them. With no ids (undefined/empty), every vendor is returned.
 */
export function resolveVendors(ids?: readonly string[]): {
  vendors: Vendor[];
  unknown: string[];
} {
  if (!ids || ids.length === 0) return { vendors: VENDORS, unknown: [] };
  const vendors: Vendor[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    const v = BY_ID.get(id);
    if (v) vendors.push(v);
    else unknown.push(raw);
  }
  return { vendors, unknown };
}

export const VENDOR_IDS = VENDORS.map((v) => v.id);
