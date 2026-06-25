import { Schema } from "effect";
import { Provider } from "./llm";

/** A single turn on the chat wire (no client-only activity/stats). */
export const ChatMessageWire = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
});
export type ChatMessageWire = typeof ChatMessageWire.Type;

/** Passage-rewrite request: selected text from a longer message + instruction. */
export const EditPayload = Schema.Struct({
  fullMessage: Schema.String,
  selection: Schema.String,
  instruction: Schema.String,
});
export type EditPayload = typeof EditPayload.Type;

export const ChatMode = Schema.Literals(["chat", "edit"]);
export type ChatMode = typeof ChatMode.Type;

/** Body of POST /api/chat. The response is an SSE event stream, not JSON. */
export const ChatRequest = Schema.Struct({
  mode: Schema.optional(ChatMode),
  messages: Schema.optional(Schema.Array(ChatMessageWire)),
  skillSlugs: Schema.Array(Schema.String),
  /** Qualified deck paths injected into the system prompt. */
  contextFiles: Schema.optional(Schema.Array(Schema.String)),
  /** Per-session artifact body overrides keyed by slug (this turn only). */
  artifactNotes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  edit: Schema.optional(EditPayload),
  /** Optional per-turn override of the provider/model; falls back to the
   *  user's saved LLM settings when omitted. */
  provider: Schema.optional(Provider),
  model: Schema.optional(Schema.String),
});
export type ChatRequest = typeof ChatRequest.Type;

/** Proposal returned by POST /api/artifacts/:slug/llm-edit. */
export const LlmEditRequest = Schema.Struct({
  instruction: Schema.String,
});
export type LlmEditRequest = typeof LlmEditRequest.Type;

export const LlmEditResult = Schema.Struct({
  slug: Schema.String,
  current: Schema.String,
  proposed: Schema.String,
  summary: Schema.Array(Schema.String),
});
export type LlmEditResult = typeof LlmEditResult.Type;
