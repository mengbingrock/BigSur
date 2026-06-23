import { Schema } from "effect";

export const DeckEntryKind = Schema.Literals(["file", "dir"]);
export type DeckEntryKind = typeof DeckEntryKind.Type;

/** A file or directory entry in a user's deck (working directory). */
export const DeckFile = Schema.Struct({
  name: Schema.String,
  /** "file" (default) or "dir" — directories report size: 0. */
  kind: DeckEntryKind,
  size: Schema.Number,
  /** ISO-8601 modified timestamp. */
  modified: Schema.String,
});
export type DeckFile = typeof DeckFile.Type;
