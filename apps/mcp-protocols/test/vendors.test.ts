import { describe, it, expect } from "vitest";
import { VENDORS, VENDOR_IDS, getVendor, resolveVendors } from "../src/vendors.ts";

describe("vendor registry", () => {
  it("lists the ten requested vendors plus protocol journals", () => {
    // All ten reagent/oligo vendors from the brief, plus the two protocol journals.
    for (const id of [
      "thermofisher",
      "qiagen",
      "neb",
      "bio-rad",
      "sigma-aldrich",
      "emd-millipore",
      "takarabio",
      "promega",
      "idt",
      "star-protocols",
      "nature-protocols",
    ]) {
      expect(VENDOR_IDS, id).toContain(id);
    }
  });

  it("builds an encoded, vendor-specific search URL for every vendor", () => {
    for (const v of VENDORS) {
      const url = v.searchUrl("RNA extraction & cleanup");
      expect(url).toMatch(/^https:\/\//);
      // The space and ampersand must be percent-encoded, not raw.
      expect(url).not.toContain(" ");
      expect(url).toContain("RNA%20extraction%20%26%20cleanup");
    }
  });

  it("resolves known ids, defaults to all, and reports unknowns", () => {
    expect(getVendor("neb")?.name).toContain("New England Biolabs");
    expect(resolveVendors().vendors).toHaveLength(VENDORS.length);
    const { vendors, unknown } = resolveVendors(["neb", "NEB", "bogus"]);
    expect(vendors.map((v) => v.id)).toEqual(["neb", "neb"]); // case-insensitive
    expect(unknown).toEqual(["bogus"]);
  });
});
