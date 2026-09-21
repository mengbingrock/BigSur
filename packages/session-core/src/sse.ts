// Minimal Server-Sent Events parsing shared by the server's session runner
// (which consumes engine SSE byte streams), the web client, and the mobile app.
// No dependencies; works on Uint8Array chunks or already-decoded text.

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Parse one frame (the text between two blank lines). Returns null for
 *  comment-only frames (heartbeats). */
export function parseSseFrame(chunk: string): SseFrame | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
}

/** Incremental parser: feed bytes or text, get complete frames back. */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  feed(chunk: Uint8Array | string): SseFrame[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    // Normalise CRLF so "\r\n\r\n" splits like "\n\n".
    if (this.buffer.includes("\r\n")) this.buffer = this.buffer.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseSseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush a trailing frame with no terminating blank line. */
  end(): SseFrame[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const frame = parseSseFrame(rest);
    return frame ? [frame] : [];
  }
}

/** Parse a frame's data as JSON, tolerating plain strings. */
export function frameJson(frame: SseFrame): Record<string, unknown> {
  try {
    const v = JSON.parse(frame.data) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { value: frame.data };
  }
}
