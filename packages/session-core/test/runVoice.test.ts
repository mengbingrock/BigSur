import { describe, expect, it } from "vitest";
import { parseRunCommand, spokenDuration, spokenToNumber } from "../src/runVoice";

describe("parseRunCommand", () => {
  it("reads the step verbs, with or without polite words", () => {
    expect(parseRunCommand("Done.")).toEqual({ kind: "advance" });
    expect(parseRunCommand("okay, next step please")).toEqual({ kind: "advance" });
    expect(parseRunCommand("Labee, done")).toEqual({ kind: "advance" });
    expect(parseRunCommand("Mark this step as done")).toEqual({ kind: "advance" });
    expect(parseRunCommand("go back")).toEqual({ kind: "back" });
    expect(parseRunCommand("Skip this step.")).toEqual({ kind: "skip" });
    expect(parseRunCommand("Where am I?")).toEqual({ kind: "where" });
    expect(parseRunCommand("read the step")).toEqual({ kind: "read" });
    expect(parseRunCommand("What's next?")).toEqual({ kind: "peek" });
    expect(parseRunCommand("pause")).toEqual({ kind: "pause" });
    expect(parseRunCommand("carry on")).toEqual({ kind: "resume" });
    expect(parseRunCommand("Finish the run")).toEqual({ kind: "finish" });
  });

  it("asks for amounts, with or without a material", () => {
    expect(parseRunCommand("How much TSS?")).toEqual({ kind: "amount", material: "tss" });
    expect(parseRunCommand("how much LB do I need")).toEqual({ kind: "amount", material: "lb" });
    expect(parseRunCommand("How much water goes in this step")).toEqual({ kind: "amount", material: "water" });
    expect(parseRunCommand("how many falcon tubes")).toEqual({ kind: "amount", material: "falcon tubes" });
    expect(parseRunCommand("How much?")).toEqual({ kind: "amount", material: "" });
  });

  it("starts, cancels and checks timers", () => {
    expect(parseRunCommand("start the timer")).toEqual({ kind: "timer", seconds: null });
    expect(parseRunCommand("Timer 10 minutes")).toEqual({ kind: "timer", seconds: 600 });
    expect(parseRunCommand("set a timer for ten minutes")).toEqual({ kind: "timer", seconds: 600 });
    expect(parseRunCommand("start a 5 minute timer")).toEqual({ kind: "timer", seconds: 300 });
    expect(parseRunCommand("timer for half an hour")).toEqual({ kind: "timer", seconds: 1800 });
    expect(parseRunCommand("timer 90 seconds")).toEqual({ kind: "timer", seconds: 90 });
    expect(parseRunCommand("cancel the timer")).toEqual({ kind: "cancel_timer" });
    expect(parseRunCommand("how long is left?")).toEqual({ kind: "time_left" });
  });

  it("keeps a note in the person's own words", () => {
    expect(parseRunCommand("Note: the pellet is loose, spun again.")).toEqual({ kind: "note", text: "the pellet is loose, spun again." });
    expect(parseRunCommand("Okay, note that OD600 was 0.42")).toEqual({ kind: "note", text: "OD600 was 0.42" });
    expect(parseRunCommand("add a note")).toEqual({ kind: "note", text: null });
  });

  it("leaves real questions and long sentences to the agent", () => {
    expect(parseRunCommand("Why does competence fall when the culture overshoots?")).toBeNull();
    expect(parseRunCommand("Can you check whether 4 C is cold enough for step 5")).toBeNull();
    expect(parseRunCommand("I think I'm done with the spin but the pellet looks smaller than usual today")).toBeNull();
    expect(parseRunCommand("nothing")).toBeNull();
    expect(parseRunCommand("")).toBeNull();
  });
});

describe("spoken numbers and durations", () => {
  it("parses digits and words", () => {
    expect(spokenToNumber("10")).toBe(10);
    expect(spokenToNumber("forty five")).toBe(45);
    expect(spokenToNumber("one and a half")).toBe(1.5);
    expect(spokenToNumber("banana")).toBeNull();
  });
  it("turns durations into seconds", () => {
    expect(spokenDuration("ten minutes")).toBe(600);
    expect(spokenDuration("an hour")).toBe(3600);
    expect(spokenDuration("half an hour")).toBe(1800);
    expect(spokenDuration("2 hours")).toBe(7200);
    expect(spokenDuration("soon")).toBeNull();
  });
});
