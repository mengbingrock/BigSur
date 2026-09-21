import { describe, expect, it } from "vitest";
import { SseParser, frameJson, parseSseFrame } from "../src/sse";

describe("SSE parser", () => {
  it("parses event/data/id fields", () => {
    const f = parseSseFrame("id: 7\nevent: delta\ndata: {\"text\":\"hi\"}");
    expect(f).toEqual({ id: "7", event: "delta", data: '{"text":"hi"}' });
    expect(frameJson(f!)).toEqual({ text: "hi" });
  });
  it("ignores comment heartbeats", () => {
    expect(parseSseFrame(": ping")).toBeNull();
  });
  it("handles chunk boundaries and CRLF", () => {
    const p = new SseParser();
    const enc = new TextEncoder();
    expect(p.feed(enc.encode("event: a\r\ndata: 1\r\n\r\nevent: b\ndata: "))).toEqual([
      { event: "a", data: "1" },
    ]);
    expect(p.feed("2\n\n")).toEqual([{ event: "b", data: "2" }]);
    expect(p.feed("event: c\ndata: 3")).toEqual([]);
    expect(p.end()).toEqual([{ event: "c", data: "3" }]);
  });
  it("joins multi-line data", () => {
    expect(parseSseFrame("data: a\ndata: b")?.data).toBe("a\nb");
  });
});
