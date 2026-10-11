import { describe, expect, it } from "vitest";
import { mapSpokenAnswer } from "../src/services/sessions/answerMap";

const q = [{ question: "Which evaluator?", options: [{ label: "Command (objective)" }, { label: "LLM rubric" }, { label: "Other…" }] }];

describe("mapSpokenAnswer", () => {
  it("matches a label regardless of case and punctuation", () => {
    expect(mapSpokenAnswer(q, "llm rubric").answers[0]!.answer).toBe("LLM rubric");
    expect(mapSpokenAnswer(q, "Command objective").answers[0]!.answer).toBe("Command (objective)");
  });
  it("matches a label contained in the utterance, or the utterance inside a label", () => {
    expect(mapSpokenAnswer(q, "let's go with the LLM rubric please").answers[0]!.answer).toBe("LLM rubric");
    expect(mapSpokenAnswer(q, "rubric").answers[0]!.answer).toBe("LLM rubric");
  });
  it("understands ordinals", () => {
    expect(mapSpokenAnswer(q, "the second one").answers[0]!.answer).toBe("LLM rubric");
    expect(mapSpokenAnswer(q, "option 3").answers[0]!.answer).toBe("Other…");
    expect(mapSpokenAnswer(q, "the last one").answers[0]!.answer).toBe("Other…");
  });
  it("yes and no on a two-option question", () => {
    const yn = [{ question: "Proceed?", options: [{ label: "Yes, run it" }, { label: "Not yet" }] }];
    expect(mapSpokenAnswer(yn, "yeah go ahead").answers[0]!.answer).toBe("Yes, run it");
    expect(mapSpokenAnswer(yn, "no").answers[0]!.answer).toBe("Not yet");
  });
  it("falls back to free text and says so", () => {
    const r = mapSpokenAnswer(q, "use the thing we tried on Tuesday");
    expect(r.matched).toBe(false);
    expect(r.answers[0]!.answer).toBe("use the thing we tried on Tuesday");
  });
});
