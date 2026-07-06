import { Schema } from "effect";

/**
 * A choice a post-stream extractor inferred from the assistant's plain-text
 * reply. Surfaced as clickable canvas question nodes.
 */
export const ExtractedChoice = Schema.Struct({
  /** Synthetic id; deterministic from message id + index. */
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  multiSelect: Schema.Boolean,
  /** "material" choices (reagent/kit swaps) stay hidden on the canvas until a
   *  sibling non-material choice is acted on. Undefined / "choice" = regular. */
  kind: Schema.optional(Schema.Literals(["material", "choice"])),
  /** For "material" entries: the exact sibling option labels this reagent
   *  applies to. Empty/undefined = applies regardless of pick. */
  parentOptions: Schema.optional(Schema.Array(Schema.String)),
});
export type ExtractedChoice = typeof ExtractedChoice.Type;

/** A workflow step the extractor inferred. Phases can be hierarchical:
 *  `subPhases` carries finer-grained children that expand on click. */
export interface ExtractedPhase {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly subPhases?: ReadonlyArray<ExtractedPhase> | undefined;
}
export const ExtractedPhase = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  summary: Schema.String,
  subPhases: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Codec<ExtractedPhase> => ExtractedPhase)),
  ),
});

export const ExtractedPipelineEdge = Schema.Struct({
  /** Canvas-unique ids matching ExtractedPhase.id. */
  source: Schema.String,
  target: Schema.String,
});
export type ExtractedPipelineEdge = typeof ExtractedPipelineEdge.Type;

export const ExtractChoicesRequest = Schema.Struct({
  text: Schema.String,
  messageId: Schema.String,
});
export type ExtractChoicesRequest = typeof ExtractChoicesRequest.Type;

export const ExtractChoicesResult = Schema.Struct({
  choices: Schema.Array(ExtractedChoice),
  phases: Schema.Array(ExtractedPhase),
  edges: Schema.Array(ExtractedPipelineEdge),
});
export type ExtractChoicesResult = typeof ExtractChoicesResult.Type;
