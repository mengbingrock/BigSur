import { describe, expect, it } from "vitest";
import { confidenceLabel, isLibrarySlug, libraryIdOf, whereLabel } from "./protocolHits";

describe("protocol hit helpers", () => {
  it("tells library slugs from own ones and recovers the id", () => {
    expect(isLibrarySlug("library:protocol-io:Protocol.io-0")).toBe(true);
    expect(isLibrarySlug("user--gibson-assembly")).toBe(false);
    expect(libraryIdOf("library:protocol-io:Protocol.io-0")).toBe("protocol-io:Protocol.io-0");
    expect(libraryIdOf("user--gibson-assembly")).toBe("user--gibson-assembly");
  });

  it("names where a hit matched by its grain", () => {
    expect(whereLabel({ heading: "Reaction", path: "2.3", grain: "step" })).toBe("Reaction › step 3");
    expect(whereLabel({ heading: "", path: "1.2", grain: "step" })).toBe("step 2");
    expect(whereLabel({ heading: "Materials", path: "1", grain: "section" })).toBe("Materials");
    expect(whereLabel({ heading: "", path: "", grain: "summary" })).toBe("");
  });

  it("words a confidence, flagging a low one", () => {
    expect(confidenceLabel(null)).toBeNull();
    expect(confidenceLabel(0.85)).toEqual({ text: "Confidence 85%", low: false });
    expect(confidenceLabel(0.2)).toEqual({ text: "Low confidence (20%) — check the source", low: true });
  });
});
