// The chunker must always move forward. A break point just past the minimum
// tail used to make the window's advance zero, and a protocol with a short
// paragraph before a long step list then looped until the process ran out of
// memory — on the box, while ingesting the shared library.
import { describe, expect, it } from "vitest";
import { chunkArtifact, chunkProtocol } from "../src/services/artifactIndex/chunk";

/** A ~130-character paragraph, a blank line, then a list far longer than one
 *  window: the exact shape that hung. */
function pathological(): string {
  const para = "Prepare the plate the day before. Keep everything cold and work quickly once the cells are out of the incubator, please.";
  const steps = Array.from({ length: 80 }, (_, i) => `${i + 1}. Add ${10 + i} ul of buffer and incubate ${5 + i} min at 37 C.`).join("\n");
  return `## Procedure\n\n${para}\n\n${steps}\n`;
}

describe("chunker termination", () => {
  it("finishes on a short paragraph followed by a long list, in bounded chunks", () => {
    const body = pathological();
    const started = Date.now();
    const chunks = chunkArtifact(body);
    expect(Date.now() - started).toBeLessThan(2000);
    // Roughly body length / (window − overlap); never thousands.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(20);
    // Every chunk carries text, and the first begins with the paragraph.
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks[0]!.text.startsWith("Prepare the plate")).toBe(true);
    // Nothing is lost: the last step appears somewhere.
    expect(chunks.some((c) => c.text.includes("80. Add 89 ul"))).toBe(true);
  });

  it("still overlaps windows so a step spanning a cut appears whole", () => {
    const steps = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step number ${i + 1} with enough words to take up some room in the window.`).join("\n");
    const chunks = chunkArtifact(`## Steps\n\n${steps}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    // Consecutive chunks share text: the overlap.
    const firstLineOfSecond = chunks[1]!.text.split("\n")[0]!;
    expect(chunks[0]!.text).toContain(firstLineOfSecond);
  });

  it("chunks a protocol with the same shape at all three grains without hanging", () => {
    const started = Date.now();
    const chunks = chunkProtocol({ name: "Plate prep", description: "Prepares a plate.", body: pathological() });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(chunks.filter((c) => c.grain === "summary")).toHaveLength(1);
    expect(chunks.filter((c) => c.grain === "step")).toHaveLength(80);
    expect(chunks.filter((c) => c.grain === "section").length).toBeLessThan(20);
  });
});
