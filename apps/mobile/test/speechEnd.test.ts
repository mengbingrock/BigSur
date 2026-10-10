import { describe, expect, it } from "vitest";
import { SpeechEndDetector, type SpeechEndVerdict } from "../src/hooks/speechEnd";

/** Play a level trace (one sample per 150 ms) and return the first verdict
 *  that isn't "listening", with the time it came. */
function play(levels: Array<number | null>): { verdict: SpeechEndVerdict; ms: number } {
  const d = new SpeechEndDetector(0);
  for (let i = 0; i < levels.length; i++) {
    const v = d.push(levels[i]!, i * 150);
    if (v !== "listening") return { verdict: v, ms: i * 150 };
  }
  return { verdict: "listening", ms: levels.length * 150 };
}

const rep = (level: number | null, ms: number) => Array<number | null>(Math.ceil(ms / 150)).fill(level);

describe("end of speech", () => {
  it("ends after a word and a pause in a quiet room", () => {
    const r = play([...rep(-55, 600), ...rep(-25, 600), ...rep(-55, 3000)]);
    expect(r.verdict).toBe("ended");
    expect(r.ms).toBeGreaterThanOrEqual(1200 + 1200 - 150);
    expect(r.ms).toBeLessThan(3000);
  });

  it("still ends in a noisy room, where fixed thresholds never saw a pause", () => {
    // A hood at -36 dB: the old -44 dB "quiet" level was never reached.
    const r = play([...rep(-36, 600), ...rep(-18, 900), ...rep(-36, 3000)]);
    expect(r.verdict).toBe("ended");
  });

  it("counts a word said before the background was measured", () => {
    const r = play([...rep(-22, 600), ...rep(-50, 3000)]);
    expect(r.verdict).toBe("ended");
  });

  it("keeps listening through a short breath between words", () => {
    const trace = [...rep(-55, 450), ...rep(-25, 600), ...rep(-55, 600), ...rep(-25, 600)];
    expect(play(trace).verdict).toBe("listening");
  });

  it("gives up when nothing is said, and caps a long recording", () => {
    expect(play(rep(-50, 7000)).verdict).toBe("nothing");
    expect(play(rep(-50, 7000)).ms).toBe(6000);
    const talking = [...rep(-50, 300), ...Array.from({ length: 200 }, (_, i) => (i % 2 ? -20 : -30))];
    const capped = play(talking);
    expect(capped.verdict).toBe("ended");
    expect(capped.ms).toBeGreaterThanOrEqual(20000);
    expect(capped.ms).toBeLessThan(20000 + 150);
  });

  it("falls back to the time caps without metering", () => {
    expect(play(rep(null, 7000)).verdict).toBe("nothing");
  });
});
