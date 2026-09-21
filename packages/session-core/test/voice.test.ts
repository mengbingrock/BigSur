import { describe, expect, it } from "vitest";
import { SentenceChunker, parseVoiceCommand } from "../src/voice";

describe("SentenceChunker", () => {
  it("emits whole sentences as tokens arrive", () => {
    const c = new SentenceChunker();
    expect(c.feed("Hello there")).toEqual([]);
    expect(c.feed(". This is **bold** text")).toEqual(["Hello there."]);
    expect(c.feed(" here. And")).toEqual(["This is bold text here."]);
    expect(c.end()).toEqual(["And"]);
  });
  it("replaces code fences", () => {
    const c = new SentenceChunker();
    const out = [...c.feed("Run this:\n```sh\nls\npwd\n```\nDone."), ...c.end()];
    expect(out).toEqual(["Run this:", "Code block, 2 lines.", "Done."]);
  });
});

describe("parseVoiceCommand", () => {
  it("recognises short control phrases", () => {
    expect(parseVoiceCommand("Stop.")).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("approve it")).toEqual({ kind: "approve" });
    expect(parseVoiceCommand("Reject")).toEqual({ kind: "reject" });
    expect(parseVoiceCommand("say that again")).toEqual({ kind: "repeat" });
  });
  it("sends ordinary sentences", () => {
    expect(parseVoiceCommand("stop the server and rerun the tests")).toEqual({
      kind: "send",
      text: "stop the server and rerun the tests",
    });
  });
});
