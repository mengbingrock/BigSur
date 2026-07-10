// POST /api/transcribe — speech-to-text for the composer's voice input.
// Body: { audio: base64, mimeType }. Returns { text }.
//
// Transcription always runs on OpenAI (Anthropic has no STT). Where the key
// comes from mirrors the user's LLM setting:
//   1. own OpenAI API key  → transcribe directly with it
//   2. Provided / own-Claude-without-a-key, on the desktop → forward the audio
//      to the connected labee.online account (Labee's OpenAI key, metered)
//   3. a server-side Labee OpenAI key (this is how labee.online itself serves
//      the forwarded request) → transcribe with it
//   4. none available → 503 (the UI hides/disables the mic)
import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { bodyJson, error, json, sessionUser } from "../httpKit";
import { remoteLabeeSession, resolveCredential } from "../services/llmSettings";
import { transcribeAudio } from "../services/openai";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI's per-file limit

interface TranscribeBody {
  audio?: string;
  mimeType?: string;
}

/** Forward the audio to the connected hosted Labee account for transcription. */
async function forwardToLabee(
  target: { base: string; cookie: string },
  body: TranscribeBody,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${target.base}/api/transcribe`, {
    method: "POST",
    headers: {
      cookie: target.cookie,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text().catch(() => "") };
}

export const transcribeRoute = HttpRouter.add(
  "POST",
  "/api/transcribe",
  Effect.gen(function* () {
    const user = yield* sessionUser;
    if (!user) return yield* error("Unauthorized.", 401);

    const body = yield* bodyJson<TranscribeBody>().pipe(
      Effect.catch(() => Effect.succeed({} as TranscribeBody)),
    );
    if (!body?.audio) return yield* error("No audio provided.", 400);

    const audio = Buffer.from(body.audio, "base64");
    if (audio.length === 0) return yield* error("Empty audio.", 400);
    if (audio.length > MAX_AUDIO_BYTES) return yield* error("Recording is too long.", 413);

    const outcome = yield* Effect.tryPromise({
      try: async (): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> => {
        // 1. The user's own OpenAI key → transcribe directly (own subscription).
        const cred = await resolveCredential(user.email, "openai");
        if (cred.mode === "own_api_key" && cred.apiKey && !cred.proxyBaseUrl) {
          return { ok: true, text: await transcribeAudio({ apiKey: cred.apiKey, audio, mimeType: body.mimeType }) };
        }

        // 2. Provided / own-Claude fallback on the desktop → labee.online.
        const remote = remoteLabeeSession();
        if (remote) {
          const relayed = await forwardToLabee(remote, body);
          if (relayed.status >= 200 && relayed.status < 300) {
            const parsed = JSON.parse(relayed.text) as { text?: string };
            return { ok: true, text: parsed.text ?? "" };
          }
          let msg = "Voice transcription failed.";
          try {
            msg = (JSON.parse(relayed.text) as { error?: string }).error ?? msg;
          } catch {
            /* non-JSON */
          }
          return { ok: false, status: relayed.status, message: msg };
        }

        // 3. A server-side Labee OpenAI key (labee.online serving the forward, or self-host).
        const serverKey = process.env.LABEE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
        if (serverKey) {
          return { ok: true, text: await transcribeAudio({ apiKey: serverKey, audio, mimeType: body.mimeType }) };
        }

        // 4. Nothing available.
        return {
          ok: false,
          status: 503,
          message:
            "Voice input needs OpenAI transcription — add an OpenAI API key in Settings, or connect a Labee account.",
        };
      },
      catch: (e) => e,
    }).pipe(
      Effect.catch((e) =>
        Effect.succeed({
          ok: false as const,
          status: 502,
          message: e instanceof Error ? e.message : "Transcription failed.",
        }),
      ),
    );

    if (!outcome.ok) return yield* error(outcome.message, outcome.status);
    return yield* json({ text: outcome.text });
  }),
);
