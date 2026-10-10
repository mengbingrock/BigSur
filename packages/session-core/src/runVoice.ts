// Spoken run commands for Lab mode: what someone at the bench says to the
// app's own microphone while a protocol run is open ("done", "how much TSS",
// "timer ten minutes", "note the pellet is loose"). They are matched here,
// on the phone, so they need no app name, no Siri, and no agent turn.
//
// Only short, whole-utterance phrases count. Anything else returns null and
// goes to the agent as an ordinary message, so a real question is never
// swallowed by a loose match.

export type RunCommand =
  | { kind: "advance" }
  | { kind: "back" }
  | { kind: "skip" }
  | { kind: "where" }
  | { kind: "read" }
  | { kind: "peek" }
  | { kind: "amount"; material: string }
  | { kind: "timer"; seconds: number | null }
  | { kind: "cancel_timer" }
  | { kind: "time_left" }
  | { kind: "note"; text: string | null }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "finish" };

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

/** "10", "ten", "forty five", "one and a half" → a number, or null. */
export function spokenToNumber(raw: string): number | null {
  const s = raw.trim().replace(/-/g, " ");
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const half = /^(.*?)\s*and a half$/.exec(s);
  if (half) {
    const base = half[1] ? spokenToNumber(half[1]) : null;
    return base === null ? null : base + 0.5;
  }
  if (s === "half a" || s === "half an" || s === "half") return 0.5;
  const words = s.split(/\s+/);
  let total = 0;
  for (const w of words) {
    const n = NUMBER_WORDS[w];
    if (n === undefined) return null;
    total += n;
  }
  return words.length ? total : null;
}

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(h|hr|hrs|hour|hours)$/, 3600],
  [/^(m|min|mins|minute|minutes)$/, 60],
  [/^(s|sec|secs|second|seconds)$/, 1],
];

/** "10 minutes", "ten minute", "an hour", "half an hour", "90 seconds" → seconds. */
export function spokenDuration(raw: string): number | null {
  const m = /^(.+?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)$/.exec(raw.trim());
  if (!m) return null;
  const qty = spokenToNumber(m[1]!);
  if (qty === null || qty <= 0) return null;
  const unit = UNIT_SECONDS.find(([re]) => re.test(m[2]!));
  return unit ? Math.round(qty * unit[1]) : null;
}

/** Lower-case, drop punctuation and the polite or wake words people add. */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^((ok|okay|hey|so|um|uh|right|and|labee|lab bee|lab helper|lab assistant|please)\s+)+/, "")
    .replace(/(\s+(please|thanks|thank you))+$/, "")
    .trim();
}

export function parseRunCommand(raw: string): RunCommand | null {
  const original = raw.trim();
  const s = normalize(original);
  if (!s) return null;

  // Notes keep the person's own words after the trigger, so match on the
  // original text (punctuation and case intact) once the trigger is found.
  const noteTrigger = /^(add a note|make a note|take a note|note that|note|log that|record that)\b[\s:,-]*/;
  if (noteTrigger.test(s)) {
    const text = original
      .replace(/^[\s,]*((ok|okay|hey|so|um|uh|right|and|labee|lab bee|lab helper|lab assistant|please)[\s,]+)*/i, "")
      .replace(/^(add a note|make a note|take a note|note that|note|log that|record that)\b[\s:,.-]*/i, "")
      .trim();
    return { kind: "note", text: text || null };
  }

  const words = s.split(" ");
  if (words.length > 9) return null;

  if (/^(done|next|next step|finished|step done|that's done|i'm done|it's done|complete|completed|mark (it|this|the step|this step) (as )?done|go on|move on)$/.test(s)) return { kind: "advance" };
  if (/^(back|go back|previous|previous step|last step|undo|undo that)$/.test(s)) return { kind: "back" };
  if (/^(skip|skip it|skip this|skip this step|skip step|skip that)$/.test(s)) return { kind: "skip" };
  if (/^(where am i|what step( am i on| is this)?|which step( am i on| is this)?|current step|what's the current step|status|progress)$/.test(s)) return { kind: "where" };
  if (/^(read( the)? step|read it|read that|repeat( the)? step|step details|details|what do i do|what do i do now|say the step|say it again|repeat that)$/.test(s)) return { kind: "read" };
  if (/^(what's next|what is next|what comes next|what's the next step|read( the)? next step|next one)$/.test(s)) return { kind: "peek" };

  if (/^(cancel|stop|kill|clear)( the)? timer$/.test(s)) return { kind: "cancel_timer" };
  if (/^(how long( is)? left|how much time( is)? left|time left|how long to go|how long now|timer status)$/.test(s)) return { kind: "time_left" };
  const timer =
    /^(?:start|set|begin)?\s*(?:a |the )?timer(?: for)?\s*(.*)$/.exec(s) ??
    /^(?:start|set)?\s*(?:a |an )?(.+?)\s*timer$/.exec(s);
  if (timer) {
    const rest = (timer[1] ?? "").trim();
    if (!rest) return { kind: "timer", seconds: null };
    const seconds = spokenDuration(rest.replace(/^(a|an)\s+(?=\d)/, ""));
    if (seconds) return { kind: "timer", seconds };
  }

  if (/^(pause|pause( the)? run|hold on|wait)$/.test(s)) return { kind: "pause" };
  if (/^(resume|resume( the)? run|continue|carry on|unpause)$/.test(s)) return { kind: "resume" };
  if (/^(finish|finish( the)? run|end( the)? run|stop( the)? run|we're finished|run finished)$/.test(s)) return { kind: "finish" };

  const amount = /^how (?:much|many)\b(.*)$/.exec(s);
  if (amount) {
    // Peel the filler off the end ("… do I need in this step"), then off
    // the front ("of the …"); what is left is the material.
    let m = ` ${amount[1] ?? ""} `;
    let prev = "";
    while (prev !== m) {
      prev = m;
      m = m
        .replace(/\s+(in|for|at|on|during) (this|the|that) step\s*$/, " ")
        .replace(/\s+(here|now|again)\s*$/, " ")
        .replace(/\s+(do|should|shall|will) (i|we) (need|add|use|put in|put|take|pipette)\s*$/, " ")
        .replace(/\s+(goes|go|went)( in)?\s*$/, " ")
        .replace(/\s+(is|are) (needed|used|added)\s*$/, " ")
        .replace(/\s+(to|i|we) (need|add|use|put in)\s*$/, " ");
    }
    m = m.replace(/^\s*(of\s+)?(the\s+)?/, "").trim();
    return { kind: "amount", material: m };
  }

  return null;
}

/** What Lab mode tells someone who asks what they can say. */
export const RUN_COMMAND_HINTS = ["done", "back", "skip", "where am I", "what's next", "how much TSS", "timer 10 minutes", "note …", "finish run"];
