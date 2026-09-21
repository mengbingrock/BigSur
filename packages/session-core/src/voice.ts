// Voice helpers shared by clients: sentence chunking for read-aloud over a
// token stream, and the tiny command grammar handled before a message is sent.

/** Feed streamed text; get back whole sentences ready to speak. Code fences
 *  are replaced with a short spoken placeholder. */
export class SentenceChunker {
  private buf = "";
  private inFence = false;

  feed(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    // Strip fenced code as it closes.
    while (true) {
      const fence = this.buf.indexOf("```");
      if (fence === -1) break;
      if (!this.inFence) {
        const before = this.buf.slice(0, fence);
        out.push(...this.split(before));
        this.buf = this.buf.slice(fence + 3);
        this.inFence = true;
      } else {
        const body = this.buf.slice(0, fence);
        const lines = body.split("\n").filter((l) => l.trim()).length;
        out.push(`Code block, ${Math.max(lines - 1, 1)} lines.`);
        this.buf = this.buf.slice(fence + 3);
        this.inFence = false;
      }
    }
    if (this.inFence) return out;
    const sentences = this.split(this.buf, true);
    return [...out, ...sentences];
  }

  /** Flush whatever is left (end of turn). */
  end(): string[] {
    const rest = clean(this.buf);
    this.buf = "";
    this.inFence = false;
    return rest ? [rest] : [];
  }

  private split(text: string, keepTail = false): string[] {
    const out: string[] = [];
    const re = /[^.!?\n]*[.!?]+(?=\s|$)|[^\n]*\n/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const s = clean(m[0]);
      if (s) out.push(s);
      last = re.lastIndex;
    }
    if (keepTail) this.buf = text.slice(last);
    else if (text.slice(last).trim()) out.push(clean(text.slice(last)));
    return out;
  }
}

function clean(s: string): string {
  return s
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type VoiceCommand =
  | { kind: "stop" }
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "new_session" }
  | { kind: "repeat" }
  | { kind: "send"; text: string };

/** Classify a transcribed utterance. Only very short, unambiguous phrases are
 *  treated as commands so ordinary sentences always go to the agent. */
export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.trim();
  const norm = text.toLowerCase().replace(/[.!,?]+$/g, "").trim();
  if (!norm) return { kind: "send", text };
  const words = norm.split(/\s+/);
  if (words.length <= 3) {
    if (/^(stop|cancel|stop it|cancel that|halt)$/.test(norm)) return { kind: "stop" };
    if (/^(approve|approved|yes approve|approve it|go ahead|confirm)$/.test(norm)) return { kind: "approve" };
    if (/^(reject|rejected|no reject|deny|decline)$/.test(norm)) return { kind: "reject" };
    if (/^(new session|new chat|start over)$/.test(norm)) return { kind: "new_session" };
    if (/^(repeat|say that again|read that again|again)$/.test(norm)) return { kind: "repeat" };
  }
  return { kind: "send", text };
}
