// Client-safe pieces of the deck module: types and pure formatters.
// `lib/deck.ts` re-exports these so server code can keep importing from one
// place, but client components must import from here to avoid pulling
// node:fs into the browser bundle.

export type DeckEntryKind = "file" | "dir";

export interface DeckFile {
  name: string;
  /** "file" (default) or "dir" — directories report size: 0. */
  kind: DeckEntryKind;
  size: number;
  modified: string; // ISO 8601
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
