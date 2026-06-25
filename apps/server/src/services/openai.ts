// OpenAI provider backend. Unlike the agentic claude CLI path, this calls the
// OpenAI Chat Completions HTTP API directly (no Bash/file tools). Streaming is
// mapped onto the same SSE event names the web chat store consumes
// (init / delta / result / end / error).

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Build a streaming SSE response for a chat turn against the OpenAI API. */
export function openAIChatStream(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: OpenAIChatMessage[];
}): ReadableStream<Uint8Array> {
  const { apiKey, model, system, messages } = opts;
  const controllerRef: { aborted: boolean } = { aborted: false };
  const abort = new AbortController();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      const enqueue = (event: string, data: unknown) => {
        if (controllerRef.aborted) return;
        controller.enqueue(sse(event, data));
      };
      enqueue("init", { model, api_key_source: "openai", permission_mode: "none" });

      let res: Response;
      try {
        res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: "system", content: system }, ...messages],
          }),
          signal: abort.signal,
        });
      } catch (e) {
        enqueue("error", { message: e instanceof Error ? e.message : "OpenAI request failed." });
        controller.close();
        return;
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const msg = parseOpenAIError(text) ?? `OpenAI API error (HTTP ${res.status}).`;
        enqueue("error", { message: msg });
        controller.close();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let usage: unknown = undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            let evt: {
              choices?: { delta?: { content?: string } }[];
              usage?: unknown;
            };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            const text = evt.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text.length > 0) {
              enqueue("delta", { index: 0, text });
            }
            if (evt.usage) usage = evt.usage;
          }
        }
        enqueue("result", {
          duration_ms: Date.now() - started,
          num_turns: 1,
          usage,
        });
        enqueue("end", {});
      } catch (e) {
        enqueue("error", { message: e instanceof Error ? e.message : "OpenAI stream error." });
      } finally {
        controller.close();
      }
    },
    cancel() {
      controllerRef.aborted = true;
      try {
        abort.abort();
      } catch {
        // already aborted
      }
    },
  });
}

/** Non-streaming completion (for the extract/edit auxiliary calls). */
export async function openAIComplete(opts: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const { apiKey, model, system, user } = opts;
  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(parseOpenAIError(text) ?? `OpenAI API error (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

function parseOpenAIError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    return j.error?.message ?? null;
  } catch {
    return null;
  }
}
