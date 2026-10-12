import { describe, expect, it } from "vitest";
import { canonicalProtocolText, paperChunks, paperProfile, selectPaperPassages, taskQuery } from "../eval/bioprobench/contextProfiles";

describe("paper-context evaluation policy", () => {
  it("routes tasks explicitly and preserves ranked whole chunks beyond 8000 characters", () => {
    const ranked = Array.from({ length: 8 }, (_, rank) => ({ rank, text: "x".repeat(5000) }));
    for (const task of ["PQA", "ERR", "ORD", "GEN"]) {
      const count = task === "PQA" || task === "ERR" ? 5 : 3;
      expect(paperProfile(task)).toBe(count === 5 ? "small" : "large");
      expect(selectPaperPassages(ranked, task)).toEqual(ranked.slice(0, count));
      expect(selectPaperPassages(ranked, task).reduce((n, c) => n + c.text.length, 0)).toBeGreaterThan(8000);
      expect(selectPaperPassages([], task)).toEqual([]);
      expect(selectPaperPassages(ranked.slice(0, 1), task)).toHaveLength(1);
    }
    expect(() => paperProfile("unknown")).toThrow("Unsupported");
  });
  it("has exact code-point lengths, overlaps and recoverable half-open offsets without splitting Unicode", () => {
    const text = "A🧪β\n".repeat(3100), points = Array.from(text);
    for (const [profile, size, overlap] of [["small", 2000, 400], ["large", 5000, 1000]] as const) {
      const chunks = paperChunks(text, profile);
      for (const [i, chunk] of chunks.entries()) {
        expect(chunk.text).toBe(points.slice(chunk.startChar, chunk.endChar).join(""));
        expect(Array.from(chunk.text).length).toBeLessThanOrEqual(size);
        if (i > 0) expect(chunks[i - 1]!.endChar - chunk.startChar).toBe(overlap);
      }
      expect(chunks.at(-1)!.endChar).toBe(points.length);
      expect(chunks[0]!.endChar).toBe(size);
      expect(paperChunks("x".repeat(size), profile)).toHaveLength(1);
    }
    expect(paperChunks("", "small")).toEqual([]);
  });
  it("keeps canonical source text and source boundaries separate", () => {
    const first = canonicalProtocolText({ title: "First", description: "Purpose", body: "a".repeat(2200) });
    const second = canonicalProtocolText({ title: "Second", description: "", body: "b".repeat(2200) });
    expect(first.startsWith("First\nPurpose\n")).toBe(true);
    expect(paperChunks(first, "small").every((c) => !c.text.includes("Second"))).toBe(true);
    expect(paperChunks(second, "small")[0]!.startChar).toBe(0);
  });
  it("uses only official visible fields for queries", () => {
    const sample = { question: "question", answer: "SECRET", wrong_steps: ["visible"], correct_steps: ["SECRET"], is_correct: false, corrupted_text: "visible", corrected_text: "SECRET", context: "context", instruction: "instruction", input: "input", output: "SECRET" };
    for (const task of ["PQA", "ERR", "ORD", "GEN"]) expect(taskQuery(task, sample)).not.toContain("SECRET");
    expect(taskQuery("ERR", { ...sample, is_correct: true, corrected_text: "official visible text" })).toContain("official visible text");
  });
});
