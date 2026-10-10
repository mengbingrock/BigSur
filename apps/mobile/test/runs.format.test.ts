import { describe, expect, it } from "vitest";
import { amountsLine, clock, elapsed, fraction, parseScale, remaining, summaryLine } from "../src/runs/format";
import { CATEGORY, categoryActions, decide, questionBody } from "../src/notifications/categories";

describe("run formatting", () => {
  it("clocks and elapsed", () => {
    expect(clock(252)).toBe("4:12");
    expect(clock(3750)).toBe("1:02:30");
    expect(elapsed(45)).toBe("45 s");
    expect(elapsed(31 * 60)).toBe("31 min");
    expect(elapsed(2 * 3600 + 5 * 60)).toBe("2 h 05");
  });
  it("remaining never goes negative", () => {
    const now = Date.now();
    expect(remaining(new Date(now + 10_000).toISOString(), now)).toBe(10);
    expect(remaining(new Date(now - 10_000).toISOString(), now)).toBe(0);
  });
  it("fraction and summary", () => {
    expect(fraction(5, 9, "running")).toBe("step 5 of 9");
    expect(fraction(9, 9, "done")).toBe("9 of 9 done");
    expect(fraction(3, 9, "done", 3)).toBe("3 of 9 done");
    expect(fraction(4, 9, "abandoned")).toBe("ended early");
    expect(summaryLine({ steps: [{ timer: null }, { timer: { seconds: 1 } }] as never, loose: false })).toBe("2 steps · 1 timer");
    expect(summaryLine({ steps: [{ timer: null }] as never, loose: true })).toBe("1 step · no numbered list — one step per paragraph");
  });
  it("amounts line and scale parsing", () => {
    expect(amountsLine({ amounts: [{ qty: "10", unit: "min", of: null }, { qty: "4", unit: "°C", of: null }] })).toBe("10 min · 4 °C");
    expect(parseScale("50", { qty: 25, unit: "mL" })).toEqual({ qty: 50, unit: "mL" });
    expect(parseScale("0.5 l", { qty: 25, unit: "mL" })).toEqual({ qty: 0.5, unit: "L" });
    expect(parseScale("lots", { qty: 25, unit: "mL" })).toBeNull();
  });
});

describe("notification categories", () => {
  it("declares the four categories with their buttons", () => {
    const c = categoryActions();
    expect(Object.keys(c)).toEqual([CATEGORY.question, CATEGORY.reply, CATEGORY.attention, CATEGORY.timer]);
    expect(c[CATEGORY.reply]![0]!.textInput?.placeholder).toBe("Message");
    expect(c[CATEGORY.timer]!.map((a) => a.identifier)).toEqual(["done", "snooze"]);
  });
  it("maps a question button onto the option by index", () => {
    const d = decide(CATEGORY.question, "opt2", { sessionId: "s1", hostId: "h1", options: ["Command", "LLM rubric"] });
    expect(d).toEqual({ do: "answer", sessionId: "s1", hostId: "h1", spoken: "LLM rubric" });
    expect(decide(CATEGORY.question, "opt3", { sessionId: "s1", options: ["a", "b"] })).toEqual({ do: "open-session", sessionId: "s1", voice: false });
  });
  it("a typed reply becomes the next turn; Read in Labee opens voice mode", () => {
    expect(decide(CATEGORY.reply, "reply", { sessionId: "s1" }, "  yes, and the table ")).toEqual({ do: "reply", sessionId: "s1", text: "yes, and the table" });
    expect(decide(CATEGORY.reply, "open-voice", { sessionId: "s1" })).toEqual({ do: "open-session", sessionId: "s1", voice: true });
  });
  it("timer buttons advance or snooze the run", () => {
    expect(decide(CATEGORY.timer, "done", { runId: "r1" })).toEqual({ do: "run-advance", runId: "r1" });
    expect(decide(CATEGORY.timer, "snooze", { runId: "r1" })).toEqual({ do: "run-timer", runId: "r1", seconds: 300, label: "5 more minutes" });
    expect(decide(CATEGORY.timer, "default", { runId: "r1", sessionId: "s1" })).toEqual({ do: "open-run", runId: "r1", sessionId: "s1" });
  });
  it("tapping any push with a session opens it", () => {
    expect(decide(null, "expo.modules.notifications.actions.DEFAULT", { sessionId: "s1" })).toEqual({ do: "open-session", sessionId: "s1", voice: false });
    expect(decide(null, "default", {})).toEqual({ do: "none" });
  });
  it("question bodies list the options", () => {
    expect(questionBody("Which evaluator?", ["Command", "LLM rubric", "Other", "Fourth"])).toBe("Which evaluator?\n1. Command  2. LLM rubric  3. Other");
  });
});
