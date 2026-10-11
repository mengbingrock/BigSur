// End-of-speech detection for tap-to-talk, relative to the room: a fume hood
// or centrifuge raises the background, so fixed dB thresholds fail. The
// background ("floor") is the quietest level heard so far, drifting up
// slowly; speech is a peak well above it; the pause is a return to near it.
// Pure, so it is unit-tested with synthetic level traces.

export const SPEECH_ABOVE_FLOOR_DB = 12;
export const QUIET_ABOVE_FLOOR_DB = 6;
export const FLOOR_DRIFT_DB = 0.03;
export const QUIET_MS = 1200;
export const NO_SPEECH_MS = 6000;
export const MAX_LISTEN_MS = 20000;

export type SpeechEndVerdict = "listening" | "ended" | "nothing";

export class SpeechEndDetector {
  private floor = Number.POSITIVE_INFINITY;
  private peak = Number.NEGATIVE_INFINITY;
  private quietSince = 0;
  spoke = false;

  constructor(private readonly began: number) {}

  /** Feed one metering sample (dBFS, or null when there is none). */
  push(level: number | null, now: number): SpeechEndVerdict {
    if (level !== null && level > -120) {
      this.floor = Math.min(this.floor, level) + FLOOR_DRIFT_DB;
      this.peak = Math.max(this.peak, level);
      // Speech said before the floor was known still counts: the peak stands
      // out once a quieter moment has set the floor.
      if (this.peak - this.floor >= SPEECH_ABOVE_FLOOR_DB) this.spoke = true;
      if (this.spoke && level < this.floor + QUIET_ABOVE_FLOOR_DB) {
        if (!this.quietSince) this.quietSince = now;
      } else {
        this.quietSince = 0;
      }
    }
    if (this.spoke && this.quietSince && now - this.quietSince >= QUIET_MS) return "ended";
    if (now - this.began >= MAX_LISTEN_MS) return this.spoke ? "ended" : "nothing";
    if (!this.spoke && now - this.began >= NO_SPEECH_MS) return "nothing";
    return "listening";
  }
}
